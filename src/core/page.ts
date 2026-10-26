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
