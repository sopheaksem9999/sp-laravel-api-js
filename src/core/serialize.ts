import { SpApiError } from './errors';
import type {
  AggregateSpec,
  Condition,
  OperandValue,
  Query,
  Scalar,
  SelectItem,
  SerializeOptions,
  Where,
} from './query-types';

const NEEDS_QUOTES = /[,()"\\]|^\s|\s$/;
/**
 * Characters an `any`/`all` list item cannot carry: the host's `parseModifierValues` is a plain
 * `explode(',')` + `trim` inside `{...}` with no quote handling, so quoting cannot protect them.
 */
const MODIFIER_UNSAFE = /[,{}"\\]|^\s|\s$/;
const LIST_OPERATORS: ReadonlySet<string> = new Set(['in', 'not_in', 'between', 'not_between']);
const LITERAL_OPERATORS: ReadonlySet<string> = new Set(['is', 'is_not']);
const FALLBACK_PER_PAGE = 25;

function unencodable(message: string): SpApiError {
  return new SpApiError({ status: 0, code: 'unencodable_value', message });
}

/** Formats one value for the wire, quoting (or throwing) when it holds reserved characters. */
function formatValue(v: Scalar, quoting: boolean): string {
  if (v === null) return 'null';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (!NEEDS_QUOTES.test(s)) return s;
  if (!quoting) {
    throw unencodable(`Value ${JSON.stringify(s)} contains reserved characters and cannot be sent with quoting disabled`);
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One `operator -> value` pair of a condition, after normalising bare values, `not` and `any`/`all`. */
interface Op {
  op: string;
  value: Scalar | Scalar[];
  negated: boolean;
  modifier?: 'any' | 'all';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function operandOf(op: string, value: OperandValue, negated: boolean): Op {
  if (isPlainObject(value)) {
    if ('any' in value) return { op, value: value.any as Scalar[], negated, modifier: 'any' };
    if ('all' in value) return { op, value: value.all as Scalar[], negated, modifier: 'all' };
  }
  return { op, value: value as Scalar | Scalar[], negated };
}

/** Expands a condition into operators. A bare array means `in`; a bare scalar means `eq`. */
function operands(cond: Condition): Op[] {
  if (Array.isArray(cond)) return [{ op: 'in', value: cond, negated: false }];
  if (!isPlainObject(cond)) return [{ op: 'eq', value: cond as Scalar, negated: false }];
  const out: Op[] = [];
  for (const [op, v] of Object.entries(cond) as Array<[string, unknown]>) {
    if (v === undefined) continue;
    if (op === 'not') {
      for (const [nop, nv] of Object.entries(v as Record<string, OperandValue | undefined>)) {
        if (nv !== undefined) out.push(operandOf(nop, nv, true));
      }
    } else {
      out.push(operandOf(op, v as OperandValue, false));
    }
  }
  return out;
}

/** Postgres-only operators, rejected on `driver: 'mysql'`. */
const PG_ONLY: ReadonlySet<string> = new Set(['fts', 'plfts', 'phfts', 'wfts', 'cs', 'cd', 'ov', 'sl', 'sr', 'nxl', 'nxr', 'adj']);
/** Operators the host accepts after `not.` (from 0.5.06); every other negation is a 422. */
const NEGATABLE: ReadonlySet<string> = new Set(['contains', 'starts_with', 'ends_with']);
const isNegatable = (op: string): boolean => NEGATABLE.has(op) || op.startsWith('date_');
/** Operators the host rejects inside embed filters. */
const NO_EMBED: ReadonlySet<string> = new Set(['regex', 'not_like', 'empty']);
/** `not.<op>` -> `not_like` pattern for hosts without `not.` support (`quoting: false`). */
const LIKE_FALLBACK: Record<string, (v: string) => string> = {
  contains: (v) => `%${v}%`,
  starts_with: (v) => `${v}%`,
  ends_with: (v) => `%${v}`,
};

/** Throws `unencodable_value` for operators the target driver, negation rules or embed context do not allow. */
function validate(o: Op, opts: SerializeOptions, embed: boolean): void {
  if (opts.driver === 'mysql' && PG_ONLY.has(o.op)) {
    throw unencodable(`Operator "${o.op}" is Postgres-only and not supported by the "mysql" driver`);
  }
  if (embed) {
    if (o.negated) throw unencodable(`Negation of "${o.op}" is not allowed inside an embed filter`);
    if (NO_EMBED.has(o.op)) throw unencodable(`Operator "${o.op}" is not allowed inside an embed filter`);
    if (o.modifier !== undefined) throw unencodable(`The "${o.modifier}" modifier is not allowed inside an embed filter`);
  }
  if (o.negated && !isNegatable(o.op)) {
    throw unencodable(`Operator "${o.op}" has no "not." form; use its negated operator (e.g. neq, not_in, not_like)`);
  }
}

/** Formats the `op.value` part of a condition (`not.`, `(any)` and fallbacks included). */
function formatOperand(o: Op, quoting: boolean): string {
  let { op, value } = o;
  let prefix = '';
  if (o.negated) {
    if (quoting) {
      prefix = 'not.';
    } else {
      const fallback = LIKE_FALLBACK[op];
      if (fallback === undefined) {
        throw unencodable(`"not.${op}" needs a host >= 0.5.06 and has no fallback with quoting disabled`);
      }
      const wrap = (v: Scalar): Scalar => fallback(v instanceof Date ? v.toISOString() : String(v));
      value = Array.isArray(value) ? value.map(wrap) : wrap(value);
      op = 'not_like';
    }
  }
  if (o.modifier !== undefined) {
    const items = Array.isArray(value) ? value : [value];
    if (items.length === 0) throw unencodable(`The "${o.modifier}" modifier needs at least one value`);
    const list = items.map((x) => {
      const s = x === null ? 'null' : x instanceof Date ? x.toISOString() : String(x);
      // Checked regardless of `quoting`: the host never unquotes modifier items, and drops empty ones.
      if (s === '' || MODIFIER_UNSAFE.test(s)) {
        throw unencodable(
          `"${o.modifier}" item ${JSON.stringify(s)} cannot be sent: the host splits the list on commas and does not ` +
            'understand quotes, so items must be non-empty and contain no , { } " \\ or leading/trailing spaces',
        );
      }
      return s;
    });
    return `${prefix}${op}(${o.modifier}).{${list.join(',')}}`;
  }
  if (Array.isArray(value)) return `${prefix}${op}.(${value.map((x) => formatValue(x, quoting)).join(',')})`;
  if (LIST_OPERATORS.has(op)) return `${prefix}${op}.(${formatValue(value, quoting)})`;
  if (LITERAL_OPERATORS.has(op)) return `${prefix}${op}.${value === null ? 'null' : String(value)}`;
  return `${prefix}${op}.${formatValue(value, quoting)}`;
}

/**
 * Column/conditions pairs of a Where. `anyOf` makes the remaining keys operators on the joined column key
 * (`name,sku`). `raw` is returned separately; `undefined` values are dropped.
 */
function columns(where: Where): { raw?: string; entries: Array<[string, Op[]]> } {
  const { raw, anyOf, ...rest } = where;
  const entries: Array<[string, Op[]]> = [];
  if (anyOf !== undefined) {
    if (anyOf.length === 0) throw unencodable('anyOf needs at least one column');
    entries.push([anyOf.join(','), operands(rest as Condition)]);
  } else {
    for (const [col, cond] of Object.entries(rest)) {
      if (cond !== undefined) entries.push([col, operands(cond)]);
    }
  }
  return { raw, entries };
}

/** Rendered select/embed items. Embed filters are `col=op.value` pairs after the columns. */
function formatSelect(items: SelectItem[], opts: SerializeOptions): string {
  return items
    .flatMap((i) => {
      if (typeof i === 'string') return [i];
      return Object.entries(i).map(([relation, spec]) => {
        if (Array.isArray(spec)) return `${relation}(${formatSelect(spec, opts)})`;
        const parts = [formatSelect(spec.cols, opts)];
        if (spec.where !== undefined) {
          const { raw, entries } = columns(spec.where);
          if (raw !== undefined) throw unencodable('"raw" is not allowed inside an embed filter');
          if (spec.where.anyOf !== undefined) throw unencodable('"anyOf" is not allowed inside an embed filter');
          for (const [col, ops] of entries) {
            for (const o of ops) {
              validate(o, opts, true);
              parts.push(`${col}=${formatOperand(o, opts.quoting)}`);
            }
          }
        }
        return `${relation}(${parts.join(',')})`;
      });
    })
    .join(',');
}

const AGGREGATE_FNS = ['count', 'sum', 'avg', 'min', 'max'] as const;

function formatAggregate(spec: AggregateSpec): string {
  const out: string[] = [];
  for (const fn of AGGREGATE_FNS) {
    const v = spec[fn];
    if (v === undefined) continue;
    if (v === true) {
      out.push(fn);
      continue;
    }
    for (const col of v) {
      if (/[,:()\s]/.test(col) || col === '') throw unencodable(`Aggregate column ${JSON.stringify(col)} cannot be sent`);
      out.push(`${fn}:${col}`);
    }
  }
  return out.join(',');
}

/**
 * Dotted `col.op.value` conditions of a Where, used inside `or=(...)` / `and=(...)` groups.
 * `raw` has no dotted form, so inside an `or` item it throws `unencodable_value` rather than being dropped.
 */
function groupConditions(where: Where, opts: SerializeOptions): string[] {
  const { raw, entries } = columns(where);
  if (raw !== undefined) throw unencodable('"raw" is not supported inside an "or" item');
  return entries.flatMap(([col, ops]) =>
    ops.map((o) => {
      validate(o, opts, false);
      return `${col}.${formatOperand(o, opts.quoting)}`;
    }),
  );
}

/** Converts a `Query` into the URL parameters the SP API expects. */
export function serializeQuery(q: Query, opts: SerializeOptions): URLSearchParams {
  const p = new URLSearchParams();
  const { quoting } = opts;

  if (q.select !== undefined && q.select.length > 0) p.set('select', formatSelect(q.select, opts));

  const andGroup: string[] = [];
  if (q.where !== undefined) {
    const { raw, entries } = columns(q.where);
    if (raw !== undefined) {
      const eq = raw.indexOf('=');
      if (eq <= 0) throw unencodable(`"raw" must be a 'col=op.value' pair; got ${JSON.stringify(raw)}`);
      p.set(raw.slice(0, eq), raw.slice(eq + 1));
    }
    for (const [col, ops] of entries) {
      for (const o of ops) validate(o, opts, false);
      if (ops.length === 1) p.set(col, formatOperand(ops[0] as Op, quoting));
      else for (const o of ops) andGroup.push(`${col}.${formatOperand(o, quoting)}`);
    }
  }
  if (andGroup.length > 0) p.set('and', `(${andGroup.join(',')})`);

  if (q.or !== undefined) {
    const parts = q.or
      .map((w) => groupConditions(w, opts))
      .filter((c) => c.length > 0)
      .map((c) => (c.length === 1 ? (c[0] as string) : `and(${c.join(',')})`));
    if (parts.length > 0) p.set('or', `(${parts.join(',')})`);
  }

  if (q.aggregate !== undefined) {
    const agg = formatAggregate(q.aggregate);
    if (agg !== '') p.set('aggregate', agg);
  }
  if (q.groupBy !== undefined && q.groupBy.length > 0) p.set('group_by', q.groupBy.join(','));
  if (q.distinct === true) p.set('distinct', 'true');
  if (q.trashed === 'with') p.set('with_trashed', 'true');
  else if (q.trashed === 'only') p.set('only_trashed', 'true');

  if (q.search !== undefined) {
    if ('s' in q.search && q.search.s !== undefined) p.set('s', q.search.s);
    if ('search' in q.search && q.search.search !== undefined) p.set('search', q.search.search);
  }

  if (q.sort !== undefined) {
    // Runtime guard for untyped callers: `sort: ['-created_at']` would otherwise send `sortby=undefined`.
    if (Array.isArray(q.sort) || typeof q.sort !== 'object' || q.sort === null || typeof q.sort.by !== 'string') {
      throw unencodable('"sort" must be { by: string, order?: "asc" | "desc" } (one column; arrays are not supported)');
    }
    p.set('sortby', q.sort.by);
    if (q.sort.order !== undefined) p.set('order', q.sort.order);
  }

  if (q.cursor !== undefined) p.set('cursor', q.cursor === null || q.cursor === '' ? '0' : q.cursor);
  else if (q.page !== undefined) p.set('page', String(q.page));

  p.set('per_page', String(q.perPage ?? opts.defaults?.perPage ?? FALLBACK_PER_PAGE));

  const total = q.total ?? opts.defaults?.total;
  if (total !== undefined) p.set('total', String(total));

  return p;
}
