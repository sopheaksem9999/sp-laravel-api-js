import { SpApiError } from './errors';
import type { CallOptions } from './table';
import type { createRequester } from './request';

export type FnOptions = {
  id?: string | number;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Query string. Not the table `Query`: nothing is added (no `per_page`); null/undefined entries are skipped, booleans become `'true'`/`'false'`. */
  query?: URLSearchParams | Record<string, string | number | boolean | null | undefined>;
} & CallOptions;

/**
 * Encodes one path segment. `''`, `'.'` and `'..'` throw `unencodable_value`: encoding leaves them unchanged, so
 * the URL would be normalised to a different route (`a/../b` is `b`) or hit a doubled slash.
 */
export function pathSegment(s: string | number): string {
  const v = String(s);
  if (v === '' || v === '.' || v === '..') {
    throw new SpApiError({ status: 0, code: 'unencodable_value', message: `Path segment ${JSON.stringify(v)} cannot be sent` });
  }
  return encodeURIComponent(v);
}

const seg = pathSegment;

/** Splits a slash-separated path and encodes each segment. */
const encodePath = (p: string): string => p.split('/').map(seg).join('/');

type Request = ReturnType<typeof createRequester>;

async function send<T>(request: Request, path: string, o: FnOptions | undefined): Promise<T> {
  const { id: _id, method, body, query, ...rest } = o ?? {};
  void _id;
  let params: URLSearchParams | undefined;
  if (query instanceof URLSearchParams) params = query;
  else if (query !== undefined) {
    params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined) params.set(k, String(v));
  }
  const r = await request<T>({ method: method ?? (body !== undefined ? 'POST' : 'GET'), path, body, query: params, ...rest });
  return r.data;
}

/** Calls `{table}/{id?}/{rpcPrefix}/{name}`; POST when a body is given, else GET. */
export async function callFn<T>(request: Request, rpcPrefix: string, table: string, name: string, o?: FnOptions): Promise<T> {
  const parts = [seg(table)];
  if (o?.id !== undefined) parts.push(seg(o.id));
  if (rpcPrefix !== '') parts.push(seg(rpcPrefix));
  parts.push(seg(name));
  return send<T>(request, parts.join('/'), o);
}

/** Calls `{rpcPrefix}/{path}`; each path segment is encoded. */
export async function callRpc<T>(request: Request, rpcPrefix: string, path: string, o?: FnOptions): Promise<T> {
  const p = encodePath(path.replace(/^\/+/, ''));
  return send<T>(request, rpcPrefix === '' ? p : `${seg(rpcPrefix)}/${p}`, o);
}
