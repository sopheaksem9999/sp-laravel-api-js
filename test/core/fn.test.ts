import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import type { ApiConfig } from '../../src';

function setup(cfg: Partial<ApiConfig> = {}) {
  const calls: Array<{ url: URL; method: string; body: unknown; headers: Headers }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), method: init?.method ?? 'GET', body: init?.body, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ success: true, data: { ok: true }, meta: {} }), { status: 200 });
  }) as typeof fetch;
  return { calls, api: createApi({ baseUrl: 'https://host.test/api', fetch: fetchFn, ...cfg }) };
}

describe('rpc / fn query option', () => {
  it('sends a record query without per_page', async () => {
    const { api, calls } = setup();
    await api.rpc('reports/summary', { query: { a: 1, b: 'x' } });
    expect(calls[0]!.url.pathname).toBe('/api/rpc/reports/summary');
    expect(calls[0]!.url.search).toBe('?a=1&b=x');
    expect(calls[0]!.url.searchParams.has('per_page')).toBe(false);
  });

  it('skips null and undefined, stringifies booleans', async () => {
    const { api, calls } = setup();
    await api.rpc('x', { query: { a: null, b: undefined, c: true, d: false } });
    expect(calls[0]!.url.search).toBe('?c=true&d=false');
  });

  it('accepts URLSearchParams and applies to fn', async () => {
    const { api, calls } = setup();
    await api.fn('invoices', 'totals', { id: 3, query: new URLSearchParams({ y: '1' }) });
    expect(calls[0]!.url.pathname).toBe('/api/invoices/3/rpc/totals');
    expect(calls[0]!.url.search).toBe('?y=1');
  });

  it('adds no ? without a query or with an empty one', async () => {
    const { api, calls } = setup();
    await api.rpc('x');
    await api.rpc('x', { query: {} });
    expect(calls[0]!.url.search).toBe('');
    expect(calls[1]!.url.search).toBe('');
  });

  it('honours explicit method with a body, and per-call headers beat auth', async () => {
    const { api, calls } = setup({ auth: { getHeaders: async () => ({ Authorization: 'Bearer a' }) } });
    await api.rpc('x', { method: 'PUT', body: { n: 1 }, query: { q: 1 }, headers: { Authorization: 'Bearer b' } });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.body).toBe('{"n":1}');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer b');
    expect(calls[0]!.url.search).toBe('?q=1');
  });

  it('works with an empty rpcPrefix', async () => {
    const { api, calls } = setup({ rpcPrefix: '' });
    await api.rpc('ping', { query: { a: 1 } });
    expect(calls[0]!.url.pathname).toBe('/api/ping');
  });

  it('still rejects a .. path segment', async () => {
    const { api } = setup();
    const e = await api.rpc('a/../b', { query: { a: 1 } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).code).toBe('unencodable_value');
  });
});
