import { SpApiError } from '../core/errors';
import type { Table } from '../core/table';

/** Options shared by every bulk call. */
export interface BulkOpts {
  /** Items per request; a positive integer (default 1000, the backend's `record.bulk_max`). */
  chunkSize?: number;
  /** Chunks in flight at once (default 1, sequential). Results keep the original order. */
  concurrency?: number;
  /** Queue the work on the backend (`?async=1`). Resolves `{ queued: true }`; there is no job id. */
  async?: boolean;
  signal?: AbortSignal;
}

/** Result of `create` / `update` / `delete` / `mixed`: the returned rows, or `{ queued: true }` when `async`. */
export type BulkResult<T> = { rows: T[]; affected: number } | { queued: true };

/** Result of `upsert`: rows written, summed across chunks. */
export interface BulkUpsertResult {
  count: number;
}

/** Module-level options. */
export interface BulkModuleOptions {
  /** Primary key column used to extract ids from rows for `delete` / `mixed` (default `'id'`). */
  pk?: string;
}

type Id = string | number;

export interface Bulk<T> {
  create(rows: Partial<T>[], o?: BulkOpts): Promise<BulkResult<T>>;
  update(rows: Partial<T>[], o?: BulkOpts): Promise<BulkResult<T>>;
  delete(idsOrRows: Array<Id | Partial<T>>, o?: BulkOpts): Promise<BulkResult<T>>;
  upsert(rows: Partial<T>[], o: BulkOpts & { matchOn: string[] }): Promise<BulkUpsertResult>;
  mixed(ops: { create?: Partial<T>[]; update?: Partial<T>[]; delete?: Array<Id | Partial<T>> }, o?: BulkOpts): Promise<BulkResult<T>>;
}

const DEFAULT_CHUNK = 1000;
const MODULE = 'bulk';

const bad = (message: string): SpApiError => new SpApiError({ status: 0, code: 'unencodable_value', message, module: MODULE });

function positiveInt(v: number | undefined, def: number, name: string): number {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v <= 0) throw bad(`bulk: ${name} must be a positive integer`);
  return v;
}

function chunked<I>(items: I[], size: number): I[][] {
  const out: I[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs `send` for every chunk, at most `concurrency` at a time. On the first failure no further chunk is
 * started and in-flight ones are aborted; that failure is rethrown (an `SpApiError` gets `completedChunks`).
 */
async function runChunks<I, R>(
  chunks: I[][],
  concurrency: number,
  signal: AbortSignal | undefined,
  send: (chunk: I[], signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort(signal?.reason);
  if (signal?.aborted === true) ctl.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });

  const results: R[] = new Array<R>(chunks.length);
  let completed = 0;
  let next = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (failure === undefined && next < chunks.length) {
      if (ctl.signal.aborted) {
        failure ??= { error: ctl.signal.reason };
        return;
      }
      const i = next++;
      try {
        results[i] = await send(chunks[i] as I[], ctl.signal);
        completed++;
      } catch (error) {
        // Only the first failure counts; later ones are usually our own abort of in-flight chunks.
        failure ??= { error };
        ctl.abort(error);
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (failure !== undefined) {
    if (failure.error instanceof SpApiError) failure.error.completedChunks = completed;
    throw failure.error;
  }
  return results;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Bulk writes for one table. Every call goes through `table.api.request`. */
export function bulk<T>(table: Table<T>, moduleOpts: BulkModuleOptions = {}): Bulk<T> {
  const pk = moduleOpts.pk ?? 'id';
  const base = encodeURIComponent(table.name);

  const toId = (item: Id | Partial<T>): Id => {
    if (typeof item === 'string' || typeof item === 'number') return item;
    const v = isRecord(item) ? (item as Record<string, unknown>)[pk] : undefined;
    if (typeof v === 'string' || typeof v === 'number') return v;
    throw bad(`bulk.delete: row has no usable primary key "${pk}"`);
  };

  /** Chunks `items`, POSTs each chunk to `path`, and folds the per-chunk results in original order. */
  async function post<R>(
    path: string,
    items: unknown[],
    o: BulkOpts | undefined,
    spec: {
      query?: URLSearchParams;
      /** Whether the backend route has an async branch. */
      asyncCapable: boolean;
      read(data: unknown, meta: Record<string, unknown>): R;
      empty: R;
      join(a: R, b: R): R;
    },
  ): Promise<R | { queued: true }> {
    const chunkSize = positiveInt(o?.chunkSize, DEFAULT_CHUNK, 'chunkSize');
    const concurrency = positiveInt(o?.concurrency, 1, 'concurrency');
    if (items.length === 0) return spec.empty;
    const useAsync = spec.asyncCapable && o?.async === true;
    const parts = await runChunks(chunked(items, chunkSize), concurrency, o?.signal, async (chunk, signal) => {
      const query = new URLSearchParams(spec.query);
      if (useAsync) query.set('async', '1');
      const r = await table.api.request<unknown>({
        method: 'POST',
        path,
        query: query.toString() === '' ? undefined : query,
        body: chunk,
        signal,
        module: MODULE,
        disabledOn404: true,
      });
      return spec.read(r.data, r.meta);
    });
    return useAsync ? { queued: true } : parts.reduce(spec.join);
  }

  type Rows = { rows: T[]; affected: number };
  const rowsSpec = {
    asyncCapable: true,
    read(data: unknown, meta: Record<string, unknown>): Rows {
      const rows = Array.isArray(data) ? (data as T[]) : [];
      return { rows, affected: typeof meta.affected === 'number' ? meta.affected : rows.length };
    },
    empty: { rows: [], affected: 0 } as Rows,
    join: (a: Rows, b: Rows): Rows => ({ rows: [...a.rows, ...b.rows], affected: a.affected + b.affected }),
  };

  const rowsCall = (route: string, items: unknown[], o: BulkOpts | undefined, asyncCapable = true): Promise<BulkResult<T>> =>
    post(route, items, o, { ...rowsSpec, asyncCapable });

  return {
    create: async (rows, o) => rowsCall(`${base}/bulk/create`, rows, o),
    update: async (rows, o) => rowsCall(`${base}/bulk/update`, rows, o),
    delete: async (idsOrRows, o) => rowsCall(`${base}/bulk/delete`, idsOrRows.map(toId), o),
    async upsert(rows, o) {
      const { matchOn } = o;
      if (!Array.isArray(matchOn) || matchOn.length === 0 || matchOn.some((c) => typeof c !== 'string' || c === '' || c.includes(','))) {
        throw bad('bulk.upsert: matchOn must be a non-empty list of column names without commas');
      }
      // The backend has no async branch for upsert, so `async` is ignored.
      const r = await post<BulkUpsertResult>(`${base}/bulk/upsert`, rows, o, {
        query: new URLSearchParams({ match_on: matchOn.join(',') }),
        asyncCapable: false,
        read: (data) => ({ count: isRecord(data) && typeof data.count === 'number' ? data.count : 0 }),
        empty: { count: 0 },
        join: (a, b) => ({ count: a.count + b.count }),
      });
      return r as BulkUpsertResult;
    },
    async mixed(ops, o) {
      if (o?.async === true) throw bad('bulk.mixed: the backend has no async mode for the mixed route');
      const items: unknown[] = [
        ...(ops.create ?? []).map((r) => ({ ...r, operation: 'create' })),
        ...(ops.update ?? []).map((r) => ({ ...r, operation: 'update' })),
        ...(ops.delete ?? []).map((r) => ({ [pk]: toId(r), operation: 'delete' })),
      ];
      return rowsCall(`${base}/bulk`, items, o, false);
    },
  };
}
