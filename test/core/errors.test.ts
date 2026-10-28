import { describe, expect, it } from 'vitest';
import { SpApiError, errorFromResponse, isSpApiError, transportError } from '../../src/index';
import { errorFromBody } from '../../src/core/errors';

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

  it('429 with an empty or blank Retry-After has retryAfter null, not 0', async () => {
    for (const v of ['', '   ']) {
      const err = await errorFromResponse(json(429, { message: 'slow' }, { 'Retry-After': v }));
      expect(err.retryAfter).toBeNull();
    }
    expect((await errorFromResponse(json(429, { message: 'slow' }, { 'Retry-After': '0' }))).retryAfter).toBe(0);
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

describe('errorFromBody', () => {
  it('a 3xx maps by status (unknown), not by body error_code', () => {
    const res = new Response('', { status: 302 });
    expect(errorFromBody(res, '{"success":false,"error_code":10002}').code).toBe('unknown');
  });
  it('maps a 200 envelope error_code and keeps status 200', () => {
    const res = new Response('', { status: 200 });
    const e = errorFromBody(res, JSON.stringify({ success: false, error_code: 10008, message: 'nope' }));
    expect(e).toMatchObject({ status: 200, code: 'forbidden', errorCode: 10008, message: 'nope' });
  });
  it('an unlisted or missing error_code is unknown', () => {
    const res = new Response('', { status: 200 });
    expect(errorFromBody(res, '{"success":false}').code).toBe('unknown');
    expect(errorFromBody(res, '{"success":false,"error_code":7}').code).toBe('unknown');
  });
});

describe('isTransport / isHttp', () => {
  it('network and timeout failures are transport, keep the cause and a safe message', () => {
    const cause = new Error('secret-token-abc at https://x.example/?k=1');
    const net = transportError('network', cause);
    expect(net.isTransport).toBe(true);
    expect(net.isHttp).toBe(false);
    expect(net.cause).toBe(cause);
    expect(String(net)).not.toContain('secret-token-abc');
    expect(transportError('timeout', cause).isTransport).toBe(true);
  });
  it('an HTTP error is http, not transport', async () => {
    const err = await errorFromResponse(json(500, { message: 'boom' }, { 'Retry-After': '5', 'X-Secret': 'hdr-secret' }));
    expect(err.isHttp).toBe(true);
    expect(err.isTransport).toBe(false);
    expect(String(err)).toBe('SpApiError: boom');
  });
  it('local status-0 errors are not transport', () => {
    const err = new SpApiError({ status: 0, code: 'unencodable_value', message: 'bad' });
    expect(err.isTransport).toBe(false);
    expect(err.isHttp).toBe(false);
  });
});

describe('retryAfter sources', () => {
  const ra = (body: unknown, headers: Record<string, string> = {}, status = 429) =>
    errorFromBody(new Response('', { status, headers }), JSON.stringify(body));
  it('reads errors.retry_after_seconds in its shapes', () => {
    expect(ra({ errors: { retry_after_seconds: [3193] } }).retryAfter).toBe(3193);
    expect(ra({ errors: { retry_after_seconds: ['3193'] } }).retryAfter).toBe(3193);
    expect(ra({ errors: { retry_after_seconds: 3193 } }).retryAfter).toBe(3193);
    expect(ra({ errors: { retry_after_seconds: [' 7 '] } }).retryAfter).toBe(7);
  });
  it('zero, negative, garbage and empty give null without throwing', () => {
    for (const v of [[], ['abc'], [0], 0, -4, [-1], [''], [null], [{}], 'x']) {
      expect(ra({ errors: { retry_after_seconds: v } }).retryAfter).toBeNull();
    }
  });
  it('keeps fieldErrors.retry_after_seconds, also for a bare number', () => {
    expect(ra({ errors: { retry_after_seconds: 12 } }).fieldErrors.retry_after_seconds).toEqual(['12']);
    expect(ra({ errors: { retry_after_seconds: [3] } }).fieldErrors.retry_after_seconds).toEqual(['3']);
  });
  it('header beats body retry_after beats errors.retry_after_seconds', () => {
    const body = { retry_after: 20, errors: { retry_after_seconds: [30] } };
    expect(ra(body, { 'Retry-After': '10' }).retryAfter).toBe(10);
    expect(ra(body).retryAfter).toBe(20);
    expect(ra({ retry_after: '15' }).retryAfter).toBe(15);
    expect(ra({ errors: { retry_after_seconds: [30] } }).retryAfter).toBe(30);
    expect(ra(body, { 'Retry-After': '0' }).retryAfter).toBe(0);
  });
  it('a garbage header falls through to the body', () => {
    expect(ra({ retry_after: 9 }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }).retryAfter).toBe(9);
  });
  it('a non-429 status carrying Retry-After sets retryAfter', () => {
    expect(ra({}, { 'Retry-After': '30' }, 503).retryAfter).toBe(30);
    expect(ra({}, {}, 503).retryAfter).toBeNull();
  });
  it('applies on the 200 envelope path too', () => {
    const e = ra({ success: false, errors: { retry_after_seconds: ['5'] } }, {}, 200);
    expect(e.retryAfter).toBe(5);
    expect(e.status).toBe(200);
  });
});
