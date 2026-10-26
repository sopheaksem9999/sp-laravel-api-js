import { callFn, callRpc } from './fn';
import type { FnOptions } from './fn';
import { makeKeys } from './keys';
import type { Keys } from './keys';
import type { Query } from './query-types';
import { createRequester } from './request';
import type { ApiConfig } from './request';
import { serializeQuery } from './serialize';
import { makeTable } from './table';
import type { Table } from './table';

/** Row (`read`) and write (`write`) types of one table, as emitted by `sp-laravel-api typegen`. */
export interface TableTypes {
  read: unknown;
  write: unknown;
}

/**
 * Constraint for a `Tables` interface (table name -> `TableTypes`), such as the one `sp-laravel-api typegen`
 * generates. Written as a mapped type so a plain `interface` (which has no index signature) satisfies it.
 */
export type TablesMap<T> = { [K in keyof T]: TableTypes };

/** No generated tables: `api.table(name)` is untyped unless a generic is given. */
export type NoTables = Record<never, never>;

type ReadOf<X> = X extends { read: infer R } ? R : unknown;
type WriteOf<X> = X extends { write: infer W } ? W : unknown;

export interface Api<TTables extends TablesMap<TTables> = NoTables> {
  request: ReturnType<typeof createRequester>;
  /** A table named in the generated `Tables` interface: typed without generics. */
  table<K extends keyof TTables & string>(name: K): Table<ReadOf<TTables[K]>, WriteOf<TTables[K]>>;
  /** Any other table; `T` is the row type (and, partially, the write type). */
  table<T = unknown>(name: string): Table<T>;
  fn<T = unknown>(table: string, name: string, o?: FnOptions): Promise<T>;
  rpc<T = unknown>(path: string, o?: FnOptions): Promise<T>;
  keys: Keys;
  config: Readonly<ApiConfig>;
}

/**
 * Creates a client. `rpcPrefix` defaults to `'rpc'`; `''` means no prefix segment.
 *
 * Pass a generated `Tables` interface (`createApi<Tables>(cfg)`) to type `api.table('invoices')` without
 * generics; tables not in it, and explicit generics, behave as before.
 */
export function createApi<TTables extends TablesMap<TTables> = NoTables>(cfg: ApiConfig): Api<TTables> {
  const config: Readonly<ApiConfig> = { ...cfg, rpcPrefix: cfg.rpcPrefix ?? 'rpc' };
  const prefix = config.rpcPrefix ?? 'rpc';
  const request = createRequester(config);
  const serialize = (q: Query): URLSearchParams =>
    serializeQuery(q, { quoting: config.quoting ?? true, driver: config.driver, defaults: config.defaults });

  // Types are compile-time only: every table is built the same way at runtime.
  function table(name: string): Table<unknown> {
    return { ...makeTable<unknown>(name, { request, serialize }), api: api as unknown as Api };
  }

  const api: Api<TTables> = {
    request,
    table: table as Api<TTables>['table'],
    fn: (t, name, o) => callFn(request, prefix, t, name, o),
    rpc: (path, o) => callRpc(request, prefix, path, o),
    keys: makeKeys(),
    config,
  };
  return api;
}
