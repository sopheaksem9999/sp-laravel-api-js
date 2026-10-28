import type { AttemptInfo, LogEntry, LogMode, LogOption, LogRequest } from '../core/log-types';

const REDACTED = '<redacted>';
const MAX_BODY = 2048;
const MARKER = '…[truncated]';
const MAX_ID = 128;

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-csrf-token']);
const SENSITIVE_HEADER_RE = /auth|token|key|secret|cookie|session|csrf|xsrf|password|credential/i;
const URL_HEADERS = new Set(['location', 'content-location', 'referer', 'referrer', 'origin']);
const SENSITIVE_KEYS = new Set(['password', 'secret', 'code', 'otp', 'jwt', 'token', 'apikey', 'accesstoken', 'refreshtoken']);
const SENSITIVE_SUFFIX = /(token|secret|password|apikey)$/;

/** Lower-cased, `-` and `_` removed: equals a listed key, ends with token/secret/password/apikey, or starts with password. */
export function isSensitiveKey(k: string): boolean {
  const n = k.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEYS.has(n) || SENSITIVE_SUFFIX.test(n) || n.startsWith('password');
}

/** Redacts header values by name (case-insensitive), the tenant header and URL-valued headers; `Headers` keys come out lower-case. */
export function redactHeaders(h: Headers | Record<string, string>, tenantHeader?: string | null): Record<string, string> {
  const tenant = tenantHeader == null ? null : tenantHeader.toLowerCase();
  const out: Record<string, string> = {};
  const put = (v: string, k: string): void => {
    const n = k.toLowerCase();
    out[k] = SENSITIVE_HEADERS.has(n) || n === tenant || SENSITIVE_HEADER_RE.test(n) ? REDACTED : URL_HEADERS.has(n) ? redactUrl(v) : v;
  };
  if (h instanceof Headers) h.forEach(put);
  else for (const [k, v] of Object.entries(h)) put(String(v), k);
  return out;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A query key is sensitive when it, or any bracket segment (`user[password]`), is. */
function isSensitiveQueryKey(rawKey: string): boolean {
  const key = decode(rawKey);
  return isSensitiveKey(key) || key.split(/[[\]]/).some((s) => s !== '' && isSensitiveKey(s));
}

function redactQuery(qs: string): string {
  return qs
    .split('&')
    .map((part) => {
      const i = part.indexOf('=');
      return i > 0 && isSensitiveQueryKey(part.slice(0, i)) ? `${part.slice(0, i)}=${REDACTED}` : part;
    })
    .join('&');
}

/** Redacts sensitive query values and credentials in the authority; the path and fragment are kept. */
export function redactUrl(url: string): string {
  const hash = url.indexOf('#');
  const frag = hash < 0 ? '' : url.slice(hash);
  const rest = hash < 0 ? url : url.slice(0, hash);
  const q = rest.indexOf('?');
  const head = (q < 0 ? rest : rest.slice(0, q)).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, `$1${REDACTED}@`);
  return q < 0 ? head + frag : `${head}?${redactQuery(rest.slice(q + 1))}${frag}`;
}

/** Cuts at `max` (default 2048) UTF-16 units (never inside a surrogate pair) and appends a marker. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max;
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return s.slice(0, cut) + MARKER;
}

function walk(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(walk);
  if (typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Object]') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = isSensitiveKey(k) ? REDACTED : walk(x);
    return out;
  }
  return v;
}

function redactString(s: string): string {
  const t = s.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(walk(JSON.parse(s)));
    } catch {
      /* not JSON: fall through */
    }
  }
  return /^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(s) ? redactQuery(s) : s;
}

function describeOpaque(v: unknown): string | undefined {
  if (v instanceof ArrayBuffer) return `<${v.byteLength} bytes>`;
  if (ArrayBuffer.isView(v)) return `<${v.byteLength} bytes>`;
  if (v instanceof FormData || v instanceof Blob) return '<multipart>';
  if (typeof ReadableStream !== 'undefined' && v instanceof ReadableStream) return '<stream>';
  return undefined;
}

/**
 * Redacts and bounds a body for a log entry. Strings holding JSON are parsed, redacted and re-serialised; objects
 * come back as redacted copies unless their JSON exceeds 2048 characters, in which case a truncated string.
 */
export function redactBody(v: unknown, max: number = MAX_BODY): unknown {
  const opaque = describeOpaque(v);
  if (opaque !== undefined) return opaque;
  if (typeof v === 'string') return truncate(redactString(v), max);
  if (v instanceof URLSearchParams) return truncate(redactQuery(v.toString()), max);
  const r = walk(v);
  if (typeof r === 'object' && r !== null) {
    const s = JSON.stringify(r);
    if (s !== undefined && s.length > max) return truncate(s, max);
  }
  return r;
}

/** Host-controlled ids are cleaned before they reach a log line: no control or line-separator characters, at most 128 code points. */
export function sanitiseRequestId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ''))
    .slice(0, MAX_ID)
    .join('')
    .trim();
  return s === '' ? null : s;
}

/** Calls the sink inline; a throw or a rejected returned promise is swallowed so the request is never affected. */
export function deliver(sink: (entry: LogEntry) => unknown, entry: LogEntry): void {
  try {
    Promise.resolve(sink(entry)).catch(() => {});
  } catch {
    /* the sink is the caller's; it must not change the request result */
  }
}

const isTextual = (ct: string | null): boolean => ct === null || ct === '' || /json|text|xml|urlencoded|javascript/i.test(ct);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function responseBodyOf(i: AttemptInfo, res: Response, max: number): unknown {
  if (!isTextual(res.headers.get('content-type'))) {
    const n = Number(res.headers.get('content-length'));
    return res.headers.has('content-length') && Number.isFinite(n) && n >= 0 ? `<${n} bytes>` : undefined;
  }
  if (i.failure != null) return i.failure.body === null ? undefined : redactBody(i.failure.body, max);
  if (i.responseType === 'text' || i.text === undefined || i.text.trim() === '') return undefined;
  const parsed = parseJson(i.text);
  return redactBody(parsed === undefined ? i.text : parsed, max);
}


function safely(f: () => unknown): unknown {
  try {
    return f();
  } catch {
    return '<unavailable>';
  }
}

export interface LoggerOptions {
  /** Receives one entry per HTTP attempt, called inline: keep it quick. A throw or rejected promise is ignored. */
  sink: (entry: LogEntry) => unknown;
  /** Default `'perRequest'`. */
  mode?: LogMode;
  /** Longest body kept in an entry, in UTF-16 code units (default 2048). */
  maxBodyLength?: number;
}

/** Decides whether this request is logged and, if so, returns the per-attempt emitter. Never throws. */
export function startLog(
  opts: LoggerOptions,
  ctx: { method: string; url: string; log: LogOption | undefined; body: unknown; tenantHeader: string | undefined },
): LogRequest | undefined {
  try {
    const { log } = ctx;
    const mode = opts.mode ?? 'perRequest';
    if (mode === 'off' || log === false || (mode === 'perRequest' && log === undefined)) return undefined;
    const max = typeof opts.maxBodyLength === 'number' && opts.maxBodyLength >= 1 ? Math.floor(opts.maxBodyLength) : MAX_BODY;
    const withHeaders = typeof log === 'object' && log.headers === true;
    const withBodies = typeof log === 'object' && log.bodies === true;
    const safeUrl = redactUrl(ctx.url);
    return {
      finish(i) {
        try {
          const res = i.res;
          const failure = i.failure ?? null;
          let requestId: string | null = null;
          let code: string | null = null;
          if (res !== undefined) {
            if (failure !== null) {
              code = failure.code;
              requestId = failure.requestId;
            } else {
              const parsed = i.text === undefined || i.text === '' ? undefined : parseJson(i.text);
              const meta = isObj(parsed) && isObj(parsed.meta) ? parsed.meta.request_id : undefined;
              requestId = (typeof meta === 'string' && meta !== '' ? meta : null) ?? res.headers.get('X-Request-ID');
            }
          } else code = i.kind ?? 'network';
          const entry: LogEntry = {
            method: ctx.method,
            url: safeUrl,
            status: res?.status ?? null,
            durationMs: Math.max(0, Date.now() - i.t0),
            requestId: sanitiseRequestId(requestId),
            attempt: i.attempt,
            code,
            errorCode: failure?.errorCode ?? null,
          };
          if (withHeaders) {
            entry.requestHeaders = redactHeaders(i.sent, ctx.tenantHeader);
            if (res !== undefined) entry.responseHeaders = redactHeaders(res.headers, ctx.tenantHeader);
          }
          if (withBodies) {
            if (ctx.body !== undefined) entry.requestBody = safely(() => redactBody(ctx.body, max));
            if (res !== undefined) {
              const b = safely(() => responseBodyOf(i, res, max));
              if (b !== undefined) entry.responseBody = b;
            }
          }
          deliver(opts.sink, entry);
        } catch {
          /* a logging bug must never change the request result */
        }
      },
    };
  } catch {
    return undefined;
  }
}
