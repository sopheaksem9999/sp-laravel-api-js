import { SpApiError } from './errors';
import { buildPage } from './page';
import type { Page } from './page';
import type { AggregateRow, AggregateSpec, Query, SelectItem, Where } from './query-types';
import type { Api } from './create-api';
import type { createRequester } from './request';

export type { Page } from './page';

/** Per-call transport options. */
export interface CallOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

type Id = string | number;

/**
 * One table. `T` is the row type returned by reads; `W` is the write type whose `Partial` the write methods
 * take (defaults to `T`; generated `Tables` interfaces supply their `{Name}Write` schema here).
 */
export interface Table<T, W = T> {
  readonly name: string;
  /** The client that created this table (used by sibling modules such as bulk). */
  readonly api: Api;
  list(q?: Query, o?: CallOptions): Promise<Page<T>>;
  get(id: Id, o?: { select?: SelectItem[] } & CallOptions): Promise<T>;
  create(body: Partial<W>, o?: CallOptions): Promise<T>;
  update(id: Id, body: Partial<W>, o?: CallOptions): Promise<T>;
  patch(id: Id, body: Partial<W>, o?: CallOptions): Promise<T>;
  remove(id: Id, o?: { force?: boolean } & CallOptions): Promise<{ deleted: boolean }>;
  restore(id: Id, o?: CallOptions): Promise<T>;
  upsert(
    body: Partial<W>,
    o: { matchOn: string[]; refetch?: boolean; select?: SelectItem[] } & CallOptions,
  ): Promise<{ id: unknown; payload: unknown } | T>;
  iterate(q?: Query, o?: CallOptions): AsyncGenerator<T>;
  aggregate<const S extends AggregateSpec, const G extends string = never>(
    spec: S,
    o?: { where?: Where; groupBy?: G[] } & CallOptions,
  ): Promise<{ rows: AggregateRow<S, G[]>[]; meta: Record<string, unknown> }>;
}

/** A table before `createApi` attaches `api`. */
export type TableCore<T, W = T> = Omit<Table<T, W>, 'api'>;

/** Encodes one path segment (table name or id). */
const seg = (s: string | number): string => encodeURIComponent(String(s));

function callOpts(o: CallOptions | undefined): CallOptions {
  const out: CallOptions = {};
  if (o?.signal !== undefined) out.signal = o.signal;
  if (o?.headers !== undefined) out.headers = o.headers;
  if (o?.timeoutMs !== undefined) out.timeoutMs = o.timeoutMs;
  return out;
}

/** Builds the CRUD surface for one table on top of a request function. */
export function makeTable<T, W = T>(
  name: string,
  ctx: { request: ReturnType<typeof createRequester>; serialize: (q: Query) => URLSearchParams },
): TableCore<T, W> {
  const { request, serialize } = ctx;
  const base = seg(name);

  // With neither `cursor` nor `page` nothing is sent for either; `next` is meta.next_cursor on a full page.
  const list = async (q: Query = {}, o?: CallOptions): Promise<Page<T>> => {
    const params = serialize(q);
    const perPage = Number(params.get('per_page'));
    const r = await request<T[]>({ method: 'GET', path: base, query: params, ...callOpts(o) });
    return buildPage(r.data, r.meta, {
      perPage: Number.isFinite(perPage) && perPage > 0 ? perPage : Number.POSITIVE_INFINITY,
      offsetMode: q.page !== undefined && q.cursor === undefined,
      wantTotal: params.get('total') === 'true',
    });
  };

  const get = async (id: Id, o?: { select?: SelectItem[] } & CallOptions): Promise<T> => {
    const query = o?.select !== undefined ? serialize({ select: o.select }) : undefined;
    // select-only: drop the pagination param the serializer always adds
    query?.delete('per_page');
    return (await request<T>({ method: 'GET', path: `${base}/${seg(id)}`, query, ...callOpts(o) })).data;
  };

  const write =
    (method: 'PUT' | 'PATCH') =>
    async (id: Id, body: Partial<W>, o?: CallOptions): Promise<T> =>
      (await request<T>({ method, path: `${base}/${seg(id)}`, body, ...callOpts(o) })).data;

  return {
    name,
    list,
    get,
    async create(body, o) {
      return (await request<T>({ method: 'POST', path: base, body, ...callOpts(o) })).data;
    },
    update: write('PUT'),
    patch: write('PATCH'),
    async remove(id, o) {
      const query = o?.force === true ? new URLSearchParams({ force: 'true' }) : undefined;
      await request<unknown>({ method: 'DELETE', path: `${base}/${seg(id)}`, query, ...callOpts(o) });
      return { deleted: true };
    },
    async restore(id, o) {
      return (await request<T>({ method: 'POST', path: `${base}/${seg(id)}/restore`, ...callOpts(o) })).data;
    },
    async upsert(body, o) {
      const query = new URLSearchParams({ match_on: o.matchOn.join(',') });
      const r = await request<{ id: unknown; payload: unknown }>({
        method: 'POST',
        path: `${base}/upsert`,
        query,
        body,
        ...callOpts(o),
      });
      if (o.refetch === true) {
        // Code 'unknown': the host broke its contract (no id in the upsert response).
        if (r.data === null || r.data === undefined || r.data.id === undefined || r.data.id === null) {
          throw new SpApiError({ status: 0, code: 'unknown', message: 'upsert refetch requested but the response had no id' });
        }
        return get(r.data.id as Id, { select: o.select, ...callOpts(o) });
      }
      return r.data;
    },
    async aggregate(spec, o) {
      const query = serialize({ where: o?.where, aggregate: spec, groupBy: o?.groupBy });
      const r = await request<never[]>({ method: 'GET', path: base, query, ...callOpts(o) });
      return { rows: Array.isArray(r.data) ? r.data : [], meta: r.meta };
    },
    async *iterate(q: Query = {}, o?: CallOptions) {
      if (q.page !== undefined && q.cursor === undefined) {
        throw new SpApiError({ status: 0, code: 'unencodable_value', message: 'iterate() requires cursor mode; do not pass `page`' });
      }
      // Copy: never mutate the caller's query.
      let query: Query = { ...q, cursor: q.cursor ?? null };
      for (;;) {
        if (o?.signal?.aborted === true) throw o.signal.reason;
        const page = await list(query, o);
        if (page.data.length === 0) return;
        yield* page.data;
        if (page.next === null) return;
        // A cursor that does not advance would loop forever.
        if (page.next === (query.cursor === null || query.cursor === undefined ? '0' : String(query.cursor))) return;
        query = { ...query, cursor: page.next };
      }
    },
  };
}
