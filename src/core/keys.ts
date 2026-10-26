import type { Query } from './query-types';
import { serializeQuery } from './serialize';

export interface Keys {
  table(t: string): readonly unknown[];
  list(t: string, q?: Query): readonly unknown[];
  get(t: string, id: string | number): readonly unknown[];
}

/** Canonical string of a query: serialized params sorted by key then value. */
function canonical(q: Query): string {
  const entries: Array<[string, string]> = [];
  serializeQuery(q, { quoting: true }).forEach((v, k) => entries.push([k, v]));
  entries.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return new URLSearchParams(entries).toString();
}

/** Query-cache keys; `table(t)` is a prefix of every list/get key for that table. */
export function makeKeys(): Keys {
  return {
    table: (t) => ['sp-api', t],
    list: (t, q = {}) => ['sp-api', t, 'list', canonical(q)],
    get: (t, id) => ['sp-api', t, 'get', String(id)],
  };
}
