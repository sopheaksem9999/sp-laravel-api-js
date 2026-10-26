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

export interface Api {
  request: ReturnType<typeof createRequester>;
  table<T = unknown>(name: string): Table<T>;
  fn<T = unknown>(table: string, name: string, o?: FnOptions): Promise<T>;
  rpc<T = unknown>(path: string, o?: FnOptions): Promise<T>;
  keys: Keys;
  config: Readonly<ApiConfig>;
}

/** Creates a client. `rpcPrefix` defaults to `'rpc'`; `''` means no prefix segment. */
export function createApi(cfg: ApiConfig): Api {
  const config: Readonly<ApiConfig> = { ...cfg, rpcPrefix: cfg.rpcPrefix ?? 'rpc' };
  const prefix = config.rpcPrefix ?? 'rpc';
  const request = createRequester(config);
  const serialize = (q: Query): URLSearchParams =>
    serializeQuery(q, { quoting: config.quoting ?? true, driver: config.driver, defaults: config.defaults });

  const api: Api = {
    request,
    table<T = unknown>(name: string): Table<T> {
      return { ...makeTable<T>(name, { request, serialize }), api };
    },
    fn: (table, name, o) => callFn(request, prefix, table, name, o),
    rpc: (path, o) => callRpc(request, prefix, path, o),
    keys: makeKeys(),
    config,
  };
  return api;
}
