import { describe, expect, it } from 'vitest';
import { SpApiError } from '../../src';
import { parseWebhook, verifyWebhook } from '../../src/webhooks';

const SECRET = 'whsec_test_secret';
const enc = new TextEncoder();

/** Signs like the backend: lowercase hex HMAC-SHA256 of the body (DispatchWebhookJob.php:78). */
async function sign(body: string | Uint8Array, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = typeof body === 'string' ? enc.encode(body) : Uint8Array.from(body);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

const BODY = '{"id":7,"total":12.5,"note":"héllo"}';

describe('verifyWebhook', () => {
  it('verifies a string body', async () => {
    expect(await verifyWebhook(BODY, await sign(BODY), SECRET)).toBe(true);
  });

  it('verifies a Uint8Array body (UTF-8 bytes)', async () => {
    const bytes = enc.encode(BODY);
    expect(await verifyWebhook(bytes, await sign(bytes), SECRET)).toBe(true);
  });

  it('is case-insensitive on the hex digits', async () => {
    expect(await verifyWebhook(BODY, (await sign(BODY)).toUpperCase(), SECRET)).toBe(true);
  });

  it('a changed byte in the body -> false', async () => {
    const sig = await sign(BODY);
    expect(await verifyWebhook(BODY.replace('12.5', '12.6'), sig, SECRET)).toBe(false);
    const bytes = enc.encode(BODY);
    bytes[3] = (bytes[3] ?? 0) ^ 1;
    expect(await verifyWebhook(bytes, sig, SECRET)).toBe(false);
  });

  it('a wrong secret -> false', async () => {
    expect(await verifyWebhook(BODY, await sign(BODY), 'other')).toBe(false);
  });

  it('an empty secret -> false (even when signed with an empty secret)', async () => {
    expect(await verifyWebhook(BODY, await sign(BODY, SECRET), '')).toBe(false);
  });

  it('a body that is not a string or Uint8Array -> false', async () => {
    const sig = await sign(BODY);
    for (const bad of [null, undefined, 42, {}, [], new ArrayBuffer(4)]) {
      expect(await verifyWebhook(bad as never, sig, SECRET)).toBe(false);
    }
  });

  it('a non-string secret -> false', async () => {
    expect(await verifyWebhook(BODY, await sign(BODY), undefined as never)).toBe(false);
  });

  it('a bad signature header is false and never throws', async () => {
    const good = await sign(BODY);
    const cases: [string, unknown][] = [
      ['missing (undefined)', undefined],
      ['null', null],
      ['empty string', ''],
      ['non-hex', 'z'.repeat(64)],
      ['odd length', good.slice(0, 63)],
      ['too short', good.slice(0, 62)],
      ['too long', `${good}00`],
      ['leading whitespace', ` ${good}`],
      ['trailing whitespace', `${good} `],
      ['trailing newline', `${good}\n`],
      ['inner whitespace', `${good.slice(0, 32)} ${good.slice(32)}`],
      ['only whitespace', '   '],
      ['0x prefix', `0x${good.slice(2)}`],
      ['sha256= prefix (the backend sends bare hex)', `sha256=${good}`],
      ['array (a repeated header)', [good]],
      ['number', 12345],
      ['object', {}],
    ];
    for (const [label, header] of cases) {
      const r = await verifyWebhook(BODY, header as never, SECRET).then(
        (v) => v,
        (e: unknown) => `threw ${String(e)}`,
      );
      expect(r, label).toBe(false);
    }
  });

  it('documents why the raw body is needed: a re-serialised body fails the check', async () => {
    // The backend signs the exact bytes it sent (compact JSON). A framework that parses the body and
    // serialises it again (or pretty-prints it) produces different bytes, so the signature no longer matches.
    const sig = await sign(BODY);
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(JSON.parse(reserialised)).toEqual(JSON.parse(BODY));
    expect(await verifyWebhook(reserialised, sig, SECRET)).toBe(false);
    expect(await verifyWebhook(BODY, sig, SECRET)).toBe(true);
  });
});

describe('parseWebhook', () => {
  const body = '{"id":7,"ref":"INV-1"}';

  it('reads a Fetch Headers object, splitting X-Webhook-Event', () => {
    const headers = new Headers({ 'X-Webhook-Event': 'invoices.created', 'X-Webhook-Signature': 'ab' });
    expect(parseWebhook({ headers, rawBody: body })).toEqual({
      table: 'invoices',
      action: 'created',
      record: { id: 7, ref: 'INV-1' },
    });
  });

  it('reads a Node-style object with mixed-case keys and array values', () => {
    const headers = { 'content-type': 'application/json', 'X-WEBHOOK-event': ['invoices.updated', 'ignored.deleted'], other: undefined };
    const r = parseWebhook({ headers, rawBody: body });
    expect(r.table).toBe('invoices');
    expect(r.action).toBe('updated');
  });

  it('reads a lowercase Node header (req.headers) with a string value', () => {
    expect(parseWebhook({ headers: { 'x-webhook-event': 'orders.deleted' }, rawBody: body }).action).toBe('deleted');
  });

  it('splits on the LAST dot so a table name may contain dots', () => {
    const r = parseWebhook({ headers: { 'x-webhook-event': 'tenant.invoices.created' }, rawBody: body });
    expect(r.table).toBe('tenant.invoices');
    expect(r.action).toBe('created');
  });

  it('decodes a Uint8Array body as UTF-8', () => {
    const bytes = enc.encode('{"name":"héllo 中"}');
    expect(parseWebhook({ headers: { 'x-webhook-event': 't.created' }, rawBody: bytes }).record).toEqual({ name: 'héllo 中' });
  });

  it('the record is the parsed body as sent (the backend sends the record itself, not a wrapper)', () => {
    expect(parseWebhook({ headers: { 'x-webhook-event': 't.deleted' }, rawBody: '[]' }).record).toEqual([]);
  });

  const expectTyped = (fn: () => unknown, secretText: string): void => {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SpApiError);
    const e = caught as SpApiError;
    expect(e.code).toBe('unknown');
    expect(e.status).toBe(400);
    expect(e.module).toBe('webhooks');
    expect(e.message).not.toContain(secretText);
    expect(JSON.stringify(e.body)).not.toContain(secretText);
    expect(e.cause).toBeUndefined();
  };

  it('malformed JSON -> SpApiError unknown/400 with a fixed message and no body text', () => {
    expectTyped(() => parseWebhook({ headers: { 'x-webhook-event': 't.created' }, rawBody: '{"card":"4111-SECRET' }), 'SECRET');
  });

  it('missing or malformed event header -> the same typed error', () => {
    for (const headers of [{}, { 'x-webhook-event': '' }, { 'x-webhook-event': 'nodot' }, { 'x-webhook-event': '.created' }, { 'x-webhook-event': 'invoices.' }]) {
      expectTyped(() => parseWebhook({ headers, rawBody: '{"a":"SECRET"}' }), 'SECRET');
    }
    expectTyped(() => parseWebhook({ headers: new Headers(), rawBody: '{"a":"SECRET"}' }), 'SECRET');
  });

  it('a body that is not a string or Uint8Array -> the typed error', () => {
    expectTyped(() => parseWebhook({ headers: { 'x-webhook-event': 't.created' }, rawBody: { a: 'SECRET' } as never }), 'SECRET');
  });
});
