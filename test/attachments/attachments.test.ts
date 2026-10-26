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

  it('404 maps to module_disabled with module attachments', async () => {
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

  it('works without options and maps 404 to module_disabled', async () => {
    const a = setup();
    await a.att.cloneTemp('abc');
    expect(a.calls[0]!.body).toEqual({ attachment_id: 'abc' });
    const b = setup(() => fail(404));
    expect((await rejection(b.att.cloneTemp(1))).code).toBe('module_disabled');
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

  it('list without options has no query', async () => {
    const { calls, att } = setup(() => json([]));
    await att.forRecord('products', 7).list();
    expect(calls[0]!.url.search).toBe('');
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

  it('404 on record routes is module_disabled (feature route)', async () => {
    const { att } = setup(() => fail(404));
    const e = await rejection(att.forRecord('products', 7).list());
    expect(e.code).toBe('module_disabled');
    expect(e.module).toBe('attachments');
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

  it('404 on folders is module_disabled', async () => {
    const { att } = setup(() => fail(404));
    expect((await rejection(att.folders.list())).code).toBe('module_disabled');
  });
});
