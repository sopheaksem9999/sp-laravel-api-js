/**
 * Filter operators understood by the SP API.
 *
 * Postgres-only operators (`regex`, `match`, `imatch`, `fts`, `plfts`, `phfts`, `wfts`, `cs`, `cd`, `ov`,
 * `sl`, `sr`, `nxl`, `nxr`, `adj`) are rejected by MySQL backends.
 */
export type Operator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in' | 'between' | 'not_between'
  | 'like' | 'ilike' | 'not_like' | 'not_ilike'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'is' | 'is_not' | 'empty' | 'not_empty'
  | 'date_eq' | 'date_gt' | 'date_gte' | 'date_lt' | 'date_lte'
  | 'regex' | 'match' | 'imatch' | 'fts' | 'plfts' | 'phfts' | 'wfts'
  | 'cs' | 'cd' | 'ov' | 'sl' | 'sr' | 'nxl' | 'nxr' | 'adj';

/** A single filter value. `Date` is sent as an ISO string. */
export type Scalar = string | number | boolean | Date | null;

/** Condition(s) on one column: a bare scalar (`eq`), an array (`in`) or an operator map. */
export type Condition = Scalar | Scalar[] | Partial<Record<Operator, Scalar | Scalar[]>>;

/** Column filters keyed by column name; the reserved key `raw` is a literal `'col=op.value'` pair. */
export type Where = { raw?: string } & { [column: string]: Condition | undefined };

/**
 * A selected column, or an object keyed by relation name whose value is the embedded columns
 * (`{ customer: ['id', 'display_name'] }`). The `{ cols, where }` form carries an embed filter.
 */
export type SelectItem = string | { [relation: string]: SelectItem[] | { cols: SelectItem[]; where?: Where } };

/** Aggregate request; the shape is completed by the advanced serializer. */
export interface AggregateSpec {
  [alias: string]: unknown;
}

export interface Query {
  select?: SelectItem[];
  where?: Where;
  or?: Where[];
  search?: { s?: string } | { search?: string };
  sort?: { by: string; order?: 'asc' | 'desc' };
  /** `undefined` = offset mode; `null`/`''` = first cursor page; string = continue. */
  cursor?: string | null;
  page?: number;
  perPage?: number;
  total?: boolean;
  distinct?: boolean;
  trashed?: 'with' | 'only';
  aggregate?: AggregateSpec;
  groupBy?: string[];
}

export interface SerializeOptions {
  /** When false, values needing quotes throw `unencodable_value` instead of being quoted. */
  quoting: boolean;
  driver?: 'pgsql' | 'mysql';
  defaults?: { perPage?: number; total?: boolean };
}
