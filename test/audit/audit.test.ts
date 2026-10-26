import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import type { ApiConfig } from '../../src';
import { audit } from '../../src/audit';

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
}

const json = (data: unknown, meta: Record<string, unknown> = {}, status = 200): Response =>
  new Response(JSON.stringify({ success: true, data, meta }), { status, headers: { 'Content-Type': 'application/json' } });

const fail = (status: number, message = 'nope', extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ success: false, message, ...extra }), { status, headers: { 'Content-Type': 'application/json' } });

function setup(handler: (seen: Seen) => Response = () => json({}), cfg: Partial<ApiConfig> = {}) {
  const calls: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const seen: Seen = { url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers) };
    calls.push(seen);
    return handler(seen);
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api', fetch: fetchFn, ...cfg });
  return { calls, audit: audit(api) };
}

const catchErr = async (p: Promise<unknown>): Promise<SpApiError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SpApiError);
  return e as SpApiError;
};

describe('audit.list', () => {
  it('lists sp_audit_logs through the table core and exposes no write methods', async () => {
    const { calls, audit: a } = setup(() => json([{ id: 1, event: 'created' }], {}));
    const page = await a.list({ where: { event: 'created' }, include: ['user'] } as never);
    expect(page.data).toEqual([{ id: 1, event: 'created' }]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/sp_audit_logs');
    const keys = Object.keys(a).sort();
    expect(keys).toEqual(['fieldStats', 'fieldTimeline', 'list', 'stats']);
  });
});

describe('audit.stats', () => {
  it('sends camel -> snake params, GET sp_audit_logs/rpc/stats', async () => {
    const stats = { total: 3, by_event: { created: 3 }, by_user: { '1': 3 }, by_entity: { invoices: 3 } };
    const { calls, audit: a } = setup(() => json(stats));
    const r = await a.stats({ startDate: '2026-01-01', endDate: '2026-02-01', userId: 5, entityType: 'invoices', event: 'created' });
    expect(r).toEqual(stats);
    const u = calls[0]?.url as URL;
    expect(calls[0]?.method).toBe('GET');
    expect(u.pathname).toBe('/api/sp_audit_logs/rpc/stats');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-02-01',
      user_id: '5',
      entity_type: 'invoices',
      event: 'created',
    });
  });

  it('sends no query when called without options', async () => {
    const { calls, audit: a } = setup();
    await a.stats();
    expect(calls[0]?.url.search).toBe('');
  });

  it('never sends tenant_id, even when a caller sneaks one in; tenant goes in the header only when configured', async () => {
    const withTenant = setup(() => json({}), { tenant: { header: 'X-Tenant-ID', value: () => 't1' } });
    await withTenant.audit.stats({ event: 'updated', tenant_id: 'other', tenantId: 'other' } as never);
    expect(withTenant.calls[0]?.url.searchParams.has('tenant_id')).toBe(false);
    expect(withTenant.calls[0]?.url.searchParams.has('tenantId')).toBe(false);
    expect([...(withTenant.calls[0]?.url.searchParams.keys() ?? [])]).toEqual(['event']);
    expect(withTenant.calls[0]?.headers.get('X-Tenant-ID')).toBe('t1');

    const none = setup();
    await none.audit.stats({});
    expect(none.calls[0]?.headers.has('X-Tenant-ID')).toBe(false);
  });

  it('honours a custom rpcPrefix, and none when it is empty', async () => {
    const a = setup(() => json({}), { rpcPrefix: 'fn' });
    await a.audit.stats();
    expect(a.calls[0]?.url.pathname).toBe('/api/sp_audit_logs/fn/stats');
    const b = setup(() => json({}), { rpcPrefix: '' });
    await b.audit.stats();
    expect(b.calls[0]?.url.pathname).toBe('/api/sp_audit_logs/stats');
  });

  it('missing tenant header surfaces as tenant_required (422)', async () => {
    const { audit: a } = setup(() => fail(422, 'invalid', { errors: { 'X-Tenant-ID': ['header X-Tenant-ID cannot be empty'] } }), {
      tenant: { header: 'X-Tenant-ID', value: () => null },
    });
    const e = await catchErr(a.stats());
    expect(e.code).toBe('tenant_required');
    expect(e.module).toBe('audit');
  });

  it('403 -> forbidden, 401 -> unauthenticated, both carry module audit', async () => {
    const e403 = await catchErr(setup(() => fail(403)).audit.stats());
    expect(e403.code).toBe('forbidden');
    expect(e403.module).toBe('audit');
    const e401 = await catchErr(setup(() => fail(401)).audit.fieldTimeline('invoices', 1, 'status'));
    expect(e401.code).toBe('unauthenticated');
    expect(e401.module).toBe('audit');
  });

  it('a 404 on a function route is module_disabled (module audit)', async () => {
    const { audit: a } = setup(() => fail(404));
    for (const p of [a.stats(), a.fieldTimeline('invoices', 1, 'status'), a.fieldStats('invoices', 1, 'status')]) {
      const e = await catchErr(p);
      expect(e.code).toBe('module_disabled');
      expect(e.module).toBe('audit');
    }
  });
});

describe('audit.fieldTimeline / fieldStats', () => {
  it('fieldTimeline: GET sp_audit_logs/rpc/field-timeline/{type}/{id}/{field}?limit=', async () => {
    const rows = [{ audit_log_id: 9, event: 'updated', user_id: 1, created_at: 'x', old_value: 'a', new_value: 'b' }];
    const { calls, audit: a } = setup(() => json(rows));
    const r = await a.fieldTimeline('invoices', 42, 'status', { limit: 10 });
    expect(r).toEqual(rows);
    expect(calls[0]?.url.pathname).toBe('/api/sp_audit_logs/rpc/field-timeline/invoices/42/status');
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ limit: '10' });
  });

  it('fieldTimeline without a limit sends no query', async () => {
    const { calls, audit: a } = setup(() => json([]));
    await a.fieldTimeline('invoices', 42, 'status');
    expect(calls[0]?.url.search).toBe('');
  });

  it('a UUID entityId is sent as a string path segment', async () => {
    const id = '0b9f2f4e-6c1f-4f7e-9d3a-1c2b3d4e5f60';
    const { calls, audit: a } = setup(() => json([]));
    await a.fieldTimeline('invoices', id, 'status');
    await a.fieldStats('invoices', id, 'status');
    expect(calls[0]?.url.pathname).toBe(`/api/sp_audit_logs/rpc/field-timeline/invoices/${id}/status`);
    expect(calls[1]?.url.pathname).toBe(`/api/sp_audit_logs/rpc/field-stats/invoices/${id}/status`);
  });

  it('fieldStats: GET .../field-stats/{type}/{id}/{field} and returns the stats shape', async () => {
    const stats = { total_changes: 2, changed_by_users: { '1': 2 }, value_frequency: { b: 2 }, current_value: 'b', first_changed_at: 'x', last_changed_at: 'y' };
    const { calls, audit: a } = setup(() => json(stats));
    expect(await a.fieldStats('invoices', 42, 'status')).toEqual(stats);
    expect(calls[0]?.url.pathname).toBe('/api/sp_audit_logs/rpc/field-stats/invoices/42/status');
    expect(calls[0]?.url.search).toBe('');
  });

  it('encodes special characters in each path segment', async () => {
    const { calls, audit: a } = setup(() => json([]));
    await a.fieldTimeline('App\\Models\\Inv oice', 'a/b?c', 'na me#x');
    expect(calls[0]?.url.pathname).toBe('/api/sp_audit_logs/rpc/field-timeline/App%5CModels%5CInv%20oice/a%2Fb%3Fc/na%20me%23x');
  });

  it('errors from fieldStats carry module audit', async () => {
    const e = await catchErr(setup(() => fail(403)).audit.fieldStats('invoices', 1, 'status'));
    expect(e.module).toBe('audit');
    expect(e.code).toBe('forbidden');
  });
});
