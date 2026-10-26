// Contract tests for `attachments(api)` against the sp-laravel-api-example backend (see contract/README.md).
// Live when SP_CONTRACT_URL is set; otherwise replays test/fixtures/<backend-version>/. With neither a
// backend nor fixtures the whole suite is SKIPPED (never silently passing).
import { describe, expect, it } from 'vitest';
import { createApi } from '../../src';
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
