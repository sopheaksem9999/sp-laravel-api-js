/** Placeholder; replaced by the real version constant in Task 9. */
export const VERSION: string = '0.0.0';

export { SpApiError, errorFromResponse, isSpApiError, transportError } from './core/errors';
export type { ErrorContext, SpErrorCode } from './core/errors';
export { serializeQuery } from './core/serialize';
export type {
  AggregateSpec,
  Operator,
  Query,
  SelectItem,
  SerializeOptions,
  Where,
} from './core/query-types';
