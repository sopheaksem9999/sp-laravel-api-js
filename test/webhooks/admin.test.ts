import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { SpApiError, createApi } from '../../src';
import type { Table } from '../../src';
import { webhooks } from '../../src/webhooks';
import type { Delivery, Endpoint, Subscription } from '../../src/webhooks';

interface Seen {
  url: URL;
  method: string;
  body: Record<string, unknown> | undefined;
}

const json = (data: unknown, meta: Record<string, unknown> = {}, status = 200): Response =>
  new Response(JSON.stringify({ success: true, data, meta }), { status, headers: { 'Content-Type': 'application/json' } });

const fail = (status: number): Response =>
  new Response(JSON.stringify({ success: false, message: 'nope' }), { status, headers: { 'Content-Type': 'application/json' } });

function setup(handler: (seen: Seen) => Response) {
  const calls: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const seen: Seen = { url: new URL(String(input)), method: init?.method ?? 'GET', body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : undefined };
    calls.push(seen);
    return handler(seen);
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api', fetch: fetchFn });
  return { calls, w: webhooks(api) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const HEX64 = /^[0-9a-f]{64}$/;

describe('webhooks.endpoints.create', () => {
  it('without a secret generates 64 hex chars from 32 random bytes, sends it, returns it once', async () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
      a.forEach((_, i) => {
        a[i] = i + 1;
      });
      return a;
    }) as never);
    // the backend hides `secret` on every read, including the create response (L11)
    const { calls, w } = setup((s) => (s.method === 'POST' ? json({ id: 'e1', name: 'n', url: 'https://r.test/h', is_active: true }) : json({ id: 'e1', name: 'n', url: 'https://r.test/h' })));
    const r = await w.endpoints.create({ name: 'n', url: 'https://r.test/h' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]?.[0] as Uint8Array).length).toBe(32);
    const expected = Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).join('');
    expect(r.secret).toBe(expected);
    expect(r.secret).toMatch(HEX64);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/sp_webhook_endpoints');
    expect(calls[0]?.body).toEqual({ name: 'n', url: 'https://r.test/h', secret: expected });
    expect(r.endpoint).toEqual({ id: 'e1', name: 'n', url: 'https://r.test/h', is_active: true });
    expect('secret' in r.endpoint).toBe(false);

    const later = await w.endpoints.get('e1');
    expect('secret' in later).toBe(false);
    // Restore here too: under Bun (spec §7 runtime matrix) the afterEach vi.restoreAllMocks() leaves this spy on
    // Bun's non-configurable Crypto.prototype.getRandomValues in place, and the next tests get the fixed bytes.
    spy.mockRestore();
  });

  it('generates a different secret each time with the real Web Crypto', async () => {
    const { w } = setup(() => json({ id: 'e1' }));
    const a = await w.endpoints.create({ url: 'https://r.test/h' });
    const b = await w.endpoints.create({ url: 'https://r.test/h' });
    expect(a.secret).toMatch(HEX64);
    expect(b.secret).toMatch(HEX64);
    expect(a.secret).not.toBe(b.secret);
  });

  it('with a secret uses it and does not call getRandomValues', async () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const { calls, w } = setup(() => json({ id: 'e1', url: 'u' }));
    const r = await w.endpoints.create({ url: 'u', secret: 'mine' });
    expect(r.secret).toBe('mine');
    expect(calls[0]?.body).toEqual({ url: 'u', secret: 'mine' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('an empty secret is treated as absent (a generated one is sent)', async () => {
    const { calls, w } = setup(() => json({ id: 'e1' }));
    const r = await w.endpoints.create({ url: 'u', secret: '' });
    expect(r.secret).toMatch(HEX64);
    expect(calls[0]?.body?.secret).toBe(r.secret);
  });

  it('a failed create throws SpApiError with module webhooks and returns no secret', async () => {
    const { w } = setup(() => fail(422));
    const e = await w.endpoints.create({ url: 'u' }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).code).toBe('validation');
    expect((e as SpApiError).module).toBe('webhooks');
  });
});

describe('webhooks.endpoints.rotateSecret', () => {
  it('generates a new secret, sends it with PUT, returns { endpoint, secret }', async () => {
    const { calls, w } = setup(() => json({ id: 'e1', url: 'u' }));
    const r = await w.endpoints.rotateSecret('e1');
    expect(r.secret).toMatch(HEX64);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url.pathname).toBe('/api/sp_webhook_endpoints/e1');
    expect(calls[0]?.body).toEqual({ secret: r.secret });
    expect(r.endpoint).toEqual({ id: 'e1', url: 'u' });
    const r2 = await w.endpoints.rotateSecret('e1');
    expect(r2.secret).not.toBe(r.secret);
  });
});

describe('webhooks.endpoints reads strip `secret` from older hosts', () => {
  const leaky = { id: 'e1', url: 'u', secret: 'LEAK' };

  it('list, get, update and patch drop secret', async () => {
    const { w } = setup((s) => (s.url.pathname.endsWith('/sp_webhook_endpoints') && s.method === 'GET' ? json([leaky, { id: 'e2', secret: 'LEAK2' }]) : json(leaky)));
    const page = await w.endpoints.list();
    expect(JSON.stringify(page.data)).not.toContain('LEAK');
    expect(page.data).toEqual([{ id: 'e1', url: 'u' }, { id: 'e2' }]);
    expect(await w.endpoints.get('e1')).toEqual({ id: 'e1', url: 'u' });
    expect(await w.endpoints.update('e1', { name: 'x' })).toEqual({ id: 'e1', url: 'u' });
    expect(await w.endpoints.patch('e1', { name: 'x' })).toEqual({ id: 'e1', url: 'u' });
  });

  it('create strips a secret echoed back by an older host and still returns the client one', async () => {
    const { w } = setup(() => json({ id: 'e1', secret: 'ECHO' }));
    const r = await w.endpoints.create({ url: 'u', secret: 'mine' });
    expect(r.endpoint).toEqual({ id: 'e1' });
    expect(r.secret).toBe('mine');
  });

  it('update with a secret body is passed through to the backend', async () => {
    const { calls, w } = setup(() => json({ id: 'e1' }));
    await w.endpoints.update('e1', { secret: 'new' });
    expect(calls[0]?.body).toEqual({ secret: 'new' });
  });

  it('remove and restore pass through; errors carry module webhooks', async () => {
    const { calls, w } = setup((s) => (s.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ restored: 1 })));
    expect(await w.endpoints.remove('e1')).toEqual({ deleted: true });
    expect(calls[0]?.method).toBe('DELETE');
    expect(await w.endpoints.restore('e1')).toEqual({ restored: 1 });
    expect(calls[1]?.url.pathname).toBe('/api/sp_webhook_endpoints/e1/restore');
  });

  it('a 404 is not_found (plain table route, not module_disabled), module webhooks', async () => {
    const { w } = setup(() => fail(404));
    const e = (await w.endpoints.list().then(
      () => null,
      (x: unknown) => x,
    )) as SpApiError;
    expect(e).toBeInstanceOf(SpApiError);
    expect(e.code).toBe('not_found');
    expect(e.module).toBe('webhooks');
  });
});

describe('webhooks.subscriptions', () => {
  it('is the full sp_webhook_subscriptions table', async () => {
    const { calls, w } = setup(() => json({ id: 's1', endpoint_id: 'e1', table_name: '*', event: 'created' }));
    expect(typeof w.subscriptions.create).toBe('function');
    expect(typeof w.subscriptions.update).toBe('function');
    expect(typeof w.subscriptions.remove).toBe('function');
    await w.subscriptions.create({ endpoint_id: 'e1', table_name: '*', event: 'created' });
    expect(calls[0]?.url.pathname).toBe('/api/sp_webhook_subscriptions');
    expect(calls[0]?.body).toEqual({ endpoint_id: 'e1', table_name: '*', event: 'created' });
    expectTypeOf(w.subscriptions).toEqualTypeOf<Table<Subscription>>();
  });

  it('errors carry module webhooks', async () => {
    const { w } = setup(() => fail(403));
    const e = (await w.subscriptions.list().then(
      () => null,
      (x: unknown) => x,
    )) as SpApiError;
    expect(e.code).toBe('forbidden');
    expect(e.module).toBe('webhooks');
  });
});

describe('webhooks.deliveries is read-only', () => {
  it('exposes only list and get (runtime and type)', async () => {
    const { calls, w } = setup(() => json([{ id: 'd1', endpoint_id: 'e1', event: 'a.created', status: 'success' }]));
    expect(Object.keys(w.deliveries).sort()).toEqual(['get', 'list']);
    for (const k of ['create', 'update', 'patch', 'remove', 'restore', 'upsert', 'iterate', 'aggregate', 'api']) {
      expect(k in w.deliveries).toBe(false);
    }
    await w.deliveries.list();
    expect(calls[0]?.url.pathname).toBe('/api/sp_webhook_deliveries');
    expectTypeOf(w.deliveries).toEqualTypeOf<Pick<Table<Delivery>, 'list' | 'get'>>();
    // @ts-expect-error deliveries cannot be created
    void w.deliveries.create;
    // @ts-expect-error deliveries cannot be removed
    void w.deliveries.remove;
  });

  it('typed values', () => {
    expectTypeOf<Subscription['event']>().toEqualTypeOf<'created' | 'updated' | 'deleted' | '*'>();
    expectTypeOf<Endpoint['name']>().toEqualTypeOf<string>();
  });
});
