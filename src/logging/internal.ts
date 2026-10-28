import type { AttemptInfo, LogEntry, LogMode, LogOption, LogRequest } from '../core/log-types';

const REDACTED = '<redacted>';
const MAX_BODY = 2048;
const MARKER = '…[truncated]';
const MAX_ID = 128;
/** Deepest nesting of arrays/objects a body may have; a deeper body is logged as `<unavailable>` as a whole. */
const MAX_DEPTH = 100;
const UNAVAILABLE = '<unavailable>';

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-csrf-token']);
const SENSITIVE_HEADER_RE = /auth|token|key|secret|cookie|session|csrf|xsrf|password|credential|signature|pass|otp|jwt|bearer/i;
const URL_HEADERS = new Set(['location', 'content-location', 'referer', 'referrer', 'origin']);
const SENSITIVE_KEYS = new Set([
  'password', 'secret', 'code', 'otp', 'jwt', 'token', 'apikey', 'accesstoken', 'refreshtoken',
  'pin', 'pwd', 'pass', 'sig', 'authorization', 'cookie',
]);
// `credential` is singular on purpose: a `credentials` key holding an object is walked, not redacted whole.
const SENSITIVE_SUFFIX =
  /(tokens?|secrets?|passwords?|passwd|passphrase|passcode|apikeys?|privatekey|secretkey|clientkey|signingkey|encryptionkey|signature|credential|otp|(otp|verification|auth|mfa|reset|recovery|backup)codes?)$/;
/** A PostgREST-style filter group (`or=(...)`, `not.and=(...)`). */
const GROUP_KEY = /^(not\.)?(and|or)$/;
/**
 * Operator words of the SP API filter syntax (the host's `FilterOperatorCatalog`) and the `not.` prefix. In a filter
 * group item `path.op.value` the dotted segments before the first of these are the column path (`sessions.token`).
 */
const OPERATORS: ReadonlySet<string> = new Set([
  'not', 'is', 'is_not', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'not_between',
  'like', 'ilike', 'not_like', 'not_ilike', 'contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with',
  'regex', 'not_regex', 'match', 'not_match', 'imatch', 'not_imatch',
  'date_eq', 'date_neq', 'date_gt', 'date_gte', 'date_lt', 'date_lte', 'empty', 'not_empty',
  'fts', 'not_fts', 'plfts', 'not_plfts', 'phfts', 'not_phfts', 'wfts', 'not_wfts', 'cs', 'not_cs', 'cd', 'not_cd',
  'ov', 'not_ov', 'sl', 'not_sl', 'sr', 'not_sr', 'nxl', 'not_nxl', 'nxr', 'not_nxr', 'adj', 'not_adj',
]);
/** The column of an embed filter inside `select` (`rel(cols,col=op.value)`): the text before `=` after the start, a `(` or a `,`. */
const EMBED_COLUMN = /(?:^|[(,])([^(),=]*)=/g;

/** Lower-cased, `-` and `_` removed: equals a listed key, matches the sensitive suffix, or starts with password. */
export function isSensitiveKey(k: string): boolean {
  const n = k.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEYS.has(n) || SENSITIVE_SUFFIX.test(n) || n.startsWith('password');
}

/** `Link` holds URLs in `<...>`; `Refresh` holds one after `url=` (or is one); other URL-valued headers are a URL. */
function redactHeaderValue(n: string, v: string): string {
  if (URL_HEADERS.has(n)) return redactUrl(v);
  // `[^<>]`, not `[^>]`: with many `<` and no `>` the latter rescans to the end from every `<` (quadratic).
  if (n === 'link') return v.replace(/<([^<>]*)>/g, (_m, u: string) => `<${redactUrl(u)}>`);
  if (n === 'refresh') {
    const m = /url\s*=\s*/i.exec(v);
    return m === null ? redactUrl(v) : v.slice(0, m.index + m[0].length) + redactUrl(v.slice(m.index + m[0].length));
  }
  return v;
}

/** Redacts header values by name (case-insensitive), the tenant header and URL-valued headers; `Headers` keys come out lower-case. */
export function redactHeaders(h: Headers | Record<string, string>, tenantHeader?: string | null): Record<string, string> {
  const tenant = tenantHeader == null ? null : tenantHeader.toLowerCase();
  const out: Record<string, string> = {};
  const put = (v: string, k: string): void => {
    const n = k.toLowerCase();
    out[k] = SENSITIVE_HEADERS.has(n) || n === tenant || SENSITIVE_HEADER_RE.test(n) ? REDACTED : redactHeaderValue(n, v);
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

/**
 * The ECMAScript `\s` class (also Dart's) as code units: TAB to CR, space, U+00A0, U+1680, U+2000-U+200A, U+2028,
 * U+2029, U+202F, U+205F, U+3000, U+FEFF. A test checks it against `/\s/` for every BMP code unit.
 */
export function isSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** Removes leading and trailing `\s` characters with two linear scans (a `\s+$` regex is quadratic on inner runs). */
function strip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s.charCodeAt(a))) a++;
  while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** Whether any (trimmed) segment of a column path (`sessions.pin`) is a sensitive key. */
function isSensitivePath(segments: string[]): boolean {
  return segments.some((s) => {
    const t = strip(s);
    return t !== '' && isSensitiveKey(t);
  });
}

/**
 * A query key is sensitive when it is, or when any part of it split on `[`, `]`, `,` or `.` is: a bracket segment
 * (`user[password]`), an `anyOf` column (`api_token,email`) or a relation path segment (`sessions.pin`).
 */
function isSensitiveQueryKey(rawKey: string): boolean {
  const key = decode(rawKey);
  return isSensitiveKey(key) || isSensitivePath(key.split(/[[\],.]/));
}

/**
 * One item of a filter group (`path.op.value`): the dotted segments before the first operator word are the column
 * path, so `sessions.token.eq.x` tests `sessions` and `token` while `status.eq.token` tests only `status`. An item
 * without a dot (a list value, a logic word) is not a condition; one without an operator word is tested whole.
 */
function isSensitiveCondition(item: string): boolean {
  if (!item.includes('.')) return false;
  const segments = item.split('.').map(strip);
  const op = segments.findIndex((s) => OPERATORS.has(s));
  return isSensitivePath(op < 0 ? segments : segments.slice(0, op));
}

/**
 * A value that embeds a condition on a sensitive column, at any nesting depth: a filter group (`or`, `and`, `not.or`,
 * `not.and`: `path.op.value` items) or a `select` with an embed filter (`rel(cols,path=op.value)`).
 */
function isSensitiveEmbedded(rawKey: string, rawValue: string): boolean {
  const key = decode(rawKey);
  if (GROUP_KEY.test(key)) return decode(rawValue).split(/[(),]/).some((item) => isSensitiveCondition(item));
  if (key === 'select') {
    for (const m of decode(rawValue).matchAll(EMBED_COLUMN)) if (isSensitivePath((m[1] as string).split('.'))) return true;
  }
  return false;
}

/** Applied to a query string and to a fragment: `key=value` parts with a sensitive key, or a value embedding a condition on a sensitive column, lose their value. */
function redactQuery(qs: string): string {
  return qs
    .split('&')
    .map((part) => {
      const i = part.indexOf('=');
      if (i <= 0) return part;
      const k = part.slice(0, i);
      return isSensitiveQueryKey(k) || isSensitiveEmbedded(k, part.slice(i + 1)) ? `${k}=${REDACTED}` : part;
    })
    .join('&');
}

/** Redacts sensitive query and fragment values and credentials in the authority; the path is kept. */
export function redactUrl(url: string): string {
  const hash = url.indexOf('#');
  const frag = hash < 0 ? '' : `#${redactQuery(url.slice(hash + 1))}`;
  const rest = hash < 0 ? url : url.slice(0, hash);
  const q = rest.indexOf('?');
  const head = (q < 0 ? rest : rest.slice(0, q)).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, `$1${REDACTED}@`);
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

/** Thrown by `walk` past `MAX_DEPTH` nested containers; `redactBody` then returns `<unavailable>`. */
class TooDeep {}

function walk(v: unknown, depth: number): unknown {
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) throw new TooDeep();
    return v.map((x) => walk(x, depth + 1));
  }
  if (typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Object]') {
    if (depth >= MAX_DEPTH) throw new TooDeep();
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = isSensitiveKey(k) ? REDACTED : walk(x, depth + 1);
    return out;
  }
  return v;
}

function redactString(s: string): string {
  const t = s.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    // Only a parse failure means "not JSON"; a body too deep to walk must not fall through and be echoed.
    const parsed = parseJson(s);
    if (parsed !== undefined) return JSON.stringify(walk(parsed, 0));
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
 * come back as redacted copies unless their JSON exceeds 2048 characters, in which case a truncated string. A body
 * nested more than 100 arrays/objects deep is `<unavailable>` as a whole. Linear in the size of the body.
 */
export function redactBody(v: unknown, max: number = MAX_BODY): unknown {
  try {
    const opaque = describeOpaque(v);
    if (opaque !== undefined) return opaque;
    if (typeof v === 'string') return truncate(redactString(v), max);
    if (v instanceof URLSearchParams) return truncate(redactQuery(v.toString()), max);
    const r = walk(v, 0);
    if (typeof r === 'object' && r !== null) {
      const s = JSON.stringify(r);
      if (s !== undefined && s.length > max) return truncate(s, max);
    }
    return r;
  } catch (e) {
    if (e instanceof TooDeep) return UNAVAILABLE;
    throw e;
  }
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
    return UNAVAILABLE;
  }
}

export interface LoggerOptions {
  /** Receives one entry per HTTP attempt, called inline: keep it quick. A throw or rejected promise is ignored. */
  sink: (entry: LogEntry) => unknown;
  /** Default `'perRequest'`; any other value than `'all'` or `'off'` also means `'perRequest'`. */
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
    // an unknown mode (a typo, a value from config) behaves as the default rather than logging everything
    const mode = opts.mode === 'all' || opts.mode === 'off' ? opts.mode : 'perRequest';
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
