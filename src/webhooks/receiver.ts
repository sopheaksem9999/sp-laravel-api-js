import { SpApiError } from '../core/errors';

const MODULE = 'webhooks';
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/** Result of `parseWebhook`. */
export interface ParsedWebhook {
  /** Table the event is about (the part of `X-Webhook-Event` before the last dot). */
  table: string;
  /** `created`, `updated` or `deleted` (the part after the last dot). */
  action: string;
  /** The JSON body as sent: the backend sends the record itself (the delete event sends the old record). */
  record: unknown;
}

/** Headers accepted by `parseWebhook`: a Fetch `Headers` or a plain Node-style object (`req.headers`). */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bodyBytes(raw: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof raw === 'string') {
    // copy into a plain ArrayBuffer-backed array (a valid Web Crypto BufferSource)
    return Uint8Array.from(new TextEncoder().encode(raw));
  }
  if (raw instanceof Uint8Array) return Uint8Array.from(raw);
  return null;
}

/**
 * Checks the `X-Webhook-Signature` header of a delivery from the backend. The header is the bare lowercase hex
 * HMAC-SHA256 of the exact raw request body, keyed with the endpoint secret (`hash_hmac('sha256', body, secret)`,
 * `DispatchWebhookJob.php`). Hex digits are accepted in either case; no `sha256=` prefix is accepted because the
 * backend never sends one.
 *
 * Pass the UNPARSED body (a string, or the `Uint8Array`/`Buffer` the framework hands you): a body that was parsed
 * and serialised again has different bytes and fails the check. The comparison is done by
 * `crypto.subtle.verify('HMAC', ...)`, which is constant-time, hence the async result.
 *
 * Returns `false` for anything wrong or unusable: a missing, empty, non-hex, odd-length, wrong-length or
 * whitespace-padded header, an empty secret, or a body that is not a string or `Uint8Array`. It never throws.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  try {
    if (typeof signatureHeader !== 'string' || !HEX_SHA256.test(signatureHeader)) return false;
    if (typeof secret !== 'string' || secret === '') return false;
    const body = bodyBytes(rawBody);
    if (body === null) return false;
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(new TextEncoder().encode(secret)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('HMAC', key, hexToBytes(signatureHeader), body);
  } catch {
    return false;
  }
}

function invalid(message: string): SpApiError {
  // Fixed messages only: the body (which may hold personal data or secrets) never reaches the error.
  return new SpApiError({ status: 400, code: 'unknown', message, module: MODULE });
}

function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers === null || typeof headers !== 'object') throw invalid('Webhook request has no headers');
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() !== name) continue;
    // A repeated header is ambiguous: only a one-entry array is accepted.
    const only = Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
    return typeof only === 'string' ? only : undefined;
  }
  return undefined;
}

/**
 * Reads a delivery: `X-Webhook-Event: {table}.{action}` (split on the LAST dot) and the JSON body. Header names are
 * case-insensitive; `headers` may be a Fetch `Headers` or a Node-style object. A repeated event header (an array with
 * more than one entry, or values joined with `, `) is rejected rather than guessed at.
 * This does NOT verify the signature: call `verifyWebhook` first, with the same raw body.
 *
 * Missing headers (`null`/`undefined`), a missing, repeated or malformed event header, a malformed JSON body, or a body that is not a string or `Uint8Array` throws
 * `SpApiError` with `code: 'unknown'`, `status: 400`, `module: 'webhooks'` and a fixed message; the body text is never
 * included. No network call is made.
 */
export function parseWebhook(o: { headers: WebhookHeaders; rawBody: string | Uint8Array }): ParsedWebhook {
  const event = readHeader(o.headers, 'x-webhook-event');
  const dot = event === undefined ? -1 : event.lastIndexOf('.');
  // A comma means the header was repeated and joined (`a.created, b.updated`); splitting it would mis-read the table.
  if (event === undefined || dot <= 0 || dot === event.length - 1 || event.includes(',')) {
    throw invalid('Webhook request has a missing or malformed X-Webhook-Event header');
  }
  let text: string;
  if (typeof o.rawBody === 'string') text = o.rawBody;
  else if (o.rawBody instanceof Uint8Array) text = new TextDecoder().decode(o.rawBody);
  else throw invalid('Webhook body must be a string or Uint8Array');
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    throw invalid('Webhook body is not valid JSON');
  }
  return { table: event.slice(0, dot), action: event.slice(dot + 1), record };
}
