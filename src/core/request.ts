import { SpApiError, errorFromBody, errorFromResponse, transportError } from './errors';
import type { Query } from './query-types';
import type { AttemptInfo, LogOption, LogRequest, RequestLogger } from './log-types';
import { serializeQuery } from './serialize';

/** Supplies auth headers and, optionally, a recovery hook for 401 responses. */
export interface ApiAuth {
  getHeaders(): Promise<Record<string, string>>;
  /**
   * Called at most once per request, on a 401 or on a 2xx response whose body is `{ success: false, error_code: 10002 }`; resolve `true` to retry the request once with fresh
   * headers. `failed.headers` are the headers sent on the failed attempt
   * (lowercase keys), so the auth layer can tell whether the token was already
   * replaced. Implementations may ignore the argument.
   */
  handleUnauthorized?(failed?: { headers: Record<string, string> }): Promise<boolean>;
}

/** Configuration for automatic transient request retries. */
export interface RetryConfig {
  /** Maximum number of retry attempts. 0 or undefined means disabled. Default: 0 */
  maxAttempts?: number;
  /** HTTP status codes that trigger a retry. Default: [408, 429, 502, 503, 504] */
  statusCodes?: number[];
  /** Whether to retry on fetch network errors and timeouts. Default: true */
  networkErrors?: boolean;
  /** Base backoff duration in milliseconds. Default: 300 */
  backoffMs?: number;
  /** Maximum backoff duration in milliseconds. Default: 5000 */
  maxBackoffMs?: number;
  /** Whether to add random jitter to backoff delay. Default: true */
  jitter?: boolean;
}

/** Shared configuration for every request a client makes. */
export interface ApiConfig {
  baseUrl: string;
  rpcPrefix?: string;
  auth?: ApiAuth;
  tenant?: { header: string; value: () => string | number | null | undefined };
  defaults?: { perPage?: number; total?: boolean };
  fetch?: typeof fetch;
  /**
   * Per-request timeout in ms (default 60000). `0`, a negative number, `Infinity`, `NaN` or anything above
   * 2^31-1 (the largest timer delay) means no timeout.
   */
  timeoutMs?: number;
  /** Diagnostics hook. Only the `realtime` module emits events (`realtime_handler_error`); the core never calls it. */
  onEvent?: (e: { type: string; [k: string]: unknown }) => void;
  quoting?: boolean;
  driver?: 'pgsql' | 'mysql';
  debug?: boolean;
  /** Automatic retry policy for transient failures. Disabled by default. */
  retry?: RetryConfig;
  /** Request logger from `createLogger` (`@sokpheak/sp-laravel-api/logging`). With none configured logging is a no-op. */
  logger?: RequestLogger;
  /**
   * Treat a 2xx response whose JSON body is an object with `success: false` as a failure and throw `SpApiError`
   * (status stays 2xx; `errorCode` and `message` come from the body; error code 10002 triggers the
   * `auth.handleUnauthorized` refresh once). Default `true`; set `false` to get such a body back as `data`.
   */
  treatSuccessFalseAsError?: boolean;
}

/** One HTTP call. */
export interface RequestOptions {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Already-encoded path relative to `baseUrl`. */
  path: string;
  query?: Query | URLSearchParams;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  debug?: boolean;
  explain?: boolean;
  module?: string;
  disabledOn404?: boolean;
  /**
   * `'json'` (default): parse the body and unwrap the `{ success, data, meta }` envelope (a body that is not
   * JSON comes back as text). `'text'`: return the raw body as a string (`''` when empty), never parsed;
   * errors are handled as usual.
   * `'blob'` / `'arrayBuffer'`: return `res.blob()` / `res.arrayBuffer()`; no envelope parse or `success: false` check.
   */
  responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer';
  /**
   * Per-call retry override:
   * - `false`: disable retry for this call
   * - `true`: enable retry using client's default policy, even on non-idempotent methods
   * - `RetryConfig`: custom retry options for this call
   */
  retry?: boolean | RetryConfig;
  /** Log this call to the configured `logger`: `true`, or `{ headers?, bodies? }` to include those (redacted). Never sent to the server. */
  log?: LogOption;
}

/** Unwrapped result of a successful call. */
export interface ApiResult<T> {
  data: T;
  meta: Record<string, unknown>;
  response: Response;
}

const DEFAULT_TIMEOUT_MS = 60000;
/** Largest delay `setTimeout` honours; larger values overflow and fire almost at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** `true` when `ms` is a usable timer delay; anything else means "no timeout". */
const hasTimeout = (ms: number): boolean => ms > 0 && ms <= MAX_TIMER_MS;

function unencodableBody(what: string): SpApiError {
  return new SpApiError({ status: 0, code: 'unencodable_value', message: `Request body cannot be sent: ${what}` });
}

/**
 * JSON-encodes a non-raw body, throwing `unencodable_value` for values `JSON.stringify` would drop or turn into
 * `{}` (streams, functions, symbols, bigints, Map/Set, promises) instead of sending them silently.
 */
function encodeJsonBody(b: unknown): string {
  const t = typeof b;
  if (t === 'function' || t === 'symbol' || t === 'bigint') throw unencodableBody(`a ${t} is not JSON`);
  if (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream) {
    throw unencodableBody('a ReadableStream is not supported by api.request; buffer it into a Blob or Uint8Array');
  }
  if (b instanceof Map || b instanceof Set) throw unencodableBody(`a ${b instanceof Map ? 'Map' : 'Set'} would be sent as {}`);
  if (isRecord(b) && typeof b.then === 'function') throw unencodableBody('a Promise would be sent as {}; await it first');
  let out: string | undefined;
  try {
    out = JSON.stringify(b);
  } catch (e) {
    throw unencodableBody(e instanceof Error ? e.message : 'JSON.stringify failed');
  }
  if (out === undefined) throw unencodableBody('JSON.stringify returned nothing');
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reports one attempt; a hand-written `finish` that throws is ignored, so the result or error is returned or thrown unchanged. */
function fin(lg: LogRequest, i: AttemptInfo): void {
  try {
    lg.finish(i);
  } catch {
    /* the logger is the caller's; it never changes the request result */
  }
}

/** Re-evaluated at each call site so TypeScript does not narrow `aborted` across awaits. */
function isAborted(s: AbortSignal | undefined): boolean {
  return s?.aborted === true;
}

function isFormData(b: unknown): b is FormData {
  return typeof FormData !== 'undefined' && b instanceof FormData;
}

function isRawBody(b: unknown): boolean {
  return (
    typeof b === 'string' ||
    isFormData(b) ||
    (typeof Blob !== 'undefined' && b instanceof Blob) ||
    b instanceof ArrayBuffer ||
    ArrayBuffer.isView(b) ||
    b instanceof URLSearchParams
  );
}

const DEFAULT_RETRY_STATUSES = [408, 429, 502, 503, 504];

function calculateRetryDelay(
  attempt: number,
  cfg: RetryConfig,
  retryAfterHeader?: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 30000);
    }
    const date = Date.parse(retryAfterHeader);
    if (!Number.isNaN(date)) {
      const diff = date - Date.now();
      if (diff > 0) return Math.min(diff, 30000);
    }
  }
  const base = cfg.backoffMs ?? 300;
  const max = cfg.maxBackoffMs ?? 5000;
  const exponential = Math.min(max, base * 2 ** attempt);
  if (cfg.jitter === false) return exponential;
  return Math.floor(exponential * (0.5 + Math.random() * 0.5));
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Creates the request function used by every module: auth, tenant, timeout, envelope unwrapping, errors. */
export function createRequester(cfg: ApiConfig): <T>(o: RequestOptions) => Promise<ApiResult<T>> {
  const base = cfg.baseUrl.replace(/\/+$/, '');

  return async function request<T>(o: RequestOptions): Promise<ApiResult<T>> {
    const doFetch = cfg.fetch ?? globalThis.fetch;

    let params: URLSearchParams | undefined;
    if (o.query instanceof URLSearchParams) params = new URLSearchParams(o.query);
    else if (o.query !== undefined) {
      params = serializeQuery(o.query, { quoting: cfg.quoting ?? true, driver: cfg.driver, defaults: cfg.defaults });
    }
    if (o.explain === true) {
      params ??= new URLSearchParams();
      params.set('explain', 'true');
    }
    const qs = params?.toString() ?? '';
    const url = `${base}/${o.path.replace(/^\/+/, '')}${qs === '' ? '' : `?${qs}`}`;

    let body: BodyInit | undefined;
    let jsonBody = false;
    if (o.body !== undefined) {
      if (isRawBody(o.body)) body = o.body as BodyInit;
      else {
        body = encodeJsonBody(o.body);
        jsonBody = true;
      }
    }

    let lg: LogRequest | undefined;
    try {
      lg = cfg.logger?.start({ method: o.method, url, log: o.log, body, tenantHeader: cfg.tenant?.header });
    } catch {
      /* a hand-written `start` that throws counts as no logger: the request is unchanged */
    }
    const requestId = globalThis.crypto.randomUUID();
    const timeoutMs = o.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const isIdempotent = o.method === 'GET' || o.method === 'HEAD';
    const retryEnabled =
      o.retry === false
        ? false
        : o.retry === true || typeof o.retry === 'object' || (isIdempotent && (cfg.retry?.maxAttempts ?? 0) > 0);
    const retryCfg: RetryConfig = {
      maxAttempts: typeof o.retry === 'object' ? o.retry.maxAttempts : cfg.retry?.maxAttempts ?? 0,
      statusCodes: (typeof o.retry === 'object' ? o.retry.statusCodes : cfg.retry?.statusCodes) ?? DEFAULT_RETRY_STATUSES,
      networkErrors: (typeof o.retry === 'object' ? o.retry.networkErrors : cfg.retry?.networkErrors) ?? true,
      backoffMs: (typeof o.retry === 'object' ? o.retry.backoffMs : cfg.retry?.backoffMs) ?? 300,
      maxBackoffMs: (typeof o.retry === 'object' ? o.retry.maxBackoffMs : cfg.retry?.maxBackoffMs) ?? 5000,
      jitter: (typeof o.retry === 'object' ? o.retry.jitter : cfg.retry?.jitter) ?? true,
    };
    const maxRetryAttempts = retryEnabled ? (retryCfg.maxAttempts ?? 0) : 0;
    let retryCount = 0;
    /** One refresh per call, shared by the 401 path and the 10002 path (even after a network/status retry). */
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      if (isAborted(o.signal)) throw o.signal?.reason;
      const headers = new Headers({ Accept: 'application/json', 'X-Request-ID': requestId });
      if (cfg.auth !== undefined) {
        for (const [k, v] of Object.entries(await cfg.auth.getHeaders())) headers.set(k, v);
      }
      const tenantValue = cfg.tenant?.value();
      if (cfg.tenant !== undefined && tenantValue !== null && tenantValue !== undefined) {
        headers.set(cfg.tenant.header, String(tenantValue));
      }
      if (o.debug === true || cfg.debug === true) headers.set('X-Debug', '1');
      if (jsonBody) headers.set('Content-Type', 'application/json');
      for (const [k, v] of Object.entries(o.headers ?? {})) headers.set(k, v);
      // The runtime adds `multipart/form-data; boundary=...` itself; a hand-set value can never carry that boundary.
      if (isFormData(o.body)) headers.delete('Content-Type');

      const controller = new AbortController();
      let timedOut = false;
      const timer = hasTimeout(timeoutMs)
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
      const onAbort = (): void => controller.abort(o.signal?.reason);
      if (isAborted(o.signal)) onAbort();
      else o.signal?.addEventListener('abort', onAbort, { once: true });

      const t0 = lg === undefined ? 0 : Date.now();
      let res: Response;
      let text = '';
      let bin: Blob | ArrayBuffer | undefined;
      let failure: SpApiError | null = null;
      try {
        res = await doFetch(url, { method: o.method, headers, body, signal: controller.signal });
        if (res.ok) {
          if (o.responseType === 'blob') bin = await res.blob();
          else if (o.responseType === 'arrayBuffer') bin = await res.arrayBuffer();
          else text = res.status === 204 ? '' : await res.text();
        }
        else {
          failure = await errorFromResponse(res, {
            module: o.module,
            tenantHeader: cfg.tenant?.header,
            disabledOn404: o.disabledOn404,
          });
        }
      } catch (e) {
        if (lg) fin(lg, { attempt: attempt + 1, t0, sent: headers, kind: isAborted(o.signal) ? 'aborted' : timedOut ? 'timeout' : 'network' });
        if (isAborted(o.signal)) throw e;
        const err = transportError(timedOut ? 'timeout' : 'network', e, o.module);
        if (retryEnabled && retryCount < maxRetryAttempts && retryCfg.networkErrors !== false) {
          retryCount++;
          const delay = calculateRetryDelay(retryCount - 1, retryCfg);
          await delayWithSignal(delay, o.signal);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
      }

      let parsed: unknown;
      let isParsed = false;
      if (failure === null && bin === undefined && o.responseType !== 'text' && text.trim() !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        isParsed = true;
        if (cfg.treatSuccessFalseAsError !== false && isRecord(parsed) && parsed.success === false) {
          failure = errorFromBody(res, text, {
            module: o.module,
            tenantHeader: cfg.tenant?.header,
          });
        }
      }

      if (failure !== null) {
        if (lg) fin(lg, { attempt: attempt + 1, t0, sent: headers, res, failure });
        if (
          !refreshed &&
          (failure.status === 401 || (failure.status >= 200 && failure.status < 300 && failure.errorCode === 10002)) &&
          cfg.auth?.handleUnauthorized !== undefined
        ) {
          refreshed = true;
          const sent: Record<string, string> = {};
          headers.forEach((v, k) => {
            sent[k.toLowerCase()] = v;
          });
          if (await cfg.auth.handleUnauthorized({ headers: sent })) {
            if (isAborted(o.signal)) throw o.signal?.reason;
            continue;
          }
        }
        if (
          retryEnabled &&
          retryCount < maxRetryAttempts &&
          retryCfg.statusCodes?.includes(failure.status)
        ) {
          retryCount++;
          const retryAfter = res.headers.get('retry-after');
          const delay = calculateRetryDelay(retryCount - 1, retryCfg, retryAfter);
          await delayWithSignal(delay, o.signal);
          continue;
        }
        throw failure;
      }

      if (lg) fin(lg, { attempt: attempt + 1, t0, sent: headers, res, text, responseType: o.responseType });
      if (bin !== undefined) return { data: bin as T, meta: {}, response: res };
      if (o.responseType === 'text') return { data: text as T, meta: {}, response: res };
      if (!isParsed) return { data: null as T, meta: {}, response: res };
      if (isRecord(parsed) && parsed.success === true) {
        return { data: parsed.data as T, meta: isRecord(parsed.meta) ? parsed.meta : {}, response: res };
      }
      return { data: parsed as T, meta: {}, response: res };
    }
  };
}
