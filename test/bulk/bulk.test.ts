import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import { bulk } from '../../src/bulk';

interface Row {
  id?: number;
  name?: string;
}

interface Seen {
  url: URL;
  method: string;
  body: unknown;
  signal: AbortSignal | undefined;
}

const json = (data: unknown, meta: Record<string, unknown> = {}, status = 200): Response =>
  new Response(JSON.stringify({ success: true, data, meta }), { status, headers: { 'Content-Type': 'application/json' } });

const fail = (status: number, message = 'nope'): Response =>
  new Response(JSON.stringify({ success: false, message }), { status, headers: { 'Content-Type': 'application/json' } });

function setup(handler: (seen: Seen, n: number) => Promise<Response> | Response, name = 'invoices') {
  const calls: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const seen: Seen = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(seen);
    return handler(seen, calls.length - 1);
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api', fetch: fetchFn });
  return { calls, api, table: api.table<Row>(name) };
}

const mk = (n: number, from = 1): Row[] => Array.from({ length: n }, (_, k) => ({ name: `r${from + k}` }));
const echo = (s: Seen): Response => {
  const body = s.body as Row[];
  return json(body.map((r) => ({ ...r, id: 1 })), { affected: body.length });
};

describe('bulk.create', () => {
  it('splits 2,500 rows into 1000/1000/500 sequential requests to invoices/bulk/create', async () => {
    const { calls, table } = setup((s) => {
      const body = s.body as Row[];
      return json(body.map((r) => ({ name: r.name })), { affected: body.length });
    });
    const input = mk(2500);
    const r = await bulk(table).create(input);
    expect(calls.map((c) => (c.body as Row[]).length)).toEqual([1000, 1000, 500]);
    for (const c of calls) {
      expect(c.method).toBe('POST');
      expect(c.url.pathname).toBe('/api/invoices/bulk/create');
      expect(Array.isArray(c.body)).toBe(true);
      expect(c.url.search).toBe('');
    }
    if ('queued' in r) throw new Error('unexpected queued');
    expect(r.affected).toBe(2500);
    expect(r.rows.map((x) => x.name)).toEqual(input.map((x) => x.name));
  });

  it('sends a bare array even for one row', async () => {
    const { calls, table } = setup(echo);
    await bulk(table).create([{ name: 'a' }]);
    expect(calls[0]?.body).toEqual([{ name: 'a' }]);
  });

  it('async:true adds ?async=1 and resolves {queued:true} on 202', async () => {
    const { calls, table } = setup(() => json({ status: 'queued', message: 'Bulk operation queued for processing' }, {}, 202));
    const r = await bulk(table).create(mk(3), { async: true });
    expect(r).toEqual({ queued: true });
    expect(calls[0]?.url.searchParams.get('async')).toBe('1');
  });

  it('async with several chunks queues every chunk and resolves {queued:true}', async () => {
    const { calls, table } = setup(() => json({ status: 'queued' }, {}, 202));
    const r = await bulk(table).create(mk(5), { async: true, chunkSize: 2 });
    expect(r).toEqual({ queued: true });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.url.searchParams.get('async')).toBe('1');
  });

  it('a failing second chunk throws with completedChunks === 1 and never sends the third', async () => {
    const { calls, table } = setup((s, n) => (n === 1 ? fail(422, 'Validation failed') : echo(s)));
    const err = await bulk(table).create(mk(2500)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpApiError);
    expect(err).toMatchObject({ status: 422, code: 'validation', module: 'bulk', completedChunks: 1 });
    expect(calls).toHaveLength(2);
  });

  it('honours chunkSize', async () => {
    const { calls, table } = setup(echo);
    await bulk(table).create(mk(5), { chunkSize: 2 });
    expect(calls.map((c) => (c.body as Row[]).length)).toEqual([2, 2, 1]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects chunkSize %s with unencodable_value and sends nothing', async (chunkSize) => {
    const { calls, table } = setup(echo);
    await expect(bulk(table).create(mk(2), { chunkSize })).rejects.toMatchObject({ code: 'unencodable_value', module: 'bulk' });
    expect(calls).toHaveLength(0);
  });

  it.each([0, 1.5])('rejects concurrency %s', async (concurrency) => {
    const { table } = setup(echo);
    await expect(bulk(table).create(mk(2), { concurrency })).rejects.toMatchObject({ code: 'unencodable_value' });
  });

  it('empty input resolves {rows:[],affected:0} with no request', async () => {
    const { calls, table } = setup(echo);
    expect(await bulk(table).create([])).toEqual({ rows: [], affected: 0 });
    expect(calls).toHaveLength(0);
  });

  it('concurrency: 2 keeps original order and never exceeds 2 in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { calls, table } = setup(async (s, n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // later chunks answer faster, so completion order differs from request order
      await new Promise((r) => setTimeout(r, (5 - n) * 5));
      inFlight--;
      return echo(s);
    });
    const input = mk(10);
    const r = await bulk(table).create(input, { chunkSize: 2, concurrency: 2 });
    expect(peak).toBe(2);
    expect(calls).toHaveLength(5);
    if ('queued' in r) throw new Error('unexpected queued');
    expect(r.rows.map((x) => x.name)).toEqual(input.map((x) => x.name));
    expect(r.affected).toBe(10);
  });

  it('with concurrency a failure stops starting new chunks and aborts in-flight ones', async () => {
    const { calls, table } = setup((s, n) => {
      if (n === 0) return fail(500, 'boom');
      return new Promise<Response>((_, reject) => {
        s.signal?.addEventListener('abort', () => reject(s.signal?.reason), { once: true });
      });
    });
    const err = await bulk(table).create(mk(8), { chunkSize: 2, concurrency: 2 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'server', completedChunks: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.signal?.aborted).toBe(true);
  });

  it('an aborted signal stops further chunks and rejects with the abort reason', async () => {
    const ctl = new AbortController();
    const reason = new Error('stop');
    const { calls, table } = setup((s, n) => {
      if (n === 0) ctl.abort(reason);
      return echo(s);
    });
    const err = await bulk(table).create(mk(6), { chunkSize: 2, signal: ctl.signal }).catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('an already aborted signal sends nothing', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('early'));
    const { calls, table } = setup(echo);
    await expect(bulk(table).create(mk(2), { signal: ctl.signal })).rejects.toThrow('early');
    expect(calls).toHaveLength(0);
  });

  it('tolerates a 204 / body-less response', async () => {
    const { table } = setup(() => new Response(null, { status: 204 }));
    expect(await bulk(table).create(mk(2))).toEqual({ rows: [], affected: 0 });
  });

  it('404 becomes module_disabled with module bulk', async () => {
    const { table } = setup(() => fail(404, 'Not Found'));
    await expect(bulk(table).create(mk(1))).rejects.toMatchObject({ code: 'module_disabled', module: 'bulk', status: 404 });
  });

  it('encodes table names with special characters', async () => {
    const { calls, table } = setup(echo, 'my table/x?');
    await bulk(table).create(mk(1));
    expect(calls[0]?.url.pathname).toBe('/api/my%20table%2Fx%3F/bulk/create');
  });
});

describe('bulk.update', () => {
  it('posts to bulk/update and concatenates rows and affected', async () => {
    const { calls, table } = setup((s) => {
      const body = s.body as Row[];
      return json(body, { affected: body.length });
    });
    const r = await bulk(table).update([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }], { chunkSize: 2 });
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/invoices/bulk/update', '/api/invoices/bulk/update']);
    expect(r).toEqual({ rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }], affected: 3 });
  });
});

describe('bulk.delete', () => {
  it('accepts ids', async () => {
    const { calls, table } = setup((s) => json((s.body as number[]).map((id) => ({ id })), { affected: 3 }));
    const r = await bulk(table).delete([1, 2, 3]);
    expect(calls[0]?.url.pathname).toBe('/api/invoices/bulk/delete');
    expect(calls[0]?.body).toEqual([1, 2, 3]);
    expect(r).toEqual({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], affected: 3 });
  });

  it('accepts rows and sends their primary keys', async () => {
    const { calls, table } = setup(() => json([], { affected: 2 }));
    await bulk(table).delete([{ id: 4, name: 'x' }, { id: 5 }]);
    expect(calls[0]?.body).toEqual([4, 5]);
  });

  it('uses the pk module option for rows', async () => {
    const { calls, table } = setup(() => json([], { affected: 1 }), 'things');
    await bulk(table, { pk: 'uuid' }).delete([{ uuid: 'a-1' } as Partial<Row>]);
    expect(calls[0]?.body).toEqual(['a-1']);
  });

  it('throws unencodable_value for a row without the primary key, sending nothing', async () => {
    const { calls, table } = setup(echo);
    await expect(bulk(table).delete([{ name: 'x' }])).rejects.toMatchObject({ code: 'unencodable_value', module: 'bulk' });
    expect(calls).toHaveLength(0);
  });

  it('chunks long id lists', async () => {
    const { calls, table } = setup(() => json([], { affected: 0 }));
    await bulk(table).delete(Array.from({ length: 5 }, (_, i) => i + 1), { chunkSize: 2 });
    expect(calls.map((c) => c.body)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('bulk.upsert', () => {
  it('sends match_on and resolves {count} summed across chunks', async () => {
    const { calls, table } = setup((s) => json({ count: (s.body as Row[]).length }));
    const r = await bulk(table).upsert(mk(3), { matchOn: ['number', 'year'], chunkSize: 2 });
    expect(r).toEqual({ count: 3 });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url.pathname).toBe('/api/invoices/bulk/upsert');
      expect(c.url.searchParams.get('match_on')).toBe('number,year');
    }
  });

  it('does not send async (the backend has no async branch for upsert)', async () => {
    const { calls, table } = setup(() => json({ count: 1 }));
    expect(await bulk(table).upsert(mk(1), { matchOn: ['a'], async: true })).toEqual({ count: 1 });
    expect(calls[0]?.url.searchParams.has('async')).toBe(false);
  });

  it.each([[[]], [['']], [['a,b']]])('rejects matchOn %j', async (matchOn) => {
    const { calls, table } = setup(() => json({ count: 0 }));
    await expect(bulk(table).upsert(mk(1), { matchOn })).rejects.toMatchObject({ code: 'unencodable_value' });
    expect(calls).toHaveLength(0);
  });

  it('empty input resolves {count:0} with no request', async () => {
    const { calls, table } = setup(() => json({ count: 0 }));
    expect(await bulk(table).upsert([], { matchOn: ['a'] })).toEqual({ count: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('bulk.mixed', () => {
  it('posts one tagged bare array to {table}/bulk', async () => {
    const { calls, table } = setup(() => json([{ id: 1 }, { id: 2 }], { affected: 2 }));
    const r = await bulk(table).mixed({ create: [{ name: 'n' }], update: [{ id: 2, name: 'u' }], delete: [7, { id: 8 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe('/api/invoices/bulk');
    expect(calls[0]?.body).toEqual([
      { name: 'n', operation: 'create' },
      { id: 2, name: 'u', operation: 'update' },
      { id: 7, operation: 'delete' },
      { id: 8, operation: 'delete' },
    ]);
    expect(r).toEqual({ rows: [{ id: 1 }, { id: 2 }], affected: 2 });
  });

  it('chunks across the flattened list and rejects async', async () => {
    const { calls, table } = setup(() => json([], { affected: 0 }));
    await bulk(table).mixed({ create: mk(3), delete: [1, 2] }, { chunkSize: 2 });
    expect(calls).toHaveLength(3);
    await expect(bulk(table).mixed({ create: mk(1) }, { async: true })).rejects.toMatchObject({ code: 'unencodable_value' });
  });

  it('empty ops resolve with no request', async () => {
    const { calls, table } = setup(echo);
    expect(await bulk(table).mixed({})).toEqual({ rows: [], affected: 0 });
    expect(calls).toHaveLength(0);
  });
});
