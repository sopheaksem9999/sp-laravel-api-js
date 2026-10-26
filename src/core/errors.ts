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

function normaliseFieldErrors(raw: unknown): Record<string, string[]> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) out[key] = value.map(String);
    else if (typeof value === 'string') out[key] = [value];
  }
  return out;
}

/** Converts a non-2xx `Response` into an `SpApiError`, consuming its body. */
export async function errorFromResponse(res: Response, ctx: ErrorContext = {}): Promise<SpApiError> {
  const text = await res.text();
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

  let code = codeFromStatus(res.status);
  if (code === 'not_found' && ctx.disabledOn404 === true) code = 'module_disabled';
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

  let retryAfter: number | null = null;
  if (res.status === 429) {
    const header = res.headers.get('Retry-After');
    const secs = header === null ? NaN : Number(header);
    if (Number.isFinite(secs) && secs >= 0) retryAfter = secs;
  }

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
  const detail = cause instanceof Error ? cause.message : '';
  const base = kind === 'timeout' ? 'Request timed out' : 'Network request failed';
  return new SpApiError({
    status: 0,
    code: kind,
    message: detail === '' ? base : `${base}: ${detail}`,
    module: module ?? null,
    cause,
  });
}
