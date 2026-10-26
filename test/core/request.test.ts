import { describe, expect, it, vi } from 'vitest';
import { createRequester } from '../../src/core/request';
import type { ApiConfig } from '../../src/core/request';
import { SpApiError } from '../../src/core/errors';

type Call = { url: string; init: RequestInit; headers: Headers };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(responses: Array<Response | (() => Response | Promise<Response>)>, cfg: Partial<ApiConfig> = {}) {
  const calls: Call[] = [];
  let i = 0;
  const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, headers: new Headers(init?.headers) });
    const r = responses[Math.min(i++, responses.length - 1)] as Response | (() => Response | Promise<Response>);
    return typeof r === 'function' ? r() : r;
  });
  const request = createRequester({ baseUrl: 'https://api.test/', fetch: fake as unknown as typeof fetch, ...cfg });
  return { request, calls, fake };
}

const ok = () => json({ success: true, error_code: 0, data: { id: 1 }, meta: { request_id: 'r1' } });

describe('createRequester', () => {
  it('builds the URL and unwraps the envelope', async () => {
    const { request, calls } = setup([ok()]);
    const q = new URLSearchParams({ a: '1' });
    const res = await request<{ id: number }>({ method: 'GET', path: '/items', query: q });
    expect(calls[0]?.url).toBe('https://api.test/items?a=1');
    expect(res.data).toEqual({ id: 1 });
    expect(res.meta).toEqual({ request_id: 'r1' });
    expect(res.response).toBeInstanceOf(Response);
  });

  it('serialises a Query and omits ? when empty', async () => {
    const { request, calls } = setup([ok(), ok()]);
    await request({ method: 'GET', path: 'items', query: { where: { id: 1 } } });
    expect(calls[0]?.url).toContain('items?id=eq.1');
    await request({ method: 'GET', path: 'items' });
    expect(calls[1]?.url).toBe('https://api.test/items');
  });

  it('sends a UUID X-Request-ID and merges auth headers', async () => {
    const { request, calls } = setup([ok()], { auth: { getHeaders: async () => ({ Authorization: 'Bearer t' }) } });
    await request({ method: 'GET', path: 'x' });
    expect(calls[0]?.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer t');
  });

  it('sets the tenant header only when value() is non-null', async () => {
    let v: string | number | null | undefined = null;
    const { request, calls } = setup([ok(), ok(), ok()], { tenant: { header: 'X-Tenant', value: () => v } });
    await request({ method: 'GET', path: 'x' });
    expect(calls[0]?.headers.has('X-Tenant')).toBe(false);
    v = 5;
    await request({ method: 'GET', path: 'x' });
    expect(calls[1]?.headers.get('X-Tenant')).toBe('5');
    v = undefined;
    await request({ method: 'GET', path: 'x' });
    expect(calls[2]?.headers.has('X-Tenant')).toBe(false);
  });

  it('returns a non-envelope 200 body as data', async () => {
    const { request } = setup([json({ foo: 'bar' })]);
    const res = await request({ method: 'GET', path: 'x' });
    expect(res.data).toEqual({ foo: 'bar' });
    expect(res.meta).toEqual({});
  });

  it('treats 204 and empty body as data null, meta {}', async () => {
    const { request } = setup([new Response(null, { status: 204 }), new Response('', { status: 200 })]);
    const a = await request({ method: 'DELETE', path: 'x' });
    expect(a.data).toBeNull();
    expect(a.meta).toEqual({});
    const b = await request({ method: 'GET', path: 'x' });
    expect(b.data).toBeNull();
    expect(b.meta).toEqual({});
  });

  it('JSON-encodes plain bodies with Content-Type', async () => {
    const { request, calls } = setup([ok()]);
    await request({ method: 'POST', path: 'x', body: { a: 1 } });
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/json');
  });

  it('passes FormData and Blob through with no content type', async () => {
    const { request, calls } = setup([ok(), ok()]);
    const fd = new FormData();
    fd.append('a', 'b');
    await request({ method: 'POST', path: 'x', body: fd });
    expect(calls[0]?.init.body).toBe(fd);
    expect(calls[0]?.headers.has('Content-Type')).toBe(false);
    const blob = new Blob(['hi']);
    await request({ method: 'POST', path: 'x', body: blob });
    expect(calls[1]?.init.body).toBe(blob);
    expect(calls[1]?.headers.has('Content-Type')).toBe(false);
  });

  it('retries once on 401 when handleUnauthorized resolves true, with fresh headers', async () => {
    let token = 'old';
    const handleUnauthorized = vi.fn(async () => {
      token = 'new';
      return true;
    });
    const { request, calls } = setup([json({ message: 'no' }, 401), ok()], {
      auth: { getHeaders: async () => ({ Authorization: token }), handleUnauthorized },
    });
    const res = await request({ method: 'GET', path: 'x' });
    expect(res.data).toEqual({ id: 1 });
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get('Authorization')).toBe('old');
    expect(calls[1]?.headers.get('Authorization')).toBe('new');
  });

  it('throws unauthenticated on a second 401 without looping', async () => {
    const handleUnauthorized = vi.fn(async () => true);
    const { request, calls } = setup([() => json({ message: 'no' }, 401)], {
      auth: { getHeaders: async () => ({}), handleUnauthorized },
    });
    await expect(request({ method: 'GET', path: 'x' })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(calls).toHaveLength(2);
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('throws on 401 when handleUnauthorized is false or absent', async () => {
    const a = setup([json({}, 401)], { auth: { getHeaders: async () => ({}), handleUnauthorized: async () => false } });
    await expect(a.request({ method: 'GET', path: 'x' })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(a.calls).toHaveLength(1);
    const b = setup([json({}, 401)], { auth: { getHeaders: async () => ({}) } });
    await expect(b.request({ method: 'GET', path: 'x' })).rejects.toMatchObject({ code: 'unauthenticated' });
    const c = setup([json({}, 401)]);
    await expect(c.request({ method: 'GET', path: 'x' })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('propagates a rejection from handleUnauthorized unchanged', async () => {
    const boom = new Error('refresh failed');
    const { request } = setup([json({}, 401)], {
      auth: { getHeaders: async () => ({}), handleUnauthorized: async () => { throw boom; } },
    });
    await expect(request({ method: 'GET', path: 'x' })).rejects.toBe(boom);
  });

  it('lets per-call headers override', async () => {
    const { request, calls } = setup([ok()], { auth: { getHeaders: async () => ({ Authorization: 'a' }) } });
    await request({ method: 'GET', path: 'x', headers: { Authorization: 'b' } });
    expect(calls[0]?.headers.get('Authorization')).toBe('b');
  });

  it('maps errors through errorFromResponse with module context', async () => {
    const { request } = setup([json({ message: 'gone' }, 404)]);
    await expect(request({ method: 'GET', path: 'x', module: 'm', disabledOn404: true })).rejects.toMatchObject({
      code: 'module_disabled',
      module: 'm',
    });
  });

  it('times out with code timeout', async () => {
    // never-resolving fake must honour the abort signal
    const fake = vi.fn((_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }),
    );
    const r = createRequester({ baseUrl: 'https://api.test', fetch: fake as unknown as typeof fetch });
    await expect(r({ method: 'GET', path: 'x', timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout', status: 0 });
  });

  it('maps fetch rejection to network, status 0', async () => {
    const { request } = setup([() => Promise.reject(new TypeError('boom'))]);
    const err = await request({ method: 'GET', path: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpApiError);
    expect(err).toMatchObject({ code: 'network', status: 0 });
  });

  it('rejects with the original AbortError when the caller aborts', async () => {
    const fake = vi.fn((_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal?.reason));
      }),
    );
    const r = createRequester({ baseUrl: 'https://api.test', fetch: fake as unknown as typeof fetch });
    const ac = new AbortController();
    const p = r({ method: 'GET', path: 'x', signal: ac.signal });
    const reason = new DOMException('stop', 'AbortError');
    ac.abort(reason);
    const err = await p.catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(err).not.toBeInstanceOf(SpApiError);
  });

  it('sends X-Debug and passes meta.debug through', async () => {
    const body = { success: true, error_code: 0, data: [], meta: { request_id: 'r', debug: { sql: 'x' } } };
    const { request, calls } = setup([json(body), json(body)]);
    const res = await request({ method: 'GET', path: 'x', debug: true });
    expect(calls[0]?.headers.get('X-Debug')).toBe('1');
    expect(res.meta.debug).toEqual({ sql: 'x' });
    const g = setup([json(body)], { debug: true });
    await g.request({ method: 'GET', path: 'x' });
    expect(g.calls[0]?.headers.get('X-Debug')).toBe('1');
  });

  it('adds explain=true to the query', async () => {
    const { request, calls } = setup([ok()]);
    await request({ method: 'GET', path: 'x', query: new URLSearchParams({ a: '1' }), explain: true });
    expect(calls[0]?.url).toBe('https://api.test/x?a=1&explain=true');
  });

  it('uses the injected fetch, never the global', async () => {
    const g = vi.spyOn(globalThis, 'fetch');
    const { request, fake } = setup([ok()]);
    await request({ method: 'GET', path: 'x' });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(g).not.toHaveBeenCalled();
    g.mockRestore();
  });
});
