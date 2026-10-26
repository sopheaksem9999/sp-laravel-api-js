// Contract tests for `bulk(table)` against the sp-laravel-api-example backend (see contract/README.md).
// Live when SP_CONTRACT_URL is set; otherwise replays test/fixtures/<backend-version>/. With neither a
// backend nor fixtures the whole suite is SKIPPED (never silently passing).
import { describe, expect, it } from 'vitest';
import { createApi } from '../../src';
import { bulk } from '../../src/bulk';
import { liveOrReplay } from '../support/replay';

const { fetch: contractFetch, mode, baseUrl, hasFixtures } = liveOrReplay();
const table = process.env.SP_CONTRACT_TABLE ?? 'customers';
const token = process.env.SP_CONTRACT_TOKEN ?? 'replay-token';

interface Row {
  id: number;
  name: string;
}

const api = createApi({
  baseUrl,
  fetch: contractFetch,
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
});

describe.skipIf(mode !== 'live' && !hasFixtures)('bulk contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it('creates in two chunks, updates, then deletes', async () => {
    const b = bulk(api.table<Row>(table));
    const created = await b.create([{ name: 'bulk-a' }, { name: 'bulk-b' }, { name: 'bulk-c' }], { chunkSize: 2 });
    if ('queued' in created) throw new Error('expected a synchronous result');
    expect(created.affected).toBe(3);
    expect(created.rows.map((r) => r.name)).toEqual(['bulk-a', 'bulk-b', 'bulk-c']);

    const ids = created.rows.map((r) => r.id);
    const updated = await b.update(ids.map((id) => ({ id, name: `${id}-renamed` })));
    if ('queued' in updated) throw new Error('expected a synchronous result');
    expect(updated.affected).toBe(3);

    const deleted = await b.delete(ids);
    if ('queued' in deleted) throw new Error('expected a synchronous result');
    expect(deleted.affected).toBe(3);
  });

  it('async create answers 202 queued', async () => {
    const r = await bulk(api.table<Row>(table)).create([{ name: 'bulk-async' }], { async: true });
    expect(r).toEqual({ queued: true });
  });
});
