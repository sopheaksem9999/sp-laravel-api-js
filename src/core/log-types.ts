import type { SpApiError } from './errors';

/** Logging switch: `'off'` never logs; `'perRequest'` (default) logs calls that opt in; `'all'` logs every call. */
export type LogMode = 'off' | 'perRequest' | 'all';

/** Per-call opt-in: `true` logs the call; the object form also asks for headers and/or bodies (always redacted). */
export type LogOption = boolean | { headers?: boolean; bodies?: boolean };

/** One HTTP attempt. Headers and bodies are present only when the call asked for them, and are always redacted. */
export interface LogEntry {
  method: string;
  /** Full URL; sensitive query and fragment values, filter groups naming a sensitive column and authority credentials are redacted. Paths (ids included) are logged verbatim. */
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

/** What the request loop knows about one finished HTTP attempt. */
export interface AttemptInfo {
  /** 1-based. */
  attempt: number;
  /** `Date.now()` taken just before the attempt. */
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

/**
 * One logged request; `finish` is called once per HTTP attempt, inline. It must not return a promise (nothing awaits
 * it, so a rejection would be unhandled); hand slow work to a queue. A `finish` that throws is ignored.
 */
export interface LogRequest {
  finish(i: AttemptInfo): void;
}

/**
 * What core needs from a logger (`createLogger` from `@sokpheak/sp-laravel-api/logging`). `start` returns `undefined`
 * to skip a request. A hand-written `start` or `finish` that throws is ignored (the request goes on as if no logger
 * were set, and its result or error is unchanged); `finish` must not return a promise.
 */
export interface RequestLogger {
  start(ctx: { method: string; url: string; log: LogOption | undefined; body: unknown; tenantHeader: string | undefined }): LogRequest | undefined;
}
