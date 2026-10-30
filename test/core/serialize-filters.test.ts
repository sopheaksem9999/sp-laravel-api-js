import { describe, expect, it } from 'vitest';
import { SpApiError, serializeFilters, serializeQuery } from '../../src';
import type { FilterQuery, Query } from '../../src';

const opts = { quoting: true };

const queries: Array<[string, FilterQuery]> = [
  ['where', { where: { status: 'paid', total: { gte: 10 } } }],
  ['where with two operators on one column', { where: { total: { gte: 10, lte: 90 } } }],
  ['or groups', { or: [{ status: 'paid' }, { status: 'open', total: { gt: 5 } }] }],
  ['search', { search: { s: 'acme' } }],
  ['select with embeds', { select: ['id', 'number', { customer: ['id', 'name'] }] }],
  ['aggregate and groupBy', { aggregate: { sum: ['total'] }, groupBy: ['status'] }],
  ['distinct', { distinct: true }],
  ['trashed', { trashed: 'only' }],
  ['sort', { sort: { by: 'created_at', order: 'desc' } }],
  ['everything together', { select: ['id'], where: { status: 'paid' }, sort: { by: 'id' }, trashed: 'with', distinct: true }],
];

describe('serializeFilters', () => {
  it.each(queries)('matches serializeQuery minus per_page: %s', (_name, q) => {
    const full = serializeQuery(q as Query, opts);
    full.delete('per_page');
    expect(serializeFilters(q, opts).toString()).toBe(full.toString());
  });

  it('quotes like values: name=like."Smith, John (Jr)"', () => {
    const p = serializeFilters({ where: { name: { like: 'Smith, John (Jr)' } } }, opts);
    expect(p.get('name')).toBe('like."Smith, John (Jr)"');
    expect(p.has('per_page')).toBe(false);
  });

  it('a plain value is not quoted and the result has no paging at all', () => {
    const p = serializeFilters({ where: { email: { like: 'a@b.com' } } }, opts);
    expect(p.get('email')).toBe('like.a@b.com');
    expect([...p.keys()]).toEqual(['email']);
  });

  it('includes sort and trashed', () => {
    const p = serializeFilters({ sort: { by: 'created_at', order: 'desc' }, trashed: 'only' }, opts);
    expect(p.get('sortby')).toBe('created_at');
    expect(p.get('order')).toBe('desc');
    expect(p.get('only_trashed')).toBe('true');
  });

  it('an empty query gives an empty result (no per_page, no total)', () => {
    expect(serializeFilters({}, opts).toString()).toBe('');
  });

  it('quoting:false still throws unencodable_value for a value that needs quotes', () => {
    expect(() => serializeFilters({ where: { name: { like: 'a,b' } } }, { quoting: false })).toThrow(SpApiError);
  });

  it.each(['perPage', 'page', 'cursor', 'direction', 'cursorColumn', 'total'])(
    'throws unencodable_value for the paging key %s',
    (key) => {
      const q = { where: { status: 'paid' }, [key]: key === 'total' ? true : key === 'perPage' || key === 'page' ? 5 : 'x' };
      let err: unknown;
      try {
        serializeFilters(q as unknown as FilterQuery, opts);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SpApiError);
      expect((err as SpApiError).code).toBe('unencodable_value');
      expect((err as SpApiError).message).toContain(key);
    },
  );

  it('a paging key set to undefined is ignored', () => {
    const q = { where: { status: 'paid' }, perPage: undefined } as unknown as FilterQuery;
    expect(serializeFilters(q, opts).get('status')).toBe('eq.paid');
  });

  it('a paging key is a compile error', () => {
    // @ts-expect-error perPage belongs to serializeQuery, not to filters
    const bad: FilterQuery = { perPage: 5 };
    expect(bad).toBeDefined();
  });
});

describe('serializeQuery is unchanged', () => {
  it('still appends per_page last and honours defaults', () => {
    const p = serializeQuery({ where: { status: 'paid' }, cursor: 'c1', direction: 'prev' }, { quoting: true, defaults: { perPage: 7, total: true } });
    expect([...p.keys()]).toEqual(['status', 'cursor', 'direction', 'per_page', 'total']);
    expect(p.get('per_page')).toBe('7');
  });
});
