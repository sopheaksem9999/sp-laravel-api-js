import { SpApiError } from './errors';
import type { LogOption } from './log-types';
import type { Query } from './query-types';

/** One page of rows plus cursors. `next` is null at the end of the data. */
export interface Page<T> {
  data: T[];
  next: string | null;
  prev: string | null;
  total: number | null;
  meta: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
}

/**
 * Builds a Page. `next` is only trusted when the page is full (a short page is the end of data);
 * offset mode never yields a cursor. `total` is only set when the call asked for it.
 */
export function buildPage<T>(
  data: T[] | null,
  meta: Record<string, unknown>,
  o: { perPage: number; offsetMode: boolean; wantTotal: boolean },
): Page<T> {
  const rows = Array.isArray(data) ? data : [];
  const next = !o.offsetMode && rows.length >= o.perPage ? str(meta.next_cursor) : null;
  const total = o.wantTotal && typeof meta.total === 'number' ? meta.total : null;
  return { data: rows, next, prev: str(meta.prev_cursor), total, meta };
}

/** Options for cursor pagination boundary operations. */
export interface CursorPaginationOptions {
  query?: Omit<Query, 'cursor' | 'page' | 'direction'>;
  perPage?: number;
  /** Column the cursor pages on (`cursor_column`); wins over `query.cursorColumn`. Host default: the sorted column. */
  cursorColumn?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Logs every page request (`true`, or `{ headers?, bodies? }`); needs a `logger` on the client. */
  log?: LogOption;
}

/** High-level cursor pagination boundary controller. */
export interface CursorPagination<T> {
  /** Fetches the very first page of rows in natural order. */
  firstPage(): Promise<Page<T>>;
  /**
   * Fetches the last page of rows by reversing the query's sort direction,
   * then restoring the returned rows back to canonical order. Needs `query.sort`: the host's default sort depends
   * on the table (`created_at` when it has one, else the primary key), which the client cannot know, so without
   * a sort it throws `SpApiError` `unencodable_value` and sends no request. A short or empty last page has `prev: null`.
   */
  lastPage(): Promise<Page<T>>;
  /** Fetches the next page from a cursor string or a Page object. Returns null if cursor is absent. */
  nextPage(cursorOrPage: string | { next: string | null }): Promise<Page<T> | null>;
  /** Fetches the previous page (sent with `direction=prev`) from a cursor string or a Page object. Returns null if cursor is absent. */
  prevPage(cursorOrPage: string | { prev: string | null }): Promise<Page<T> | null>;
}

/**
 * Creates a cursor pagination controller providing firstPage, lastPage (with direction reversal),
 * nextPage, and prevPage navigation.
 */
export function createCursorPagination<T>(
  table: { list(q?: Query, o?: { signal?: AbortSignal; headers?: Record<string, string>; timeoutMs?: number; log?: LogOption }): Promise<Page<T>> },
  options?: CursorPaginationOptions,
): CursorPagination<T> {
  const { query: rawQuery = {}, perPage, cursorColumn, signal, headers, timeoutMs, log } = options ?? {};
  // `direction` is owned by the controller (untyped callers could still pass it); `cursorColumn` option wins.
  const rest: Query = { ...(rawQuery as Query) };
  delete rest.direction;
  const baseQuery: Omit<Query, 'cursor' | 'page' | 'direction'> = {
    ...rest,
    ...(cursorColumn !== undefined ? { cursorColumn } : {}),
  };
  const callOpts = { signal, headers, timeoutMs, log };

  return {
    async firstPage(): Promise<Page<T>> {
      return table.list(
        {
          ...baseQuery,
          cursor: null,
          ...(perPage !== undefined ? { perPage } : {}),
        },
        callOpts,
      );
    },

    async lastPage(): Promise<Page<T>> {
      const currentSort = baseQuery.sort;
      if (currentSort === undefined || currentSort === null || typeof currentSort !== 'object' || typeof currentSort.by !== 'string') {
        throw new SpApiError({
          status: 0,
          code: 'unencodable_value',
          message:
            'lastPage() needs a `sort` ({ by, order? }) in the query: the host default sort depends on the table, so the last page cannot be derived without it',
        });
      }
      // An omitted `order` is `desc` on the host.
      const reversedOrder: 'asc' | 'desc' = (currentSort.order ?? 'desc') === 'desc' ? 'asc' : 'desc';
      const reversedSort = { by: currentSort.by, order: reversedOrder };

      const page = await table.list(
        {
          ...baseQuery,
          sort: reversedSort,
          cursor: null,
          ...(perPage !== undefined ? { perPage } : {}),
        },
        callOpts,
      );

      // A short or empty page is the whole result: there is nothing before it.
      const short = page.data.length === 0 || (perPage !== undefined && page.data.length < perPage);
      return {
        data: [...page.data].reverse(),
        next: null,
        prev: short ? null : page.next,
        total: page.total,
        meta: page.meta,
      };
    },

    async nextPage(cursorOrPage: string | { next: string | null }): Promise<Page<T> | null> {
      const cursor = typeof cursorOrPage === 'string' ? cursorOrPage : cursorOrPage.next;
      if (!cursor) return null;
      return table.list(
        {
          ...baseQuery,
          cursor,
          ...(perPage !== undefined ? { perPage } : {}),
        },
        callOpts,
      );
    },

    async prevPage(cursorOrPage: string | { prev: string | null }): Promise<Page<T> | null> {
      const cursor = typeof cursorOrPage === 'string' ? cursorOrPage : cursorOrPage.prev;
      if (!cursor) return null;
      return table.list(
        {
          ...baseQuery,
          cursor,
          direction: 'prev',
          ...(perPage !== undefined ? { perPage } : {}),
        },
        callOpts,
      );
    },
  };
}
