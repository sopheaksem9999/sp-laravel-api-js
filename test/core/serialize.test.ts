import { describe, expect, it } from 'vitest';
import { SpApiError, serializeQuery } from '../../src/index';
import type { Query } from '../../src/index';

const q = (query: Query, quoting = true): URLSearchParams => serializeQuery(query, { quoting });

describe('serializeQuery', () => {
  it('always sends per_page', () => {
    expect(q({}).get('per_page')).toBe('25');
    expect(serializeQuery({}, { quoting: true, defaults: { perPage: 50 } }).get('per_page')).toBe('50');
    expect(serializeQuery({ perPage: 10 }, { quoting: true, defaults: { perPage: 50 } }).get('per_page')).toBe('10');
  });

  it('handles cursor mode', () => {
    expect(q({ cursor: null }).get('cursor')).toBe('0');
    expect(q({ cursor: '' }).get('cursor')).toBe('0');
    expect(q({ cursor: 'abc' }).get('cursor')).toBe('abc');
    expect(q({}).has('cursor')).toBe(false);
  });

  it('sends page', () => {
    expect(q({ page: 2 }).get('page')).toBe('2');
  });

  it('serialises in arrays', () => {
    expect(q({ where: { status: ['open', 'paid'] } }).get('status')).toBe('in.(open,paid)');
    expect(q({ where: { status: { in: ['open', 'paid'] } } }).get('status')).toBe('in.(open,paid)');
  });

  it('empty in sends in.()', () => {
    const p = q({ where: { status: { in: [] } } });
    expect(p.has('status')).toBe(true);
    expect(p.get('status')).toBe('in.()');
    expect(q({ where: { status: [] } }).get('status')).toBe('in.()');
  });

  it('quotes items', () => {
    expect(q({ where: { name: { in: ['Acme, Inc.', 'B'] } } }).get('name')).toBe('in.("Acme, Inc.",B)');
    expect(q({ where: { name: 'Acme, Inc.' } }).get('name')).toBe('eq."Acme, Inc."');
    expect(q({ where: { name: 'say "hi"' } }).get('name')).toBe('eq."say \\"hi\\""');
    expect(q({ where: { name: 'a\\b' } }).get('name')).toBe('eq."a\\\\b"');
    expect(q({ where: { name: ' lead' } }).get('name')).toBe('eq." lead"');
    expect(q({ where: { name: 'f(x)' } }).get('name')).toBe('eq."f(x)"');
    expect(q({ where: { name: 'plain' } }).get('name')).toBe('eq.plain');
  });

  it('throws unencodable_value when quoting is off', () => {
    for (const where of [{ name: 'Acme, Inc.' }, { name: { in: ['a', 'b)'] } }]) {
      try {
        q({ where }, false);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SpApiError);
        expect((e as SpApiError).code).toBe('unencodable_value');
      }
    }
    expect(q({ where: { name: 'plain' } }, false).get('name')).toBe('eq.plain');
  });

  it('serialises is null', () => {
    expect(q({ where: { deleted_at: { is: null } } }).get('deleted_at')).toBe('is.null');
  });

  it('groups multiple operators on one column into and=()', () => {
    const p = q({ where: { total: { gte: 100, lt: 500 } } });
    expect(p.get('and')).toBe('(total.gte.100,total.lt.500)');
    expect(p.has('total')).toBe(false);
  });

  it('serialises select', () => {
    expect(
      q({ select: ['id', 'ref_number', { customer: ['id', 'display_name'] }] }).get('select'),
    ).toBe('id,ref_number,customer(id,display_name)');
  });

  it('serialises nested embeds', () => {
    expect(q({ select: ['id', { customer: ['id', { address: ['city'] }] }] }).get('select')).toBe(
      'id,customer(id,address(city))',
    );
  });

  it('serialises sort and search', () => {
    const p = q({ sort: { by: 'created_at', order: 'desc' } });
    expect(p.get('sortby')).toBe('created_at');
    expect(p.get('order')).toBe('desc');
    expect(q({ search: { s: 'acme' } }).get('s')).toBe('acme');
    expect(q({ search: { search: 'acme' } }).get('search')).toBe('acme');
  });

  it('serialises or groups', () => {
    expect(q({ or: [{ status: 'draft' }, { due_date: { lt: '2026-11-01' } }] }).get('or')).toBe(
      '(status.eq.draft,due_date.lt.2026-11-01)',
    );
  });

  it('ANDs multiple conditions inside one or item', () => {
    expect(q({ or: [{ status: 'draft' }, { a: 1, b: 2 }] }).get('or')).toBe(
      '(status.eq.draft,and(a.eq.1,b.eq.2))',
    );
    expect(q({ or: [{ status: 'draft' }, { total: { gte: 1, lt: 5 } }] }).get('or')).toBe(
      '(status.eq.draft,and(total.gte.1,total.lt.5))',
    );
  });

  it('splits raw at the first =', () => {
    expect(q({ where: { raw: 'col=op.va=lue' } }).get('col')).toBe('op.va=lue');
  });

  it('serialises Date as ISO string', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(q({ where: { created_at: { gte: d } } }).get('created_at')).toBe('gte.2026-01-02T03:04:05.000Z');
  });

  it('never produces bracket keys', () => {
    const p = q({ where: { total: { gte: 1, lt: 5 }, a: 'x' }, or: [{ b: 1 }], select: ['id'] });
    for (const k of p.keys()) expect(k).not.toContain('[');
  });

  it('serialises total', () => {
    expect(q({ total: false }).get('total')).toBe('false');
    expect(q({ total: true }).get('total')).toBe('true');
    expect(serializeQuery({}, { quoting: true, defaults: { total: false } }).get('total')).toBe('false');
    expect(q({}).has('total')).toBe(false);
  });
});
