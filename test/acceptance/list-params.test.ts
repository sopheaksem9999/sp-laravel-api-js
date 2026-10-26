// Spec §10: "No list call is sent without `per_page`, and no cursor call with an empty `cursor`."
// Table-driven over every list entry point of the package (core and modules), spying on `fetch`. Each row runs
// the call against a fake host and checks every request it sent. Edge-safe (runs in both vitest projects).
import { describe, expect, it } from 'vitest';
import { createApi } from '../../src';
import type { Api } from '../../src';
import { attachments } from '../../src/attachments';
import { audit } from '../../src/audit';
import { permissions } from '../../src/permissions';
import { webhooks } from '../../src/webhooks';

const PER_PAGE = 2;

/** A fake host: full pages with a next cursor for the first `pages` requests, then an empty page. */
function setup(pages = 1) {
  const sent: URL[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    sent.push(url);
    const n = sent.length;
    const full = n <= pages;
    const body = {
      success: true,
      data: full ? Array.from({ length: PER_PAGE }, (_, i) => ({ id: n * 10 + i })) : [],
      meta: full ? { next_cursor: `c${n + 1}`, prev_cursor: null } : { next_cursor: null },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const api = createApi({ baseUrl: 'https://host.test/api', fetch: fetchFn });
  return { api, sent };
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

type Mode = 'cursor-first' | 'cursor-next' | 'offset' | 'none';

interface Row {
  name: string;
  /** Runs the entry point; `pages` = how many full pages the fake host serves before an empty one. */
  call: (api: Api) => Promise<unknown>;
  pages?: number;
  /** Expected requests and the paging mode of each (cursor-first = the first cursor page, `cursor=0`). */
  modes: Mode[];
  perPage?: number;
}

const ROWS: Row[] = [
  { name: 'table.list()', call: (a) => a.table('t').list(), modes: ['none'], perPage: 25 },
  { name: 'table.list({ perPage })', call: (a) => a.table('t').list({ perPage: 7 }), modes: ['none'], perPage: 7 },
  { name: 'table.list({ cursor: null })', call: (a) => a.table('t').list({ cursor: null, perPage: PER_PAGE }), modes: ['cursor-first'] },
  { name: "table.list({ cursor: '' })", call: (a) => a.table('t').list({ cursor: '', perPage: PER_PAGE }), modes: ['cursor-first'] },
  { name: "table.list({ cursor: 'abc' })", call: (a) => a.table('t').list({ cursor: 'abc', perPage: PER_PAGE }), modes: ['cursor-next'] },
  { name: 'table.list({ page: 2 })', call: (a) => a.table('t').list({ page: 2, perPage: PER_PAGE }), modes: ['offset'] },
  {
    name: 'table.iterate() first and later pages',
    call: (a) => drain(a.table('t').iterate({ perPage: PER_PAGE })),
    pages: 3,
    modes: ['cursor-first', 'cursor-next', 'cursor-next', 'cursor-next'],
  },
  {
    name: "table.iterate({ cursor: '' })",
    call: (a) => drain(a.table('t').iterate({ cursor: '', perPage: PER_PAGE })),
    pages: 1,
    modes: ['cursor-first', 'cursor-next'],
  },
  { name: 'audit.list()', call: (a) => audit(a).list(), modes: ['none'], perPage: 25 },
  { name: 'audit.list({ cursor: null })', call: (a) => audit(a).list({ cursor: null, perPage: PER_PAGE }), modes: ['cursor-first'] },
  { name: 'webhooks.endpoints.list()', call: (a) => webhooks(a).endpoints.list(), modes: ['none'], perPage: 25 },
  { name: 'webhooks.subscriptions.list({ cursor })', call: (a) => webhooks(a).subscriptions.list({ cursor: 'x', perPage: PER_PAGE }), modes: ['cursor-next'] },
  { name: 'webhooks.subscriptions.iterate()', call: (a) => drain(webhooks(a).subscriptions.iterate({ perPage: PER_PAGE })), pages: 2, modes: ['cursor-first', 'cursor-next', 'cursor-next'] },
  { name: 'webhooks.deliveries.list({ cursor: null })', call: (a) => webhooks(a).deliveries.list({ cursor: null, perPage: PER_PAGE }), modes: ['cursor-first'] },
  { name: 'permissions.roles.list()', call: (a) => permissions(a).roles.list(), modes: ['none'], perPage: 25 },
  { name: 'permissions.roles.iterate()', call: (a) => drain(permissions(a).roles.iterate({ perPage: PER_PAGE })), pages: 1, modes: ['cursor-first', 'cursor-next'] },
  { name: 'permissions.permissions.list({ page: 1 })', call: (a) => permissions(a).permissions.list({ page: 1, perPage: PER_PAGE }), modes: ['offset'] },
  { name: 'attachments.folders.list({ parent_id })', call: (a) => attachments(a).folders.list({ parent_id: 1 }), modes: ['none'], perPage: 25 },
  { name: 'attachments.folders.list()', call: (a) => attachments(a).folders.list(), modes: ['none'], perPage: 25 },
  { name: 'attachments.folders.listPage(cursor: null)', call: (a) => attachments(a).folders.listPage(undefined, { cursor: null, perPage: PER_PAGE }), modes: ['cursor-first'] },
  { name: 'attachments.folders.listPage(cursor)', call: (a) => attachments(a).folders.listPage({ parent_id: 1 }, { cursor: 'c9', perPage: PER_PAGE }), modes: ['cursor-next'] },
  { name: 'attachments.folders.listPage(page)', call: (a) => attachments(a).folders.listPage(undefined, { page: 3, perPage: PER_PAGE }), modes: ['offset'] },
  { name: 'attachments.forRecord().list()', call: (a) => attachments(a).forRecord('products', 7).list({ collection: 'gallery' }), modes: ['none'], perPage: 25 },
];

function checkRequest(url: URL, mode: Mode, perPage: number): void {
  const p = url.searchParams;
  // Rule 1: every list request carries a positive integer per_page.
  expect(p.get('per_page'), `${url} lacks per_page`).toMatch(/^[1-9]\d*$/);
  expect(Number(p.get('per_page'))).toBe(perPage);
  // Rule 2: a cursor, when sent, is never empty.
  if (p.has('cursor')) expect(p.get('cursor'), `${url} sends an empty cursor`).not.toBe('');
  expect(p.getAll('cursor').length).toBeLessThanOrEqual(1);
  if (mode === 'cursor-first') expect(p.get('cursor')).toBe('0');
  if (mode === 'cursor-next') expect(p.get('cursor')).toMatch(/^(?!0$).+/);
  if (mode === 'offset') expect(p.has('cursor')).toBe(false);
  if (mode === 'none') expect(p.has('cursor')).toBe(false);
}

describe('every list call sends per_page and never an empty cursor (spec §10)', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('%s', async (_name, row) => {
    const { api, sent } = setup(row.pages ?? 1);
    await row.call(api);
    expect(sent.map((u) => u.pathname.split('/').pop())).toHaveLength(row.modes.length);
    sent.forEach((url, i) => checkRequest(url, row.modes[i]!, row.perPage ?? PER_PAGE));
  });

  it('the checker rejects a missing per_page and an empty cursor (non-vacuous)', () => {
    expect(() => checkRequest(new URL('https://h.test/t?cursor=0'), 'cursor-first', PER_PAGE)).toThrow();
    expect(() => checkRequest(new URL(`https://h.test/t?per_page=${PER_PAGE}&cursor=`), 'cursor-next', PER_PAGE)).toThrow();
    expect(() => checkRequest(new URL(`https://h.test/t?per_page=${PER_PAGE}&cursor=c2`), 'cursor-first', PER_PAGE)).toThrow();
  });

  // forRecord().list() is in ROWS: per_page is sent (spec §10), but the backend drops the query on this route
  // (sp-laravel-api AttachmentUploadController::getForRecord) and answers at most record.default_per_page links
  // (task-36 report, Finding F2, backend issue). folders.list() without a filter was Finding F1, fixed in round 1.
  it('forRecord().list() sends collection_name next to per_page and nothing else', async () => {
    const { api, sent } = setup(0);
    await attachments(api).forRecord('products', 7).list({ collection: 'gallery' });
    expect([...sent[0]!.searchParams.keys()].sort()).toEqual(['collection_name', 'per_page']);
  });
});
