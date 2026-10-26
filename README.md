# @sopheak/sp-laravel-api

Typed JavaScript client for the [`sopheak/sp-laravel-api`](https://packagist.org/packages/sopheak/sp-laravel-api) Laravel package. ESM and CJS, no runtime dependencies, runs in browsers, edge runtimes and Node 20+.

This release (0.1) ships the core: `createApi`, `table()`, `api.fn()` / `api.rpc()`, the query serializer, pages and `iterate`, query-cache keys, and one error type. Feature modules (bulk, attachments, and so on) arrive in later releases; see [Modules](#modules).

## Install

```sh
npm install @sopheak/sp-laravel-api
```

## Quick start

Core only, no other package needed. This code is run by the test suite (`test/docs/readme-snippets.test.ts`) against a fake `fetch`.

<!-- snippet:quickstart -->
```ts
import { createApi } from '@sopheak/sp-laravel-api';

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
```

`auth` is any object with `getHeaders(): Promise<Record<string, string>>`. It may also have `handleUnauthorized(): Promise<boolean>`: on a 401 the client calls it once and, if it resolves `true`, retries the request once with fresh headers. Omit `auth` for public tables.

Other table methods: `update` (PUT), `patch`, `remove`, `restore`, `upsert`, `aggregate`. `api.fn('invoices', 'approve', { id: 7, method: 'POST' })` calls a table function and `api.rpc('auth/whoami')` a global one. `api.request()` is the low-level call for anything else.

## Query syntax cheat sheet

The query object is serialised for you; nobody hand-writes filter strings. What goes on the wire:

| You write | Sent as |
|---|---|
| `where: { status: 'open' }` | `status=eq.open` |
| `where: { status: { in: ['open', 'paid'] }, total: { gte: 100 } }` | `status=in.(open,paid)&total=gte.100` |
| `where: { deleted_at: { is: null } }` | `deleted_at=is.null` |
| `or: [{ status: 'draft' }, { due_date: { lt: '2026-11-01' } }]` | `or=(status.eq.draft,due_date.lt.2026-11-01)` |
| `where: { name: 'Acme, Inc.', code: ['A', 'B,C'] }` | `name=eq."Acme, Inc."&code=in.(A,"B,C")` (URL-encoded on the wire) |
| `select: ['id', { customer: ['id', 'display_name'] }]` | `select=id,customer(id,display_name)` |
| `sort: { by: 'created_at', order: 'desc' }` | `sortby=created_at&order=desc` |
| `search: { s: 'acme' }` | `s=acme` (or `{ search: 'acme' }`, depending on the table) |
| `where: { raw: 'qty=gt.5' }` | `qty=gt.5` (escape hatch for anything the builder does not cover) |

- **Lists are always `in.(...)`.** A bare array means `in`; a bare scalar means `eq`. The bracket syntax is never produced.
- **Quoting.** Any value or list item containing `,`, `(`, `)`, `"` or `\`, or with leading or trailing spaces, is sent in double quotes (`eq."Acme, Inc."`). Other values are sent bare.
- **Cursor paging.** `cursor: null` sends `cursor=0` (the first page); a cursor string is sent as is; an empty `cursor=` is never sent. `page.next` is the next cursor, or `null` at the end. `iterate()` handles this for you. Use `page: 2` for offset paging instead (`iterate()` needs cursor mode).
- **`per_page` is always sent** on list calls (default 25; set `defaults.perPage` on the client or `perPage` per query). `total: true` asks for a total, returned as `page.total`.
- **Hosts older than 0.5.06** have no quoting and split every value on commas. Pass `createApi({ quoting: false })` and the serializer throws `SpApiError` with code `unencodable_value` for a value it cannot send safely, instead of sending a filter the server would misread.

## Error handling

Every failure (HTTP error, Laravel validation response, HTML error page, empty body, network, timeout) is thrown as one `SpApiError`.

```ts
import { isSpApiError } from '@sopheak/sp-laravel-api';

try {
  await invoices.create({ total: -1 });
} catch (e) {
  if (isSpApiError(e) && e.code === 'validation') {
    console.log(e.fieldErrors); // { total: ['...'] }, always an object
  } else if (isSpApiError(e) && e.code === 'rate_limited') {
    console.log(`retry in ${e.retryAfter}s`);
  } else {
    throw e;
  }
}
```

Fields: `status` (0 for network/timeout), `code`, `message`, `fieldErrors`, `errorCode` (the backend's `error_code` when enveloped), `module`, `requestId`, `retryAfter` (seconds, from `Retry-After`), `body`, `response`.

| `code` | Meaning |
|---|---|
| `unauthenticated` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `validation` | 422 |
| `tenant_required` | 422 whose error key is your configured tenant header: ask the user to pick a company |
| `module_disabled` | the host has switched a backend module off (raised by the feature modules, not by the 0.1 core) |
| `not_configured` | the host has not configured a feature (reserved for the feature modules, not raised by the 0.1 core) |
| `unencodable_value` | a query value cannot be encoded (see `quoting: false` above) |
| `rate_limited` | 429 |
| `server` | 5xx |
| `network` | the request never got a response |
| `timeout` | `timeoutMs` elapsed (default 60 s) |
| `unknown` | anything else |

## Caching with TanStack Query

The package keeps no cache of its own. `api.keys` gives stable, serialisable keys built from the serialised query, so equal queries share a key. This code is run by the test suite with a stand-in for TanStack Query. It reuses `api` and `Invoice` from the quick start.

<!-- snippet:tanstack -->
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query } from '@sopheak/sp-laravel-api';

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
```

## Using it from a framework

The client does not care which framework you use: it is plain functions. The examples below show the usual glue for one thing, reacting to auth state (for example the signed-in user or company), using an `auth` object that offers `getState()` and `subscribe()`.

**This package does not depend on `@sopheak/sp-jwt-auth`.** Those two methods come from the sibling package `@sopheak/sp-jwt-auth` (`createJwtAuth(...)`, which also satisfies the `ApiAuth` seam by exposing `getHeaders()`). Any object with `getHeaders()` works as `auth` here; use your own if you do not need that package.

```ts
import { createApi } from '@sopheak/sp-laravel-api';
import { createJwtAuth } from '@sopheak/sp-jwt-auth';

// auth: a JWT auth object from @sopheak/sp-jwt-auth (configuration omitted)
const auth = createJwtAuth({ /* ... */ });
const api = createApi({
  baseUrl: '/api/v2',
  rpcPrefix: 't',
  auth,
  tenant: { header: 'X-Company-ID', value: () => auth.getState().companyId },
});
```

| Framework | Glue |
|---|---|
| Vue | `const state = shallowRef(auth.getState()); auth.subscribe(() => (state.value = auth.getState()));` |
| React, Next.js, Remix | `const state = useSyncExternalStore(auth.subscribe, auth.getState, auth.getState);` |
| Angular | `const state = signal(auth.getState()); auth.subscribe(() => state.set(auth.getState()));` Provide `auth` and `api` once, for example `{ provide: SP_AUTH, useValue: auth }`. For RxJS, wrap the same two calls in `new Observable(...)`. |
| Svelte | `const authState = readable(auth.getState(), (set) => auth.subscribe(() => set(auth.getState())));` (use as `$authState`, also in Svelte 5) |
| Solid | `const state = from((set) => auth.subscribe(() => set(auth.getState())));` |

These glue lines depend on the framework and on `@sopheak/sp-jwt-auth`, so they are shown for reference and are not run by this package's tests.

### Angular and `fetch`

The client calls `fetch`, not Angular's `HttpClient`, so `HttpClient` interceptors (loading bars, logging) do not see its requests. Put such concerns in a wrapper passed as the `fetch` option:

```ts
const api = createApi({
  baseUrl: '/api/v2',
  fetch: async (input, init) => {
    loading.set(true);
    try {
      return await fetch(input, init);
    } finally {
      loading.set(false);
    }
  },
});
```

Tests mock through the same `fetch` option instead of `HttpTestingController`.

### Servers: one instance per request

On a server, who the request is made as decides how many `createApi` instances you want.

- **Auth is per user** (the caller's token, a session cookie, the framework's `event.fetch`): create `createApi` **per request**. A shared instance would send one user's credentials, tenant or cached state on another user's request.
- **The server acts as itself** (a service account or client-credentials token, a fixed tenant): one shared instance for the whole process is correct.

```ts
// Express, as the calling user: a new instance per request
app.use((req, _res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  req.laravel = createApi({
    baseUrl: process.env.LARAVEL_API_URL!,
    auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
  });
  next();
});

// As the server itself: created once at startup and shared
const laravel = createApi({
  baseUrl: process.env.LARAVEL_API_URL!,
  auth: serviceAccountAuth, // any object with getHeaders()
  tenant: { header: 'X-Company-ID', value: () => '5' },
});
```

## Modules

The core is all that is in 0.1. The subpath modules below are planned and are **not in this release**: the import paths do not exist yet, and importing them fails.

| Backend module | Import path | Status |
|---|---|---|
| `bulk_operations` | `@sopheak/sp-laravel-api/bulk` | coming in 0.2 |
| `attachments` | `@sopheak/sp-laravel-api/attachments` | coming in 0.2 |
| `audit` | `@sopheak/sp-laravel-api/audit` | coming in 0.2 |
| `permissions` | `@sopheak/sp-laravel-api/permissions` | coming in 0.2 |
| `webhooks` | `@sopheak/sp-laravel-api/webhooks` | coming in 0.2 |
| Broadcasting | `@sopheak/sp-laravel-api/realtime` | coming in 0.2 |
| `api_docs` | `@sopheak/sp-laravel-api/docs` | coming in 0.2 |

Each will be a function that takes the core client, so bundlers drop whatever you do not import.

## Backend compatibility

| `@sopheak/sp-laravel-api` | `sopheak/sp-laravel-api` (Laravel) |
|---|---|
| `0.1` | `^0.5.06` |

Hosts older than 0.5.06 work with `quoting: false` (see above).

## License

MIT. Copyright (c) 2026 Sem Sopheak.
