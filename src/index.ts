/** Placeholder; replaced by the real version constant in Task 9. */
export const VERSION: string = '0.0.0';

export { SpApiError, errorFromResponse, isSpApiError, transportError } from './core/errors';
export type { ErrorContext, SpErrorCode } from './core/errors';
export { serializeQuery } from './core/serialize';
export type {
  AggregateRow,
  AggregateSpec,
  Condition,
  Modifier,
  Operator,
  OperandValue,
  OperatorMap,
  Query,
  Scalar,
  SelectItem,
  SerializeOptions,
  Where,
} from './core/query-types';
export { createRequester } from './core/request';
export type { ApiAuth, ApiConfig, ApiResult, RequestOptions } from './core/request';
export { makeTable } from './core/table';
export type { CallOptions, Page, Table } from './core/table';
