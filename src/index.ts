import pkg from '../package.json';

/** Package version, inlined from package.json at build time. */
export const VERSION: string = pkg.version;

export { createApi } from './core/create-api';
export type { Api, NoTables, TableTypes, TablesMap } from './core/create-api';
export type { FnOptions } from './core/fn';
export type { Keys } from './core/keys';

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
export type { CallOptions, Page, Table, TableCore } from './core/table';
