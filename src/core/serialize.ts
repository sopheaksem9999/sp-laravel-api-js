import { SpApiError } from './errors';
import type { Condition, Operator, Query, Scalar, SelectItem, SerializeOptions, Where } from './query-types';

const NEEDS_QUOTES = /[,()"\\]|^\s|\s$/;
const LIST_OPERATORS: ReadonlySet<string> = new Set(['in', 'not_in', 'between', 'not_between']);
const LITERAL_OPERATORS: ReadonlySet<string> = new Set(['is', 'is_not']);
const FALLBACK_PER_PAGE = 25;

/** Formats one value for the wire, quoting (or throwing) when it holds reserved characters. */
function formatValue(v: Scalar, quoting: boolean): string {
  if (v === null) return 'null';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (!NEEDS_QUOTES.test(s)) return s;
  if (!quoting) {
    throw new SpApiError({
      status: 0,
      code: 'unencodable_value',
      message: `Value ${JSON.stringify(s)} contains reserved characters and cannot be sent with quoting disabled`,
    });
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Formats the `op.value` part of a condition. */
function formatOperand(op: string, value: Scalar | Scalar[], quoting: boolean): string {
  if (Array.isArray(value)) return `${op}.(${value.map((x) => formatValue(x, quoting)).join(',')})`;
  if (LIST_OPERATORS.has(op)) return `${op}.(${formatValue(value, quoting)})`;
  if (LITERAL_OPERATORS.has(op)) return `${op}.${value === null ? 'null' : String(value)}`;
  return `${op}.${formatValue(value, quoting)}`;
}

/** Expands a condition into `[operator, value]` pairs. A bare array means `in`; a bare scalar means `eq`. */
function operands(cond: Condition): Array<[string, Scalar | Scalar[]]> {
  if (Array.isArray(cond)) return [['in', cond]];
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    return (Object.entries(cond) as Array<[Operator, Scalar | Scalar[] | undefined]>).filter(
      (e): e is [Operator, Scalar | Scalar[]] => e[1] !== undefined,
    );
  }
  return [['eq', cond]];
}

function formatSelect(items: SelectItem[]): string {
  return items.map((i) => (typeof i === 'string' ? i : `${i.embed}(${formatSelect(i.select)})`)).join(',');
}

/** Dotted `col.op.value` conditions of a Where, used inside `or=(...)` / `and=(...)` groups. */
function groupConditions(where: Where, quoting: boolean): string[] {
  const out: string[] = [];
  for (const [col, cond] of Object.entries(where)) {
    if (col === 'raw' || cond === undefined) continue;
    for (const [op, v] of operands(cond as Condition)) out.push(`${col}.${formatOperand(op, v, quoting)}`);
  }
  return out;
}

/** Converts a `Query` into the URL parameters the SP API expects. */
export function serializeQuery(q: Query, opts: SerializeOptions): URLSearchParams {
  const p = new URLSearchParams();
  const { quoting } = opts;

  if (q.select !== undefined && q.select.length > 0) p.set('select', formatSelect(q.select));

  const andGroup: string[] = [];
  for (const [col, cond] of Object.entries(q.where ?? {})) {
    if (cond === undefined) continue;
    if (col === 'raw') {
      const raw = String(cond);
      const eq = raw.indexOf('=');
      if (eq > 0) p.set(raw.slice(0, eq), raw.slice(eq + 1));
      continue;
    }
    const ops = operands(cond as Condition);
    if (ops.length === 1) {
      const [op, v] = ops[0] as [string, Scalar | Scalar[]];
      p.set(col, formatOperand(op, v, quoting));
    } else {
      for (const [op, v] of ops) andGroup.push(`${col}.${formatOperand(op, v, quoting)}`);
    }
  }
  if (andGroup.length > 0) p.set('and', `(${andGroup.join(',')})`);

  if (q.or !== undefined) {
    const parts = q.or.flatMap((w) => groupConditions(w, quoting));
    if (parts.length > 0) p.set('or', `(${parts.join(',')})`);
  }

  if (q.search !== undefined) {
    if ('s' in q.search && q.search.s !== undefined) p.set('s', q.search.s);
    if ('search' in q.search && q.search.search !== undefined) p.set('search', q.search.search);
  }

  if (q.sort !== undefined) {
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
