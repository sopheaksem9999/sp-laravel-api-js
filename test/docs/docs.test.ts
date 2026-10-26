import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import type { ApiConfig } from '../../src';
import { docs } from '../../src/docs';

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
}

function setup(handler: (seen: Seen) => Response | Promise<Response>, cfg: Partial<ApiConfig> = {}) {
  const calls: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const seen: Seen = { url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers) };
    calls.push(seen);
    return handler(seen);
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api/v2', fetch: fetchFn, ...cfg });
  return { calls, api, d: docs(api) };
}

const OPENAPI = { openapi: '3.0.3', info: { title: 'x', version: '2.0.0' }, paths: { '/api/v2/invoices': {} } };

// What routes/api.php answers when `record.api_docs.is_private` is true.
const privateDocs = (): Response =>
  new Response(JSON.stringify({ success: false, message: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

const catchErr = async (p: Promise<unknown>): Promise<SpApiError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SpApiError);
  return e as SpApiError;
};

describe('docs.openapi', () => {
  it('GETs docs/openapi.json and returns the (un-enveloped) document', async () => {
    const { calls, d } = setup(
      () =>
        new Response(JSON.stringify(OPENAPI), {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.oai.openapi+json; charset=utf-8' },
        }),
    );
    expect(await d.openapi()).toEqual(OPENAPI);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.href).toBe('https://host.test/api/v2/docs/openapi.json');
  });

  it('sends the auth and tenant headers like every other call', async () => {
    const { calls, d } = setup(() => new Response(JSON.stringify(OPENAPI), { status: 200 }), {
      auth: { getHeaders: async () => ({ Authorization: 'Bearer t0k' }) },
      tenant: { header: 'X-Company-ID', value: () => 5 },
    });
    await d.openapi();
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer t0k');
    expect(calls[0]?.headers.get('X-Company-ID')).toBe('5');
  });

  it('404 (docs private) -> module_disabled with module docs', async () => {
    const { d } = setup(privateDocs);
    const e = await catchErr(d.openapi());
    expect(e.code).toBe('module_disabled');
    expect(e.module).toBe('docs');
    expect(e.status).toBe(404);
  });

  it('5xx (generation failed) -> server with module docs', async () => {
    const { d } = setup(
      () => new Response(JSON.stringify({ error: 'Failed to generate OpenAPI specification', message: 'boom' }), { status: 500 }),
    );
    const e = await catchErr(d.openapi());
    expect(e.code).toBe('server');
    expect(e.module).toBe('docs');
    expect(e.message).toBe('boom');
  });

  it('honours signal', async () => {
    const ac = new AbortController();
    const reason = new Error('stop');
    ac.abort(reason);
    const { calls, d } = setup(() => new Response('{}'));
    await expect(d.openapi({ signal: ac.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(0);
  });
});

describe('docs.llms', () => {
  it('GETs docs/llms.txt and returns the markdown text', async () => {
    const text = '# SP Laravel API Agent Contract\n\nThis API is private/internal.\n';
    const { calls, d } = setup(() => new Response(text, { status: 200, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }));
    const r = await d.llms();
    expect(r).toBe(text);
    expect(typeof r).toBe('string');
    expect(calls[0]?.url.href).toBe('https://host.test/api/v2/docs/llms.txt');
  });

  it('returns the text verbatim even when it happens to be valid JSON', async () => {
    const { d } = setup(() => new Response('{"success":true,"data":1}', { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
    expect(await d.llms()).toBe('{"success":true,"data":1}');
  });

  it('404 (docs private) -> module_disabled with module docs', async () => {
    const { d } = setup(privateDocs);
    const e = await catchErr(d.llms());
    expect(e.code).toBe('module_disabled');
    expect(e.module).toBe('docs');
  });

  it('401 -> unauthenticated with module docs', async () => {
    const { d } = setup(() => new Response(JSON.stringify({ message: 'Unauthenticated.' }), { status: 401 }));
    const e = await catchErr(d.llms());
    expect(e.code).toBe('unauthenticated');
    expect(e.module).toBe('docs');
  });
});
