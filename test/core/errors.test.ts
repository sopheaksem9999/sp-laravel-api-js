import { describe, expect, it } from 'vitest';
import { SpApiError, errorFromResponse, isSpApiError, transportError } from '../../src/index';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('errorFromResponse', () => {
  it('maps status to code', async () => {
    const cases: Array<[number, string]> = [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [422, 'validation'],
      [500, 'server'],
      [502, 'server'],
      [418, 'unknown'],
    ];
    for (const [status, code] of cases) {
      const err = await errorFromResponse(json(status, { message: 'x' }));
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(isSpApiError(err)).toBe(true);
    }
  });

  it('429 reads Retry-After', async () => {
    const err = await errorFromResponse(json(429, { message: 'slow' }, { 'Retry-After': '7' }));
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfter).toBe(7);
  });

  it('enveloped error', async () => {
    const err = await errorFromResponse(
      json(400, {
        success: false,
        error_code: 10004,
        message: 'm',
        errors: [],
        meta: { request_id: 'r1' },
      }),
      { module: 'crm' },
    );
    expect(err.errorCode).toBe(10004);
    expect(err.fieldErrors).toEqual({});
    expect(err.requestId).toBe('r1');
    expect(err.message).toBe('m');
    expect(err.module).toBe('crm');
    expect(err.response).toBeInstanceOf(Response);
  });

  it('plain Laravel error', async () => {
    const err = await errorFromResponse(json(422, { message: 'bad', errors: { a: ['x'] } }));
    expect(err.fieldErrors.a?.[0]).toBe('x');
    expect(err.errorCode).toBeNull();
  });

  it('requestId falls back to X-Request-ID', async () => {
    const err = await errorFromResponse(json(500, { message: 'boom' }, { 'X-Request-ID': 'hdr-1' }));
    expect(err.requestId).toBe('hdr-1');
  });

  it('empty top-level message falls back to errors.message', async () => {
    const err = await errorFromResponse(json(400, { message: '', errors: { message: ['inner'] } }));
    expect(err.message).toBe('inner');
  });

  it('html and empty bodies', async () => {
    const html = await errorFromResponse(new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(html.code).toBe('server');
    expect(html.body).toBe('<html>Bad Gateway</html>');
    expect(html.fieldErrors).toEqual({});
    expect(html.message).not.toBe('');

    const empty = await errorFromResponse(new Response('', { status: 502 }));
    expect(empty.code).toBe('server');
    expect(empty.body).toBeNull();
    expect(empty.fieldErrors).toEqual({});
    expect(empty.message).not.toBe('');
  });

  it('tenant_required', async () => {
    const err = await errorFromResponse(
      json(422, { message: 'x', errors: { 'X-Tenant-ID': ['required'] } }),
      { tenantHeader: 'X-Tenant-ID' },
    );
    expect(err.code).toBe('tenant_required');
    const other = await errorFromResponse(json(422, { message: 'x', errors: { a: ['b'] } }), {
      tenantHeader: 'X-Tenant-ID',
    });
    expect(other.code).toBe('validation');
  });

  it('module_disabled only with disabledOn404', async () => {
    const on = await errorFromResponse(json(404, { message: 'x' }), { disabledOn404: true });
    expect(on.code).toBe('module_disabled');
    const off = await errorFromResponse(json(404, { message: 'x' }));
    expect(off.code).toBe('not_found');
  });
});

describe('completedChunks', () => {
  it('is unset by default and carried when given', () => {
    const base = { status: 500, code: 'server' as const, message: 'x' };
    expect(new SpApiError(base).completedChunks).toBeUndefined();
    expect(new SpApiError({ ...base, completedChunks: 2 }).completedChunks).toBe(2);
  });
});

describe('transportError', () => {
  it('builds a network/timeout error without a response', () => {
    const cause = new Error('down');
    const err = transportError('network', cause, 'crm');
    expect(err).toBeInstanceOf(SpApiError);
    expect(err.code).toBe('network');
    expect(err.status).toBe(0);
    expect(err.response).toBeNull();
    expect(err.module).toBe('crm');
    expect(err.cause).toBe(cause);
    expect(transportError('timeout', cause).code).toBe('timeout');
  });
});
