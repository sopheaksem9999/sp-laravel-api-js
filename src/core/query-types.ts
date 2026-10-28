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

/**
 * `any` / `all` modifier: the operator matches any (or all) of the listed values, e.g. `like(any).{a%,b%}`.
 * Items are never quoted (the host splits the list on commas and does not understand quotes): an empty list, an
 * empty item, or an item containing `,` `{` `}` `"` `\` or leading/trailing spaces throws `unencodable_value`.
 */
export type Modifier = { any: Scalar[] } | { all: Scalar[] };

/** The right-hand side of one operator: a value, a list, or an `any`/`all` modifier. */
export type OperandValue = Scalar | Scalar[] | Modifier;

/** Operator map for one column. `not` negates the operators nested inside it (`{ not: { contains: 'x' } }`). */
export type OperatorMap = Partial<Record<Operator, OperandValue>> & {
  not?: Partial<Record<Operator, OperandValue>>;
};

/** Condition(s) on one column: a bare scalar (`eq`), an array (`in`) or an operator map. */
export type Condition = Scalar | Scalar[] | OperatorMap;

/**
 * Column filters keyed by column name. Reserved keys:
 * - `raw`: a literal `'col=op.value'` pair (a value with no `=` after a non-empty column throws `unencodable_value`);
 * - `anyOf`: columns ORed together (`name,sku=op.v`); the remaining keys are then operators, not columns,
 *   e.g. `{ anyOf: ['name', 'sku'], ilike: 'cola' }`.
 */
export type Where = { raw?: string; anyOf?: string[] } & { [column: string]: Condition | undefined };

/**
 * A selected column, or an object keyed by relation name whose value is the embedded columns
 * (`{ customer: ['id', 'display_name'] }`). The `{ cols, where }` form carries an embed filter
 * (`items(*,status=eq.paid)`); embeds allow no `regex`, `not_like`, `empty`, negation, `raw`, `anyOf` or modifiers.
 */
export type SelectItem = string | { [relation: string]: SelectItem[] | { cols: SelectItem[]; where?: Where } };

/**
 * Aggregate request. `count: true` is a row count; the column lists are sent as `fn:col`.
 * Result aliases are fixed: `count` and `{fn}_{col}` (see {@link AggregateRow}).
 */
export interface AggregateSpec {
  count?: true | readonly string[];
  sum?: readonly string[];
  avg?: readonly string[];
  min?: readonly string[];
  max?: readonly string[];
}

type ColumnsOf<S, F extends string> = S extends { [K in F]?: infer C }
  ? NonNullable<C> extends readonly (infer E extends string)[]
    ? E
    : never
  : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Row shape of an aggregate response, derived from the request:
 * `AggregateRow<{ sum: ['total'] }, ['status']>` is `{ sum_total: number; status: unknown }`.
 * `count: true` yields `count`; `count: ['col']` yields `count_col`.
 */
export type AggregateRow<S extends AggregateSpec, G extends readonly string[] = []> = Simplify<
  (S extends { count: true } ? { count: number } : unknown) &
    { [C in ColumnsOf<S, 'count'> as `count_${C}`]: number } &
    { [C in ColumnsOf<S, 'sum'> as `sum_${C}`]: number } &
    { [C in ColumnsOf<S, 'avg'> as `avg_${C}`]: number } &
    { [C in ColumnsOf<S, 'min'> as `min_${C}`]: number | string | null } &
    { [C in ColumnsOf<S, 'max'> as `max_${C}`]: number | string | null } &
    { [C in G[number]]: unknown }
>;

export interface Query {
  select?: SelectItem[];
  where?: Where;
  or?: Where[];
  search?: { s?: string } | { search?: string };
  sort?: { by: string; order?: 'asc' | 'desc' };
  /** `undefined` = offset mode; `null`/`''` = first cursor page; string = continue. */
  cursor?: string | null;
  /** Cursor paging direction: `'prev'` reads the rows before `cursor` (sent as `direction=`). Default on the host: `'next'`. */
  direction?: 'next' | 'prev';
  /** Column the cursor pages on (sent as `cursor_column=`). Default on the host: the sorted column. */
  cursorColumn?: string;
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
