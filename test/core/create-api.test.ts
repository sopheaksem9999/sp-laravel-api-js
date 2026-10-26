import { describe, expect, expectTypeOf, it } from 'vitest';
import { createApi } from '../../src/core/create-api';
import { VERSION } from '../../src/index';

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function mk(cfg: Partial<Parameters<typeof createApi>[0]> = {}, payload: unknown = { success: true, data: { ok: 1 }, meta: { m: 1 } }) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body as string | undefined });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { seen, api: createApi({ baseUrl: 'https://x.test/api', fetch, ...cfg }) };
}

describe('fn', () => {
  it('POSTs {table}/{prefix}/{name} with a body', async () => {
    const { seen, api } = mk({ rpcPrefix: 't' });
    expect(await api.fn('invoices', 'create', { method: 'POST', body: { a: 1 } })).toEqual({ ok: 1 });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('https://x.test/api/invoices/t/create');
    expect(seen[0]?.body).toBe('{"a":1}');
  });
  it('includes the id', async () => {
    const { seen, api } = mk({ rpcPrefix: 't' });
    await api.fn('invoices', 'approve', { id: 7 });
    expect(seen[0]?.url).toBe('https://x.test/api/invoices/7/t/approve');
    expect(seen[0]?.method).toBe('GET');
  });
  it('defaults to POST when a body is present, honours explicit method', async () => {
    const { seen, api } = mk();
    await api.fn('invoices', 'x', { body: {} });
    await api.fn('invoices', 'x', { body: {}, method: 'PUT' });
    expect(seen.map((s) => s.method)).toEqual(['POST', 'PUT']);
  });
  it("omits the prefix segment for ''", async () => {
    const { seen, api } = mk({ rpcPrefix: '' });
    await api.fn('invoices', 'create');
    expect(seen[0]?.url).toBe('https://x.test/api/invoices/create');
  });
  it("defaults the prefix to 'rpc' and encodes segments", async () => {
    const { seen, api } = mk();
    await api.fn('a b', 'c/d', { id: 'x/y' });
    expect(seen[0]?.url).toBe('https://x.test/api/a%20b/x%2Fy/rpc/c%2Fd');
  });
});

describe('rpc', () => {
  it('prefixes the path', async () => {
    const { seen, api } = mk({ rpcPrefix: 't' });
    await api.rpc('auth/whoami');
    expect(seen[0]?.url).toBe('https://x.test/api/t/auth/whoami');
  });
  it("uses just the path for ''", async () => {
    const { seen, api } = mk({ rpcPrefix: '' });
    await api.rpc('auth/whoami', { method: 'POST' });
    expect(seen[0]?.url).toBe('https://x.test/api/auth/whoami');
    expect(seen[0]?.method).toBe('POST');
  });
  it('encodes each segment', async () => {
    const { seen, api } = mk();
    await api.rpc('a b/c');
    expect(seen[0]?.url).toBe('https://x.test/api/rpc/a%20b/c');
  });
});

describe('keys', () => {
  const { api } = mk();
  it('is stable for semantically equal queries', () => {
    const a = api.keys.list('invoices', { where: { a: 1, b: 2 }, perPage: 5 });
    const b = api.keys.list('invoices', { perPage: 5, where: { b: 2, a: 1 } });
    expect(a).toEqual(b);
    expect(a.slice(0, 3)).toEqual(['sp-api', 'invoices', 'list']);
    expect(typeof a[3]).toBe('string');
  });
  it('differs for different queries', () => {
    expect(api.keys.list('invoices', { perPage: 5 })).not.toEqual(api.keys.list('invoices', { perPage: 6 }));
  });
  it('table is a prefix of list and get', () => {
    expect(api.keys.table('invoices')).toEqual(['sp-api', 'invoices']);
    expect(api.keys.list('invoices').slice(0, 2)).toEqual(api.keys.table('invoices'));
    expect(api.keys.get('invoices', 7)).toEqual(['sp-api', 'invoices', 'get', '7']);
  });
});

describe('table / config / auth', () => {
  it('sets api and name on tables', () => {
    const { api } = mk();
    const t = api.table('invoices');
    expect(t.name).toBe('invoices');
    expect(t.api).toBe(api);
  });
  it('sends no Authorization without auth', async () => {
    const { seen, api } = mk();
    await api.table('invoices').get(1);
    expect(seen[0]?.headers.has('Authorization')).toBe(false);
  });
  it('sends auth headers when configured', async () => {
    const { seen, api } = mk({ auth: { getHeaders: async () => ({ Authorization: 'Bearer z' }) } });
    await api.table('invoices').get(1);
    expect(seen[0]?.headers.get('Authorization')).toBe('Bearer z');
  });
  it('exposes config', () => {
    expect(mk().api.config.baseUrl).toBe('https://x.test/api');
  });
  it('exports a VERSION from package.json', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('aggregate', () => {
  it('sends aggregate params and returns rows + meta', async () => {
    const { seen, api } = mk({}, { success: true, data: [{ sum_total: 3, status: 'a' }], meta: { n: 1 } });
    const r = await api.table('invoices').aggregate({ sum: ['total'] }, { groupBy: ['status'], where: { x: 1 } });
    const u = new URL(seen[0]?.url ?? '');
    expect(u.searchParams.get('aggregate')).toBe('sum:total');
    expect(u.searchParams.get('group_by')).toBe('status');
    expect(r.rows).toEqual([{ sum_total: 3, status: 'a' }]);
    expect(r.meta).toEqual({ n: 1 });
  });
  it('is typed by spec and groupBy', async () => {
    const { api } = mk({}, { success: true, data: [], meta: {} });
    const r = await api.table('invoices').aggregate({ count: true, sum: ['total'] }, { groupBy: ['status'] });
    expectTypeOf(r.rows).toEqualTypeOf<{ count: number; sum_total: number; status: unknown }[]>();
  });
});
