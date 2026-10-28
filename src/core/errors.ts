/** Machine-readable category of a failed SP API call. */
export type SpErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'tenant_required'
  | 'module_disabled'
  | 'not_configured'
  | 'unencodable_value'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown';

/** Extra context the calling module supplies when converting a response. */
export interface ErrorContext {
  /** Name of the module that issued the request. */
  module?: string;
  /** Tenant header name; a 422 whose `errors` key equals it is `tenant_required`. */
  tenantHeader?: string;
  /** When true, a 404 means the module/feature is disabled rather than a missing record. */
  disabledOn404?: boolean;
}

interface Init {
  status: number;
  code: SpErrorCode;
  message: string;
  module?: string | null;
  errorCode?: number | null;
  fieldErrors?: Record<string, string[]>;
  requestId?: string | null;
  retryAfter?: number | null;
  body?: unknown;
  response?: Response | null;
  cause?: unknown;
  completedChunks?: number;
}

/** Single error shape thrown for every failed SP API call (HTTP, envelope, plain Laravel, HTML, empty, transport). */
export class SpApiError extends Error {
  status: number;
  code: SpErrorCode;
  module: string | null;
  errorCode: number | null;
  fieldErrors: Record<string, string[]>;
  requestId: string | null;
  retryAfter: number | null;
  body: unknown;
  response: Response | null;
  /** Underlying error for transport failures (declared here because the ES2020 lib lacks `Error.cause`). */
  cause?: unknown;
  /**
   * Set by the `bulk` module when a chunked call fails part-way: the number of chunks that
   * succeeded (each chunk is its own backend transaction, so those stay committed).
   */
  completedChunks?: number;

  /** Creates an error from already-normalised fields; prefer `errorFromResponse` / `transportError`. */
  constructor(init: Init) {
    super(init.message);
    if (init.cause !== undefined) this.cause = init.cause;
    if (init.completedChunks !== undefined) this.completedChunks = init.completedChunks;
    this.name = 'SpApiError';
    this.status = init.status;
    this.code = init.code;
    this.module = init.module ?? null;
    this.errorCode = init.errorCode ?? null;
    this.fieldErrors = init.fieldErrors ?? {};
    this.requestId = init.requestId ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.body = init.body ?? null;
    this.response = init.response ?? null;
  }

  /** True for a failure with no HTTP response: a network failure or a timeout (not other local errors). */
  get isTransport(): boolean {
    return this.status === 0 && (this.code === 'network' || this.code === 'timeout');
  }

  /** True when the server answered (any HTTP status). */
  get isHttp(): boolean {
    return this.status > 0;
  }
}

/** Type guard for `SpApiError`. */
export function isSpApiError(e: unknown): e is SpApiError {
  return e instanceof SpApiError;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function codeFromStatus(status: number): SpErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'server';
  return 'unknown';
}

/** Envelope `error_code` to category, used when the HTTP status is 2xx/3xx (a `200 { success:false }` body). */
function codeFromEnvelope(errorCode: unknown): SpErrorCode {
  if (errorCode === 10002) return 'unauthenticated';
  if (errorCode === 10008) return 'forbidden';
  if (errorCode === 10009) return 'not_found';
  if (errorCode === 10004) return 'validation';
  if (errorCode === 10010) return 'server';
  return 'unknown';
}

function normaliseFieldErrors(raw: unknown): Record<string, string[]> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) out[key] = value.map(String);
    else if (typeof value === 'string') out[key] = [value];
    else if (key === 'retry_after_seconds' && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = [String(value)];
    }
  }
  return out;
}

/** Parses a number or numeric string of seconds; null when not finite or negative (`zeroOk` keeps 0). */
function parseSeconds(v: unknown, zeroOk: boolean): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else return null;
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !zeroOk)) return null;
  return n;
}

/** `errors.retry_after_seconds`: the first element or a bare value; must be > 0. */
function fromErrors(v: unknown): number | null {
  return parseSeconds(Array.isArray(v) ? v[0] : v, false);
}

/** Converts a non-2xx `Response` into an `SpApiError`, consuming its body. */
export async function errorFromResponse(res: Response, ctx: ErrorContext = {}): Promise<SpApiError> {
  return errorFromBody(res, await res.text(), ctx);
}

/** Builds an `SpApiError` from a `Response` whose body text was already read (also used for `200 { success:false }`). */
export function errorFromBody(res: Response, text: string, ctx: ErrorContext = {}): SpApiError {
  let body: unknown = text === '' ? null : text;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  const obj = isRecord(body) ? body : null;
  const fieldErrors = normaliseFieldErrors(obj?.errors);

  let code = res.status >= 200 && res.status < 300 ? codeFromEnvelope(obj?.error_code) : codeFromStatus(res.status);
  if (code === 'not_found' && res.status === 404 && ctx.disabledOn404 === true) code = 'module_disabled';
  if (
    code === 'validation' &&
    ctx.tenantHeader !== undefined &&
    Object.prototype.hasOwnProperty.call(fieldErrors, ctx.tenantHeader)
  ) {
    code = 'tenant_required';
  }

  let message = typeof obj?.message === 'string' ? obj.message : '';
  if (message === '') message = fieldErrors.message?.[0] ?? '';
  if (message === '') message = `Request failed with status ${res.status}`;

  const meta = obj !== null && isRecord(obj.meta) ? obj.meta : null;
  const requestId =
    (typeof meta?.request_id === 'string' && meta.request_id !== '' ? meta.request_id : null) ??
    res.headers.get('X-Request-ID');

  const retryAfter =
    parseSeconds(res.headers.get('Retry-After'), true) ??
    parseSeconds(obj?.retry_after, true) ??
    fromErrors(isRecord(obj?.errors) ? obj.errors.retry_after_seconds : undefined);

  return new SpApiError({
    status: res.status,
    code,
    message,
    module: ctx.module ?? null,
    errorCode: typeof obj?.error_code === 'number' ? obj.error_code : null,
    fieldErrors,
    requestId,
    retryAfter,
    body,
    response: res,
  });
}

/** Builds an `SpApiError` for a failure with no HTTP response (network failure or timeout). */
export function transportError(kind: 'network' | 'timeout', cause: unknown, module?: string): SpApiError {
  const base = kind === 'timeout' ? 'Request timed out' : 'Network request failed';
  return new SpApiError({
    status: 0,
    code: kind,
    message: base,
    module: module ?? null,
    cause,
  });
}
