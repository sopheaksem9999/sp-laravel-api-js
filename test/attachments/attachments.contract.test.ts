// Contract tests for `attachments(api)` against the sp-laravel-api-example backend (see contract/README.md).
// Live when SP_CONTRACT_URL is set; otherwise replays test/fixtures/<backend-version>/. With neither a
// backend nor fixtures the whole suite is SKIPPED (never silently passing).
import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import { attachments } from '../../src/attachments';
import { liveOrReplay } from '../support/replay';

const { fetch: contractFetch, mode, baseUrl, hasFixtures } = liveOrReplay();
const table = process.env.SP_CONTRACT_TABLE ?? 'customers';
const token = process.env.SP_CONTRACT_TOKEN ?? 'replay-token';

const api = createApi({
  baseUrl,
  fetch: contractFetch,
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
});

describe.skipIf(mode !== 'live' && !hasFixtures)('attachments contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it('uploads, links, lists, unlinks and builds urls', async () => {
    const att = attachments(api);
    const file = await att.upload(new Blob(['contract'], { type: 'text/plain' }), { name: 'contract.txt' });
    expect(file.id).toBeDefined();
    expect(att.downloadUrl(file.id)).toContain(`/${String(file.id)}/download`);

    const rec = att.forRecord(table, 1);
    const links = await rec.link([file.id], { collection: 'contract' });
    expect(links.length).toBe(1);
    const listed = await rec.list({ collection: 'contract' });
    expect(listed.length).toBeGreaterThanOrEqual(1);
    await rec.unlink(file.id);
  });

  it('creates and removes a folder', async () => {
    const att = attachments(api);
    const folder = await att.folders.create({ name: 'contract-folder' });
    expect(folder.id).toBeDefined();
    const found = await att.folders.list({ id: folder.id });
    expect(found.length).toBe(1);
    await att.folders.remove(folder.id);
  });
});

// Direct and multipart upload need `direct_upload.enabled` on the host (off by default) and, for multipart and the
// presigned PUT, an S3/R2 disk whose CORS policy exposes `ETag`. Each case is gated on an explicit env flag.
const directOn = process.env.SP_CONTRACT_DIRECT_UPLOAD === '1';
const multipartOn = process.env.SP_CONTRACT_MULTIPART === '1';
const directOff = process.env.SP_CONTRACT_DIRECT_UPLOAD_DISABLED === '1';
const backend = mode === 'live' || hasFixtures;

describe('attachments direct/multipart contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it.skipIf(!backend || !directOn)('uploadDirect: create-upload-url -> PUT/POST -> complete-upload', async () => {
    const att = attachments(api);
    const file = await att.uploadDirect(new Blob(['direct contract'], { type: 'text/plain' }), { name: 'direct.txt' });
    expect(file.id).toBeDefined();
    expect(file.size).toBe(15);
  });

  it.skipIf(!backend || !multipartOn)('uploadMultipart: 2 parts (5 MiB + 1 byte), resumable state, progress to total', async () => {
    const att = attachments(api);
    const total = 5 * 1024 * 1024 + 1;
    const states: unknown[] = [];
    let last = { loaded: 0, total: null as number | null };
    const file = await att.uploadMultipart(new Uint8Array(total), {
      name: 'multipart.bin',
      partSize: 5 * 1024 * 1024,
      onState: (s) => states.push(s),
      onProgress: (p) => {
        last = p;
      },
    });
    expect(file.id).toBeDefined();
    expect(file.size).toBe(total);
    expect(states.length).toBe(3);
    expect(last).toEqual({ loaded: total, total });
  });

  it.skipIf(!backend || !directOff)('direct upload disabled -> module_disabled with module attachments.direct_upload', async () => {
    const e = await attachments(api)
      .uploadDirect(new Blob(['x']))
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).code).toBe('module_disabled');
    expect((e as SpApiError).module).toBe('attachments.direct_upload');
  });
});
