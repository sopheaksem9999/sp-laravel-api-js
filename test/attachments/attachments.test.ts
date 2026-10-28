import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import type { ApiConfig } from '../../src';
import { attachments } from '../../src/attachments';

interface Seen {
  url: URL;
  method: string;
  body: unknown;
  rawBody: unknown;
  headers: Headers;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ success: true, data, meta: {} }), { status, headers: { 'Content-Type': 'application/json' } });

const fail = (status: number, message = 'nope'): Response =>
  new Response(JSON.stringify({ success: false, message }), { status, headers: { 'Content-Type': 'application/json' } });

function setup(handler: (s: Seen, n: number) => Response | Promise<Response> = () => json({ id: 1 }), cfg: Partial<ApiConfig> = {}) {
  const calls: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const seen: Seen = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
      rawBody: raw,
      headers: new Headers(init?.headers),
    };
    calls.push(seen);
    return handler(seen, calls.length - 1);
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api/', fetch: fetchFn, ...cfg });
  return { calls, api, att: attachments(api) };
}

const rejection = async (p: Promise<unknown>): Promise<SpApiError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SpApiError);
  return e as SpApiError;
};

describe('attachments.upload', () => {
  it('POSTs multipart sp_attachments/rpc/upload with file and fields, no manual Content-Type', async () => {
    const { calls, att } = setup(() => json({ id: 9, filename: 'a.txt' }));
    const file = new Blob(['hello'], { type: 'text/plain' });
    const r = await att.upload(file, {
      visibility: 'public',
      recordType: 'products',
      recordId: 7,
      collection: 'gallery',
      name: 'a.txt',
    });
    expect(r.id).toBe(9);
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/api/sp_attachments/rpc/upload');
    expect(c.headers.has('Content-Type')).toBe(false);
    const fd = c.rawBody as FormData;
    expect(fd).toBeInstanceOf(FormData);
    const f = fd.get('file') as File;
    expect(f.name).toBe('a.txt');
    expect(await f.text()).toBe('hello');
    expect(fd.get('visibility')).toBe('public');
    expect(fd.get('record_type')).toBe('products');
    expect(fd.get('record_id')).toBe('7');
    expect(fd.get('collection_name')).toBe('gallery');
  });

  it('wraps a Uint8Array into a Blob and omits unset fields', async () => {
    const { calls, att } = setup();
    await att.upload(new Uint8Array([1, 2, 3]), { name: 'raw.bin' });
    const fd = calls[0]!.rawBody as FormData;
    const f = fd.get('file') as File;
    expect(f.size).toBe(3);
    expect(f.name).toBe('raw.bin');
    expect(fd.has('file')).toBe(true);
    for (const k of ['visibility', 'record_type', 'record_id', 'collection_name']) expect(fd.has(k)).toBe(false);
  });

  it('honours rpcPrefix', async () => {
    const a = setup(undefined, { rpcPrefix: 't' });
    await a.att.upload(new Blob(['x']), {});
    expect(a.calls[0]!.url.pathname).toBe('/api/sp_attachments/t/upload');
    const b = setup(undefined, { rpcPrefix: '' });
    await b.att.upload(new Blob(['x']), {});
    expect(b.calls[0]!.url.pathname).toBe('/api/sp_attachments/upload');
  });

  it('applies auth and tenant headers', async () => {
    const { calls, att } = setup(undefined, {
      auth: { getHeaders: async () => ({ Authorization: 'Bearer tok' }) },
      tenant: { header: 'X-Tenant', value: () => 5 },
    });
    await att.upload(new Blob(['x']), {});
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer tok');
    expect(calls[0]!.headers.get('X-Tenant')).toBe('5');
  });

  it('404 on upload with recordType stays not_found (missing target record)', async () => {
    const { att } = setup(() => fail(404, 'Target record not found'));
    const e = await rejection(att.upload(new Blob(['x']), { recordType: 'products', recordId: 1 }));
    expect(e.code).toBe('not_found');
    expect(e.module).toBe('attachments');
  });

  it('404 on upload without recordType maps to module_disabled with module attachments', async () => {
    const { att } = setup(() => fail(404));
    const e = await rejection(att.upload(new Blob(['x']), {}));
    expect(e.code).toBe('module_disabled');
    expect(e.module).toBe('attachments');
  });

  it('surfaces 422 with module attachments', async () => {
    const { att } = setup(() => fail(422));
    const e = await rejection(att.upload(new Blob(['x']), {}));
    expect(e.code).toBe('validation');
    expect(e.module).toBe('attachments');
  });
});

describe('attachments.cloneTemp', () => {
  it('POSTs clone-temp with attachment_id and mapped options', async () => {
    const { calls, att } = setup();
    await att.cloneTemp(5, { visibility: 'temp_private', tempTimeoutMinutes: 30, recordType: 'products', recordId: 7, collection: 'c' });
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/api/sp_attachments/rpc/clone-temp');
    expect(c.body).toEqual({
      attachment_id: '5',
      visibility: 'temp_private',
      temp_timeout_minutes: 30,
      record_type: 'products',
      record_id: '7',
      collection_name: 'c',
    });
  });

  it('works without options and keeps a 404 as not_found (missing attachment)', async () => {
    const a = setup();
    await a.att.cloneTemp('abc');
    expect(a.calls[0]!.body).toEqual({ attachment_id: 'abc' });
    const b = setup(() => fail(404));
    expect((await rejection(b.att.cloneTemp(1))).code).toBe('not_found');
  });

  it('surfaces 410 as status 410', async () => {
    const { att } = setup(() => fail(410, 'Attachment has expired'));
    const e = await rejection(att.cloneTemp(1));
    expect(e.status).toBe(410);
    expect(e.code).not.toBe('module_disabled');
  });
});

describe('attachments.viewUrl / downloadUrl', () => {
  it('builds exact urls per rpcPrefix', () => {
    expect(setup().att.viewUrl(7, { w: 200, fit: 'crop' })).toBe('https://host.test/api/sp_attachments/rpc/7/view?w=200&fit=crop');
    expect(setup(undefined, { rpcPrefix: 't' }).att.viewUrl(7, { w: 200, fit: 'crop' })).toBe(
      'https://host.test/api/sp_attachments/t/7/view?w=200&fit=crop',
    );
    expect(setup(undefined, { rpcPrefix: '' }).att.viewUrl(7, { w: 200, fit: 'crop' })).toBe(
      'https://host.test/api/sp_attachments/7/view?w=200&fit=crop',
    );
  });

  it('orders w, h, fit, format; no query without options', () => {
    const { att } = setup();
    expect(att.viewUrl(1, { format: 'webp', h: 32, w: 2000, fit: 'contain' })).toBe(
      'https://host.test/api/sp_attachments/rpc/1/view?w=2000&h=32&fit=contain&format=webp',
    );
    expect(att.viewUrl(1)).toBe('https://host.test/api/sp_attachments/rpc/1/view');
  });

  it('downloadUrl and URL-encoded ids', () => {
    const { att } = setup();
    expect(att.downloadUrl(7)).toBe('https://host.test/api/sp_attachments/rpc/7/download');
    expect(att.downloadUrl('a/b c')).toBe('https://host.test/api/sp_attachments/rpc/a%2Fb%20c/download');
    expect(att.viewUrl('a/b')).toBe('https://host.test/api/sp_attachments/rpc/a%2Fb/view');
  });

  it('rejects bad w/h/fit/format with unencodable_value and no request', () => {
    const { att, calls } = setup();
    const bad: Array<Parameters<typeof att.viewUrl>[1]> = [
      { w: 31 },
      { w: 2001 },
      { h: 10 },
      { h: 2001 },
      { w: 100.5 },
      { fit: 'cover' as 'crop' },
      { format: 'bmp' as 'png' },
    ];
    for (const o of bad) {
      let err: unknown;
      try {
        att.viewUrl(1, o);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SpApiError);
      expect((err as SpApiError).code).toBe('unencodable_value');
      expect((err as SpApiError).module).toBe('attachments');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('attachments.forRecord', () => {
  it('list GETs record/{table}/{id} with collection_name', async () => {
    const { calls, att } = setup(() => json([{ id: 1, attachment_id: 2 }]));
    const r = await att.forRecord('products', 7).list({ collection: 'gallery' });
    expect(r).toEqual([{ id: 1, attachment_id: 2 }]);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url.pathname).toBe('/api/sp_attachments/rpc/record/products/7');
    expect(calls[0]!.url.searchParams.get('collection_name')).toBe('gallery');
  });

  it('list without options sends only per_page (spec §10; the backend ignores it on this route)', async () => {
    const { calls, att } = setup(() => json([]));
    await att.forRecord('products', 7).list();
    expect(calls[0]!.url.search).toBe('?per_page=25');
  });

  it('encodes special characters in table and id', async () => {
    const { calls, att } = setup(() => json([]));
    await att.forRecord('we ird/t', 'a b#1').list();
    expect(calls[0]!.url.pathname).toBe('/api/sp_attachments/rpc/record/we%20ird%2Ft/a%20b%231');
  });

  it('link sends ONE POST with attachment_ids as strings', async () => {
    const { calls, att } = setup(() => json([{ id: 1 }, { id: 2 }]));
    const r = await att.forRecord('products', 7).link([1, 2], { collection: 'gallery' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/api/sp_attachments/rpc/record/products/7');
    expect(calls[0]!.body).toEqual({ attachment_ids: ['1', '2'], collection_name: 'gallery' });
    expect(r).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('link with a single id returns an array', async () => {
    const { calls, att } = setup(() => json([{ id: 1 }]));
    await att.forRecord('products', 7).link(3);
    expect(calls[0]!.body).toEqual({ attachment_ids: ['3'] });
  });

  it('quoting:false sends one attachment_id POST per id, sequentially, and combines links', async () => {
    let inflight = 0;
    let max = 0;
    const { calls, att } = setup(
      async (s, n) => {
        inflight++;
        max = Math.max(max, inflight);
        await Promise.resolve();
        inflight--;
        return json({ id: 10 + n, attachment_id: (s.body as { attachment_id: string }).attachment_id });
      },
      { quoting: false },
    );
    const r = await att.forRecord('products', 7).link([1, 2]);
    expect(calls.map((c) => c.body)).toEqual([{ attachment_id: '1' }, { attachment_id: '2' }]);
    expect(max).toBe(1);
    expect(r).toEqual([
      { id: 10, attachment_id: '1' },
      { id: 11, attachment_id: '2' },
    ]);
  });

  it('unlink DELETEs record/{table}/{id}/{attachmentId}', async () => {
    const { calls, att } = setup(() => json(null));
    await att.forRecord('products', 7).unlink(5);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url.pathname).toBe('/api/sp_attachments/rpc/record/products/7/5');
  });

  it('404 on record routes stays not_found (missing record or link)', async () => {
    const { att } = setup(() => fail(404, 'Target record not found'));
    const rec = att.forRecord('products', 7);
    for (const p of [rec.list(), rec.link(1), rec.unlink(1)]) {
      const e = await rejection(p);
      expect(e.code).toBe('not_found');
      expect(e.module).toBe('attachments');
    }
  });

  it('link([]) makes no request and resolves []', async () => {
    const { calls, att } = setup();
    expect(await att.forRecord('products', 7).link([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('attachments.folders', () => {
  it('list serialises operators: parent_id=eq.1', async () => {
    const { calls, att } = setup(() => json([{ id: 1 }]));
    const r = await att.folders.list({ parent_id: { eq: 1 } });
    expect(r).toEqual([{ id: 1 }]);
    expect(calls[0]!.url.pathname).toBe('/api/sp_attachments/rpc/folders');
    expect(calls[0]!.url.searchParams.get('parent_id')).toBe('eq.1');
  });

  it('list with a bare value still serialises with an operator', async () => {
    const { calls, att } = setup(() => json([]));
    await att.folders.list({ parent_id: 1 });
    expect(calls[0]!.url.searchParams.get('parent_id')).toBe('eq.1');
  });

  it('list without a filter still sends per_page (default 25, then defaults.perPage, then perPage)', async () => {
    const { calls, att } = setup(() => json([]));
    await att.folders.list();
    expect(calls[0]!.url.search).toBe('?per_page=25');
    await att.folders.list(undefined, { perPage: 50 });
    expect(calls[1]!.url.searchParams.get('per_page')).toBe('50');
    const withDefaults = setup(() => json([]), { defaults: { perPage: 10 } });
    await withDefaults.att.folders.list();
    expect(withDefaults.calls[0]!.url.searchParams.get('per_page')).toBe('10');
  });

  it('listPage: cursor=0 on the first page, next follows meta.next_cursor on a full page, perPage respected', async () => {
    const page = (data: unknown[], next: string | null): Response =>
      new Response(JSON.stringify({ success: true, data, meta: { next_cursor: next } }), { headers: { 'Content-Type': 'application/json' } });
    let n = 0;
    const { calls, att } = setup(() => (++n === 1 ? page([{ id: 1 }, { id: 2 }], 'c2') : page([{ id: 3 }], 'c3')));
    const first = await att.folders.listPage({ parent_id: 1 }, { perPage: 2, cursor: null });
    expect(calls[0]!.url.searchParams.get('cursor')).toBe('0');
    expect(calls[0]!.url.searchParams.get('per_page')).toBe('2');
    expect(calls[0]!.url.searchParams.get('parent_id')).toBe('eq.1');
    expect(first.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(first.next).toBe('c2');
    const second = await att.folders.listPage({ parent_id: 1 }, { perPage: 2, cursor: first.next });
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c2');
    expect(second.data).toEqual([{ id: 3 }]);
    expect(second.next).toBeNull(); // short page: the end, whatever meta says
  });

  it('listPage in offset mode (page) and against a host that returns no meta: next is null', async () => {
    const { calls, att } = setup(() => json([{ id: 1 }]));
    const p = await att.folders.listPage(undefined, { page: 2, perPage: 1 });
    expect(calls[0]!.url.searchParams.get('page')).toBe('2');
    expect(calls[0]!.url.searchParams.has('cursor')).toBe(false);
    expect(p.data).toEqual([{ id: 1 }]);
    expect(p.next).toBeNull();
  });

  it('404 on listPage is module_disabled (feature route)', async () => {
    const { att } = setup(() => new Response('{}', { status: 404 }));
    await expect(att.folders.listPage()).rejects.toMatchObject({ code: 'module_disabled', module: 'attachments' });
  });

  it('create POSTs, update PUTs, remove DELETEs', async () => {
    const { calls, att } = setup(() => json({ id: 3, name: 'X' }));
    await att.folders.create({ name: 'X', parent_id: 1 });
    await att.folders.update(3, { name: 'Y' });
    await att.folders.remove(3);
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['POST', '/api/sp_attachments/rpc/folders'],
      ['PUT', '/api/sp_attachments/rpc/folders/3'],
      ['DELETE', '/api/sp_attachments/rpc/folders/3'],
    ]);
    expect(calls[0]!.body).toEqual({ name: 'X', parent_id: '1' });
    expect(calls[1]!.body).toEqual({ name: 'Y' });
  });

  it('409 on remove surfaces with status 409', async () => {
    const { att } = setup(() => fail(409, 'Folder is not empty'));
    const e = await rejection(att.folders.remove(3));
    expect(e.status).toBe(409);
    expect(e.message).toBe('Folder is not empty');
    expect(e.module).toBe('attachments');
  });

  it('404 on folders.list and folders.create is module_disabled (feature routes)', async () => {
    const { att } = setup(() => fail(404));
    expect((await rejection(att.folders.list())).code).toBe('module_disabled');
    expect((await rejection(att.folders.create({ name: 'x' }))).code).toBe('module_disabled');
  });

  it('404 on folders.update and folders.remove stays not_found (unknown folder)', async () => {
    const { att } = setup(() => fail(404));
    expect((await rejection(att.folders.update(1, { name: 'x' }))).code).toBe('not_found');
    expect((await rejection(att.folders.remove(1))).code).toBe('not_found');
  });
});

describe('viewBytes / viewBlob', () => {
  const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const bytesRes = (): Response => new Response(allBytes.slice(), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });

  it('returns exact non-UTF-8 bytes with auth and tenant headers', async () => {
    const { att, calls } = setup(() => bytesRes(), {
      auth: { getHeaders: async () => ({ Authorization: 'Bearer t' }) },
      tenant: { header: 'X-Tenant', value: () => 'acme' },
    });
    const out = await att.viewBytes(7);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual(Array.from(allBytes));
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url.pathname).toBe('/api/sp_attachments/rpc/7/view');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer t');
    expect(calls[0]!.headers.get('x-tenant')).toBe('acme');
  });

  it('viewBlob returns a Blob with the bytes', async () => {
    const { att } = setup(() => bytesRes());
    const b = await att.viewBlob(7);
    expect(b).toBeInstanceOf(Blob);
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(allBytes);
  });

  it('sends resize options and validates them', async () => {
    const { att, calls } = setup(() => bytesRes());
    await att.viewBytes(7, { w: 64, h: 64, fit: 'crop', format: 'webp' });
    expect(calls[0]!.url.search).toBe('?w=64&h=64&fit=crop&format=webp');
    await expect(att.viewBytes(7, { w: 10 })).rejects.toMatchObject({ code: 'unencodable_value' });
  });

  it('keeps 404 as not_found', async () => {
    const { att } = setup(() => fail(404));
    await expect(att.viewBytes(7)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns a success:false looking payload as bytes', async () => {
    const { att } = setup(() => new Response('{"success":false}', { status: 200 }));
    expect(new TextDecoder().decode(await att.viewBytes(7))).toBe('{"success":false}');
  });
});

describe('degenerate path segments', () => {
  for (const bad of ['..', '.', '']) {
    it(`rejects id ${JSON.stringify(bad)} without sending a request`, async () => {
      const { att, calls } = setup(() => json({ id: 1 }));
      const label = (f: () => unknown) => {
        try {
          f();
        } catch (e) {
          return (e as SpApiError).code;
        }
        return 'no throw';
      };
      expect(label(() => att.viewUrl(bad))).toBe('unencodable_value');
      expect(label(() => att.downloadUrl(bad))).toBe('unencodable_value');
      await expect(att.viewBytes(bad)).rejects.toMatchObject({ code: 'unencodable_value' });
      await expect(att.viewBlob(bad)).rejects.toMatchObject({ code: 'unencodable_value' });
      await expect(att.forRecord('invoices', 1).unlink(bad)).rejects.toMatchObject({ code: 'unencodable_value' });
      expect(label(() => att.forRecord('invoices', bad))).toBe('unencodable_value');
      expect(calls).toHaveLength(0);
    });
  }

  it('still encodes normal ids', () => {
    const { att } = setup();
    expect(att.viewUrl('a b/c')).toBe('https://host.test/api/sp_attachments/rpc/a%20b%2Fc/view');
  });
});

describe('form upload re-send', () => {
  const content = 'x'.repeat(5000);
  const fileText = async (s: Seen): Promise<string> => {
    const f = (s.rawBody as FormData).get('file') as File;
    return f.text();
  };

  it('re-sends full content after a 401 refresh', async () => {
    const { att, calls } = setup((_s, n) => (n === 0 ? fail(401) : json({ id: 1 })), {
      auth: { getHeaders: async () => ({}), handleUnauthorized: async () => true },
    });
    await att.upload(new Blob([content]));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.rawBody).toBeInstanceOf(FormData);
    expect(await fileText(calls[1]!)).toBe(content);
  });

  it('requester re-sends a FormData with full content after a 503 retry (api.request retry:true; upload() itself never retries a POST)', async () => {
    const { api, calls } = setup((_s, n) => (n === 0 ? fail(503) : json({ id: 1 })), {
      retry: { maxAttempts: 1, backoffMs: 1, jitter: false },
    });
    const fd = new FormData();
    fd.append('file', new Blob([content]), 'a.bin');
    await api.request({ method: 'POST', path: 'sp_attachments/rpc/upload', body: fd, retry: true });
    expect(calls).toHaveLength(2);
    expect(await fileText(calls[1]!)).toBe(content);
  });
});
