import type { SpApiError } from './errors';

/** Logging switch: `'off'` never logs; `'perRequest'` (default once a logger exists) logs requests that opt in; `'all'` logs every request. */
export type LogMode = 'off' | 'perRequest' | 'all';

/** Per-call opt-in: `true` logs the call; the object form also asks for headers and/or bodies (always redacted). */
export type LogOption = boolean | { headers?: boolean; bodies?: boolean };

/** One HTTP attempt. Headers and bodies are present only when the call asked for them, and are always redacted. */
export interface LogEntry {
  method: string;
  /** Full URL; query values of sensitive keys are redacted. Paths (ids included) are logged verbatim. */
  url: string;
  /** `null` when no response arrived (network failure, timeout, abort). */
  status: number | null;
  durationMs: number;
  /** From the response (`meta.request_id` or `X-Request-ID`), sanitised; `null` when absent. */
  requestId: string | null;
  /** 1-based; a 401 refresh retry or a `RetryConfig` retry is its own entry with the next number. */
  attempt: number;
  /** Error category (`SpApiError.code`, or `'aborted'`); `null` on success. */
  code: string | null;
  errorCode: number | null;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
}

const REDACTED = '<redacted>';
const MAX_BODY = 2048;
const MARKER = '…[truncated]';
const MAX_ID = 128;

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-csrf-token']);
const SENSITIVE_KEYS = new Set(['password', 'accesstoken', 'refreshtoken', 'token', 'code', 'otp', 'secret', 'apikey']);

/** `-`/`_`/case-insensitive match of the listed keys, or any key ending in `_token`. */
function isSensitiveKey(k: string): boolean {
  const lower = k.toLowerCase();
  return SENSITIVE_KEYS.has(lower.replace(/[-_]/g, '')) || lower.replace(/-/g, '_').endsWith('_token');
}

/** Redacts header values by name (case-insensitive) and the tenant header; `Headers` keys come out lower-case. */
export function redactHeaders(h: Headers | Record<string, string>, tenantHeader?: string | null): Record<string, string> {
  const tenant = tenantHeader == null ? null : tenantHeader.toLowerCase();
  const out: Record<string, string> = {};
  const put = (v: string, k: string): void => {
    const n = k.toLowerCase();
    out[k] = SENSITIVE_HEADERS.has(n) || n === tenant ? REDACTED : v;
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

/** Cuts at 2048 UTF-16 units (never inside a surrogate pair) and appends a marker. */
function truncate(s: string): string {
  if (s.length <= MAX_BODY) return s;
  let cut = MAX_BODY;
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
export function redactBody(v: unknown): unknown {
  const opaque = describeOpaque(v);
  if (opaque !== undefined) return opaque;
  if (typeof v === 'string') return truncate(redactString(v));
  if (v instanceof URLSearchParams) return truncate(redactQuery(v.toString()));
  const r = walk(v);
  if (typeof r === 'object' && r !== null) {
    const s = JSON.stringify(r);
    if (s !== undefined && s.length > MAX_BODY) return truncate(s);
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

/** What the request loop knows about one finished attempt. */
export interface AttemptInfo {
  /** 1-based. */
  attempt: number;
  t0: number;
  /** Headers sent on this attempt. */
  sent: Headers;
  res?: Response;
  /** The text the request already read from a 2xx response. */
  text?: string;
  /** The error built from a non-2xx response. */
  failure?: SpApiError | null;
  /** Set when no response arrived. */
  kind?: 'aborted' | 'timeout' | 'network';
  responseType?: string;
}

export interface AttemptLogger {
  now(): number;
  emit(i: AttemptInfo): void;
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

function responseBodyOf(i: AttemptInfo, res: Response): unknown {
  if (!isTextual(res.headers.get('content-type'))) {
    const n = Number(res.headers.get('content-length'));
    return res.headers.has('content-length') && Number.isFinite(n) && n >= 0 ? `<${n} bytes>` : undefined;
  }
  if (i.failure != null) return i.failure.body === null ? undefined : redactBody(i.failure.body);
  if (i.responseType === 'text' || i.text === undefined || i.text.trim() === '') return undefined;
  const parsed = parseJson(i.text);
  return redactBody(parsed === undefined ? i.text : parsed);
}

/**
 * Decides whether this request is logged and, if so, returns the per-attempt emitter; `undefined` means no
 * logging (mode off, not opted in, or any failure while setting up). Never throws.
 */
export function startLog(
  logger: (entry: LogEntry) => unknown,
  mode: LogMode | undefined,
  tenantHeader: string | undefined,
  o: { method: string; log?: LogOption },
  url: string,
  sentBody: unknown,
): AttemptLogger | undefined {
  try {
    const log = o.log;
    const m = mode ?? 'perRequest';
    if (m === 'off' || log === false || (m === 'perRequest' && log === undefined)) return undefined;
    const withHeaders = typeof log === 'object' && log.headers === true;
    const withBodies = typeof log === 'object' && log.bodies === true;
    const safeUrl = redactUrl(url);
    const now = (): number => Date.now();
    return {
      now,
      emit(i) {
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
            method: o.method,
            url: safeUrl,
            status: res?.status ?? null,
            durationMs: Math.max(0, now() - i.t0),
            requestId: sanitiseRequestId(requestId),
            attempt: i.attempt,
            code,
            errorCode: failure?.errorCode ?? null,
          };
          if (withHeaders) {
            entry.requestHeaders = redactHeaders(i.sent, tenantHeader);
            if (res !== undefined) entry.responseHeaders = redactHeaders(res.headers, tenantHeader);
          }
          if (withBodies) {
            if (sentBody !== undefined) entry.requestBody = safely(() => redactBody(sentBody));
            if (res !== undefined) {
              const b = safely(() => responseBodyOf(i, res));
              if (b !== undefined) entry.responseBody = b;
            }
          }
          deliver(logger, entry);
        } catch {
          /* a logging bug must never change the request result */
        }
      },
    };
  } catch {
    return undefined;
  }
}

function safely(f: () => unknown): unknown {
  try {
    return f();
  } catch {
    return '<unavailable>';
  }
}
