// Pages backwards from the last page against the monorepo's in-process fake backend (a TEST DOUBLE written from the
// host's documented behaviour, not the real Laravel host). Skipped when the fake backend is not next to this package.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src';
import type { Table } from '../../src';

const fakePath = resolve(__dirname, '../../../contract/fake-backend/src/app.mjs');
const available = existsSync(fakePath);

interface Invoice {
  id: number;
  created_at: string;
}

describe.skipIf(!available)('cursor paging against the fake backend', () => {
  let close: () => Promise<unknown> | unknown = () => undefined;
  let invoices: Table<Invoice>;
  const urls: URL[] = [];

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(fakePath).href)) as {
      createFakeBackend: (o: object) => { listen(p: number, h: string): Promise<{ url: string }>; close(): unknown };
    };
    const fb = mod.createFakeBackend({ accessTtlSeconds: 600 });
    const { url } = await fb.listen(0, '127.0.0.1');
    close = () => fb.close();
    const login = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: 'ada@example.test', password: 'secret-password' }),
    });
    const token = ((await login.json()) as { token: { access_token: string } }).token.access_token;
    const api = createApi({
      baseUrl: `${url}/api/v2/record`,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(new URL(String(input)));
        return fetch(input, init);
      }) as typeof fetch,
      auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}`, 'X-Tenant-ID': '1' }) },
    });
    invoices = api.table<Invoice>('invoices');
  });
  afterAll(async () => {
    await close();
  });

  for (const order of ['desc', 'asc'] as const) {
    it(`pages backwards from the last page with direction=prev (sort created_at ${order})`, async () => {
      const sort = { by: 'created_at', order } as const;
      const all: number[] = [];
      for await (const r of invoices.iterate({ sort, perPage: 40 })) all.push(r.id);
      expect(all.length).toBeGreaterThan(40);

      const cp = invoices.cursorPagination({ perPage: 10, query: { sort } });
      urls.length = 0;
      let page = await cp.lastPage();
      expect(urls[0]?.searchParams.get('order')).toBe(order === 'desc' ? 'asc' : 'desc');
      expect(page.next).toBeNull();
      const seen = page.data.map((r) => r.id);
      expect(seen).toEqual(all.slice(-10));

      let back = await cp.prevPage(page);
      expect(urls[urls.length - 1]?.searchParams.get('direction')).toBe('prev');
      expect(back?.data.map((r) => r.id)).toEqual(all.slice(-20, -10));
      for (let i = 0; i < 100 && back !== null; i++) {
        seen.unshift(...back.data.map((r) => r.id));
        page = back;
        back = await cp.prevPage(page);
      }
      expect(seen).toEqual(all);
    });
  }

  it('an unsorted lastPage throws before any request', async () => {
    urls.length = 0;
    await expect(invoices.cursorPagination({ perPage: 10 }).lastPage()).rejects.toMatchObject({ code: 'unencodable_value' });
    expect(urls).toHaveLength(0);
  });
});
