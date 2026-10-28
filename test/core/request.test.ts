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

  it('passes the headers sent on the failed attempt to handleUnauthorized, lowercase-keyed', async () => {
    const seen: unknown[] = [];
    const auth = {
      getHeaders: async () => ({ Authorization: 'Bearer T1' }),
      handleUnauthorized: async (failed?: { headers: Record<string, string> }) => {
        seen.push(failed);
        return false;
      },
    };
    const { request } = setup([json({}, 401)], { auth, tenant: { header: 'X-Tenant', value: () => 5 } });
    await expect(request({ method: 'GET', path: 'x', headers: { 'X-Extra': 'e' } })).rejects.toBeInstanceOf(SpApiError);
    expect(seen).toHaveLength(1);
    const headers = (seen[0] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer T1');
    expect(headers['x-tenant']).toBe('5');
    expect(headers['x-extra']).toBe('e');
    expect(Object.keys(headers).every((k) => k === k.toLowerCase())).toBe(true);
  });

  it('still works with a zero-argument handleUnauthorized', async () => {
    let token = 'old';
    const auth = {
      getHeaders: async () => ({ Authorization: token }),
      handleUnauthorized: async (): Promise<boolean> => {
        token = 'new';
        return true;
      },
    };
    const { request, calls } = setup([json({}, 401), ok()], { auth });
    await expect(request({ method: 'GET', path: 'x' })).resolves.toMatchObject({ data: { id: 1 } });
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

  it.each([0, -1, Number.POSITIVE_INFINITY, 2 ** 31, Number.NaN])('timeoutMs %s means no timeout (never fires at once)', async (t) => {
    const fake = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((res, rej) => {
          const id = setTimeout(() => res(json({ success: true, data: 1 })), 30);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(id);
            rej(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const perCall = createRequester({ baseUrl: 'https://api.test', fetch: fake as unknown as typeof fetch });
    await expect(perCall({ method: 'GET', path: 'x', timeoutMs: t })).resolves.toMatchObject({ data: 1 });
    const fromConfig = createRequester({ baseUrl: 'https://api.test', fetch: fake as unknown as typeof fetch, timeoutMs: t });
    await expect(fromConfig({ method: 'GET', path: 'x' })).resolves.toMatchObject({ data: 1 });
  });

  it.each([
    ['a ReadableStream', () => new ReadableStream()],
    ['a function', () => () => 1],
    ['a bigint', () => BigInt(1)],
    ['a symbol', () => Symbol('s')],
    ['an object holding a bigint', () => ({ n: BigInt(1) })],
    ['a Map', () => new Map([['a', 1]])],
    ['a Set', () => new Set([1])],
    ['a Promise', () => Promise.resolve(1)],
  ])('a body that is %s throws unencodable_value and sends nothing', async (_label, make) => {
    const { request, fake } = setup([ok()]);
    const err = await request({ method: 'POST', path: 'x', body: make() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpApiError);
    expect(err).toMatchObject({ code: 'unencodable_value', status: 0 });
    expect(fake).not.toHaveBeenCalled();
  });

  it('still sends plain JSON, raw bodies and objects with toJSON', async () => {
    const { request, calls } = setup([ok(), ok()]);
    await request({ method: 'POST', path: 'x', body: { at: new Date(0), n: [1, null] } });
    expect(calls[0]?.init.body).toBe('{"at":"1970-01-01T00:00:00.000Z","n":[1,null]}');
    await request({ method: 'POST', path: 'x', body: 'raw' });
    expect(calls[1]?.init.body).toBe('raw');
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

  it('overrides headers case-insensitively', async () => {
    const { request, calls } = setup([ok()], { auth: { getHeaders: async () => ({ Authorization: 'a' }) } });
    await request({
      method: 'POST',
      path: 'x',
      body: { a: 1 },
      headers: { authorization: 'b', 'content-type': 'text/plain' },
    });
    expect(calls[0]?.headers.get('Authorization')).toBe('b');
    expect(calls[0]?.headers.get('Content-Type')).toBe('text/plain');
  });

  it('rejects with the reason without fetching when the signal is already aborted', async () => {
    const { request, fake } = setup([ok()]);
    const ac = new AbortController();
    const reason = new DOMException('stop', 'AbortError');
    ac.abort(reason);
    await expect(request({ method: 'GET', path: 'x', signal: ac.signal })).rejects.toBe(reason);
    expect(fake).not.toHaveBeenCalled();
  });

  it('does not retry when the caller aborts during handleUnauthorized', async () => {
    const ac = new AbortController();
    const reason = new DOMException('stop', 'AbortError');
    const { request, fake } = setup([() => json({}, 401)], {
      auth: {
        getHeaders: async () => ({}),
        handleUnauthorized: async () => {
          ac.abort(reason);
          return true;
        },
      },
    });
    await expect(request({ method: 'GET', path: 'x', signal: ac.signal })).rejects.toBe(reason);
    expect(fake).toHaveBeenCalledTimes(1);
  });
});

describe('createRequester responseType', () => {
  it("responseType 'text' returns the raw body, even when it parses as JSON or an envelope", async () => {
    const body = JSON.stringify({ success: true, data: 'x' });
    const { request } = setup([new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } })]);
    const r = await request<string>({ method: 'GET', path: 'docs/llms.txt', responseType: 'text' });
    expect(r.data).toBe(body);
    expect(r.meta).toEqual({});
  });

  it("responseType 'text' returns '' (not null) for an empty or 204 body", async () => {
    const { request } = setup([new Response('', { status: 200 }), new Response(null, { status: 204 })]);
    expect((await request<string>({ method: 'GET', path: 'a', responseType: 'text' })).data).toBe('');
    expect((await request<string>({ method: 'GET', path: 'b', responseType: 'text' })).data).toBe('');
  });

  it("responseType 'text' still throws SpApiError on a non-2xx response", async () => {
    const { request } = setup([json({ success: false, message: 'Not Found' }, 404)]);
    const e = await request({ method: 'GET', path: 'x', responseType: 'text', module: 'docs', disabledOn404: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SpApiError);
    expect(e).toMatchObject({ code: 'module_disabled', module: 'docs' });
  });

  it('the default (json) is unchanged: a non-JSON 200 body comes back as text', async () => {
    const { request } = setup([new Response('# hello', { status: 200 })]);
    expect((await request<string>({ method: 'GET', path: 'x' })).data).toBe('# hello');
  });
});

describe('createRequester 200 success:false', () => {
  const fail = (error_code: number, extra: Record<string, unknown> = {}) =>
    json({ success: false, error_code, message: 'x', ...extra });
  const expired = () => fail(10002);

  it('throws SpApiError with status 200, body errorCode and message, code unknown', async () => {
    const { request } = setup([fail(5)]);
    const e = await request({ method: 'GET', path: 'a' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SpApiError);
    expect(e).toMatchObject({ status: 200, errorCode: 5, message: 'x', code: 'unknown' });
  });

  it.each([
    [10002, 'unauthenticated'],
    [10008, 'forbidden'],
    [10009, 'not_found'],
    [10004, 'validation'],
    [10010, 'server'],
  ])('maps error_code %i to %s', async (n, code) => {
    const { request } = setup([fail(n)]);
    const e = await request({ method: 'GET', path: 'a' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 200, code, errorCode: n });
  });

  it('a 10004 keyed by the tenant header is tenant_required', async () => {
    const { request } = setup([fail(10004, { errors: { 'X-Tenant-ID': ['required'] } })], {
      tenant: { header: 'X-Tenant-ID', value: () => null },
    });
    const e = await request({ method: 'GET', path: 'a' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'tenant_required', status: 200 });
  });

  it('{success:true} is unchanged', async () => {
    const { request } = setup([ok()]);
    expect((await request({ method: 'GET', path: 'a' })).data).toEqual({ id: 1 });
  });

  it('treatSuccessFalseAsError:false returns the body as data', async () => {
    const { request } = setup([fail(5)], { treatSuccessFalseAsError: false });
    const r = await request<{ success: boolean }>({ method: 'GET', path: 'a' });
    expect(r.data).toMatchObject({ success: false, error_code: 5 });
  });

  it('array, string, null bodies and responseType text are untouched', async () => {
    const { request } = setup([
      json([{ success: false }]),
      new Response('"success"', { status: 200 }),
      new Response('null', { status: 200 }),
      fail(5),
    ]);
    expect((await request({ method: 'GET', path: 'a' })).data).toEqual([{ success: false }]);
    expect((await request({ method: 'GET', path: 'a' })).data).toBe('success');
    expect((await request({ method: 'GET', path: 'a' })).data).toBeNull();
    const t = await request<string>({ method: 'GET', path: 'a', responseType: 'text' });
    expect(JSON.parse(t.data)).toMatchObject({ success: false });
  });

  it('10002 with a hook returning true refreshes once with fresh headers and returns the result', async () => {
    let token = 'old';
    const handleUnauthorized = vi.fn(async () => {
      token = 'new';
      return true;
    });
    const { request, calls } = setup([expired(), ok()], {
      auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }), handleUnauthorized },
    });
    const r = await request({ method: 'GET', path: 'a' });
    expect(r.data).toEqual({ id: 1 });
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer old');
    expect(calls[1]?.headers.get('Authorization')).toBe('Bearer new');
  });

  it('a second 10002 throws after exactly 2 fetches', async () => {
    const handleUnauthorized = vi.fn(async () => true);
    const { request, fake } = setup([expired, expired], { auth: { getHeaders: async () => ({}), handleUnauthorized } });
    const e = await request({ method: 'GET', path: 'a' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ errorCode: 10002, status: 200 });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('10002 throws at once without auth, without a hook, or when the hook resolves false', async () => {
    for (const a of [undefined as ApiConfig['auth'], { getHeaders: async () => ({}) }, { getHeaders: async () => ({}), handleUnauthorized: async () => false }]) {
      const { request, fake } = setup([expired()], a === undefined ? {} : { auth: a });
      await expect(request({ method: 'GET', path: 'a' })).rejects.toMatchObject({ errorCode: 10002 });
      expect(fake).toHaveBeenCalledTimes(1);
    }
  });

  it('a throwing hook propagates unchanged', async () => {
    const boom = new Error('boom');
    const { request, fake } = setup([expired()], {
      auth: {
        getHeaders: async () => ({}),
        handleUnauthorized: async () => {
          throw boom;
        },
      },
    });
    await expect(request({ method: 'GET', path: 'a' })).rejects.toBe(boom);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('a 401 after a network retry still refreshes', async () => {
    const handleUnauthorized = vi.fn(async () => true);
    const { request, fake } = setup(
      [
        () => {
          throw new TypeError('down');
        },
        json({ message: 'no' }, 401),
        ok(),
      ],
      {
        auth: { getHeaders: async () => ({}), handleUnauthorized },
        retry: { maxAttempts: 2, backoffMs: 1, jitter: false },
      },
    );
    const r = await request({ method: 'GET', path: 'a' });
    expect(r.data).toEqual({ id: 1 });
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(fake).toHaveBeenCalledTimes(3);
  });

  it('a 200 10009 on a disabledOn404 call stays not_found; a real 404 is module_disabled', async () => {
    const { request } = setup([fail(10009), json({ message: 'no' }, 404)]);
    const a = await request({ method: 'GET', path: 'a', disabledOn404: true }).catch((x: unknown) => x);
    expect(a).toMatchObject({ code: 'not_found', status: 200 });
    const b = await request({ method: 'GET', path: 'a', disabledOn404: true }).catch((x: unknown) => x);
    expect(b).toMatchObject({ code: 'module_disabled', status: 404 });
  });

  it('a 3xx never maps by body nor refreshes', async () => {
    const handleUnauthorized = vi.fn(async () => true);
    const { request, fake } = setup([new Response(JSON.stringify({ success: false, error_code: 10002 }), { status: 302 })], {
      auth: { getHeaders: async () => ({}), handleUnauthorized },
    });
    await request({ method: 'GET', path: 'a' }).catch(() => undefined);
    expect(handleUnauthorized).not.toHaveBeenCalled();
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('a 401 then a 10002 refreshes only once', async () => {
    const handleUnauthorized = vi.fn(async () => true);
    const { request, fake } = setup([json({ message: 'no' }, 401), expired()], {
      auth: { getHeaders: async () => ({}), handleUnauthorized },
    });
    await expect(request({ method: 'GET', path: 'a' })).rejects.toMatchObject({ errorCode: 10002 });
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(fake).toHaveBeenCalledTimes(2);
  });
});

describe('createRequester binary responseType', () => {
  for (const rt of ['blob', 'arrayBuffer'] as const) {
    const bytes = async (d: unknown): Promise<string> =>
      new TextDecoder().decode(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : new Uint8Array(d as ArrayBuffer));

    it(`${rt}: a 10002-looking 200 body is returned untouched and no refresh runs`, async () => {
      const handleUnauthorized = vi.fn(async () => true);
      const body = '{"success":false,"error_code":10002}';
      const { request, fake } = setup([new Response(body, { status: 200 })], {
        auth: { getHeaders: async () => ({}), handleUnauthorized },
      });
      const r = await request<unknown>({ method: 'GET', path: 'x', responseType: rt });
      expect(await bytes(r.data)).toBe(body);
      expect(handleUnauthorized).not.toHaveBeenCalled();
      expect(fake).toHaveBeenCalledTimes(1);
    });

    it(`${rt}: {"success":false} bytes are returned untouched`, async () => {
      const { request } = setup([new Response('{"success":false}', { status: 200 })]);
      const r = await request<unknown>({ method: 'GET', path: 'x', responseType: rt });
      expect(await bytes(r.data)).toBe('{"success":false}');
    });

    it(`${rt}: a non-2xx still raises SpApiError`, async () => {
      const { request } = setup([json({ success: false, message: 'gone' }, 404)]);
      const e = await request({ method: 'GET', path: 'x', responseType: rt }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SpApiError);
      expect((e as SpApiError).status).toBe(404);
    });
  }
});
