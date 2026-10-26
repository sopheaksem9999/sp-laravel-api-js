import { errorFromResponse, transportError } from './errors';
import type { SpApiError } from './errors';
import type { Query } from './query-types';
import { serializeQuery } from './serialize';

/** Supplies auth headers and, optionally, a recovery hook for 401 responses. */
export interface ApiAuth {
  getHeaders(): Promise<Record<string, string>>;
  /**
   * Called once on a 401; resolve `true` to retry the request once with fresh
   * headers. `failed.headers` are the headers sent on the failed attempt
   * (lowercase keys), so the auth layer can tell whether the token was already
   * replaced. Implementations may ignore the argument.
   */
  handleUnauthorized?(failed?: { headers: Record<string, string> }): Promise<boolean>;
}

/** Shared configuration for every request a client makes. */
export interface ApiConfig {
  baseUrl: string;
  rpcPrefix?: string;
  auth?: ApiAuth;
  tenant?: { header: string; value: () => string | number | null | undefined };
  defaults?: { perPage?: number; total?: boolean };
  fetch?: typeof fetch;
  timeoutMs?: number;
  onEvent?: (e: { type: string; [k: string]: unknown }) => void;
  quoting?: boolean;
  driver?: 'pgsql' | 'mysql';
  debug?: boolean;
}

/** One HTTP call. */
export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
}

/** Unwrapped result of a successful call. */
export interface ApiResult<T> {
  data: T;
  meta: Record<string, unknown>;
  response: Response;
}

const DEFAULT_TIMEOUT_MS = 60000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Re-evaluated at each call site so TypeScript does not narrow `aborted` across awaits. */
function isAborted(s: AbortSignal | undefined): boolean {
  return s?.aborted === true;
}

function isRawBody(b: unknown): boolean {
  return (
    typeof b === 'string' ||
    (typeof FormData !== 'undefined' && b instanceof FormData) ||
    (typeof Blob !== 'undefined' && b instanceof Blob) ||
    b instanceof ArrayBuffer ||
    ArrayBuffer.isView(b) ||
    b instanceof URLSearchParams
  );
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
        body = JSON.stringify(o.body);
        jsonBody = true;
      }
    }

    const requestId = globalThis.crypto.randomUUID();
    const timeoutMs = o.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = (): void => controller.abort(o.signal?.reason);
      if (isAborted(o.signal)) onAbort();
      else o.signal?.addEventListener('abort', onAbort, { once: true });

      let res: Response;
      let text = '';
      let failure: SpApiError | null = null;
      try {
        res = await doFetch(url, { method: o.method, headers, body, signal: controller.signal });
        if (res.ok) text = res.status === 204 ? '' : await res.text();
        else {
          failure = await errorFromResponse(res, {
            module: o.module,
            tenantHeader: cfg.tenant?.header,
            disabledOn404: o.disabledOn404,
          });
        }
      } catch (e) {
        if (isAborted(o.signal)) throw e;
        throw transportError(timedOut ? 'timeout' : 'network', e, o.module);
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
      }

      if (failure !== null) {
        if (failure.status === 401 && attempt === 0 && cfg.auth?.handleUnauthorized !== undefined) {
          const sent: Record<string, string> = {};
          headers.forEach((v, k) => {
            sent[k.toLowerCase()] = v;
          });
          if (await cfg.auth.handleUnauthorized({ headers: sent })) {
            if (isAborted(o.signal)) throw o.signal?.reason;
            continue;
          }
        }
        throw failure;
      }

      if (text.trim() === '') return { data: null as T, meta: {}, response: res };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (isRecord(parsed) && parsed.success === true) {
        return { data: parsed.data as T, meta: isRecord(parsed.meta) ? parsed.meta : {}, response: res };
      }
      return { data: parsed as T, meta: {}, response: res };
    }
  };
}
