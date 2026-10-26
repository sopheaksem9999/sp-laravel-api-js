import { describe, expect, expectTypeOf, it } from 'vitest';
import { SpApiError, serializeQuery } from '../../src/index';
import type { AggregateRow, Query, SerializeOptions } from '../../src/index';

const q = (query: Query, opts: Partial<SerializeOptions> = {}): URLSearchParams =>
  serializeQuery(query, { quoting: true, ...opts });

const unencodable = (fn: () => unknown): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).code).toBe('unencodable_value');
    return;
  }
  throw new Error('expected unencodable_value');
};

describe('aggregates', () => {
  it('serialises aggregate and group_by', () => {
    const p = q({ aggregate: { count: true, sum: ['total'], avg: ['qty'] }, groupBy: ['status'] });
    expect(p.get('aggregate')).toBe('count,sum:total,avg:qty');
    expect(p.get('group_by')).toBe('status');
  });

  it('serialises count:col, min and max, and several group_by columns', () => {
    const p = q({ aggregate: { count: ['id'], min: ['a'], max: ['b'] }, groupBy: ['x', 'y'] });
    expect(p.get('aggregate')).toBe('count:id,min:a,max:b');
    expect(p.get('group_by')).toBe('x,y');
  });

  it('rejects column names that would break the wire format', () => {
    unencodable(() => q({ aggregate: { sum: ['a,b'] } }));
  });

  it('derives the row type from the request', () => {
    expectTypeOf<AggregateRow<{ sum: ['total'] }>>().toHaveProperty('sum_total');
    expectTypeOf<AggregateRow<{ sum: ['total'] }>['sum_total']>().toEqualTypeOf<number>();
    expectTypeOf<AggregateRow<{ count: true; avg: ['qty'] }, ['status']>>().toHaveProperty('count');
    expectTypeOf<AggregateRow<{ count: true; avg: ['qty'] }, ['status']>>().toHaveProperty('avg_qty');
    expectTypeOf<AggregateRow<{ count: true; avg: ['qty'] }, ['status']>>().toHaveProperty('status');
    expectTypeOf<AggregateRow<{ sum: ['total'] }>>().not.toHaveProperty('count');
  });
});

describe('distinct and trashed', () => {
  it('sends distinct', () => {
    expect(q({ distinct: true }).get('distinct')).toBe('true');
    expect(q({}).has('distinct')).toBe(false);
  });

  it('maps trashed', () => {
    expect(q({ trashed: 'with' }).get('with_trashed')).toBe('true');
    expect(q({ trashed: 'only' }).get('only_trashed')).toBe('true');
    expect(q({}).has('with_trashed')).toBe(false);
  });
});

describe('negation', () => {
  it('sends not.<op>.<v>', () => {
    expect(q({ where: { name: { not: { contains: 'x' } } } }).get('name')).toBe('not.contains.x');
    expect(q({ where: { d: { not: { date_gt: '2026-01-01' } } } }).get('d')).toBe('not.date_gt.2026-01-01');
  });

  it('falls back to not_like with quoting:false', () => {
    const o = { quoting: false };
    expect(q({ where: { name: { not: { contains: 'x' } } } }, o).get('name')).toBe('not_like.%x%');
    expect(q({ where: { name: { not: { starts_with: 'x' } } } }, o).get('name')).toBe('not_like.x%');
    expect(q({ where: { name: { not: { ends_with: 'x' } } } }, o).get('name')).toBe('not_like.%x');
  });

  it('throws with quoting:false where no fallback exists', () => {
    unencodable(() => q({ where: { d: { not: { date_gt: '2026-01-01' } } } }, { quoting: false }));
  });

  it('rejects negation of operators that have none', () => {
    unencodable(() => q({ where: { n: { not: { eq: 1 } } } }));
  });
});

describe('any / all and anyOf', () => {
  it('serialises modifiers', () => {
    expect(q({ where: { name: { like: { any: ['a%', 'b%'] } } } }).get('name')).toBe('like(any).{a%,b%}');
    expect(q({ where: { name: { like: { all: ['%a%', '%b%'] } } } }).get('name')).toBe('like(all).{%a%,%b%}');
  });

  it('serialises anyOf as a joined column key', () => {
    expect(q({ where: { anyOf: ['name', 'sku'], ilike: 'cola' } }).get('name,sku')).toBe('ilike.cola');
    expect(q({ where: { 'name,sku': { ilike: 'cola' } } }).get('name,sku')).toBe('ilike.cola');
  });
});

describe('embed filters', () => {
  it('serialises an embed filter', () => {
    const p = q({ select: ['id', { items: { cols: ['*'], where: { status: { eq: 'paid' } } } }] });
    expect(p.get('select')).toBe('id,items(*,status=eq.paid)');
  });

  it('serialises bare scalars and several filters', () => {
    const p = q({ select: [{ items: { cols: ['*'], where: { status: 'paid', qty: { gt: 1 } } } }] });
    expect(p.get('select')).toBe('items(*,status=eq.paid,qty=gt.1)');
  });

  it('keeps the plain array form', () => {
    expect(q({ select: [{ customer: ['id'] }] }).get('select')).toBe('customer(id)');
  });

  it('rejects regex, not_like, empty and negation', () => {
    for (const where of [
      { a: { regex: 'x' } },
      { a: { not_like: 'x' } },
      { a: { empty: true } },
      { a: { not: { contains: 'x' } } },
    ]) {
      unencodable(() => q({ select: [{ items: { cols: ['*'], where } }] }));
    }
  });

  it('rejects raw, anyOf and modifiers in embeds', () => {
    unencodable(() => q({ select: [{ items: { cols: ['*'], where: { raw: 'a=eq.1' } } }] }));
    unencodable(() => q({ select: [{ items: { cols: ['*'], where: { anyOf: ['a', 'b'], eq: 1 } } }] }));
    unencodable(() => q({ select: [{ items: { cols: ['*'], where: { a: { like: { any: ['x'] } } } } }] }));
  });
});

describe('or items', () => {
  it('keeps multi-condition items as nested and(...)', () => {
    const p = q({ or: [{ a: 1, b: { gt: 2 } }, { c: 3 }] });
    expect(p.get('or')).toBe('(and(a.eq.1,b.gt.2),c.eq.3)');
  });

  it('rejects raw inside or items (not representable in or=(...))', () => {
    unencodable(() => q({ or: [{ raw: 'a=eq.1' }] }));
  });

  it('supports negation and modifiers inside or items', () => {
    expect(q({ or: [{ a: { not: { contains: 'x' } } }, { b: { like: { any: ['p', 'q'] } } }] }).get('or')).toBe(
      '(a.not.contains.x,b.like(any).{p,q})',
    );
  });
});

describe('drivers', () => {
  it('rejects Postgres-only operators on mysql', () => {
    unencodable(() => q({ where: { t: { fts: 'x' } } }, { driver: 'mysql' }));
    unencodable(() => q({ or: [{ t: { cs: 'x' } }] }, { driver: 'mysql' }));
  });

  it('accepts them on pgsql and with no driver', () => {
    expect(q({ where: { t: { fts: 'x' } } }, { driver: 'pgsql' }).get('t')).toBe('fts.x');
    expect(q({ where: { t: { fts: 'x' } } }).get('t')).toBe('fts.x');
  });

  it('accepts regex on both drivers', () => {
    expect(q({ where: { t: { regex: 'x' } } }, { driver: 'mysql' }).get('t')).toBe('regex.x');
    expect(q({ where: { t: { regex: 'x' } } }, { driver: 'pgsql' }).get('t')).toBe('regex.x');
  });
});
