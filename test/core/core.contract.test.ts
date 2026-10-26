// Contract tests for src/core against the sp-laravel-api-example backend (see contract/README.md).
// Live when SP_CONTRACT_URL is set; otherwise replays test/fixtures/<backend-version>/. With neither a
// backend nor fixtures the whole suite is SKIPPED (never silently passing). Auth is a seeded bearer
// token (SP_CONTRACT_TOKEN, from contract/.env), not @sopheak/sp-jwt-auth.
import { describe, expect, it } from 'vitest';
import { createApi } from '../../src';
import { liveOrReplay } from '../support/replay';

const { fetch: contractFetch, mode, baseUrl, hasFixtures } = liveOrReplay();
const table = process.env.SP_CONTRACT_TABLE ?? 'customers';
const token = process.env.SP_CONTRACT_TOKEN ?? 'replay-token';

interface Row {
  id: number;
  name: string;
  total?: number;
}

const urls: URL[] = [];
const recordUrls: typeof fetch = async (input, init) => {
  urls.push(new URL(input instanceof Request ? input.url : String(input)));
  return contractFetch(input, init);
};
const lastUrl = (): URL => urls[urls.length - 1] as URL;

const api = createApi({
  baseUrl,
  fetch: recordUrls,
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
});
const rows = api.table<Row>(table);

describe.skipIf(mode !== 'live' && !hasFixtures)('core contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it('lists page by page to the end via cursor', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const page: Awaited<ReturnType<typeof rows.list>> = await rows.list({ perPage: 2, cursor });
      seen.push(...page.data.map((r) => r.id));
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
  });

  // UNVERIFIED-CONTRACT
  it('creates a row then gets it back', async () => {
    const created = await rows.create({ name: 'Contract Co' });
    const got = await rows.get(created.id);
    expect(got.id).toBe(created.id);
    expect(got.name).toBe('Contract Co');
  });

  // UNVERIFIED-CONTRACT
  it('sends per_page always and cursor=0 for a first cursor page, nothing for neither', async () => {
    await rows.list({ perPage: 3, cursor: null });
    expect(lastUrl().searchParams.get('per_page')).toBe('3');
    expect(lastUrl().searchParams.get('cursor')).toBe('0');
    await rows.list({ perPage: 3 });
    expect(lastUrl().searchParams.has('cursor')).toBe(false);
    expect(lastUrl().searchParams.get('per_page')).toBe('3');
  });

  // UNVERIFIED-CONTRACT: if the backend errors on in.(), change Task 5's empty-`in` to throw unencodable_value.
  it('in.() with an empty array returns 0 rows', async () => {
    const page = await rows.list({ where: { name: { in: [] } }, perPage: 5 });
    expect(lastUrl().searchParams.get('name')).toBe('in.()');
    expect(page.data).toHaveLength(0);
  });

  // UNVERIFIED-CONTRACT
  it('honours two operators on one column via and=(…)', async () => {
    const page = await rows.list({ where: { total: { gte: 100, lt: 500 } }, perPage: 50 });
    expect(lastUrl().searchParams.get('and')).toBe('(total.gte.100,total.lt.500)');
    for (const r of page.data) {
      expect(r.total).toBeGreaterThanOrEqual(100);
      expect(r.total).toBeLessThan(500);
    }
  });

  // UNVERIFIED-CONTRACT
  it('quotes values with commas: eq."Acme, Inc."', async () => {
    const page = await rows.list({ where: { name: 'Acme, Inc.' }, perPage: 5 });
    expect(lastUrl().searchParams.get('name')).toBe('eq."Acme, Inc."');
    expect(page.data.length).toBeGreaterThan(0);
    for (const r of page.data) expect(r.name).toBe('Acme, Inc.');
  });
});
