import { describe, expect, expectTypeOf, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import type { Table } from '../../src';
import { permissions } from '../../src/permissions';
import type { Permission, Role } from '../../src/permissions';

interface Seen {
  url: URL;
  method: string;
  body: unknown;
}

const json = (data: unknown, meta: Record<string, unknown> = {}, status = 200): Response =>
  new Response(JSON.stringify({ success: true, data, meta }), { status, headers: { 'Content-Type': 'application/json' } });

const fail = (status: number, message = 'nope'): Response =>
  new Response(JSON.stringify({ success: false, message }), { status, headers: { 'Content-Type': 'application/json' } });

function setup(handler: (seen: Seen) => Response = () => json({ id: 3, name: 'admin' })) {
  const calls: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const seen: Seen = { url: new URL(String(input)), method: init?.method ?? 'GET', body: typeof raw === 'string' ? JSON.parse(raw) : undefined };
    calls.push(seen);
    return handler(seen);
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api', fetch: fetchFn });
  return { calls, p: permissions(api) };
}

const catchErr = async (p: Promise<unknown>): Promise<SpApiError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SpApiError);
  return e as SpApiError;
};

describe('permissions.roles / permissions tables', () => {
  it('roles is the full sp_roles table', async () => {
    const { calls, p } = setup(() => json([{ id: 1, name: 'a' }]));
    expect(p.roles.name).toBe('sp_roles');
    await p.roles.list();
    expect(calls[0]?.url.pathname).toBe('/api/sp_roles');
    expect(typeof p.roles.create).toBe('function');
    expect(typeof p.roles.remove).toBe('function');
  });

  it('permissions exposes only list, get and update (runtime and type)', async () => {
    const { calls, p } = setup(() => json([]));
    expect(Object.keys(p.permissions).sort()).toEqual(['get', 'list', 'update']);
    for (const k of ['create', 'remove', 'restore', 'upsert', 'patch', 'iterate', 'aggregate', 'api', 'bulk']) {
      expect(k in p.permissions).toBe(false);
    }
    await p.permissions.list();
    expect(calls[0]?.url.pathname).toBe('/api/sp_permissions');
    await p.permissions.update(5, { description: 'x' });
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.url.pathname).toBe('/api/sp_permissions/5');
    expectTypeOf(p.permissions).toEqualTypeOf<Pick<Table<Permission>, 'list' | 'get' | 'update'>>();
    expectTypeOf(p.roles).toEqualTypeOf<Table<Role>>();
    // @ts-expect-error create is not available on permissions
    void p.permissions.create;
    // @ts-expect-error remove is not available on permissions
    void p.permissions.remove;
  });
});

describe('permissions.assign', () => {
  it('assign(3,[1,2]) is PUT sp_roles/3 with { permissions: [1,2] }', async () => {
    const { calls, p } = setup();
    const r = await p.assign(3, [1, 2]);
    expect(r).toEqual({ id: 3, name: 'admin' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url.pathname).toBe('/api/sp_roles/3');
    expect(calls[0]?.body).toEqual({ permissions: [1, 2] });
  });

  it('deduplicates ids and accepts uuid ids; role id with special characters is encoded', async () => {
    const { calls, p } = setup();
    await p.assign('a/b c', ['u1', 'u2', 'u1', 1, 1]);
    expect(calls[0]?.url.pathname).toBe('/api/sp_roles/a%2Fb%20c');
    expect(calls[0]?.body).toEqual({ permissions: ['u1', 'u2', 1] });
  });

  it('empty ids make no write and resolve the current role with one GET', async () => {
    const { calls, p } = setup();
    const r = await p.assign(3, []);
    expect(r).toEqual({ id: 3, name: 'admin' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/sp_roles/3');
  });

  it('a 404 stays not_found (missing role), with module permissions', async () => {
    const e = await catchErr(setup(() => fail(404)).p.assign(3, [1]));
    expect(e.code).toBe('not_found');
    expect(e.module).toBe('permissions');
  });

  it('403 -> forbidden, 401 -> unauthenticated, module permissions', async () => {
    const e403 = await catchErr(setup(() => fail(403)).p.assign(3, [1]));
    expect(e403.code).toBe('forbidden');
    expect(e403.module).toBe('permissions');
    const e401 = await catchErr(setup(() => fail(401)).p.detach(3, [1]));
    expect(e401.code).toBe('unauthenticated');
    expect(e401.module).toBe('permissions');
  });
});

describe('permissions.detach', () => {
  it('detach(3,[3]) is PUT sp_roles/3 with { permissions: [{ id: 3, _delete: true }] }', async () => {
    const { calls, p } = setup();
    await p.detach(3, [3]);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url.pathname).toBe('/api/sp_roles/3');
    expect(calls[0]?.body).toEqual({ permissions: [{ id: 3, _delete: true }] });
  });

  it('deduplicates ids; empty ids make no write', async () => {
    const { calls, p } = setup();
    await p.detach(3, [4, 4, 5]);
    expect(calls[0]?.body).toEqual({ permissions: [{ id: 4, _delete: true }, { id: 5, _delete: true }] });
    await p.detach(3, []);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe('GET');
  });

  it('a 404 stays not_found', async () => {
    const e = await catchErr(setup(() => fail(404)).p.detach(3, [1]));
    expect(e.code).toBe('not_found');
    expect(e.module).toBe('permissions');
  });
});
