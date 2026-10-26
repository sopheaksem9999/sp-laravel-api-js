// Contract tests for `permissions(api)` against the sp-laravel-api-example backend (see contract/README.md).
// Live when SP_CONTRACT_URL is set; otherwise replays test/fixtures/<backend-version>/. With neither a
// backend nor fixtures the whole suite is SKIPPED (never silently passing).
import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import { permissions } from '../../src/permissions';
import { liveOrReplay } from '../support/replay';

const { fetch: contractFetch, mode, baseUrl, hasFixtures } = liveOrReplay();
const token = process.env.SP_CONTRACT_TOKEN ?? 'replay-token';

const api = createApi({
  baseUrl,
  fetch: contractFetch,
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
});

describe.skipIf(mode !== 'live' && !hasFixtures)('permissions contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it('creates a role, assigns then detaches a permission, and removes the role', async () => {
    const p = permissions(api);
    const list = await p.permissions.list({ perPage: 2 } as never);
    expect(list.data.length).toBeGreaterThanOrEqual(1);
    const perm = list.data[0];
    if (perm === undefined) throw new Error('no permission rows');

    const role = await p.roles.create({ name: `contract-role-${Date.now()}` });
    expect(role.id).toBeDefined();
    try {
      await p.assign(role.id, [perm.id]);
      const attached = await p.roles.get(role.id, { select: ['id', { permissions: ['id'] }] } as never);
      expect(JSON.stringify(attached)).toContain(String(perm.id));

      await p.detach(role.id, [perm.id]);
      const after = await p.roles.get(role.id, { select: ['id', { permissions: ['id'] }] } as never);
      expect((after.permissions ?? []).length).toBe(0);
      // detach removes the link only: the permission row survives
      expect((await p.permissions.get(perm.id)).id).toBe(perm.id);
    } finally {
      await p.roles.remove(role.id);
    }
  });

  it('assign on a missing role -> not_found with module permissions', async () => {
    const e = await permissions(api)
      .assign(999999999, [1])
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).code).toBe('not_found');
    expect((e as SpApiError).module).toBe('permissions');
  });
});
