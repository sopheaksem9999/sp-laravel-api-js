# @sokpheak/sp-laravel-api

Typed JavaScript client for the [`sopheak/sp-laravel-api`](https://packagist.org/packages/sopheak/sp-laravel-api) Laravel package. ESM and CJS, no runtime dependencies, runs in browsers, edge runtimes and Node 20+. CI runs the build, guards and smoke imports (CJS and ESM, plus the dist, modules and bundle guards) on Node 20, and the full test suite on Node 22 and 24 (Vitest 5 needs Node 22.12+), on Deno and Bun, and under `@edge-runtime/vm`. The edge run proves the code works with the edge web globals, but it cannot block Node globals (vitest leaves `process` and `Buffer` visible there), so an AST scan of `src/` and the dist and browser-bundle checks are what keep Node-only code out.

It ships the core (`createApi`, `table()`, `api.fn()` / `api.rpc()`, the query serializer, pages and `iterate`, query-cache keys, and one error type), seven feature modules as subpath imports (`bulk`, `attachments`, `audit`, `permissions`, `webhooks`, `realtime`, `docs`; see [Modules](#modules)), and the Node-only `sp-laravel-api typegen` CLI.

## Install

```sh
npm install @sokpheak/sp-laravel-api
```

## Quick start

Core only, no other package needed. This code is run by the test suite (`test/docs/readme-snippets.test.ts`) against a fake `fetch`.

<!-- snippet:quickstart -->
```ts
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';

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

### `createApi` options

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | (required) | origin plus the host's `api_prefix`, e.g. `https://api.example.com/api/v2` |
| `rpcPrefix` | `'rpc'` | the host's `rpc_prefix`; `''` means no prefix segment |
| `auth` | none | `{ getHeaders(), handleUnauthorized? }`, see below |
| `tenant` | none | `{ header, value: () => id }`; sent on every request when `value()` is not `null`/`undefined` |
| `defaults` | `{ perPage: 25 }` | `perPage` and `total` used when a query does not set them |
| `fetch` | `globalThis.fetch` | the `fetch` used for every call, including the attachments' direct-to-storage PUT (so never add auth headers in it; use `auth`) |
| `timeoutMs` | `60000` | per-request timeout (`timeout` error); per call `timeoutMs` overrides it. `0`, a negative number, `Infinity` or anything above 2^31-1 means no timeout |
| `quoting` | `true` | `false` for hosts older than 0.5.06: values that need quotes throw `unencodable_value` instead |
| `driver` | none | `'mysql'` rejects the Postgres-only operators client-side (`unencodable_value`) |
| `debug` | `false` | sends `X-Debug: 1` on every request (per call: `debug: true`) |
| `onEvent` | none | diagnostics hook. **Only the `realtime` module emits anything** (`{ type: 'realtime_handler_error' }` when your `onChange` throws); the core and the other modules never call it, so it is not a request log |

`auth` is any object with `getHeaders(): Promise<Record<string, string>>`. It may also have `handleUnauthorized(failed?: { headers }): Promise<boolean>`: on a 401 the client calls it once, passing the headers sent on the failed attempt (lowercase keys), and, if it resolves `true`, retries the request once with fresh headers. Omit `auth` for public tables.

Other table methods: `update` (PUT), `patch`, `remove`, `restore`, `upsert`, `aggregate`. `restore(id)` resolves `{ restored: number }` (the backend's count, typed `RestoreResult`), not the row; call `get(id)` afterwards if you need it. `api.fn('invoices', 'approve', { id: 7, method: 'POST' })` calls a table function and `api.rpc('auth/whoami')` a global one. `api.request()` is the low-level call for anything else.

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
| `where: { raw: 'qty=gt.5' }` | `qty=gt.5` (escape hatch for anything the builder does not cover; a `raw` with no `col=` part throws `unencodable_value`) |

- **`any` / `all` modifiers are never quoted.** `where: { name: { like: { any: ['a%', 'b%'] } } }` is sent as `name=like(any).{a%,b%}`. The host splits that list on plain commas and does not understand quotes, so an empty list, an empty item, or an item containing `,`, `{`, `}`, `"`, `\` or leading/trailing spaces throws `unencodable_value` (with or without `quoting`) instead of silently becoming a different filter.
- **Lists are always `in.(...)`.** A bare array means `in`; a bare scalar means `eq`. The bracket syntax is never produced.
- **Quoting.** Any value or list item containing `,`, `(`, `)`, `"` or `\`, or with leading or trailing spaces, is sent in double quotes (`eq."Acme, Inc."`). Other values are sent bare.
- **Cursor paging.** `cursor: null` sends `cursor=0` (the first page); a cursor string is sent as is; an empty `cursor=` is never sent. `page.next` is the next cursor, or `null` at the end. `iterate()` handles this for you. Use `page: 2` for offset paging instead; offset mode never yields `next` (it is always `null` there, so step `page` yourself), and `iterate()` needs cursor mode.
- **`per_page` is always sent** on list calls (default 25; set `defaults.perPage` on the client or `perPage` per query). `total: true` asks for a total, returned as `page.total`.
- **Hosts older than 0.5.06** have no quoting and split every value on commas. Pass `createApi({ quoting: false })` and the serializer throws `SpApiError` with code `unencodable_value` for a value it cannot send safely, instead of sending a filter the server would misread.

## Error handling

Every failure (HTTP error, Laravel validation response, HTML error page, empty body, network, timeout) is thrown as one `SpApiError`.

```ts
// typecheck
import { isSpApiError } from '@sokpheak/sp-laravel-api';

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
// typecheck
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query } from '@sokpheak/sp-laravel-api';

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

**This package does not depend on `@sokpheak/sp-jwt-auth`.** Those two methods come from the sibling package `@sokpheak/sp-jwt-auth` (`createJwtAuth(...)`, which also satisfies the `ApiAuth` seam by exposing `getHeaders()`). Any object with `getHeaders()` works as `auth` here; use your own if you do not need that package.

```ts
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';
import { createJwtAuth } from '@sokpheak/sp-jwt-auth';

// auth: a JWT auth object from @sokpheak/sp-jwt-auth (configuration omitted)
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

These glue lines depend on the framework and on `@sokpheak/sp-jwt-auth`, so they are shown for reference and are not run by this package's tests.

### Angular and `fetch`

The client calls `fetch`, not Angular's `HttpClient`, so `HttpClient` interceptors (loading bars, logging) do not see its requests. Put such concerns in a wrapper passed as the `fetch` option:

```ts
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';

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
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';

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

The core is in 0.1. `bulk`, `attachments`, `audit`, `permissions`, `webhooks`, `realtime` and `docs` are available as subpath imports, and the package ships the `sp-laravel-api typegen` CLI.

| Backend module | Import path | Status |
|---|---|---|
| `bulk_operations` | `@sokpheak/sp-laravel-api/bulk` | available (see below) |
| `attachments` | `@sokpheak/sp-laravel-api/attachments` | available (see below) |
| `audit` | `@sokpheak/sp-laravel-api/audit` | available (see below) |
| `permissions` | `@sokpheak/sp-laravel-api/permissions` | available (see below) |
| `webhooks` | `@sokpheak/sp-laravel-api/webhooks` | available (see below) |
| Broadcasting | `@sokpheak/sp-laravel-api/realtime` | available (see below) |
| `api_docs` | `@sokpheak/sp-laravel-api/docs` + CLI `sp-laravel-api typegen` | available (see below) |

Each is a function that takes a table from the core client, so bundlers drop whatever you do not import, and the main entry never includes module code.

### Bulk

```ts
// typecheck
import { bulk } from '@sokpheak/sp-laravel-api/bulk';

const invoices = bulk(api.table<Invoice>('invoices'));
const r = await invoices.create(rows); // chunks of 1000, one request each
if (!('queued' in r)) console.log(r.affected, r.rows);
await invoices.upsert(rows, { matchOn: ['number'] }); // { count }
```

`create`, `update`, `delete`, `upsert` and `mixed`, with `chunkSize`, `concurrency`, `async` and `signal` options. Each chunk (each request, also for `mixed`) is its own backend transaction; a failed call throws with `error.completedChunks`. A mistyped table name reads as `module_disabled` (the bulk routes' only 404). See [src/bulk/README.md](src/bulk/README.md) for the backend contract, limits and async behaviour.

### Attachments

```ts
// typecheck
import { attachments } from '@sokpheak/sp-laravel-api/attachments';

const att = attachments(api);
const file = await att.upload(blob, { recordType: 'products', recordId: 7, name: 'photo.png' });
await att.forRecord('products', 7).link([file.id]);
const src = att.viewUrl(file.id, { w: 200, fit: 'crop' }); // a string, no request
const big = await att.uploadMultipart(video, { onProgress: ({ loaded, total }) => show(loaded, total) });
```

`upload`, `uploadDirect`, `uploadMultipart`, `cloneTemp`, `viewUrl`, `downloadUrl`, `forRecord(table, id)` (`list`, `link`, `unlink`) and `folders` (`list`, `listPage`, `create`, `update`, `remove`; list calls always send `per_page`). `uploadDirect` and `uploadMultipart` (resumable, `concurrency`, `onProgress`, `signal`) need `direct_upload.enabled` on the host and, in browsers, a bucket CORS policy exposing `ETag`; a 404 there is `module_disabled` with `module: 'attachments.direct_upload'`. `upload(file, { strategy: 'auto' })` picks multipart above `partSize × 2` (default part 8 MiB), direct only when `directUpload: true` is passed, else the form upload; `upload` without a strategy is the form upload. The multipart `upload_token` (in `onState` snapshots) is a credential. Protected files need the auth header, so fetch them as a blob for `<img>`, or use the signed `preview_url` when the host enables previews. A 404 is `module_disabled` only on calls with no lookup target (`upload` without `recordType`, `folders.list`, `folders.create`); on the others it stays `not_found` (missing record, link, attachment or folder), so a disabled module reads as `not_found` there and `capabilities()` (from `/docs`) is the reliable detector. See [src/attachments/README.md](src/attachments/README.md) for routes, field names and error handling.

### Audit

```ts
// typecheck
import { audit } from '@sokpheak/sp-laravel-api/audit';

const log = audit(api);
// read-only sp_audit_logs; relations are embedded through select (there is no include parameter)
const page = await log.list({ select: ['*', { user: ['id', 'name'] }], sort: { by: 'created_at', order: 'desc' } });
const s = await log.stats({ startDate: '2026-01-01', event: 'updated' }); // { total, by_event, by_user, by_entity }
const history = await log.fieldTimeline('invoices', 42, 'status', { limit: 20 });
```

`list`, `stats`, `fieldTimeline` and `fieldStats`. `startDate` / `endDate` are compared by the backend as given, so a date-only `endDate` excludes that day after 00:00:00. The tenant always comes from the client's tenant header: there is no `tenantId` option and no `tenant_id` is ever sent. The calls need the Gate `manage-audit-logs` (401 `unauthenticated`, 403 `forbidden`); the audit routes are off by default and a 404 on the three function routes is `module_disabled`. See [src/audit/README.md](src/audit/README.md).

### Permissions

```ts
// typecheck
import { permissions } from '@sokpheak/sp-laravel-api/permissions';

const p = permissions(api);
const role = await p.roles.create({ name: 'Auditor' });
await p.assign(role.id, [1, 2]);  // attach (existing links are kept)
await p.detach(role.id, [2]);     // detach the link only; the permission row stays
```

`roles` (`sp_roles` CRUD), `permissions` (`sp_permissions`: `list`, `get`, `update` only), `assign` and `detach`. A 404 on `assign` / `detach` is `not_found` (missing role), never `module_disabled`. See [src/permissions/README.md](src/permissions/README.md).

### Webhooks

```ts
// typecheck
import { webhooks, verifyWebhook, parseWebhook } from '@sokpheak/sp-laravel-api/webhooks';

// Admin: the backend never generates or returns the secret, so the client creates it and shows it once.
const w = webhooks(api);
const { endpoint, secret } = await w.endpoints.create({ name: 'Sync', url: 'https://app.example/hooks/laravel' });
await w.subscriptions.create({ endpoint_id: endpoint.id, table_name: 'invoices', event: 'created' });

// Receiver (Express): verify the raw body, then read it
app.post('/hooks/laravel', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!(await verifyWebhook(req.body, req.get('X-Webhook-Signature'), process.env.SP_WEBHOOK_SECRET!)))
    return res.status(401).end();
  const { table, action, record } = parseWebhook({ headers: req.headers, rawBody: req.body });
  res.status(204).end();
});
```

The signature (`X-Webhook-Signature`, bare lowercase hex HMAC-SHA256 of the exact body) needs the **raw** body, not a parsed-and-serialised one:

- Express: `express.raw({ type: 'application/json' })` on the webhook route
- NestJS: `NestFactory.create(App, { rawBody: true })`, then `req.rawBody`
- Next.js route handler, SvelteKit `+server.ts`, Astro endpoint, Remix action, Cloudflare Workers: `await request.text()`
- Nuxt / h3: `await readRawBody(event)`

`verifyWebhook` returns `false` (never throws) for any bad or missing header. `endpoints.create` and `endpoints.rotateSecret(id)` return `{ endpoint, secret }` once (if either times out after the host applied it, the new secret is lost and deliveries fail verification: rotate again); `secret` is stripped from every read, `deliveries` is read-only, and `subscriptions` is full CRUD. Webhooks are off by default on the host (`webhooks.enabled`), and with the module off the tables 404 as `not_found`. See [src/webhooks/README.md](src/webhooks/README.md).

### Realtime

<!-- snippet:realtime -->
```ts
// typecheck
import { subscribeTenant, type EchoLike } from '@sokpheak/sp-laravel-api/realtime';

function setupRealtime(echo: EchoLike) {
  return subscribeTenant(echo, api, {
    tenantId: 5,
    tables: ['invoices'],
    onChange: (change) => queryClient.invalidateQueries({ queryKey: change.queryKey }),
  });
}
```

The module is transport-free: `subscribeTenant` connects any Echo-compatible client to the tenant channel (`private-tenant.{id}`, or `private-tenant.global`), binds the leading-dot mutation events (`.invoices.created`, etc.), and returns an unsubscribe function. For low-level usage, `rt.handler({ onChange })` takes the broadcast payload `{ table, action, record, tenant_id, timestamp }` and maps it to `onChange({ table, action, record, queryKey })`, where `queryKey` is `api.keys.table(table)` (the prefix of every list and get key of that table).

#### Broadcasting Services Setup
- **Laravel Reverb:**
  ```ts
  // illustrative
  const echo = new Echo({
    broadcaster: 'reverb',
    key: 'reverb-key',
    wsHost: 'api.example.com',
    wsPort: 8080,
    wssPort: 443,
    forceTLS: true,
    enabledTransports: ['ws', 'wss'],
    authorizer: echoPusherAuthorizer(api.config.auth, { authEndpoint: 'https://api.example.com/broadcasting/auth' }),
  });
  ```
- **Pusher Channels (Hosted):**
  ```ts
  // illustrative
  const echo = new Echo({
    broadcaster: 'pusher',
    key: 'pusher-key',
    cluster: 'mt1',
    forceTLS: true,
    authorizer: echoPusherAuthorizer(api.config.auth, { authEndpoint: 'https://api.example.com/broadcasting/auth' }),
  });
  ```
- **Soketi / laravel-websockets (Self-Hosted):**
  ```ts
  // illustrative
  const echo = new Echo({
    broadcaster: 'pusher',
    key: 'soketi-key',
    wsHost: '127.0.0.1',
    wsPort: 6001,
    forceTLS: false,
    disableStats: true,
    enabledTransports: ['ws', 'wss'],
    authorizer: echoPusherAuthorizer(api.config.auth, { authEndpoint: '/broadcasting/auth' }),
  });
  ```
- **Ably:** Use `@ably/laravel-echo` or Ably's Pusher-compatible endpoint with your Ably API key.
- **Redis / Socket.IO:** Use `broadcaster: 'socket.io'` with `socket.io-client`.

#### Host Requirements
- Enable `record.broadcast_events` (`SP_BROADCAST_EVENTS=true` in `.env`).
- Define the channel authorization callback in `routes/channels.php`:
  ```php
  Broadcast::channel('tenant.{id}', function ($user, $id) {
      return (int) $user->tenant_id === (int) $id;
  });
  ```
- Expose `/broadcasting/auth` protected by the API authentication guard.

React hook with `subscribeTenant`:

```tsx
// typecheck
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeTenant, type EchoLike } from '@sokpheak/sp-laravel-api/realtime';

function useRealtime(echo: EchoLike, tenantId: number | null, tables: string[]) {
  const queryClient = useQueryClient();
  useEffect(() => {
    return subscribeTenant(echo, api, {
      tenantId,
      tables,
      onChange: (c) => queryClient.invalidateQueries({ queryKey: c.queryKey }),
    });
  }, [echo, tenantId, queryClient, tables]);
}
```

Vue watcher with `subscribeTenant`:

```ts
// typecheck
import { watchEffect, type Ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { subscribeTenant, type EchoLike } from '@sokpheak/sp-laravel-api/realtime';

export function useRealtime(echo: EchoLike, tenantId: Ref<number | null>, tables: string[]) {
  const queryClient = useQueryClient();
  watchEffect((onCleanup) => {
    const unsubscribe = subscribeTenant(echo, api, {
      tenantId: tenantId.value,
      tables,
      onChange: (c) => queryClient.invalidateQueries({ queryKey: c.queryKey }),
    });
    onCleanup(unsubscribe);
  });
}
```

- The backend event is named `{table}.{action}` through `broadcastAs()`, so Echo needs the **leading dot** (`.invoices.created`); `subscribeTenant` handles this automatically.
- The channel is `private-tenant.{id}` on the wire; Echo adds `private-` itself. With no tenant id (empty, `0`, `'0'`) the backend uses `tenant.global`.
- Mutation actions: `created`, `updated`, `deleted`, `restored`, and batched `upserted`.
- Payload shape: `{ table, action, record, tenant_id, timestamp }`.
- Bulk upsert broadcasts once, as one batched `upserted` event, with `record = { count, match_on, keys }`.
- A malformed payload, or an `action` the client does not know, is ignored. The callback never throws; an `onChange` that throws is swallowed and reported through `onEvent` as `{ type: 'realtime_handler_error' }` with a fixed message and no payload data.
- With `bulk(table).*({ async: true })` the only way to see completion is the realtime events (or re-reading).

See [src/realtime/README.md](src/realtime/README.md).

### Docs and capabilities

```ts
// typecheck
import { capabilities, docs } from '@sokpheak/sp-laravel-api/docs';

const doc = await docs(api).openapi(); // OpenAPI 3.0.3 document
const text = await docs(api).llms();   // markdown

const caps = await capabilities(api);  // read once, cached per client; { refresh: true } re-reads
if (caps === 'unknown') {
  // docs private (404) or host unreachable: rely on module_disabled / not_found from the calls
} else if (!caps.directUpload) {
  hideLargeUploadButton();
}
```

`capabilities` reports `bulk`, `attachments`, `directUpload`, `audit`, `permissions`, `webhooks` and `docs` as booleans, from the paths of the host's OpenAPI document (modules that are off are not documented), and `realtime` as `true` or `'unknown'`. It resolves `'unknown'` instead of throwing when the docs are private or the host is unreachable; 401, 403 and 5xx are thrown. It detects routes, not access (a Gate can still refuse). See [src/docs/README.md](src/docs/README.md).

### Type generation

```sh
npx sp-laravel-api typegen --url https://host/api/v2/docs/openapi.json --out src/types/sp-api.ts
npx sp-laravel-api typegen --file openapi.json --out src/types/sp-api.ts  # offline, from php artisan sp-laravel-api:export-openapi
```

```ts
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';
import type { Tables } from './types/sp-api';

const api = createApi<Tables>({ baseUrl: '/api/v2' });
const invoice = await api.table('invoices').get(7); // typed as InvoicesRead, no generic
```

The CLI (Node 20+) emits an interface per `{Name}Read` / `{Name}Write` schema and `interface Tables`; the output is deterministic. Options for `--url`: `--header 'Name: value'` (repeatable), `SP_API_TOKEN` (sent as a bearer token), `--tenant <id>` (with `--tenant-header <name>`, default `X-Tenant-ID`) and `--timeout <seconds>` (default 30). Credentials in the URL itself are refused. Exit codes: 0 ok, 1 usage, 2 failure (including a timeout); errors never print tokens or headers. Private docs answer 404 to any token, so use `--file`. The backend marks only non-nullable columns as `required` and emits no `nullable` flag, so every other column is typed `name?: T | null` (safe, if sometimes wider than the column), `id` is always present on rows, JSON columns are `unknown`, and computed attributes are not in the schema (add them to your type and list them in `select`). A table name missing from `Tables` falls back to `Table<unknown>` rather than failing to compile, and the modules (`bulk` etc.) type writes with the read type. See [src/docs/README.md](src/docs/README.md).

## Backend compatibility

| `@sokpheak/sp-laravel-api` | `sopheak/sp-laravel-api` (Laravel) |
|---|---|
| `0.1` | `^0.5.06` |

Hosts older than 0.5.06 work with `quoting: false` (see above).

## License

MIT. Copyright (c) 2026 Sem Sopheak.
