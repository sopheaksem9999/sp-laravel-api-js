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

    // Case 1: Default sort (implied id asc -> reversed to id desc)
    const pagination = createCursorPagination(mockTable, { perPage: 3 });
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

    // Passing Page object with prev
    await pagination.prevPage({ prev: 'cur_page_1' });
    expect(calls[2]?.cursor).toBe('cur_page_1');

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
});
