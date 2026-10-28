import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/core/create-api';
import type { ApiConfig } from '../../src/core/request';
import { createLogger } from '../../src/logging';
import type { LogEntry, LogMode, RequestLogger } from '../../src/logging';
import { sanitiseRequestId } from '../../src/logging/internal';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Rig {
  api: ReturnType<typeof createApi>;
  entries: LogEntry[];
  calls: { url: string; init: RequestInit }[];
}

function rig(
  responses: (() => Response | Promise<Response>)[],
  opts: Partial<ApiConfig> & { logMode?: LogMode } = {},
  sink?: (e: LogEntry) => unknown,
): Rig {
  const { logMode, ...cfg } = opts;
  const entries: LogEntry[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const make = responses[Math.min(i++, responses.length - 1)];
    return make();
  };
  const api = createApi({
    baseUrl: 'https://api.example.com/api',
    fetch,
    logger: createLogger({
      mode: logMode,
      sink: (e) => {
        entries.push(e);
        return sink?.(e) as void;
      },
    }),
    ...cfg,
  });
  return { api, entries, calls };
}

function headerNames(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

const ok = (): Response => json({ success: true, data: [{ id: 1 }], meta: {} });

describe('request logging', () => {
  it('no logger configured produces no entry', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const calls: RequestInit[] = [];
    const api = createApi({
      baseUrl: 'https://api.example.com/api',
      fetch: async (_u, init) => {
        calls.push(init ?? {});
        return ok();
      },
    });
    const r = await api.request({ method: 'GET', path: 'invoices', log: true });
    expect(r.data).toEqual([{ id: 1 }]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(Object.keys(headerNames(calls[0]?.headers)).sort()).toEqual(['accept', 'x-request-id']);
  });

  it('perRequest mode logs only opted-in requests', async () => {
    const { api, entries } = rig([ok]);
    await api.table('invoices').list();
    expect(entries).toHaveLength(0);
    await api.table('invoices').list({}, { log: false });
    expect(entries).toHaveLength(0);
    await api.table('invoices').list({}, { log: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ method: 'GET', status: 200, attempt: 1, code: null, errorCode: null });
    expect(entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(entries[0]?.url).toContain('https://api.example.com/api/invoices');
    expect(entries[0]).not.toHaveProperty('requestHeaders');
    expect(entries[0]).not.toHaveProperty('responseBody');
  });

  it('logMode off never logs', async () => {
    const { api, entries } = rig([ok], { logMode: 'off' });
    await api.table('invoices').list({}, { log: true });
    expect(entries).toHaveLength(0);
  });

  it('all mode logs every request', async () => {
    const { api, entries } = rig([ok, ok, ok], { logMode: 'all' });
    await api.table('invoices').list();
    await api.rpc('ping');
    await api.fn('invoices', 'send', { id: 3 });
    expect(entries).toHaveLength(3);
    await api.table('invoices').list({}, { log: false });
    expect(entries).toHaveLength(3);
  });

  it('each attempt is logged with an increasing attempt number', async () => {
    // 401 refresh retry
    let refreshed = false;
    const a = rig(
      [() => json({ message: 'Unauthenticated.' }, 401), ok],
      {
        auth: {
          getHeaders: async () => ({ Authorization: refreshed ? 'Bearer new' : 'Bearer old' }),
          handleUnauthorized: async () => {
            refreshed = true;
            return true;
          },
        },
      },
    );
    await a.api.table('invoices').list({}, { log: true });
    expect(a.entries.map((e) => [e.attempt, e.status, e.code])).toEqual([
      [1, 401, 'unauthenticated'],
      [2, 200, null],
    ]);

    // retry config: 503 then 200 (a 200 { success: false, error_code } retry does not exist in this package yet)
    const b = rig([() => json({ message: 'down' }, 503), () => json({ message: 'down' }, 503), ok], {
      logMode: 'all',
      retry: { maxAttempts: 3, backoffMs: 1, jitter: false },
    });
    await b.api.table('invoices').list();
    expect(b.entries.map((e) => [e.attempt, e.status])).toEqual([
      [1, 503],
      [2, 503],
      [3, 200],
    ]);
    expect(b.entries[0]?.code).toBe('server');
  });

  it('error entry carries code, errorCode and requestId', async () => {
    const { api, entries } = rig(
      [() => json({ message: 'Nope', error_code: 10002, errors: { name: ['bad'] }, meta: { request_id: 'req-9' } }, 422)],
      { logMode: 'all' },
    );
    await expect(api.table('invoices').create({ name: '' })).rejects.toMatchObject({ code: 'validation' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 422, code: 'validation', errorCode: 10002, requestId: 'req-9', attempt: 1 });
    expect(entries[0]).not.toHaveProperty('responseBody');
    expect(JSON.stringify(entries[0])).not.toContain('Nope');
  });

  it('error entry takes the request id from the response header', async () => {
    const { api, entries } = rig([() => json({ message: 'x' }, 500, { 'X-Request-ID': 'hdr-1' })], { logMode: 'all' });
    await expect(api.table('invoices').list()).rejects.toBeTruthy();
    expect(entries[0]?.requestId).toBe('hdr-1');
  });

  it('a transport failure is logged with status null and the error code', async () => {
    const { api, entries } = rig(
      [
        () => {
          throw new TypeError('connect failed');
        },
      ],
      { logMode: 'all' },
    );
    await expect(api.table('invoices').list()).rejects.toMatchObject({ code: 'network' });
    expect(entries[0]).toMatchObject({ status: null, code: 'network', errorCode: null, requestId: null, attempt: 1 });
  });

  it('an aborted request is logged with status null and code aborted', async () => {
    const entries: LogEntry[] = [];
    const ac = new AbortController();
    let started!: () => void;
    const fetchStarted = new Promise<void>((r) => (started = r));
    const api = createApi({
      baseUrl: 'https://api.example.com/api',
      logger: createLogger({ mode: 'all', sink: (e) => void entries.push(e) }),
      fetch: (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(init.signal?.reason));
          started();
        }),
    });
    const p = api.table('invoices').list({}, { signal: ac.signal });
    await fetchStarted;
    ac.abort();
    await expect(p).rejects.toBeTruthy();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: null, code: 'aborted', attempt: 1 });
  });

  it('sensitive headers are redacted', async () => {
    const { api, entries } = rig(
      [() => json({ success: true, data: [] }, 200, { 'Set-Cookie': 'sid=SECRETCOOKIE', 'X-Trace': 'abc' })],
      {
        auth: { getHeaders: async () => ({ Authorization: 'Bearer SECRETTOKEN', Cookie: 'sid=SECRETCOOKIE' }) },
        tenant: { header: 'X-Company-ID', value: () => 'TENANT777' },
      },
    );
    await api.table('invoices').list({}, { log: { headers: true }, headers: { 'X-CSRF-Token': 'SECRETCSRF', 'X-Note': 'hello' } });
    const e = entries[0];
    expect(e?.requestHeaders?.authorization).toBe('<redacted>');
    expect(e?.requestHeaders?.cookie).toBe('<redacted>');
    expect(e?.requestHeaders?.['x-csrf-token']).toBe('<redacted>');
    expect(e?.requestHeaders?.['x-company-id']).toBe('<redacted>');
    expect(e?.requestHeaders?.['x-note']).toBe('hello');
    expect(e?.responseHeaders?.['set-cookie']).toBe('<redacted>');
    expect(e?.responseHeaders?.['x-trace']).toBe('abc');
    const all = JSON.stringify(e);
    for (const s of ['SECRETTOKEN', 'SECRETCOOKIE', 'SECRETCSRF', 'TENANT777']) expect(all).not.toContain(s);
  });

  it('sensitive body and query keys are redacted at any depth', async () => {
    const reqBody = {
      email: 'a@example.com',
      password: 'PW1',
      profile: { api_key: 'KEY1', lines: [{ otp: 'OTP1', ok: 1 }, { nested: { refresh_token: 'RT1' } }] },
    };
    const resBody = { success: true, data: { access_token: 'AT1', device_token: 'DT1', items: [{ secret: 'SEC1', id: 1 }] }, meta: {} };
    const { api, entries } = rig([() => json(resBody)], { logMode: 'all' });
    await api.request({
      method: 'POST',
      path: 'login',
      query: new URLSearchParams({ token: 'QT1', code: 'QC1', per_page: '5' }),
      body: reqBody,
      log: { bodies: true },
    });
    const e = entries[0];
    const all = JSON.stringify(e);
    for (const s of ['PW1', 'KEY1', 'OTP1', 'RT1', 'AT1', 'DT1', 'SEC1', 'QT1', 'QC1']) expect(all).not.toContain(s);
    expect(e?.url).toContain('per_page=5');
    expect(e?.url).toContain('token=<redacted>');
    // the request body was sent as text, so the entry holds the redacted, re-serialised text
    expect(JSON.parse(e?.requestBody as string)).toMatchObject({ email: 'a@example.com', password: '<redacted>' });
    expect(e?.responseBody).toMatchObject({ success: true, data: { access_token: '<redacted>', items: [{ secret: '<redacted>', id: 1 }] } });
  });

  it('bodies are truncated and binary bodies are not printed', async () => {
    const big = 'z'.repeat(5000);
    const a = rig([() => json({ success: true, data: { text: big } })], { logMode: 'all' });
    await a.api.request({ method: 'POST', path: 'x', body: { text: big }, log: { bodies: true } });
    for (const b of [a.entries[0]?.requestBody, a.entries[0]?.responseBody]) {
      expect(typeof b).toBe('string');
      expect((b as string).endsWith('…[truncated]')).toBe(true);
      expect((b as string).length).toBe(2048 + '…[truncated]'.length);
    }

    const bin = rig(
      [() => new Response(new Uint8Array(10), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '10' } })],
      { logMode: 'all' },
    );
    await bin.api.request({ method: 'POST', path: 'x', body: new Uint8Array(33), log: { bodies: true } });
    expect(bin.entries[0]?.requestBody).toBe('<33 bytes>');
    expect(bin.entries[0]?.responseBody).toBe('<10 bytes>');

    const form = new FormData();
    form.append('file', new Blob(['hello']), 'a.txt');
    const multi = rig([ok], { logMode: 'all' });
    await multi.api.request({ method: 'POST', path: 'x', body: form, log: { bodies: true } });
    expect(multi.entries[0]?.requestBody).toBe('<multipart>');

    const txt = rig([() => new Response('plain TEXT password=abc', { status: 200 })], { logMode: 'all' });
    await txt.api.request({ method: 'GET', path: 'x', responseType: 'text', log: { bodies: true } });
    expect(txt.entries[0]).not.toHaveProperty('responseBody');
  });

  it('never reads the response body a second time', async () => {
    let reads = 0;
    const res = json({ success: true, data: { a: 1 } });
    const origText = res.text.bind(res);
    res.text = () => {
      reads++;
      return origText();
    };
    res.clone = () => {
      throw new Error('clone must not be used');
    };
    const { api, entries } = rig([() => res], { logMode: 'all' });
    await api.request({ method: 'GET', path: 'x', log: { bodies: true, headers: true } });
    expect(reads).toBe(1);
    expect(entries[0]?.responseBody).toMatchObject({ data: { a: 1 } });
  });

  it('a throwing sink does not change the request result', async () => {
    const { api, entries } = rig([ok, () => json({ message: 'bad' }, 422)], { logMode: 'all' }, () => {
      throw new Error('sink exploded');
    });
    const r = await api.table('invoices').list();
    expect(r.data).toEqual([{ id: 1 }]);
    await expect(api.table('invoices').list()).rejects.toMatchObject({ status: 422, code: 'validation' });
    expect(entries).toHaveLength(2);
  });

  it('a rejected sink promise does not change the request result', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown): void => void unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { api } = rig([ok, () => json({ message: 'bad' }, 500)], { logMode: 'all' }, () => Promise.reject(new Error('sink rejected')));
      const r = await api.table('invoices').list();
      expect(r.data).toEqual([{ id: 1 }]);
      await expect(api.table('invoices').list()).rejects.toMatchObject({ status: 500 });
      // unhandled rejections surface after the microtask queue drains and a macrotask turn
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a sink with a throwing then does not change the result', async () => {
    const evil = {
      get then(): never {
        throw new Error('then getter');
      },
    };
    const { api } = rig([ok], { logMode: 'all' }, () => evil);
    await expect(api.table('invoices').list()).resolves.toBeTruthy();
  });

  it('the per-request log option is not sent as a header', async () => {
    const { api, calls } = rig([ok, ok, ok], { logMode: 'all' });
    await api.table('invoices').list({}, { log: true });
    await api.rpc('ping', { log: { bodies: true, headers: true } });
    await api.fn('invoices', 'send', { id: 1, log: true });
    for (const c of calls) {
      expect(Object.keys(headerNames(c.init.headers)).some((n) => n.includes('log'))).toBe(false);
      expect(c.url).not.toContain('log');
    }
  });

  it('logs one entry per attempt without changing the request', async () => {
    const { api, calls, entries } = rig([ok], { logMode: 'all' });
    await api.table('invoices').get(7, { log: true });
    expect(calls).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toBe('https://api.example.com/api/invoices/7');
  });
});

describe('a hand-written logger that throws', () => {
  const boom: RequestLogger = {
    start: () => ({
      finish: () => {
        throw new Error('finish boom');
      },
    }),
  };

  it('in start leaves the request unchanged', async () => {
    const logger: RequestLogger = {
      start: () => {
        throw new Error('start boom');
      },
    };
    const { api, calls } = rig([ok], { logger });
    await expect(api.table('invoices').list()).resolves.toMatchObject({ data: [{ id: 1 }] });
    expect(calls).toHaveLength(1);
  });

  it('in finish on the success path returns the result', async () => {
    const { api, calls } = rig([() => json({ success: true, data: { id: 9 } }, 201)], { logger: boom, retry: { maxAttempts: 2, backoffMs: 1, jitter: false } });
    // a POST that succeeds is neither retried nor sent twice
    await expect(api.request({ method: 'POST', path: 'invoices', body: { ref_number: 'INV-1' }, retry: true })).resolves.toMatchObject({ data: { id: 9 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('in finish on the error path rethrows the original error', async () => {
    // a failing status: the configured retry still happens, then the original error is thrown
    const a = rig([() => json({ message: 'down' }, 503)], { logger: boom, retry: { maxAttempts: 1, backoffMs: 1, jitter: false } });
    await expect(a.api.table('invoices').list()).rejects.toMatchObject({ status: 503, code: 'server' });
    expect(a.calls).toHaveLength(2);

    // a network failure: the configured retry still happens and its success is returned
    const b = rig(
      [
        () => {
          throw new TypeError('fetch failed');
        },
        ok,
      ],
      { logger: boom, retry: { maxAttempts: 1, backoffMs: 1, jitter: false } },
    );
    await expect(b.api.table('invoices').list()).resolves.toMatchObject({ data: [{ id: 1 }] });
    expect(b.calls).toHaveLength(2);

    // without retry the caller gets the original transport error, not the logger's
    const c = rig(
      [
        () => {
          throw new TypeError('fetch failed');
        },
      ],
      { logger: boom },
    );
    await expect(c.api.table('invoices').list()).rejects.toMatchObject({ code: 'network' });

    // a 401 refresh retry still happens
    let refreshed = false;
    const d = rig([() => json({ message: 'Unauthenticated.' }, 401), ok], {
      logger: boom,
      auth: {
        getHeaders: async () => ({ Authorization: refreshed ? 'Bearer new' : 'Bearer old' }),
        handleUnauthorized: async () => {
          refreshed = true;
          return true;
        },
      },
    });
    await expect(d.api.table('invoices').list()).resolves.toMatchObject({ data: [{ id: 1 }] });
    expect(d.calls).toHaveLength(2);
  });
});

describe('logger options', () => {
  it('an unknown mode behaves as perRequest', async () => {
    const { api, entries } = rig([ok], { logMode: 'Al' as LogMode });
    await api.table('invoices').list();
    expect(entries).toHaveLength(0);
    await api.table('invoices').list({}, { log: true });
    expect(entries).toHaveLength(1);
  });
});

describe('request id sanitising', () => {
  it('strips control characters, line breaks, ANSI escapes and U+2028/U+2029', () => {
    expect(sanitiseRequestId('a\nb\rc\u001b[31md\u2028e\u2029f\u007fg\u0085h\u0000i')).toBe('abc[31mdefghi');
  });

  it('caps at 128 characters', () => {
    expect(sanitiseRequestId('x'.repeat(10000))).toBe('x'.repeat(128));
  });

  it('never splits a surrogate pair at the cut', () => {
    const id = 'x'.repeat(127) + '\u{1F600}' + 'tail';
    const out = sanitiseRequestId(id) as string;
    expect(out).toBe('x'.repeat(127) + '\u{1F600}');
    expect([...out]).toHaveLength(128);
    const out2 = sanitiseRequestId('\u{1F600}'.repeat(200)) as string;
    expect([...out2]).toHaveLength(128);
    expect(out2).toBe('\u{1F600}'.repeat(128));
  });

  it('is null when empty, not a string or all control characters', () => {
    expect(sanitiseRequestId('')).toBeNull();
    expect(sanitiseRequestId('\n ')).toBeNull();
    expect(sanitiseRequestId(42)).toBeNull();
    expect(sanitiseRequestId(null)).toBeNull();
  });

  it('is applied to the request id of an entry', async () => {
    const hostile = 'id-1\n[ERROR] forged\u001b[0m ' + 'y'.repeat(500);
    const { api, entries } = rig([() => json({ message: 'x', meta: { request_id: hostile } }, 500)], { logMode: 'all' });
    await expect(api.table('invoices').list()).rejects.toBeTruthy();
    const id = entries[0]?.requestId as string;
    for (const bad of ['\n', '\r', '\u001b', '\u2028', '\u2029']) expect(id.includes(bad)).toBe(false);
    expect([...id].length).toBeLessThanOrEqual(128);
    expect(id.startsWith('id-1[ERROR] forged')).toBe(true);
  });
});

describe('request logging, hardening', () => {
  it('redacts secret-looking headers and URL-valued response headers in an entry', async () => {
    const { api, entries } = rig(
      [() => json({ success: true, data: [] }, 200, { Location: 'https://api.example.com/next?token=LOCTOKEN&a=1', 'X-Session-Id': 'SESS1' })],
      { logMode: 'all', auth: { getHeaders: async () => ({ 'X-API-Key': 'APIKEY1', 'Proxy-Authorization': 'PROXY1', 'X-Auth-Token': 'AT1' }) } },
    );
    await api.table('invoices').list({}, { log: { headers: true }, headers: { 'X-XSRF-Token': 'XS1' } });
    const all = JSON.stringify(entries[0]);
    for (const s of ['LOCTOKEN', 'SESS1', 'APIKEY1', 'PROXY1', 'AT1', 'XS1']) expect(all).not.toContain(s);
    expect(entries[0]?.responseHeaders?.location).toBe('https://api.example.com/next?token=<redacted>&a=1');
  });

  it('cursorPagination forwards the log option to every list call', async () => {
    const { api, entries, calls } = rig([() => json({ success: true, data: [{ id: 1 }], meta: { next_cursor: 'n1', prev_cursor: 'p1' } })], { logMode: 'perRequest' });
    const cp = api.table('invoices').cursorPagination({ perPage: 1, log: true });
    const first = await cp.firstPage();
    await cp.lastPage();
    await cp.nextPage(first);
    await cp.prevPage(first);
    expect(entries).toHaveLength(4);
    for (const c of calls) expect(c.url).not.toContain('log');
    const quiet = api.table('invoices').cursorPagination({ perPage: 1 });
    await quiet.firstPage();
    expect(entries).toHaveLength(4);
  });
});
