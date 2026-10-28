import { describe, expect, it, vi } from 'vitest';
import { buildPage, createCursorPagination } from '../../src/core/page';
import type { Page } from '../../src/core/page';
import type { Query } from '../../src/core/query-types';
import { createApi } from '../../src';

describe('buildPage', () => {
  it('identifies next_cursor on full page and ignores on short page', () => {
    const full = buildPage([{ id: 1 }, { id: 2 }], { next_cursor: 'cur_abc' }, { perPage: 2, offsetMode: false, wantTotal: false });
    expect(full.next).toBe('cur_abc');

    const short = buildPage([{ id: 1 }], { next_cursor: 'cur_abc' }, { perPage: 2, offsetMode: false, wantTotal: false });
    expect(short.next).toBeNull();
  });

  it('never yields next_cursor in offsetMode', () => {
    const page = buildPage([{ id: 1 }, { id: 2 }], { next_cursor: 'cur_abc' }, { perPage: 2, offsetMode: true, wantTotal: false });
    expect(page.next).toBeNull();
  });

  it('populates total only when wantTotal is true', () => {
    const noTotal = buildPage([{ id: 1 }], { total: 42 }, { perPage: 2, offsetMode: false, wantTotal: false });
    expect(noTotal.total).toBeNull();

    const withTotal = buildPage([{ id: 1 }], { total: 42 }, { perPage: 2, offsetMode: false, wantTotal: true });
    expect(withTotal.total).toBe(42);
  });
});

describe('createCursorPagination', () => {
  it('firstPage() queries with cursor: null and forwards base query and perPage', async () => {
    const calls: Query[] = [];
    const mockTable = {
      async list(q: Query = {}): Promise<Page<{ id: number }>> {
        calls.push(q);
        return { data: [{ id: 1 }, { id: 2 }], next: 'cur_page_2', prev: null, total: null, meta: {} };
      },
    };

    const pagination = createCursorPagination(mockTable, {
      query: { where: { status: 'active' } },
      perPage: 15,
    });

    const page = await pagination.firstPage();
    expect(page.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls[0]).toEqual({
      where: { status: 'active' },
      cursor: null,
      perPage: 15,
    });
  });

  it('lastPage() reverses sort direction and restores items to canonical order', async () => {
    const calls: Query[] = [];
    const mockTable = {
      async list(q: Query = {}): Promise<Page<{ id: number; createdAt: string }>> {
        calls.push(q);
        // Backend returns items in reversed sort order
        return {
          data: [
            { id: 10, createdAt: '2026-03-01' },
            { id: 9, createdAt: '2026-02-01' },
            { id: 8, createdAt: '2026-01-01' },
          ],
          next: 'cursor_before_8',
          prev: null,
          total: 10,
          meta: {},
        };
      },
    };

    // Case 1: explicit sort asc -> reversed to desc
    const pagination = createCursorPagination(mockTable, { perPage: 3, query: { sort: { by: 'id', order: 'asc' } } });
    const lastPage = await pagination.lastPage();

    expect(calls[0]?.sort).toEqual({ by: 'id', order: 'desc' });
    expect(calls[0]?.cursor).toBeNull();
    // Items restored back to canonical chronological order
    expect(lastPage.data.map((r) => r.id)).toEqual([8, 9, 10]);
    expect(lastPage.next).toBeNull();
    expect(lastPage.prev).toBe('cursor_before_8');
    expect(lastPage.total).toBe(10);

    // Case 2: Explicit sort desc -> reversed to asc
    calls.length = 0;
    const paginationDesc = createCursorPagination(mockTable, {
      query: { sort: { by: 'created_at', order: 'desc' } },
    });
    await paginationDesc.lastPage();
    expect(calls[0]?.sort).toEqual({ by: 'created_at', order: 'asc' });
  });

  it('nextPage() and prevPage() navigate using cursor strings or Page objects', async () => {
    const calls: Query[] = [];
    const mockTable = {
      async list(q: Query = {}): Promise<Page<{ id: number }>> {
        calls.push(q);
        return { data: [{ id: 3 }], next: 'cur_page_3', prev: 'cur_page_1', total: null, meta: {} };
      },
    };

    const pagination = createCursorPagination(mockTable, { perPage: 10 });

    // Passing cursor string
    const pageNext = await pagination.nextPage('cur_page_2');
    expect(calls[0]?.cursor).toBe('cur_page_2');
    expect(pageNext?.data).toEqual([{ id: 3 }]);

    // Passing Page object with next
    await pagination.nextPage({ next: 'cur_page_3' });
    expect(calls[1]?.cursor).toBe('cur_page_3');

    // Passing Page object with prev: read backwards from the cursor
    await pagination.prevPage({ prev: 'cur_page_1' });
    expect(calls[2]?.cursor).toBe('cur_page_1');
    expect(calls[2]?.direction).toBe('prev');
    expect(calls[0]?.direction).toBeUndefined();
    expect(calls[1]?.direction).toBeUndefined();

    // Passing missing/null cursor returns null without calling table.list
    const nullNext = await pagination.nextPage({ next: null });
    expect(nullNext).toBeNull();
    const nullPrev = await pagination.prevPage({ prev: null });
    expect(nullPrev).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('table.cursorPagination() creates controller directly from api.table()', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, data: [{ id: 1 }], meta: { next_cursor: 'cur_2' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const api = createApi({ baseUrl: 'https://example.com/api', fetch: fetchMock as unknown as typeof fetch });
    const pagination = api.table('items').cursorPagination({ perPage: 1 });

    const first = await pagination.firstPage();
    expect(first.data).toEqual([{ id: 1 }]);
    expect(first.next).toBe('cur_2');
  });

  describe('cursor direction, cursorColumn and lastPage edge cases', () => {
    function recorder(page: Partial<Page<{ id: number }>> = {}) {
      const calls: Query[] = [];
      const table = {
        async list(q: Query = {}): Promise<Page<{ id: number }>> {
          calls.push(q);
          return { data: [], next: null, prev: null, total: null, meta: {}, ...page };
        },
      };
      return { calls, table };
    }

    it('prevPage sends direction prev and keeps the sort and cursorColumn; nextPage never does', async () => {
      const { calls, table } = recorder();
      const cp = createCursorPagination(table, {
        perPage: 5,
        cursorColumn: 'created_at',
        query: { sort: { by: 'created_at', order: 'desc' } },
      });
      await cp.prevPage('p1');
      await cp.nextPage('n1');
      expect(calls[0]).toEqual({ sort: { by: 'created_at', order: 'desc' }, cursorColumn: 'created_at', cursor: 'p1', direction: 'prev', perPage: 5 });
      expect(calls[1]?.direction).toBeUndefined();
      expect(calls[1]?.cursorColumn).toBe('created_at');
    });

    it('a caller-supplied direction never leaks into any request', async () => {
      const { calls, table } = recorder();
      const cp = createCursorPagination(table, { query: { direction: 'prev', sort: { by: 'id' } } as never });
      await cp.firstPage();
      await cp.nextPage('n1');
      await cp.lastPage();
      expect(calls.map((c) => c.direction)).toEqual([undefined, undefined, undefined]);
    });

    it('prevPage with a null or empty cursor sends nothing', async () => {
      const { calls, table } = recorder();
      const cp = createCursorPagination(table);
      expect(await cp.prevPage({ prev: null })).toBeNull();
      expect(await cp.prevPage('')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('lastPage on a single short page has no prev, even when the host returns a cursor', async () => {
      const { table } = recorder({ data: [{ id: 2 }, { id: 1 }], next: 'would_go_back' });
      const cp = createCursorPagination(table, { perPage: 5, query: { sort: { by: 'id', order: 'asc' } } });
      const page = await cp.lastPage();
      expect(page.data.map((r) => r.id)).toEqual([1, 2]);
      expect(page.prev).toBeNull();
      expect(page.next).toBeNull();
    });

    it('lastPage on an empty result has no prev and no rows', async () => {
      const { table } = recorder({ next: 'stray' });
      const cp = createCursorPagination(table, { perPage: 5, query: { sort: { by: 'id', order: 'asc' } } });
      const page = await cp.lastPage();
      expect(page.data).toEqual([]);
      expect(page.prev).toBeNull();
    });

    it('lastPage on a full page keeps the cursor to go back', async () => {
      const { table } = recorder({ data: [{ id: 3 }, { id: 2 }], next: 'back' });
      const cp = createCursorPagination(table, { perPage: 2, query: { sort: { by: 'id', order: 'asc' } } });
      expect((await cp.lastPage()).prev).toBe('back');
    });

    it('lastPage without a sort throws unencodable_value and sends no request', async () => {
      const { calls, table } = recorder();
      const cp = createCursorPagination(table, { perPage: 5 });
      await expect(cp.lastPage()).rejects.toMatchObject({ code: 'unencodable_value', message: expect.stringContaining('lastPage()') });
      expect(calls).toHaveLength(0);
    });

    it('lastPage treats an omitted order as the host default (desc) and reverses it to asc', async () => {
      const { calls, table } = recorder();
      await createCursorPagination(table, { query: { sort: { by: 'created_at' } } }).lastPage();
      expect(calls[0]?.sort).toEqual({ by: 'created_at', order: 'asc' });
    });
  });
});
