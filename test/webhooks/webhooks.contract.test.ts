// Contract tests for `webhooks(api)` against the sp-laravel-api-example backend (see contract/README.md).
// Live when SP_CONTRACT_URL is set; otherwise replays test/fixtures/<backend-version>/. With neither a
// backend nor fixtures the whole suite is SKIPPED (never silently passing).
import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import { webhooks } from '../../src/webhooks';
import { liveOrReplay } from '../support/replay';

const { fetch: contractFetch, mode, baseUrl, hasFixtures } = liveOrReplay();
const token = process.env.SP_CONTRACT_TOKEN ?? 'replay-token';

const api = createApi({
  baseUrl,
  fetch: contractFetch,
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
});

describe.skipIf(mode !== 'live' && !hasFixtures)('webhooks contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it('creates an endpoint (secret returned once, never read back), subscribes, lists deliveries, cleans up', async () => {
    const w = webhooks(api);
    const created = await w.endpoints.create({ name: `contract-${Date.now()}`, url: 'https://example.test/hook' });
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.endpoint.id).toBeDefined();
    expect('secret' in created.endpoint).toBe(false);
    try {
      expect('secret' in (await w.endpoints.get(created.endpoint.id))).toBe(false);
      const rotated = await w.endpoints.rotateSecret(created.endpoint.id);
      expect(rotated.secret).not.toBe(created.secret);
      expect('secret' in rotated.endpoint).toBe(false);

      const sub = await w.subscriptions.create({ endpoint_id: created.endpoint.id, table_name: '*', event: 'created' });
      try {
        expect(sub.id).toBeDefined();
      } finally {
        await w.subscriptions.remove(sub.id);
      }
      const deliveries = await w.deliveries.list({ perPage: 5 } as never);
      expect(Array.isArray(deliveries.data)).toBe(true);
    } finally {
      await w.endpoints.remove(created.endpoint.id);
    }
  });
});

// Disabled-module case: needs a host with `webhooks.enabled` off. The tables are plain table routes, so a missing
// table reads as not_found (never module_disabled). Gated on an explicit env flag.
const hooksOff = process.env.SP_CONTRACT_WEBHOOKS_DISABLED === '1';
describe('webhooks disabled contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it.skipIf((mode !== 'live' && !hasFixtures) || !hooksOff)('endpoints.list -> not_found with module webhooks', async () => {
    const e = await webhooks(api)
      .endpoints.list()
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).code).toBe('not_found');
    expect((e as SpApiError).module).toBe('webhooks');
  });
});
