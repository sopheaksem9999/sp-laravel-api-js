import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import { attachments } from '../../src/attachments';
import type { UploadOptions, UploadStrategyOptions } from '../../src/attachments';

interface Seen {
  url: URL;
  method: string;
  rawBody: unknown;
  headers: Headers;
}

const json = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data, meta: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function setup() {
  const calls: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), method: init?.method ?? 'GET', rawBody: init?.body, headers: new Headers(init?.headers) });
    return json({ id: 1 });
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api/', fetch: fetchFn });
  return { calls, att: attachments(api) };
}

const file = new Blob(['hello'], { type: 'text/plain' });

/** Runs an upload, expects `unencodable_value` from the attachments module and no request at all. */
async function throwsBeforeRequest(o: UploadStrategyOptions, message?: string | RegExp): Promise<void> {
  const { calls, att } = setup();
  const err = await att.upload(file, o).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SpApiError);
  expect((err as SpApiError).code).toBe('unencodable_value');
  expect((err as SpApiError).module).toBe('attachments');
  if (message !== undefined) expect((err as SpApiError).message).toMatch(message);
  expect(calls).toHaveLength(0);
}

async function formOf(o: UploadStrategyOptions): Promise<FormData> {
  const { calls, att } = setup();
  await att.upload(file, o);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url.pathname).toBe('/api/sp_attachments/rpc/upload');
  return calls[0]?.rawBody as FormData;
}

describe('upload options on the form upload', () => {
  it('sends width, height, fit, sizeName as w, h, fit, size_name', async () => {
    const fd = await formOf({ width: 512, height: 256, fit: 'crop' });
    expect(fd.get('w')).toBe('512');
    expect(fd.get('h')).toBe('256');
    expect(fd.get('fit')).toBe('crop');
    const named = await formOf({ sizeName: 'thumb' });
    expect(named.get('size_name')).toBe('thumb');
    expect(named.has('w')).toBe(false);
  });

  it('sends replaceOld true as replace_old=true with record and collection', async () => {
    const fd = await formOf({ replaceOld: true, recordType: 'products', recordId: 7, collection: 'gallery' });
    expect(fd.get('replace_old')).toBe('true');
    expect(fd.get('record_type')).toBe('products');
    expect(fd.get('record_id')).toBe('7');
    expect(fd.get('collection_name')).toBe('gallery');
  });

  it('replaceOld false is not sent and does not throw', async () => {
    const fd = await formOf({ replaceOld: false });
    expect(fd.has('replace_old')).toBe(false);
  });

  it('replaceOld true without recordType or recordId throws', async () => {
    await throwsBeforeRequest({ replaceOld: true }, /replaceOld/);
    await throwsBeforeRequest({ replaceOld: true, recordType: 'products' }, /replaceOld/);
    await throwsBeforeRequest({ replaceOld: true, recordId: 7 }, /replaceOld/);
  });

  it('sends title, caption, folderId as strings', async () => {
    const fd = await formOf({ title: 'Logo', caption: 'Our logo', folderId: 12 });
    expect(fd.get('title')).toBe('Logo');
    expect(fd.get('caption')).toBe('Our logo');
    expect(fd.get('folder_id')).toBe('12');
  });

  it('asTemp true alone sends as_temp=true', async () => {
    const fd = await formOf({ asTemp: true });
    expect(fd.get('as_temp')).toBe('true');
    expect(fd.has('visibility')).toBe(false);
  });

  it('asTemp true with private or public visibility throws', async () => {
    await throwsBeforeRequest({ asTemp: true, visibility: 'private' }, /asTemp/);
    await throwsBeforeRequest({ asTemp: true, visibility: 'public' }, /asTemp/);
  });

  it('asTemp true with a temp visibility is allowed', async () => {
    const fd = await formOf({ asTemp: true, visibility: 'temp_public' });
    expect(fd.get('as_temp')).toBe('true');
    expect(fd.get('visibility')).toBe('temp_public');
  });

  it('asTemp false with temp_private throws', async () => {
    await throwsBeforeRequest({ asTemp: false, visibility: 'temp_private' }, /asTemp/);
  });

  it('asTemp false with public visibility is not sent and does not throw', async () => {
    const fd = await formOf({ asTemp: false, visibility: 'public' });
    expect(fd.has('as_temp')).toBe(false);
    expect(fd.get('visibility')).toBe('public');
  });

  it('tempTimeoutMinutes with asTemp true is sent as temp_timeout_minutes', async () => {
    const fd = await formOf({ asTemp: true, tempTimeoutMinutes: 90 });
    expect(fd.get('temp_timeout_minutes')).toBe('90');
  });

  it('tempTimeoutMinutes with visibility temp_public is sent', async () => {
    const fd = await formOf({ visibility: 'temp_public', tempTimeoutMinutes: 5 });
    expect(fd.get('temp_timeout_minutes')).toBe('5');
  });

  it('a timeout without a temporary upload throws', async () => {
    await throwsBeforeRequest({ tempTimeoutMinutes: 30 }, /temporary/);
    await throwsBeforeRequest({ visibility: 'private', tempTimeoutMinutes: 30 }, /temporary/);
    await throwsBeforeRequest({ tempTimeoutAt: '2026-10-30T10:00:00Z' }, /temporary/);
  });

  it('both tempTimeoutMinutes and tempTimeoutAt throws', async () => {
    await throwsBeforeRequest({ asTemp: true, tempTimeoutMinutes: 30, tempTimeoutAt: '2026-10-30T10:00:00Z' }, /tempTimeout/);
  });

  it.each([0, -5, 1.5, Number.NaN])('tempTimeoutMinutes %s that is not a positive integer throws', async (v) => {
    await throwsBeforeRequest({ asTemp: true, tempTimeoutMinutes: v }, /tempTimeoutMinutes/);
  });

  it('tempTimeoutAt string is sent unchanged', async () => {
    const fd = await formOf({ asTemp: true, tempTimeoutAt: '2026-10-30T17:00:00+07:00' });
    expect(fd.get('temp_timeout_at')).toBe('2026-10-30T17:00:00+07:00');
  });

  it('tempTimeoutAt Date is sent as toISOString()', async () => {
    const fd = await formOf({ asTemp: true, tempTimeoutAt: new Date('2026-10-30T10:00:00Z') });
    expect(fd.get('temp_timeout_at')).toBe('2026-10-30T10:00:00.000Z');
  });

  it('an invalid Date or an empty string for tempTimeoutAt throws', async () => {
    await throwsBeforeRequest({ asTemp: true, tempTimeoutAt: new Date('not a date') }, /tempTimeoutAt/);
    await throwsBeforeRequest({ asTemp: true, tempTimeoutAt: '' }, /tempTimeoutAt/);
  });

  it.each([{ width: 100 }, { height: 100 }, { fit: 'crop' as const }])('sizeName together with %j throws', async (extra) => {
    await throwsBeforeRequest({ sizeName: 'thumb', ...extra }, /sizeName/);
  });

  it.each([0, -1, 1.5, Number.NaN, '512' as unknown as number])('width of %s throws', async (v) => {
    await throwsBeforeRequest({ width: v }, /width/);
    await throwsBeforeRequest({ height: v }, /height/);
  });

  it('fit other than crop or contain throws', async () => {
    await throwsBeforeRequest({ fit: 'stretch' as unknown as 'crop' }, /fit/);
  });

  it('an empty sizeName throws', async () => {
    await throwsBeforeRequest({ sizeName: '' }, /sizeName/);
  });

  it('a call with none of the new options sends exactly the previous fields', async () => {
    const o: UploadOptions = { visibility: 'public', recordType: 'products', recordId: 7, collection: 'gallery', name: 'a.txt' };
    const fd = await formOf(o);
    expect([...(fd as unknown as { keys(): Iterable<string> }).keys()].sort()).toEqual(['collection_name', 'file', 'record_id', 'record_type', 'visibility']);
  });
});
