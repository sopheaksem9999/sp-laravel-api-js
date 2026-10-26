import type { CallOptions } from './table';
import type { createRequester } from './request';

export type FnOptions = {
  id?: string | number;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
} & CallOptions;

const seg = (s: string | number): string => encodeURIComponent(String(s));

/** Splits a slash-separated path and encodes each segment. */
const encodePath = (p: string): string => p.split('/').map(seg).join('/');

type Request = ReturnType<typeof createRequester>;

async function send<T>(request: Request, path: string, o: FnOptions | undefined): Promise<T> {
  const { id: _id, method, body, ...rest } = o ?? {};
  void _id;
  const r = await request<T>({ method: method ?? (body !== undefined ? 'POST' : 'GET'), path, body, ...rest });
  return r.data;
}

/** Calls `{table}/{id?}/{rpcPrefix}/{name}`; POST when a body is given, else GET. */
export function callFn<T>(request: Request, rpcPrefix: string, table: string, name: string, o?: FnOptions): Promise<T> {
  const parts = [seg(table)];
  if (o?.id !== undefined) parts.push(seg(o.id));
  if (rpcPrefix !== '') parts.push(seg(rpcPrefix));
  parts.push(seg(name));
  return send<T>(request, parts.join('/'), o);
}

/** Calls `{rpcPrefix}/{path}`; each path segment is encoded. */
export function callRpc<T>(request: Request, rpcPrefix: string, path: string, o?: FnOptions): Promise<T> {
  const p = encodePath(path.replace(/^\/+/, ''));
  return send<T>(request, rpcPrefix === '' ? p : `${seg(rpcPrefix)}/${p}`, o);
}
