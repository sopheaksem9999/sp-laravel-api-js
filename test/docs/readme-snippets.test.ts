import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import readme from '../../README.md?raw';
import self from './readme-snippets.test.ts?raw';
import { createApi } from '../../src/index';
import type { Api, Query } from '../../src/index';
import type { EchoChannelLike, EchoLike } from '../../src/realtime';
import { subscribeTenant } from '../../src/realtime';

// The README snippets below are copied verbatim (imports aside) between the region markers.
// The sync test at the bottom fails when README.md and this file drift apart.

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

const calls: Call[] = [];

function respond(data: unknown, meta: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: true, data, meta }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const row = (id: number) => ({ id, ref_number: `INV-${1000 + id}`, total: 100 + id, status: 'open' });

const fakeFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  calls.push({ method, url, headers: new Headers(init?.headers), body: init?.body as string | undefined });
  if (method === 'POST') return respond({ ...row(99), ref_number: 'INV-1001' });
  if (url.pathname.endsWith('/invoices/7')) return respond(row(7));
  return respond([row(1), row(2)], { next_cursor: 'c2' });
}) as unknown as typeof fetch;

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', fakeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function quickStart(): Promise<void> {
  // #region snippet:quickstart
  // import { createApi } from '@sokpheak/sp-laravel-api';

  const token = 'eyJ...'; // from your login flow
  const companyId = 5;

  const api = createApi({
    baseUrl: 'https://api.example.com/api/v2', // origin + the host's api_prefix
    rpcPrefix: 't', // the host's rpc_prefix ('' for none, default 'rpc')
    auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
    tenant: { header: 'X-Company-ID', value: () => companyId },
  });

  interface Invoice {
    id: number;
    ref_number: string;
    total: number;
    status: string;
  }
  const invoices = api.table<Invoice>('invoices');

  // One page. cursor: null starts cursor paging (sends cursor=0); perPage is always sent.
  const page = await invoices.list({
    select: ['id', 'ref_number', 'total'],
    where: { status: { in: ['open', 'paid'] }, total: { gte: 100 } },
    sort: { by: 'created_at', order: 'desc' },
    cursor: null,
    perPage: 50,
  });
  console.log(page.data.length, page.next); // next is a cursor string, or null at the end

  const invoice = await invoices.get(7);
  const created = await invoices.create({ ref_number: 'INV-1001', total: 120 });
  console.log(invoice.ref_number, created.id);

  // Every row of a query, fetching cursor pages as needed.
  for await (const row of invoices.iterate({ where: { status: 'open' }, perPage: 100 })) {
    console.log(row.ref_number);
  }
  // #endregion
}

describe('README quick start', () => {
  it('runs against a fake fetch and sends the documented requests', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await quickStart();

    const list = calls[0]!;
    expect(list.method).toBe('GET');
    expect(list.url.pathname).toBe('/api/v2/invoices');
    expect(list.url.searchParams.get('cursor')).toBe('0');
    expect(list.url.searchParams.get('per_page')).toBe('50');
    expect(list.headers.get('Authorization')).toBe('Bearer eyJ...');
    expect(list.headers.get('X-Company-ID')).toBe('5');

    expect(calls[1]!.url.pathname).toBe('/api/v2/invoices/7');
    expect(calls[2]!.method).toBe('POST');
    expect(JSON.parse(calls[2]!.body!)).toEqual({ ref_number: 'INV-1001', total: 120 });

    // iterate: first page was short of perPage, so it stops after one request
    expect(calls).toHaveLength(4);
    expect(log).toHaveBeenCalledWith(2, null);
    expect(log).toHaveBeenCalledWith('INV-1007', 99);
    expect(log).toHaveBeenCalledWith('INV-1002');
  });
});

// Minimal stand-ins for @tanstack/react-query, so the snippet runs without the dependency.
function useQuery<T>(o: { queryKey: readonly unknown[]; queryFn: () => Promise<T> }) {
  return o;
}
function useMutation<V, T>(o: { mutationFn: (v: V) => Promise<T>; onSuccess: () => unknown }) {
  return o;
}
const invalidated: Array<readonly unknown[]> = [];
function useQueryClient() {
  return { invalidateQueries: (f: { queryKey: readonly unknown[] }) => void invalidated.push(f.queryKey) };
}

interface Invoice {
  id: number;
  ref_number: string;
  total: number;
  status: string;
}
let api: Api;

// #region snippet:tanstack
// import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// import type { Query } from '@sokpheak/sp-laravel-api';

function useInvoices(q: Query) {
  return useQuery({
    queryKey: api.keys.list('invoices', q), // same query, same key
    queryFn: () => api.table<Invoice>('invoices').list(q),
  });
}

function useCreateInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Invoice>) => api.table<Invoice>('invoices').create(body),
    // keys.table('invoices') is a prefix of every list/get key for that table
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.keys.table('invoices') }),
  });
}
// #endregion

// #region snippet:realtime
// import { useQueryClient } from '@tanstack/react-query';
// import { subscribeTenant, type EchoLike } from '@sokpheak/sp-laravel-api/realtime';

function setupRealtime(echo: EchoLike) {
  const queryClient = useQueryClient();
  return subscribeTenant(echo, api, {
    tenantId: 5,
    tables: ['invoices'],
    onChange: (change) => queryClient.invalidateQueries({ queryKey: change.queryKey }),
  });
}
// #endregion

describe('README TanStack example', () => {
  it('builds stable keys and runs the query and mutation', async () => {
    api = createApi({ baseUrl: 'https://api.example.com/api/v2', fetch: fakeFetch });
    const q: Query = { where: { status: 'open' }, perPage: 50 };
    const a = useInvoices(q);
    const b = useInvoices({ perPage: 50, where: { status: 'open' } });
    expect(a.queryKey).toEqual(b.queryKey);
    expect(api.keys.table('invoices')).toEqual(a.queryKey.slice(0, 2));
    expect((await a.queryFn()).data).toHaveLength(2);

    const m = useCreateInvoice();
    expect((await m.mutationFn({ total: 120 })).id).toBe(99);
    await m.onSuccess();
    expect(invalidated).toEqual([['sp-api', 'invoices']]);

    const channel: EchoChannelLike = {
      listen: () => channel,
      stopListening: () => channel,
    };
    const fakeEcho: EchoLike = {
      private: () => channel,
      leave: () => {},
    };
    const unsub = setupRealtime(fakeEcho);
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

function region(source: string, name: string): string {
  const m = new RegExp(`// #region snippet:${name}\\n([\\s\\S]*?)\\n\\s*// #endregion`).exec(source);
  if (m === null) throw new Error(`no region ${name} in test file`);
  return normalise(m[1]!);
}

function block(source: string, name: string): string {
  const m = new RegExp(`<!-- snippet:${name} -->\\s*\`\`\`ts\\n([\\s\\S]*?)\\n\`\`\``).exec(source);
  if (m === null) throw new Error(`no snippet ${name} in README`);
  return normalise(m[1]!);
}

/** Drops single-line imports (the test imports from src/), the `// typecheck` marker and common indentation. */
function normalise(code: string): string {
  const lines = code
    .split('\n')
    .filter((l) => !/^\s*(\/\/\s*)?import .*;\s*$/.test(l) && !/^\s*\/\/ (typecheck|illustrative)\s*$/.test(l));
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^ */.exec(l)![0].length);
  const cut = Math.min(...indents);
  return lines
    .map((l) => l.slice(cut).trimEnd())
    .join('\n')
    .trim();
}

describe('README stays in sync with this file', () => {
  it.each(['quickstart', 'tanstack', 'realtime'])('snippet %s matches', (name) => {
    expect(block(readme, name)).toBe(region(self, name));
  });
});
