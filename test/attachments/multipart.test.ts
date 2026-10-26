// Direct and multipart upload (Task 27). Scripted fake fetch; runs in both vitest projects (no node: imports, no Buffer).
import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import type { ApiConfig } from '../../src';
import { MIN_PART_SIZE, attachments } from '../../src/attachments';
import type { AttachmentsOptions, MultipartState } from '../../src/attachments';

const MiB = 1024 * 1024;
const PART = 5 * MiB;
const SIG = 'SIG-SECRET';
const TOKEN = 'TOKEN-SECRET-abc123';
const KEY = 'attachments/private/k.bin';

interface Call {
  url: URL;
  fn: string;
  method: string;
  body: Record<string, unknown> | undefined;
  rawBody: unknown;
  headers: Headers;
  signal: AbortSignal | undefined;
  part: number;
}

type Handler = (c: Call) => Response | Promise<Response>;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ success: true, data, meta: {} }), { status, headers: { 'Content-Type': 'application/json' } });

const fail = (status: number, message = 'nope'): Response =>
  new Response(JSON.stringify({ success: false, message }), { status, headers: { 'Content-Type': 'application/json' } });

const etag = (n: number): string => `"etag-${n}"`;

const defaults: Record<string, Handler> = {
  'create-multipart-upload': () =>
    json({ key: KEY, upload_id: 'UP-1', disk: 's3', part_size: 104857600, upload_token: TOKEN, expires_at: 1900000000 }),
  'sign-multipart-part': (c) => {
    const n = Number(c.body?.part_number);
    return json({
      url: `https://s3.test/bucket/${KEY}?partNumber=${n}&uploadId=UP-1&X-Amz-Signature=${SIG}-${n}`,
      headers: { Host: ['s3.test'] },
      part_number: n,
      expires_at: 1900000100,
    });
  },
  'complete-multipart-upload': () => json({ id: 42, filename: 'big.bin' }),
  'abort-multipart-upload': () => json(null),
  'create-upload-url': () =>
    json({
      key: KEY,
      upload_url: `https://s3.test/bucket/${KEY}?X-Amz-Signature=${SIG}-direct`,
      headers: { Host: ['s3.test'], 'Content-Type': ['image/png'], 'x-amz-acl': ['private'] },
      method: 'PUT',
      disk: 's3',
      upload_token: TOKEN,
      expires_at: 1900000000,
    }),
  'complete-upload': () => json({ id: 7, filename: 'a.png' }),
  upload: () => json({ id: 1 }),
};

const putOk = (c: Call): Response => new Response(null, { status: 200, headers: { ETag: etag(c.part) } });

function harness(o: { api?: Record<string, Handler>; put?: Handler; cfg?: Partial<ApiConfig>; mod?: AttachmentsOptions } = {}) {
  const calls: Call[] = [];
  const handlers = { ...defaults, ...o.api };
  const put = o.put ?? putOk;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const raw = init?.body;
    const external = url.host === 's3.test';
    const call: Call = {
      url,
      fn: external ? 'PUT' : url.pathname.split('/').pop()!,
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      rawBody: raw,
      headers: new Headers(init?.headers),
      signal: init?.signal ?? undefined,
      part: Number(url.searchParams.get('partNumber') ?? 0),
    };
    calls.push(call);
    const h = external ? put : handlers[call.fn];
    if (h === undefined) throw new Error(`no handler for ${call.fn}`);
    const signal = init?.signal;
    if (signal?.aborted === true) throw signal.reason;
    return await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      Promise.resolve(h(call)).then(resolve, reject);
    });
  }) as typeof fetch;
  const api = createApi({
    baseUrl: 'https://host.test/api/',
    fetch: fetchFn,
    auth: { getHeaders: async () => ({ Authorization: 'Bearer user-jwt' }) },
    tenant: { header: 'X-Tenant', value: () => 5 },
    ...o.cfg,
  });
  return { calls, api, att: attachments(api, o.mod) };
}

const rejection = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (x: unknown) => x,
  );

const spError = async (p: Promise<unknown>): Promise<SpApiError> => {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(SpApiError);
  return e as SpApiError;
};

const size = (raw: unknown): number => {
  if (raw instanceof Blob) return raw.size;
  if (raw instanceof Uint8Array) return raw.byteLength;
  throw new Error(`unexpected body ${String(raw)}`);
};

const bytes = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(n);

const last = <T>(a: T[]): T => a[a.length - 1]!;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Walks message, cause chain and every enumerable field; returns all strings found. */
function deepStrings(v: unknown, seen = new Set<unknown>()): string[] {
  if (typeof v === 'string') return [v];
  if (v === null || typeof v !== 'object' || seen.has(v)) return [];
  seen.add(v);
  const out: string[] = [];
  if (v instanceof Error) out.push(v.message, String(v.stack ?? ''), ...deepStrings((v as { cause?: unknown }).cause, seen));
  if (v instanceof Response) out.push(v.url);
  for (const k of Object.keys(v)) out.push(...deepStrings((v as Record<string, unknown>)[k], seen));
  return out;
}

const assertNoSecrets = (e: unknown): void => {
  for (const s of deepStrings(e)) {
    expect(s).not.toContain(SIG);
    expect(s).not.toContain(TOKEN);
  }
};

describe('attachments.uploadMultipart flow', () => {
  it('create -> sign per part -> PUT -> complete with ordered parts (3-part Blob)', async () => {
    const { calls, att } = harness();
    const blob = new Blob([bytes(12 * MiB)], { type: 'application/octet-stream' });
    const r = await att.uploadMultipart(blob, { partSize: PART, name: 'big.bin', concurrency: 1 });
    expect(r.id).toBe(42);
    expect(calls.map((c) => c.fn)).toEqual([
      'create-multipart-upload',
      'sign-multipart-part',
      'PUT',
      'sign-multipart-part',
      'PUT',
      'sign-multipart-part',
      'PUT',
      'complete-multipart-upload',
    ]);
    const create = calls[0]!;
    expect(create.method).toBe('POST');
    expect(create.url.pathname).toBe('/api/sp_attachments/rpc/create-multipart-upload');
    expect(create.body).toEqual({ filename: 'big.bin', content_type: 'application/octet-stream', visibility: 'private' });
    const signs = calls.filter((c) => c.fn === 'sign-multipart-part');
    expect(signs.map((c) => c.body)).toEqual([1, 2, 3].map((n) => ({
      key: KEY,
      upload_id: 'UP-1',
      upload_token: TOKEN,
      expires_at: 1900000000,
      part_number: n,
      visibility: 'private',
    })));
    const puts = calls.filter((c) => c.fn === 'PUT');
    expect(puts.map((c) => c.method)).toEqual(['PUT', 'PUT', 'PUT']);
    expect(puts.map((c) => c.part)).toEqual([1, 2, 3]);
    expect(puts.map((c) => size(c.rawBody))).toEqual([PART, PART, 2 * MiB]);
    const complete = last(calls);
    expect(complete.body).toEqual({
      key: KEY,
      upload_id: 'UP-1',
      upload_token: TOKEN,
      expires_at: 1900000000,
      parts: [1, 2, 3].map((n) => ({ part_number: n, etag: etag(n) })),
      filename: 'big.bin',
      visibility: 'private',
    });
  });

  it('default partSize is 8 MiB: 12 MiB Uint8Array -> 8 + 4 MiB parts', async () => {
    const { calls, att } = harness();
    await att.uploadMultipart(bytes(12 * MiB));
    expect(calls.filter((c) => c.fn === 'PUT').map((c) => size(c.rawBody))).toEqual([8 * MiB, 4 * MiB]);
    expect(calls[0]!.body?.filename).toBe('file');
  });

  it('accepts an ArrayBuffer source', async () => {
    const { calls, att } = harness();
    await att.uploadMultipart(new ArrayBuffer(6 * MiB), { partSize: PART });
    expect(calls.filter((c) => c.fn === 'PUT').map((c) => size(c.rawBody))).toEqual([PART, MiB]);
  });

  it('PUTs to the signed URL without auth or tenant headers, applying backend headers except Host', async () => {
    const { calls, att } = harness({
      api: {
        'sign-multipart-part': (c) =>
          json({
            url: `https://s3.test/b?partNumber=${String(c.body?.part_number)}&X-Amz-Signature=${SIG}`,
            headers: { Host: ['s3.test'], 'x-amz-checksum': ['abc', 'def'] },
          }),
      },
    });
    await att.uploadMultipart(bytes(PART), { partSize: PART });
    const put = calls.find((c) => c.fn === 'PUT')!;
    expect(put.headers.has('Authorization')).toBe(false);
    expect(put.headers.has('X-Tenant')).toBe(false);
    expect(put.headers.has('X-Request-ID')).toBe(false);
    expect(put.headers.has('Host')).toBe(false);
    expect(put.headers.get('x-amz-checksum')).toBe('abc, def');
    // backend calls keep auth
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer user-jwt');
  });

  it('sends visibility identically on every call (create, sign, complete)', async () => {
    const { calls, att } = harness();
    await att.uploadMultipart(bytes(11 * MiB), { partSize: PART, visibility: 'public', folderId: 3, recordType: 'products', recordId: 9, collection: 'g' });
    const api = calls.filter((c) => c.fn !== 'PUT');
    expect(api.length).toBe(5);
    for (const c of api) expect(c.body?.visibility).toBe('public');
    expect(calls[0]!.body?.folder_id).toBe('3');
    const complete = last(api);
    expect(complete.body).toMatchObject({ folder_id: '3', record_type: 'products', record_id: '9', collection_name: 'g', visibility: 'public' });
  });

  it('sends visibility identically on abort too', async () => {
    const { calls, att } = harness({ put: () => new Response('boom', { status: 500 }) });
    await rejection(att.uploadMultipart(bytes(PART), { partSize: PART, visibility: 'temp_public' }));
    const api = calls.filter((c) => c.fn !== 'PUT');
    expect(api.map((c) => c.fn)).toEqual(['create-multipart-upload', 'sign-multipart-part', 'abort-multipart-upload']);
    for (const c of api) expect(c.body?.visibility).toBe('temp_public');
  });

  it('concurrency 2 with 4 parts: at most 2 PUTs in flight, parts signed lazily', async () => {
    const gates = new Map<number, ReturnType<typeof deferred<void>>>();
    for (let n = 1; n <= 4; n++) gates.set(n, deferred<void>());
    let inFlight = 0;
    let max = 0;
    const { calls, att } = harness({
      put: async (c) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await gates.get(c.part)!.promise;
        inFlight--;
        return putOk(c);
      },
    });
    const p = att.uploadMultipart(new Blob([bytes(4 * PART)]), { partSize: PART, concurrency: 2 });
    await tick();
    expect(inFlight).toBe(2);
    // Only the two parts in flight are signed so far.
    expect(calls.filter((c) => c.fn === 'sign-multipart-part').map((c) => c.body?.part_number)).toEqual([1, 2]);
    gates.get(1)!.resolve();
    await tick();
    expect(calls.filter((c) => c.fn === 'sign-multipart-part').map((c) => c.body?.part_number)).toEqual([1, 2, 3]);
    expect(inFlight).toBe(2);
    gates.get(2)!.resolve();
    gates.get(3)!.resolve();
    gates.get(4)!.resolve();
    await p;
    expect(max).toBe(2);
    // Each part is signed only after the previous slot freed up: sign #3 comes after PUT #1 started.
    const order = calls.map((c) => (c.fn === 'PUT' ? `put${c.part}` : c.fn === 'sign-multipart-part' ? `sign${String(c.body?.part_number)}` : c.fn));
    expect(order.indexOf('sign3')).toBeGreaterThan(order.indexOf('put1'));
    expect(order.indexOf('sign4')).toBeGreaterThan(order.indexOf('put2'));
    const complete = last(calls);
    expect((complete.body?.parts as Array<{ part_number: number }>).map((x) => x.part_number)).toEqual([1, 2, 3, 4]);
  });

  it('completes with parts in number order even when they finish out of order', async () => {
    const g1 = deferred<void>();
    const { calls, att } = harness({
      put: async (c) => {
        if (c.part === 1) await g1.promise;
        return putOk(c);
      },
    });
    const p = att.uploadMultipart(bytes(3 * PART), { partSize: PART, concurrency: 3 });
    await tick();
    g1.resolve();
    await p;
    expect(last(calls).body?.parts).toEqual([1, 2, 3].map((n) => ({ part_number: n, etag: etag(n) })));
  });
});

describe('attachments.uploadMultipart failures', () => {
  it('a failing part triggers abort-multipart-upload once and rethrows the original error', async () => {
    const { calls, att } = harness({ put: (c) => (c.part === 2 ? new Response('boom', { status: 500 }) : putOk(c)) });
    const e = await spError(att.uploadMultipart(bytes(3 * PART), { partSize: PART, concurrency: 1 }));
    expect(e.status).toBe(500);
    expect(e.code).toBe('server');
    expect(e.module).toBe('attachments.direct_upload');
    const aborts = calls.filter((c) => c.fn === 'abort-multipart-upload');
    expect(aborts.length).toBe(1);
    expect(aborts[0]!.body).toEqual({ key: KEY, upload_id: 'UP-1', upload_token: TOKEN, expires_at: 1900000000, visibility: 'private' });
    expect(calls.some((c) => c.fn === 'complete-multipart-upload')).toBe(false);
    assertNoSecrets(e);
  });

  it('abort failure does not mask the original error', async () => {
    const { calls, att } = harness({
      api: { 'sign-multipart-part': () => fail(422, 'Invalid or expired upload token'), 'abort-multipart-upload': () => fail(500, 'abort broke') },
    });
    const e = await spError(att.uploadMultipart(bytes(PART), { partSize: PART }));
    expect(e.status).toBe(422);
    expect(e.message).toBe('Invalid or expired upload token');
    expect(calls.filter((c) => c.fn === 'abort-multipart-upload').length).toBe(1);
  });

  it('abort transport failure does not mask the original error', async () => {
    const { att } = harness({
      put: () => new Response('x', { status: 403 }),
      api: {
        'abort-multipart-upload': () => {
          throw new TypeError('socket hang up');
        },
      },
    });
    const e = await spError(att.uploadMultipart(bytes(PART), { partSize: PART }));
    expect(e.status).toBe(403);
    expect(e.code).toBe('unknown');
  });

  it('a failing complete call is rethrown after abort', async () => {
    const { calls, att } = harness({ api: { 'complete-multipart-upload': () => fail(422, 'bad parts') } });
    const e = await spError(att.uploadMultipart(bytes(PART), { partSize: PART }));
    expect(e.message).toBe('bad parts');
    expect(last(calls).fn).toBe('abort-multipart-upload');
  });

  it('a failure on create makes no abort call (nothing to abort)', async () => {
    const { calls, att } = harness({ api: { 'create-multipart-upload': () => fail(422, 'Multipart upload is not supported for this disk') } });
    const e = await spError(att.uploadMultipart(bytes(PART), { partSize: PART }));
    expect(e.code).toBe('validation');
    expect(calls.map((c) => c.fn)).toEqual(['create-multipart-upload']);
  });

  it('404 on create-multipart-upload is module_disabled with module attachments.direct_upload', async () => {
    const { att } = harness({ api: { 'create-multipart-upload': () => fail(404, 'Not found') } });
    const e = await spError(att.uploadMultipart(bytes(PART), { partSize: PART }));
    expect(e.code).toBe('module_disabled');
    expect(e.module).toBe('attachments.direct_upload');
  });

  it('missing ETag header on a part PUT -> typed error mentioning CORS ExposeHeaders: ETag', async () => {
    const { calls, att } = harness({ put: () => new Response(null, { status: 200 }) });
    const e = await spError(att.uploadMultipart(bytes(PART), { partSize: PART }));
    expect(e.code).toBe('unknown');
    expect(e.message).toContain('CORS');
    expect(e.message).toContain('ExposeHeaders: ETag');
    expect(calls.filter((c) => c.fn === 'abort-multipart-upload').length).toBe(1);
    assertNoSecrets(e);
  });

  it('a network failure on the PUT is a typed network error without the signed URL', async () => {
    const { att } = harness({
      put: (c) => {
        throw new TypeError(`fetch failed for ${c.url.toString()}`);
      },
    });
    const e = await spError(att.uploadMultipart(bytes(PART), { partSize: PART }));
    expect(e.code).toBe('network');
    assertNoSecrets(e);
  });

  it('aborting signal: in-flight PUTs aborted, abort-multipart called, rejects with the reason', async () => {
    const ctl = new AbortController();
    const { calls, att } = harness({ put: () => new Promise<Response>(() => undefined) });
    const p = att.uploadMultipart(bytes(3 * PART), { partSize: PART, concurrency: 2, signal: ctl.signal });
    await tick();
    const puts = calls.filter((c) => c.fn === 'PUT');
    expect(puts.length).toBe(2);
    const reason = new Error('user cancelled');
    ctl.abort(reason);
    const e = await rejection(p);
    expect(e).toBe(reason);
    for (const put of puts) expect(put.signal?.aborted).toBe(true);
    const aborts = calls.filter((c) => c.fn === 'abort-multipart-upload');
    expect(aborts.length).toBe(1);
    expect(aborts[0]!.signal?.aborted ?? false).toBe(false);
    expect(calls.some((c) => c.fn === 'complete-multipart-upload')).toBe(false);
  });

  it('an already-aborted signal rejects with its reason and makes no request', async () => {
    const ctl = new AbortController();
    const reason = new Error('early');
    ctl.abort(reason);
    const { calls, att } = harness();
    expect(await rejection(att.uploadMultipart(bytes(PART), { partSize: PART, signal: ctl.signal }))).toBe(reason);
    expect(calls.length).toBe(0);
  });

  it('validates partSize (>= 5 MiB, integer) and concurrency (positive integer) with no request', async () => {
    const { calls, att } = harness();
    expect(MIN_PART_SIZE).toBe(5 * MiB);
    for (const o of [{ partSize: PART - 1 }, { partSize: PART + 0.5 }, { concurrency: 0 }, { concurrency: 1.5 }, { concurrency: -1 }]) {
      const e = await spError(att.uploadMultipart(bytes(10), o));
      expect(e.code).toBe('unencodable_value');
      expect(e.module).toBe('attachments');
    }
    expect(calls.length).toBe(0);
  });

  it('rejects an unsupported source with unencodable_value', async () => {
    const { att } = harness();
    const e = await spError(att.uploadMultipart('text' as unknown as Blob));
    expect(e.code).toBe('unencodable_value');
  });

  it('no thrown error (message, cause, fields) contains a signed URL or upload token', async () => {
    const scenarios: Array<Parameters<typeof harness>[0]> = [
      { put: () => new Response(`<Error><SignatureProvided>${SIG}</SignatureProvided></Error>`, { status: 403 }) },
      { put: () => new Response(null, { status: 200 }) },
      { put: (c) => Promise.reject(new TypeError(`connect ECONNREFUSED ${c.url.toString()}`)) },
      { api: { 'complete-multipart-upload': () => fail(422, 'Invalid or expired upload token') } },
    ];
    for (const s of scenarios) {
      const { att } = harness(s);
      const e = await spError(att.uploadMultipart(bytes(PART), { partSize: PART }));
      assertNoSecrets(e);
    }
    const direct = harness({ put: () => new Response(`<Error>${SIG}</Error>`, { status: 403 }) });
    const e = await spError(direct.att.uploadDirect(new Blob(['x'], { type: 'image/png' })));
    expect(e.status).toBe(403);
    assertNoSecrets(e);
  });
});

describe('attachments.uploadMultipart resume, state and progress', () => {
  const state = (parts: Array<{ number: number; etag: string }>): MultipartState => ({
    key: KEY,
    upload_id: 'UP-1',
    upload_token: TOKEN,
    expires_at: 1900000000,
    parts,
  });

  it('resume skips parts already in state.parts and uploads only the rest', async () => {
    const { calls, att } = harness();
    const r = await att.uploadMultipart(new Blob([bytes(4 * PART)]), {
      partSize: PART,
      resume: state([
        { number: 1, etag: etag(1) },
        { number: 3, etag: etag(3) },
      ]),
    });
    expect(r.id).toBe(42);
    expect(calls.some((c) => c.fn === 'create-multipart-upload')).toBe(false);
    expect(calls.filter((c) => c.fn === 'sign-multipart-part').map((c) => c.body?.part_number)).toEqual([2, 4]);
    expect(calls.filter((c) => c.fn === 'PUT').map((c) => c.part)).toEqual([2, 4]);
    expect(last(calls).body?.parts).toEqual([1, 2, 3, 4].map((n) => ({ part_number: n, etag: etag(n) })));
  });

  it('resume with every part done only completes', async () => {
    const { calls, att } = harness();
    await att.uploadMultipart(bytes(2 * PART), { partSize: PART, resume: state([{ number: 1, etag: etag(1) }, { number: 2, etag: etag(2) }]) });
    expect(calls.map((c) => c.fn)).toEqual(['complete-multipart-upload']);
  });

  it('resume with a non-seekable source is unencodable_value', async () => {
    const { calls, att } = harness();
    async function* gen() {
      yield bytes(10);
    }
    const e = await spError(att.uploadMultipart(gen(), { partSize: PART, resume: state([]) }));
    expect(e.code).toBe('unencodable_value');
    expect(calls.length).toBe(0);
  });

  it('a malformed resume state is unencodable_value', async () => {
    const { att } = harness();
    const e = await spError(att.uploadMultipart(bytes(10), { resume: { key: KEY } as unknown as MultipartState }));
    expect(e.code).toBe('unencodable_value');
  });

  it('onState delivers snapshot copies after create and after every part', async () => {
    const seen: MultipartState[] = [];
    const { calls, att } = harness();
    await att.uploadMultipart(bytes(3 * PART), {
      partSize: PART,
      concurrency: 1,
      onState: (s) => {
        seen.push(JSON.parse(JSON.stringify(s)) as MultipartState);
        // Tampering with a snapshot must not leak into later snapshots or the upload.
        s.parts.push({ number: 99, etag: 'tampered' });
        s.upload_id = 'tampered';
      },
    });
    expect(seen.map((s) => s.parts.map((p) => p.number))).toEqual([[], [1], [1, 2], [1, 2, 3]]);
    for (const s of seen) expect(s.upload_id).toBe('UP-1');
    const final = last(seen);
    expect(final.key).toBe(KEY);
    expect(final.upload_token).toBe(TOKEN);
    expect(final.expires_at).toBe(1900000000);
    expect(last(calls).body?.upload_id).toBe('UP-1');
    expect(last(calls).body?.parts).toEqual([1, 2, 3].map((n) => ({ part_number: n, etag: etag(n) })));
  });

  it('a resumed snapshot round-trips (JSON) into resume', async () => {
    let saved = '';
    const first = harness({ put: (c) => (c.part === 3 ? new Promise<Response>(() => undefined) : putOk(c)) });
    const ctl = new AbortController();
    const p = first.att.uploadMultipart(bytes(3 * PART), {
      partSize: PART,
      concurrency: 1,
      signal: ctl.signal,
      onState: (s) => {
        saved = JSON.stringify(s);
      },
    });
    await tick();
    ctl.abort(new Error('stop'));
    await rejection(p);
    const second = harness();
    await second.att.uploadMultipart(bytes(3 * PART), { partSize: PART, resume: JSON.parse(saved) as MultipartState });
    expect(second.calls.filter((c) => c.fn === 'PUT').map((c) => c.part)).toEqual([3]);
  });

  it('onProgress reaches loaded === total', async () => {
    const events: Array<{ loaded: number; total: number | null }> = [];
    const { att } = harness();
    const total = 2 * PART + 123;
    await att.uploadMultipart(new Blob([bytes(total)]), { partSize: PART, onProgress: (p) => events.push({ ...p }) });
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) expect(e.total).toBe(total);
    for (let i = 1; i < events.length; i++) expect(events[i]!.loaded).toBeGreaterThanOrEqual(events[i - 1]!.loaded);
    expect(last(events).loaded).toBe(total);
  });

  it('async-iterable source with unknown total: exact partSize chunks, last smaller, final event total === loaded', async () => {
    async function* gen() {
      for (let i = 0; i < 4; i++) yield bytes(3 * MiB);
      yield bytes(7);
    }
    const events: Array<{ loaded: number; total: number | null }> = [];
    const { calls, att } = harness();
    await att.uploadMultipart(gen(), { partSize: PART, onProgress: (p) => events.push({ ...p }) });
    const total = 12 * MiB + 7;
    expect(calls.filter((c) => c.fn === 'PUT').map((c) => size(c.rawBody))).toEqual([PART, PART, 2 * MiB + 7]);
    expect(events.slice(0, -1).every((e) => e.total === null)).toBe(true);
    expect(last(events)).toEqual({ loaded: total, total });
    expect(calls[0]!.body?.content_type).toBeUndefined();
  });

  it('ReadableStream source is streamed in parts', async () => {
    const chunk = bytes(2 * MiB);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ < 6) c.enqueue(chunk);
        else c.close();
      },
    });
    const { calls, att } = harness();
    await att.uploadMultipart(stream, { partSize: PART });
    expect(calls.filter((c) => c.fn === 'PUT').map((c) => size(c.rawBody))).toEqual([PART, PART, 2 * MiB]);
  });

  it('an empty source uploads a single empty part', async () => {
    const { calls, att } = harness();
    await att.uploadMultipart(new Blob([]));
    expect(calls.filter((c) => c.fn === 'PUT').map((c) => size(c.rawBody))).toEqual([0]);
  });
});

describe('attachments.uploadDirect', () => {
  it('S3: create-upload-url -> PUT to signed URL with backend headers, no auth -> complete-upload', async () => {
    const { calls, att } = harness();
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    const r = await att.uploadDirect(blob, { name: 'a.png', visibility: 'public', recordType: 'products', recordId: 7, collection: 'gallery' });
    expect(r.id).toBe(7);
    expect(calls.map((c) => c.fn)).toEqual(['create-upload-url', 'PUT', 'complete-upload']);
    const [create, put, complete] = calls as [Call, Call, Call];
    expect(create.url.pathname).toBe('/api/sp_attachments/rpc/create-upload-url');
    expect(create.body).toEqual({ filename: 'a.png', content_type: 'image/png', visibility: 'public' });
    expect(put.method).toBe('PUT');
    expect(put.url.toString()).toBe(`https://s3.test/bucket/${KEY}?X-Amz-Signature=${SIG}-direct`);
    expect(put.headers.has('Authorization')).toBe(false);
    expect(put.headers.has('X-Tenant')).toBe(false);
    expect(put.headers.has('Host')).toBe(false);
    expect(put.headers.get('Content-Type')).toBe('image/png');
    expect(put.headers.get('x-amz-acl')).toBe('private');
    expect(put.rawBody).toBe(blob);
    expect(complete.headers.get('Authorization')).toBe('Bearer user-jwt');
    expect(complete.body).toEqual({
      key: KEY,
      upload_token: TOKEN,
      expires_at: 1900000000,
      filename: 'a.png',
      content_type: 'image/png',
      visibility: 'public',
      record_type: 'products',
      record_id: '7',
      collection_name: 'gallery',
    });
  });

  it('local disk: upload_url null -> POST the file to complete-upload (complete_endpoint) via the API', async () => {
    const { calls, att } = harness({
      api: {
        'create-upload-url': () =>
          json({
            key: KEY,
            upload_url: null,
            method: 'POST',
            disk: 'local',
            upload_token: TOKEN,
            expires_at: 1900000000,
            complete_endpoint: 'https://host.test/api/sp_attachments/rpc/complete-upload',
          }),
      },
    });
    const r = await att.uploadDirect(bytes(4), { name: 'raw.bin' });
    expect(r.id).toBe(7);
    expect(calls.map((c) => c.fn)).toEqual(['create-upload-url', 'complete-upload']);
    const c = calls[1]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/api/sp_attachments/rpc/complete-upload');
    expect(c.headers.get('Authorization')).toBe('Bearer user-jwt');
    expect(c.headers.has('Content-Type')).toBe(false);
    const fd = c.rawBody as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect((fd.get('file') as File).size).toBe(4);
    expect((fd.get('file') as File).name).toBe('raw.bin');
    expect(fd.get('key')).toBe(KEY);
    expect(fd.get('upload_token')).toBe(TOKEN);
    expect(fd.get('expires_at')).toBe('1900000000');
    expect(fd.get('filename')).toBe('raw.bin');
    expect(fd.get('visibility')).toBe('private');
  });

  it('404 on create-upload-url -> module_disabled with module attachments.direct_upload', async () => {
    const { calls, att } = harness({ api: { 'create-upload-url': () => fail(404, 'Direct upload is disabled') } });
    const e = await spError(att.uploadDirect(new Blob(['x'])));
    expect(e.code).toBe('module_disabled');
    expect(e.module).toBe('attachments.direct_upload');
    expect(calls.length).toBe(1);
  });

  it('404 on complete-upload stays not_found (file not found on disk)', async () => {
    const { att } = harness({ api: { 'complete-upload': () => fail(404, 'File not found on disk') } });
    const e = await spError(att.uploadDirect(new Blob(['x'])));
    expect(e.code).toBe('not_found');
  });

  it('a failed PUT is a typed error and complete-upload is not called', async () => {
    const { calls, att } = harness({ put: () => new Response('nope', { status: 503 }) });
    const e = await spError(att.uploadDirect(new Blob(['x'])));
    expect(e.status).toBe(503);
    expect(e.code).toBe('server');
    expect(calls.some((c) => c.fn === 'complete-upload')).toBe(false);
  });

  it('buffers an async-iterable source into one body', async () => {
    async function* gen() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }
    const { calls, att } = harness();
    await att.uploadDirect(gen());
    expect(size(calls.find((c) => c.fn === 'PUT')!.rawBody)).toBe(3);
  });

  it('honours rpcPrefix', async () => {
    const { calls, att } = harness({ cfg: { rpcPrefix: '' } });
    await att.uploadDirect(new Blob(['x']));
    expect(calls[0]!.url.pathname).toBe('/api/sp_attachments/create-upload-url');
    expect(calls[2]!.url.pathname).toBe('/api/sp_attachments/complete-upload');
  });
});

describe("attachments.upload strategies", () => {
  const fns = (calls: Call[]): string[] => calls.map((c) => c.fn);

  it('no strategy and strategy "form" keep the multipart/form-data POST', async () => {
    const a = harness();
    await a.att.upload(bytes(20 * MiB));
    expect(fns(a.calls)).toEqual(['upload']);
    const b = harness();
    await b.att.upload(bytes(20 * MiB), { strategy: 'form', directUpload: true });
    expect(fns(b.calls)).toEqual(['upload']);
  });

  it('"auto" picks multipart above partSize x 2', async () => {
    const { calls, att } = harness();
    await att.upload(new Blob([bytes(2 * PART + 1)]), { strategy: 'auto', partSize: PART });
    expect(fns(calls)[0]).toBe('create-multipart-upload');
  });

  it('"auto" at exactly partSize x 2 does not use multipart; without directUpload it is the form upload', async () => {
    const { calls, att } = harness();
    await att.upload(new Blob([bytes(2 * PART)]), { strategy: 'auto', partSize: PART });
    expect(fns(calls)).toEqual(['upload']);
  });

  it('"auto" uses the default 8 MiB part size for the threshold', async () => {
    const a = harness();
    await a.att.upload(bytes(16 * MiB), { strategy: 'auto' });
    expect(fns(a.calls)).toEqual(['upload']);
    const b = harness();
    await b.att.upload(bytes(16 * MiB + 1), { strategy: 'auto' });
    expect(fns(b.calls)[0]).toBe('create-multipart-upload');
  });

  it('"auto" uses direct only with directUpload: true (per call or module option)', async () => {
    const a = harness();
    await a.att.upload(new Blob(['x']), { strategy: 'auto', directUpload: true });
    expect(fns(a.calls)).toEqual(['create-upload-url', 'PUT', 'complete-upload']);
    const b = harness({ mod: { directUpload: true } });
    await b.att.upload(new Blob(['x']), { strategy: 'auto' });
    expect(fns(b.calls)[0]).toBe('create-upload-url');
    const c = harness({ mod: { directUpload: true } });
    await c.att.upload(new Blob(['x']), { strategy: 'auto', directUpload: false });
    expect(fns(c.calls)).toEqual(['upload']);
  });

  it('"auto" with a stream of unknown size uses multipart', async () => {
    async function* gen() {
      yield bytes(10);
    }
    const { calls, att } = harness();
    await att.upload(gen(), { strategy: 'auto' });
    expect(fns(calls)[0]).toBe('create-multipart-upload');
  });

  it('explicit "direct" and "multipart" strategies', async () => {
    const a = harness();
    await a.att.upload(new Blob(['x']), { strategy: 'direct' });
    expect(fns(a.calls)[0]).toBe('create-upload-url');
    const b = harness();
    await b.att.upload(new Blob(['x']), { strategy: 'multipart' });
    expect(fns(b.calls)[0]).toBe('create-multipart-upload');
  });

  it('form upload of a stream source is unencodable_value', async () => {
    async function* gen() {
      yield bytes(10);
    }
    const { calls, att } = harness();
    const e = await spError(att.upload(gen()));
    expect(e.code).toBe('unencodable_value');
    expect(calls.length).toBe(0);
  });

  it('unknown strategy is unencodable_value', async () => {
    const { att } = harness();
    const e = await spError(att.upload(bytes(1), { strategy: 'fast' as 'auto' }));
    expect(e.code).toBe('unencodable_value');
  });
});
