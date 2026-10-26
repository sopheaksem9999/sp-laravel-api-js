// Contract tests for `audit(api)` against the sp-laravel-api-example backend (see contract/README.md).
// Live when SP_CONTRACT_URL is set; otherwise replays test/fixtures/<backend-version>/. With neither a
// backend nor fixtures the whole suite is SKIPPED (never silently passing).
import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import { audit } from '../../src/audit';
import { liveOrReplay } from '../support/replay';

const { fetch: contractFetch, mode, baseUrl, hasFixtures } = liveOrReplay();
const token = process.env.SP_CONTRACT_TOKEN ?? 'replay-token';

const api = createApi({
  baseUrl,
  fetch: contractFetch,
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
});

describe.skipIf(mode !== 'live' && !hasFixtures)('audit contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it('lists audit logs and reads stats', async () => {
    const a = audit(api);
    const page = await a.list({ perPage: 5 } as never);
    expect(Array.isArray(page.data)).toBe(true);
    const stats = await a.stats();
    expect(typeof stats.total).toBe('number');
    expect(typeof stats.by_event).toBe('object');
    expect(typeof stats.by_user).toBe('object');
    expect(typeof stats.by_entity).toBe('object');
  });

  it('reads a field timeline and field stats', async () => {
    const a = audit(api);
    const timeline = await a.fieldTimeline('customers', 1, 'name', { limit: 5 });
    expect(Array.isArray(timeline)).toBe(true);
    const stats = await a.fieldStats('customers', 1, 'name');
    expect(typeof stats.total_changes).toBe('number');
  });
});

// Disabled-module case: needs a host with the audit routes off (the default). Gated on an explicit env flag.
const auditOff = process.env.SP_CONTRACT_AUDIT_DISABLED === '1';
describe('audit disabled contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it.skipIf((mode !== 'live' && !hasFixtures) || !auditOff)('stats -> module_disabled with module audit', async () => {
    const e = await audit(api)
      .stats()
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).code).toBe('module_disabled');
    expect((e as SpApiError).module).toBe('audit');
  });
});
