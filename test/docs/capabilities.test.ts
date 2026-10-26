import { describe, expect, expectTypeOf, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import type { ApiConfig } from '../../src';
import { capabilities } from '../../src/docs';
import type { Capabilities } from '../../src/docs';

interface Seen {
  url: URL;
}

function setup(handler: () => Response | Promise<Response>, cfg: Partial<ApiConfig> = {}) {
  const calls: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push({ url: new URL(String(input)) });
    return handler();
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api/v2', fetch: fetchFn, ...cfg });
  return { calls, api };
}

const okDoc = (doc: unknown): Response =>
  new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/vnd.oai.openapi+json; charset=utf-8' } });

/**
 * Paths shaped like OpenApiService::paths()/rpcPaths(): `/{apiPrefix}/{table}`, `/{apiPrefix}/{table}/{id}`,
 * `/{apiPrefix}/{table}/bulk/{op}`, `/{apiPrefix}/{table}/{rpc}/{fn}` (no `{rpc}` segment when the prefix is '').
 */
function docWith(rpc: string, modules: { bulk?: boolean; attachments?: boolean; direct?: boolean; audit?: boolean; webhooks?: boolean; permissions?: boolean; realtime?: boolean }) {
  const fn = (table: string, name: string) => `/api/v2/${table}/${rpc === '' ? '' : `${rpc}/`}${name}`;
  const paths: Record<string, unknown> = {
    '/api/v2/invoices': { get: {} },
    '/api/v2/invoices/{id}': { get: {} },
    '/api/v2/invoices/upsert': { post: {} },
    // Documented whenever canUpsert, even with bulk operations off (OpenApiService ~L1540): not a bulk signal.
    '/api/v2/invoices/bulk/upsert': { post: {} },
    [fn('invoices', 'approve')]: { post: {} },
  };
  if (modules.bulk === true) {
    paths['/api/v2/invoices/bulk/create'] = { post: {} };
    paths['/api/v2/invoices/bulk/update'] = { post: {} };
    paths['/api/v2/invoices/bulk/delete'] = { post: {} };
  }
  if (modules.attachments === true) {
    paths['/api/v2/sp_attachments/{id}'] = { get: {} };
    paths[fn('sp_attachments', 'upload')] = { post: {} };
    paths[fn('sp_attachments', 'folders')] = { get: {} };
  }
  if (modules.direct === true) {
    paths[fn('sp_attachments', 'create-upload-url')] = { post: {} };
    paths[fn('sp_attachments', 'create-multipart-upload')] = { post: {} };
  }
  if (modules.audit === true) {
    paths['/api/v2/sp_audit_logs'] = { get: {} };
    paths[fn('sp_audit_logs', 'stats')] = { get: {} };
  }
  if (modules.webhooks === true) {
    paths['/api/v2/sp_webhook_endpoints'] = { get: {}, post: {} };
    paths['/api/v2/sp_webhook_subscriptions'] = { get: {}, post: {} };
    paths['/api/v2/sp_webhook_deliveries'] = { get: {} };
  }
  if (modules.permissions === true) {
    paths['/api/v2/sp_roles'] = { get: {}, post: {} };
    paths['/api/v2/sp_permissions'] = { get: {} };
  }
  const doc: Record<string, unknown> = { openapi: '3.0.3', info: {}, paths, components: { schemas: {} } };
  if (modules.realtime === true) doc['x-sp-realtime'] = { version: '1.0', transport: 'laravel-broadcasting', channels: [] };
  return doc;
}

const ALL = { bulk: true, attachments: true, direct: true, audit: true, webhooks: true, permissions: true, realtime: true };

describe('capabilities', () => {
  it("returns 'unknown' when the docs are private (404)", async () => {
    const { api } = setup(() => new Response(JSON.stringify({ success: false, message: 'Not Found' }), { status: 404 }));
    expect(await capabilities(api)).toBe('unknown');
  });

  it("returns 'unknown' on a network failure and on a timeout (never throws for those)", async () => {
    const { api } = setup(() => {
      throw new TypeError('fetch failed');
    });
    expect(await capabilities(api)).toBe('unknown');
    // never answers; rejects when the requester's timeout aborts it
    const hang = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const slow = createApi({ baseUrl: 'https://host.test/api/v2', fetch: hang, timeoutMs: 5 });
    expect(await capabilities(slow)).toBe('unknown');
  });

  it("returns 'unknown' when the body is not an OpenAPI document", async () => {
    const { api } = setup(() => new Response('<html>hi</html>', { status: 200 }));
    expect(await capabilities(api)).toBe('unknown');
  });

  it('rethrows 401 / 403 / 5xx as typed SpApiError with module docs', async () => {
    for (const [status, code] of [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [500, 'server'],
    ] as const) {
      const { api } = setup(() => new Response(JSON.stringify({ message: 'x' }), { status }));
      const e = await capabilities(api).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SpApiError);
      expect(e).toMatchObject({ code, module: 'docs', status });
    }
  });

  it('reports audit: false when no audit path exists (and every other absent module false)', async () => {
    const { api, calls } = setup(() => okDoc(docWith('rpc', {})));
    const caps = await capabilities(api);
    expect(caps).toEqual({
      docs: true,
      bulk: false,
      attachments: false,
      directUpload: false,
      audit: false,
      permissions: false,
      webhooks: false,
      realtime: 'unknown',
    });
    expect(calls[0]?.url.href).toBe('https://host.test/api/v2/docs/openapi.json');
  });

  it('reports every module present (default rpc prefix)', async () => {
    const { api } = setup(() => okDoc(docWith('rpc', ALL)));
    expect(await capabilities(api)).toEqual({
      docs: true,
      bulk: true,
      attachments: true,
      directUpload: true,
      audit: true,
      permissions: true,
      webhooks: true,
      realtime: true,
    });
  });

  it("honours rpcPrefix 't'", async () => {
    const { api } = setup(() => okDoc(docWith('t', { attachments: true, direct: false, audit: true })), { rpcPrefix: 't' });
    const caps = (await capabilities(api)) as Capabilities;
    expect(caps.attachments).toBe(true);
    expect(caps.directUpload).toBe(false);
    expect(caps.audit).toBe(true);
    expect(caps.bulk).toBe(false);
  });

  it("honours rpcPrefix '' (no segment)", async () => {
    const { api } = setup(() => okDoc(docWith('', { attachments: true, direct: true })), { rpcPrefix: '' });
    const caps = (await capabilities(api)) as Capabilities;
    expect(caps.attachments).toBe(true);
    expect(caps.directUpload).toBe(true);
  });

  it('does not match the upload function under the wrong rpc prefix', async () => {
    // the host uses 't' but the client is configured with the default 'rpc'
    const { api } = setup(() => okDoc(docWith('t', { attachments: true })));
    expect(((await capabilities(api)) as Capabilities).attachments).toBe(false);
  });

  it('is cached per api instance; refresh: true refetches; another instance fetches its own', async () => {
    let n = 0;
    const { api, calls } = setup(() => okDoc(docWith('rpc', n++ === 0 ? {} : { audit: true })));
    expect(((await capabilities(api)) as Capabilities).audit).toBe(false);
    expect(((await capabilities(api)) as Capabilities).audit).toBe(false);
    expect(calls).toHaveLength(1);
    expect(((await capabilities(api, { refresh: true })) as Capabilities).audit).toBe(true);
    expect(calls).toHaveLength(2);
    expect(((await capabilities(api)) as Capabilities).audit).toBe(true);
    expect(calls).toHaveLength(2);

    const other = setup(() => okDoc(docWith('rpc', {})));
    await capabilities(other.api);
    expect(other.calls).toHaveLength(1);
  });

  it("caches the private-docs 'unknown' but not a network 'unknown' or a thrown error", async () => {
    const priv = setup(() => new Response('{}', { status: 404 }));
    await capabilities(priv.api);
    await capabilities(priv.api);
    expect(priv.calls).toHaveLength(1);

    let fail = true;
    const flaky = setup(() => {
      if (fail) throw new TypeError('offline');
      return okDoc(docWith('rpc', { audit: true }));
    });
    expect(await capabilities(flaky.api)).toBe('unknown');
    fail = false;
    expect(((await capabilities(flaky.api)) as Capabilities).audit).toBe(true);
    expect(flaky.calls).toHaveLength(2);

    let status = 401;
    const auth = setup(() => (status === 401 ? new Response('{}', { status }) : okDoc(docWith('rpc', {}))));
    await capabilities(auth.api).catch(() => undefined);
    status = 200;
    expect(await capabilities(auth.api)).not.toBe('unknown');
    expect(auth.calls).toHaveLength(2);
  });

  it('honours signal (an abort is rethrown, not reported as unknown)', async () => {
    const ac = new AbortController();
    const reason = new Error('stop');
    ac.abort(reason);
    const { api } = setup(() => okDoc(docWith('rpc', {})));
    await expect(capabilities(api, { signal: ac.signal })).rejects.toBe(reason);
  });

  it('is typed', () => {
    expectTypeOf(capabilities).returns.resolves.toEqualTypeOf<Capabilities | 'unknown'>();
    expectTypeOf<Capabilities['audit']>().toEqualTypeOf<boolean>();
    expectTypeOf<Capabilities['realtime']>().toEqualTypeOf<true | 'unknown'>();
  });
});
