import { describe, expect, expectTypeOf, it } from 'vitest';
import { serializeQuery } from '../../src/core/serialize';
import { makeTable } from '../../src/core/table';
import type { RestoreResult } from '../../src/index';
import type { Query } from '../../src/core/query-types';
import type { RequestOptions } from '../../src/core/request';

interface Row {
  id: number;
}

type Call = RequestOptions;

function setup(responses: Array<{ data?: unknown; meta?: Record<string, unknown> } | Error>, name = 'invoices') {
  const calls: Call[] = [];
  let i = 0;
  const request = (async (o: RequestOptions) => {
    calls.push(o);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { data: r?.data ?? null, meta: r?.meta ?? {}, response: new Response() };
  }) as never;
  const serialize = (q: Query): URLSearchParams => serializeQuery(q, { quoting: true });
  return { calls, table: makeTable<Row>(name, { request, serialize }) };
}

const rows = (n: number, from = 1): Row[] => Array.from({ length: n }, (_, k) => ({ id: from + k }));
const qs = (c: Call | undefined): string => (c?.query instanceof URLSearchParams ? c.query.toString() : '');

describe('table.list', () => {
  it('GETs the table with per_page and cursor=0 for the first cursor page', async () => {
    const { calls, table } = setup([{ data: rows(2), meta: {} }]);
    await table.list({ perPage: 50, cursor: null });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('invoices');
    expect(qs(calls[0])).toBe('cursor=0&per_page=50');
  });

  it('next is meta.next_cursor only when the page is full', async () => {
    const full = setup([{ data: rows(2), meta: { next_cursor: 'c2', prev_cursor: 'c0' } }]);
    const p = await full.table.list({ perPage: 2, cursor: null });
    expect(p.next).toBe('c2');
    expect(p.prev).toBe('c0');
    const short = setup([{ data: rows(1), meta: { next_cursor: 'c2' } }]);
    expect((await short.table.list({ perPage: 2, cursor: null })).next).toBeNull();
    expect((await short.table.list({ perPage: 2, cursor: null })).prev).toBeNull();
  });

  it('uses the per_page the serializer sent (default 25)', async () => {
    const { table } = setup([{ data: rows(25), meta: { next_cursor: 'n' } }]);
    expect((await table.list({ cursor: null })).next).toBe('n');
  });

  it('total is null unless total:true was asked', async () => {
    const a = setup([{ data: rows(1), meta: { total: 9 } }]);
    expect((await a.table.list({ cursor: null })).total).toBeNull();
    const b = setup([{ data: rows(1), meta: { total: 9 } }]);
    expect((await b.table.list({ cursor: null, total: true })).total).toBe(9);
  });

  it('offset mode passes meta through with next null', async () => {
    const meta = { page: 2, last_page: 5, next_cursor: 'zzz' };
    const { calls, table } = setup([{ data: rows(2), meta }]);
    const p = await table.list({ page: 2, perPage: 2 });
    expect(qs(calls[0])).toBe('page=2&per_page=2');
    expect(p.next).toBeNull();
    expect(p.meta).toEqual(meta);
  });
});

describe('table CRUD', () => {
  it('get sends select', async () => {
    const { calls, table } = setup([{ data: { id: 7 } }]);
    expect(await table.get(7, { select: ['id', 'name'] })).toEqual({ id: 7 });
    expect(calls[0]?.path).toBe('invoices/7');
    expect(qs(calls[0])).toBe('select=id%2Cname');
  });

  it('create is POST and returns data', async () => {
    const { calls, table } = setup([{ data: { id: 1 } }]);
    expect(await table.create({ id: 1 })).toEqual({ id: 1 });
    expect(calls[0]).toMatchObject({ method: 'POST', path: 'invoices', body: { id: 1 } });
  });

  it('update is PUT and patch is PATCH', async () => {
    const { calls, table } = setup([{ data: { id: 7 } }]);
    await table.update(7, { id: 7 });
    await table.patch(7, { id: 7 });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['PUT', 'invoices/7'],
      ['PATCH', 'invoices/7'],
    ]);
  });

  it('remove with force sends ?force=true and resolves {deleted:true}', async () => {
    const { calls, table } = setup([{ data: null }]);
    expect(await table.remove(7, { force: true })).toEqual({ deleted: true });
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe('invoices/7');
    expect(qs(calls[0])).toBe('force=true');
  });

  it('remove without force sends no query', async () => {
    const { calls, table } = setup([{ data: { whatever: 1 } }]);
    expect(await table.remove(7)).toEqual({ deleted: true });
    expect(qs(calls[0])).toBe('');
  });

  it('restore POSTs to /restore and returns the backend count {restored}', async () => {
    const { calls, table } = setup([{ data: { restored: 1 } }]);
    expect(await table.restore(7)).toEqual({ restored: 1 });
    expectTypeOf(table.restore).returns.resolves.toEqualTypeOf<RestoreResult>();
    expect(calls[0]).toMatchObject({ method: 'POST', path: 'invoices/7/restore' });
  });

  it('exposes its name', () => {
    expect(setup([]).table.name).toBe('invoices');
  });
});

describe('table.upsert', () => {
  it('POSTs upsert with comma-joined match_on and returns {id,payload}', async () => {
    const { calls, table } = setup([{ data: { id: 5, payload: { a: 1 } } }]);
    const r = await table.upsert({ id: 1 }, { matchOn: ['qbo_id', 'sku'] });
    expect(r).toEqual({ id: 5, payload: { a: 1 } });
    expect(calls[0]).toMatchObject({ method: 'POST', path: 'invoices/upsert' });
    expect(qs(calls[0])).toBe('match_on=qbo_id%2Csku');
  });

  it('refetch follows with GET invoices/<id>', async () => {
    const { calls, table } = setup([{ data: { id: 5, payload: {} } }, { data: { id: 5 } }]);
    const r = await table.upsert({ id: 1 }, { matchOn: ['sku'], refetch: true, select: ['id'] });
    expect(r).toEqual({ id: 5 });
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.path).toBe('invoices/5');
    expect(qs(calls[1])).toBe('select=id');
  });
});

describe('path encoding', () => {
  it('encodes ids and table names per segment', async () => {
    const { calls, table } = setup([{ data: {} }]);
    await table.get('a/b');
    await table.get('x y#1');
    await table.get('3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab');
    expect(calls.map((c) => c.path)).toEqual([
      'invoices/a%2Fb',
      'invoices/x%20y%231',
      'invoices/3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab',
    ]);
    const t = setup([{ data: {} }], 'my table');
    await t.table.get(1);
    expect(t.calls[0]?.path).toBe('my%20table/1');
  });
});

describe('table.iterate', () => {
  async function collect(it: AsyncGenerator<Row>): Promise<Row[]> {
    const out: Row[] = [];
    for await (const r of it) out.push(r);
    return out;
  }

  it('follows next across 3 pages then stops', async () => {
    const { calls, table } = setup([
      { data: rows(2, 1), meta: { next_cursor: 'a' } },
      { data: rows(2, 3), meta: { next_cursor: 'b' } },
      { data: rows(1, 5), meta: { next_cursor: 'c' } },
    ]);
    const all = await collect(table.iterate({ perPage: 2 }));
    expect(all.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(3);
    expect(qs(calls[0])).toContain('cursor=0');
    expect(qs(calls[1])).toContain('cursor=a');
    expect(qs(calls[2])).toContain('cursor=b');
  });

  it('a full last page costs one more request, stopping on the empty page', async () => {
    const { calls, table } = setup([
      { data: rows(2), meta: { next_cursor: 'a' } },
      { data: [], meta: {} },
    ]);
    expect(await collect(table.iterate({ perPage: 2 }))).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('does not mutate the caller query', async () => {
    const { table } = setup([{ data: rows(1), meta: {} }]);
    const q: Query = { perPage: 2 };
    await collect(table.iterate(q));
    expect(q).toEqual({ perPage: 2 });
  });

  it('honours an already-aborted signal with its reason', async () => {
    const { calls, table } = setup([{ data: rows(2), meta: { next_cursor: 'a' } }]);
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(collect(table.iterate({ perPage: 2 }, { signal: ac.signal }))).rejects.toThrow('stop');
    expect(calls).toHaveLength(0);
  });

  it('aborting between pages rejects with the reason', async () => {
    const { calls, table } = setup([{ data: rows(2), meta: { next_cursor: 'a' } }]);
    const ac = new AbortController();
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const r of table.iterate({ perPage: 2 }, { signal: ac.signal })) {
          seen.push(r.id);
          if (seen.length === 2) ac.abort(new Error('halt'));
        }
      })(),
    ).rejects.toThrow('halt');
    expect(calls).toHaveLength(1);
  });
});

describe('table hardening', () => {
  it('iterate stops when next equals the cursor just sent', async () => {
    const { calls, table } = setup([{ data: rows(2), meta: { next_cursor: 'same' } }]);
    const out: Row[] = [];
    for await (const r of table.iterate({ perPage: 2, cursor: 'same' })) out.push(r);
    expect(out).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('iterate with page (offset mode) throws unencodable_value', async () => {
    const { calls, table } = setup([{ data: rows(1), meta: {} }]);
    await expect(table.iterate({ page: 1 }).next()).rejects.toMatchObject({
      name: 'SpApiError',
      code: 'unencodable_value',
      message: expect.stringContaining('iterate() requires cursor mode'),
    });
    expect(calls).toHaveLength(0);
  });

  it('upsert refetch without an id throws instead of requesting undefined', async () => {
    const { calls, table } = setup([{ data: { payload: {} }, meta: {} }]);
    await expect(table.upsert({}, { matchOn: ['a'], refetch: true })).rejects.toMatchObject({ code: 'unknown' });
    expect(calls).toHaveLength(1);
  });

  it('plain list() sends neither cursor nor page; next is next_cursor on a full page', async () => {
    const { calls, table } = setup([{ data: rows(25), meta: { next_cursor: 'n' } }]);
    const p = await table.list();
    expect(qs(calls[0])).toBe('per_page=25');
    expect(p.next).toBe('n');
  });
});
