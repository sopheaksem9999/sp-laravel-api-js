import type { RequestLogger } from '../core/log-types';
import { startLog } from './internal';
import type { LoggerOptions } from './internal';

export type { LogEntry, LogMode, LogOption, RequestLogger } from '../core/log-types';
export type { LoggerOptions } from './internal';

/**
 * Creates the request logger to pass as `createApi({ logger })`. Off unless a call opts in (`log: true`) or
 * `mode` is `'all'`. Headers, bodies and query values are always redacted; the package never writes output itself.
 */
export function createLogger(options: LoggerOptions): RequestLogger {
  return { start: (ctx) => startLog(options, ctx) };
}
