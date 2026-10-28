# @sokpheak/sp-laravel-api

Typed JavaScript client service for the [`sopheak/sp-laravel-api`](https://packagist.org/packages/sopheak/sp-laravel-api) Laravel package. ESM and CJS, no runtime dependencies, runs in browsers, edge runtimes and Node 20+. CI runs the build, guards and smoke imports (CJS and ESM, plus the dist, modules and bundle guards) on Node 20, and the full test suite on Node 22 and 24 (Vitest 5 needs Node 22.12+), on Deno and Bun, and under `@edge-runtime/vm`. The edge run proves the code works with the edge web globals, but it cannot block Node globals (vitest leaves `process` and `Buffer` visible there), so an AST scan of `src/` and the dist and browser-bundle checks are what keep Node-only code out.

> [!IMPORTANT]
> **Client Service Compatibility Notice:**  
> `@sokpheak/sp-laravel-api` is a client-side library and **works only with** backends running [`sopheak/sp-laravel-api`](https://packagist.org/packages/sopheak/sp-laravel-api). It provides typed Table Gateway CRUD operations, query serialization, REST modules (bulk, attachments, audit, permissions), and multi-broadcaster realtime event subscriptions.

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
| `retry` | off | automatic retry of transient failures, see [Retries](#retries) |
| `treatSuccessFalseAsError` | `true` | a 2xx response whose JSON body is `{ success: false }` is thrown as `SpApiError`; `false` returns that body as `data` (see [Error handling](#error-handling)) |
| `onEvent` | none | diagnostics hook. **Only the `realtime` module emits anything** (`{ type: 'realtime_handler_error' }` when your `onChange` throws); the core and the other modules never call it, so it is not a request log |

`auth` is any object with `getHeaders(): Promise<Record<string, string>>`. It may also have `handleUnauthorized(failed?: { headers }): Promise<boolean>`: on a 401 the client calls it once, passing the headers sent on the failed attempt (lowercase keys), and, if it resolves `true`, retries the request once with fresh headers. Omit `auth` for public tables.

Other table methods: `update` (PUT), `patch`, `remove`, `restore`, `upsert`, `aggregate`. `restore(id)` resolves `{ restored: number }` (the backend's count, typed `RestoreResult`), not the row; call `get(id)` afterwards if you need it. `api.fn('invoices', 'approve', { id: 7, method: 'POST' })` calls a table function and `api.rpc('auth/whoami')` a global one. `api.request()` is the low-level call for anything else.

## Functions: `rpc` and `fn`

`api.rpc(path, options?)` calls `{rpcPrefix}/{path}` and `api.fn(table, name, options?)` calls `{table}/{id?}/{rpcPrefix}/{name}`. Both resolve the unwrapped result: the `data` of a `{ success: true, data }` envelope, else the parsed body (text when it is not JSON, `null` when it is empty or a 204).

```ts
// typecheck
const me = await api.rpc<{ id: number; name: string }>('auth/whoami'); // GET: no body
const report = await api.rpc('reports/summary', {
  query: { year: 2026, open: true, tag: null }, // ?year=2026&open=true (null/undefined are skipped; no per_page is added)
});
const approved = await api.fn('invoices', 'approve', { id: 7, method: 'POST', body: { note: 'ok' } });
const exported = await api.rpc('reports/export', { method: 'POST', body: { format: 'csv' }, timeoutMs: 120_000 });
console.log(me.name, report, approved, exported);
```

- `method` defaults to `POST` when a `body` is given and `GET` otherwise.
- `query` is a `URLSearchParams` or a plain record (`string | number | boolean | null | undefined`; booleans are sent as `'true'` / `'false'`). It is not the table `Query`: nothing is serialised into filters.
- `id` (for `fn`) and every path segment are encoded; an empty, `.` or `..` segment (including the `rpcPrefix`) throws `unencodable_value` before any request is sent.
- Options also take the per-request options (`signal`, `headers`, `timeoutMs`, `log`), see [Per-request options](#per-request-options).
- For a binary or text response use `api.request({ method, path, responseType })`: `'text'` returns the raw string, `'blob'` a `Blob` and `'arrayBuffer'` an `ArrayBuffer`, each as `result.data`. These three skip the envelope parse and the `success: false` check.

## Request logging

Off by default and silent unless you give the client a logger. It lives in its own subpath, so it adds nothing to the main entry unless you import it. The package never writes output itself (no `console` call inside it); the sink is yours.

```ts
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';
import { createLogger } from '@sokpheak/sp-laravel-api/logging';

const api = createApi({
  baseUrl: 'https://api.example.com/api/v2',
  // mode: 'perRequest' (default: only calls that opt in), 'all' (every call) or 'off'
  logger: createLogger({ sink: (entry) => console.log(entry.method, entry.url, entry.status, `${entry.durationMs}ms`, `attempt ${entry.attempt}`) }),
});
```

Opt in per call on any table method (including `cursorPagination({ log })`), `rpc` or `fn` (the option is never sent to the server). `log: true` logs method, URL, status, duration, request id, attempt and the error `code` / `errorCode`; headers and bodies appear only when asked for:

```ts
// typecheck
const invoices = api.table('invoices');
await invoices.list({ where: { status: 'open' } }, { log: true });
await invoices.create({ ref_number: 'INV-1' }, { log: { bodies: true } });
await api.rpc('reports/summary', { log: { headers: true, bodies: true } });
```

One entry is produced per HTTP attempt, so a 401 refresh retry or a configured `retry` shows up as its own entry with the next `attempt` (1-based). A call that fails without a response (network error, timeout, abort) still produces an entry with `status: null` and the error `code`.

- Redaction cannot be switched off, not by `headers` or `bodies`. A header is shown as `<redacted>` when its name contains `auth`, `token`, `key`, `secret`, `cookie`, `session`, `csrf`, `xsrf`, `password`, `credential`, `signature`, `pass`, `otp`, `jwt` or `bearer`, and for the tenant header. URL-valued headers go through the URL rule below: `Location`, `Content-Location`, `Referer` and `Origin` whole, every `<...>` URL of `Link`, and the URL after `url=` in `Refresh`.
- A body or query key is redacted, at any depth (inside arrays too), when, ignoring case, `-` and `_`, it is `password`, `secret`, `code`, `otp`, `jwt`, `token`, `apikey`, `accesstoken`, `refreshtoken`, `pin`, `pwd`, `pass`, `sig`, `authorization` or `cookie`; ends with `token(s)`, `secret(s)`, `password(s)`, `passwd`, `passphrase`, `passcode`, `apikey(s)`, `privatekey`, `secretkey`, `clientkey`, `signingkey`, `encryptionkey`, `signature`, `credential` or `otp`, or with `code(s)` after `otp`, `verification`, `auth`, `mfa`, `reset`, `recovery` or `backup` (`otp_code`, `recovery_codes`); or starts with `password`. Keys that only contain such a word stay visible (`error_code`, `country_code`, `idempotency_key`, `tokens_left`, `primary_key`, `status`). `credential` is singular on purpose: a `credentials` object is walked and its sensitive keys redacted.
- URLs: a query value is redacted when its key, or any part of the key split on `[`, `]`, `,` or `.`, is sensitive (`user[password]`, comma-joined `anyOf` keys such as `api_token,email`, relation paths such as `sessions.pin`; percent-encoded keys are decoded first); so are `key=value` pairs in the fragment (`#access_token=...`). A value that embeds a condition on a sensitive column, at any depth, is redacted whole: a filter group (`or`, `and`, `not.or`, `not.and`) where any segment of a column path before the operator is sensitive (`or=(email.eq.a@example.com,api_token.eq.x)`, `or=(sessions.pin.eq.x)`; `or=(status.eq.token)` is kept, `token` being the value), and a `select` with an embed filter on such a column (`select=id,sessions(id,token=eq.x)`; a `select` that only names a sensitive column is kept). Credentials in the authority (`https://user:pw@host`) are redacted. A query or fragment value that holds a URL (`redirect=https://...`, also percent-encoded) is redacted as a URL itself, up to 2 levels deep. Keys and values are percent-decoded tolerantly: valid `%XX` UTF-8 is decoded, an invalid escape or raw non-ASCII text is kept and the rest still decoded.
- Caveats: redaction is a denylist of key names and patterns, not a guarantee. A secret under a name it does not know, in a plain-text body, in JSON stringified inside a string value or in a URL path (`/invoices/42` is logged verbatim) reaches the sink. Do not log the bodies or URLs of sensitive endpoints (login, password reset, payment, token exchange) in production.
- Bodies are cut at 2048 characters (`maxBodyLength`); binary bodies are shown as `<N bytes>`, `FormData` and `Blob` as `<multipart>`, streams as `<stream>`, and a body nested more than 100 arrays/objects deep as `<unavailable>`. Only plain data is walked (JSON objects and arrays, strings, numbers, booleans, `null`): any other object in a body (a class instance, a model with `toJSON`, a `Map`, a `Set`, a `Date`) is shown as `<object>`, never as itself. A text body is parsed as JSON after leading and trailing whitespace, BOM and NBSP are removed. Redaction takes time linear in the size of the URL, header or body. A response body is never read a second time or buffered for logging.
- The sink runs inline, on the request path: keep it quick and hand slow work to a queue. A sink that throws, or returns a rejected promise, is ignored and never changes the result of the call.
- `debug` is a different option: it asks the server for diagnostics (`X-Debug`).

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
- **Cursor paging.** `cursor: null` (or `''`) sends `cursor=0` (the first page); a cursor string is sent as is; an empty `cursor=` is never sent. `page.next` is the next cursor, or `null` at the end. `iterate()` handles this for you. Use `page: 2` for offset paging instead; offset mode never yields `next` (it is always `null` there, so step `page` yourself), and `iterate()` needs cursor mode. See [Cursor pagination](#cursor-pagination).
- **`per_page` is always sent** on list calls (default 25; set `defaults.perPage` on the client or `perPage` per query). `total: true` asks for a total, returned as `page.total`.
- **Hosts older than 0.5.06** have no quoting and split every value on commas. Pass `createApi({ quoting: false })` and the serializer throws `SpApiError` with code `unencodable_value` for a value it cannot send safely, instead of sending a filter the server would misread.

## Cursor pagination

```ts
// typecheck
const pager = invoices.cursorPagination({
  query: { where: { status: 'open' }, sort: { by: 'created_at', order: 'desc' } }, // a sort is needed for lastPage()
  perPage: 20,
  cursorColumn: 'created_at', // optional, sent as cursor_column=
});

const first = await pager.firstPage(); // cursor=0
const second = await pager.nextPage(first); // null when first.next is null
const back = second === null ? null : await pager.prevPage(second); // direction=prev, null when second.prev is null
const last = await pager.lastPage(); // the final rows, in the query's own order

// The same thing by hand on any list call:
const before = await invoices.list({ cursor: 'abc', direction: 'prev', cursorColumn: 'created_at', perPage: 20 });
console.log(first.next, back?.data.length, last.prev, before.prev);
```

- `direction` is `'next'` (the host default) or `'prev'` (the rows before `cursor`); `cursorColumn` names the column the cursor pages on (default on the host: the sorted column). Both are validated and sent as `direction=` and `cursor_column=`.
- `next` is only set on a **full** page (as many rows as `per_page`): a short page is the end of the data and gives `next: null`. An empty page ends `iterate()`, as does a `next` that does not move on.
- `lastPage()` reverses the query's `sort` and fetches the first page of that, then restores the order. It needs a `sort`: without one it throws `SpApiError` `unencodable_value` and sends nothing, because the host's default sort depends on the table. An omitted `order` counts as `desc`, the host default. An empty or short last page gives `prev: null`; `next` is always `null`.
- `nextPage` / `prevPage` take a cursor string or a `Page` and resolve `null` (no request) when there is no cursor.

## Retries

Off by default. Enable it for the whole client with `retry`:

```ts
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';

const api = createApi({
  baseUrl: 'https://api.example.com/api/v2',
  retry: {
    maxAttempts: 3, // retries after the first attempt; 0 (the default) means off
    statusCodes: [408, 429, 502, 503, 504], // the default list
    networkErrors: true, // network failures and timeouts are retried (default true)
    backoffMs: 300, // 300 ms, then 600, 1200... capped at maxBackoffMs
    maxBackoffMs: 5000,
    jitter: true, // each delay is scaled by a random 50-100%
  },
});

// Per call, on api.request: `true` uses the client policy, an object is its own policy, `false` switches it off.
await api.request({ method: 'POST', path: 'invoices/sync', body: {}, retry: { maxAttempts: 2 } });
await api.request({ method: 'GET', path: 'invoices', retry: false });
```

- The client-level policy retries `GET` and `HEAD` only. A write is retried only when that call asks for it with `retry: true` (client policy) or `retry: { maxAttempts }`, so make sure the endpoint is safe to repeat.
- A per-call `retry` object does not merge with the client policy: unset fields take the defaults above (including `maxAttempts: 0`).
- `retry` is an `api.request` option; table methods, `rpc` and `fn` use the client policy (and only for `GET`/`HEAD`).
- A `Retry-After` header on the failed response (seconds or an HTTP date) replaces the backoff delay, capped at 30 s. A caller abort is never retried and also cancels the wait.
- A 2xx `{ success: false }` envelope error is never retried (its status is not in the list). The 401 refresh (`handleUnauthorized`) is separate and does not use up a retry; it runs once per call.

## Per-request options

Every table method, `rpc` and `fn` take an options object with `signal`, `headers`, `timeoutMs` and `log` (also `debug` on `request`). `upsert` also takes `matchOn`, `refetch` and `select`.

```ts
// typecheck
const ctl = new AbortController();
const pending = invoices.list(
  { where: { status: 'open' } },
  {
    signal: ctl.signal, // abort to cancel the request (also while a retry is waiting)
    timeoutMs: 5_000, // overrides the client's timeoutMs; 0 means no timeout
    headers: { 'X-Trace-Id': 'abc123' }, // applied last, so they win over the auth and tenant headers
    log: true,
  },
);
ctl.abort();
try {
  await pending;
} catch (e) {
  console.log(e === ctl.signal.reason); // an abort rejects with the signal's reason, not an SpApiError
}

// Insert-or-update by the match columns; resolves { id, payload }
const result = await invoices.upsert({ ref_number: 'INV-1', total: 120 }, { matchOn: ['ref_number'] });
// Re-read the row afterwards: resolves the row (with select, only those columns)
const row = await invoices.upsert(
  { ref_number: 'INV-1', total: 130 },
  { matchOn: ['ref_number'], refetch: true, select: ['id', 'total'] },
);
console.log(result, row);
```

A timeout throws `SpApiError` `timeout`. `refetch: true` makes a second request (`GET {table}/{id}`) with the same options, and throws `SpApiError` `unknown` if the upsert response carries no `id`. The tenant header is added after the auth headers, so it replaces an auth header of the same name.

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

```ts
// typecheck
import { createApi, isSpApiError } from '@sokpheak/sp-laravel-api';

try {
  await invoices.get(7);
} catch (e) {
  if (!isSpApiError(e)) throw e;
  if (e.isTransport) {
    // no response: e.code is 'network' or 'timeout'; the underlying error is on e.cause only
    console.log(e.code, e.cause);
  } else if (e.isHttp) {
    // the server answered: e.status > 0 (also 200 for an envelope error)
    console.log(e.status, e.code, e.errorCode, e.requestId, e.retryAfter);
  }
}

// Keep the old behaviour: a 2xx { success: false } body resolves as data instead of throwing.
const lenient = createApi({ baseUrl: 'https://api.example.com/api/v2', treatSuccessFalseAsError: false });
console.log(lenient.config.treatSuccessFalseAsError);
```

Fields: `status` (0 when there is no response), `code`, `message`, `fieldErrors`, `errorCode` (the backend's `error_code` when enveloped), `module`, `requestId`, `retryAfter` (seconds), `body`, `response`, `cause` (the original error of a `network` / `timeout` failure), and the getters `isTransport` (status 0 with code `network` or `timeout`; not another local error such as `unencodable_value`) and `isHttp` (`status > 0`).

- **Transport messages are fixed** (`Network request failed`, `Request timed out`) because the underlying error text may carry a URL or a token; read `err.cause` if you need it. A caller abort is not an `SpApiError`: it rejects with the signal's reason.
- **`retryAfter`** is the first of: the `Retry-After` header (any status; numeric seconds, `0` or more), the body's `retry_after`, then `errors.retry_after_seconds` (first element or a bare number or numeric string; must be above 0). Anything else gives `null`. `fieldErrors.retry_after_seconds` keeps the value as a string array.
- **A 2xx response with a JSON object body `{ success: false }` is an error** (`treatSuccessFalseAsError`, default `true`), because the backend can answer an application failure with HTTP 200. It is thrown with `status` 200 (the real HTTP status, 2xx), `message` and `errorCode` from the body, and `code` from the envelope `error_code`: `10002` `unauthenticated`, `10008` `forbidden`, `10009` `not_found`, `10004` `validation` (`tenant_required` when the tenant header is the failing field), `10010` `server`, anything else `unknown`. Arrays, strings and `null` bodies, 3xx responses and `responseType` `'text'`, `'blob'` and `'arrayBuffer'` calls are not checked. `disabledOn404` modules still map only a real 404 to `module_disabled`; a 200 with `10009` is `not_found`.
- **`error_code` 10002 refreshes like a 401**: with `auth.handleUnauthorized` the hook is called once and, if it resolves `true`, the call is retried once. The refresh is allowed once per call, also when the 401 comes after a network or status retry. Without the hook (or when it resolves `false`) the error is thrown at once.

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

`upload`, `uploadDirect`, `uploadMultipart`, `cloneTemp`, `viewUrl`, `downloadUrl`, `forRecord(table, id)` (`list`, `link`, `unlink`) and `folders` (`list`, `listPage`, `create`, `update`, `remove`; list calls always send `per_page`). `uploadDirect` and `uploadMultipart` (resumable, `concurrency`, `onProgress`, `signal`) need `direct_upload.enabled` on the host and, in browsers, a bucket CORS policy exposing `ETag`; a 404 there is `module_disabled` with `module: 'attachments.direct_upload'`. `upload(file, { strategy: 'auto' })` picks multipart above `partSize × 2` (default part 8 MiB), direct only when `directUpload: true` is passed, else the form upload; `upload` without a strategy is the form upload. The multipart `upload_token` (in `onState` snapshots) is a credential. Protected files need the auth header, so fetch them with `viewBytes` / `viewBlob` (below) for `<img>`, or use the signed `preview_url` when the host enables previews. A 404 is `module_disabled` only on calls with no lookup target (`upload` without `recordType`, `folders.list`, `folders.create`); on the others it stays `not_found` (missing record, link, attachment or folder), so a disabled module reads as `not_found` there and `capabilities()` (from `/docs`) is the reliable detector. See [src/attachments/README.md](src/attachments/README.md) for routes, field names and error handling.

Private images and files through the client's own auth and tenant headers (the exact bytes, never decoded as text):

```ts
// typecheck
const stored = await att.upload(blob, { recordType: 'products', recordId: 7, name: 'photo.png' });
const bytes = await att.viewBytes(stored.id, { w: 200, h: 200, fit: 'crop', format: 'webp' }); // Uint8Array
const preview = await att.viewBlob(stored.id, { signal: controller.signal, timeoutMs: 10_000 }); // Blob
img.src = URL.createObjectURL(preview);
console.log(bytes.byteLength);

try {
  att.forRecord('products', ''); // throws synchronously: no request is sent
} catch (e) {
  console.log(e instanceof Error && e.name === 'SpApiError'); // code: 'unencodable_value'
}
```

`viewBytes` / `viewBlob` take the `viewUrl` size options plus `signal`, `headers` and `timeoutMs`, and call `GET sp_attachments/{rpc}/{id}/view`. Attachment ids, record ids, the table name and the `rpcPrefix` go through the same guard as `rpc` path segments: an empty, `.` or `..` value throws `SpApiError` `unencodable_value` and no request is sent (`forRecord(table, id)` throws on the call itself, not on the first `list`/`link`).

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
import { useQueryClient } from '@tanstack/react-query';
import { subscribeTenant, type EchoLike } from '@sokpheak/sp-laravel-api/realtime';

function setupRealtime(echo: EchoLike) {
  const queryClient = useQueryClient();
  return subscribeTenant(echo, api, {
    tenantId: 5,
    tables: ['invoices'],
    onChange: (change) => queryClient.invalidateQueries({ queryKey: change.queryKey }),
  });
}
```

The module is transport-free: `subscribeTenant` connects any Echo-compatible client to the tenant channel (`private-tenant.{id}`, or `private-tenant.global`), binds the leading-dot mutation events (`.invoices.created`, etc.), and returns an unsubscribe function. For low-level usage, `rt.handler({ onChange, onUnhandled? })` takes the broadcast payload `{ table, action, record, tenant_id, timestamp }` and maps it to `onChange({ table, action, record, queryKey, raw, eventName? })`, where `queryKey` is `api.keys.table(table)` (the prefix of every list and get key of that table), `raw` is the payload exactly as received and `eventName` the bound event name without the leading dot.

Custom events and payloads that are not valid record events reach `onUnhandled({ eventName, payload })` instead (without it they are ignored). Bind custom Echo event names with `events`:

```ts
// typecheck
import { subscribeTenant, type EchoLike } from '@sokpheak/sp-laravel-api/realtime';

function setupLiveCourier(echo: EchoLike) {
  return subscribeTenant(echo, api, {
    tenantId: 5,
    tables: ['orders'],
    events: ['.courier_location.moved'], // bound as-is: include the leading dot if Echo needs it
    onChange: (change) => console.log(change.eventName, change.action, change.raw), // valid record events only
    onUnhandled: ({ eventName, payload }) => console.log(eventName, payload), // everything else
  });
}
```

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
- `onChange` only receives valid record events (an object with a non-empty string `table` and one of the five actions). A malformed payload, an `action` the client does not know or a custom event goes to `onUnhandled` when you gave one, and is ignored otherwise. Callbacks never throw into the transport: an `onChange` or `onUnhandled` that throws (or rejects) is swallowed and reported through `onEvent` as `{ type: 'realtime_handler_error' }` with a fixed message and no payload data. A hand-built `RealtimeChange` (for example in a test) must include `raw`.
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
npx sp-laravel-api typegen --schema openapi.json --out src/types/sp-api.ts # alias accepting URL or file path
```

```ts
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';
import type { Tables } from './types/sp-api';

const api = createApi<Tables>({ baseUrl: '/api/v2' });
const invoice = await api.table('invoices').get(7); // typed as InvoicesRead, no generic
```

The CLI (Node 20+) emits an interface per `{Name}Read` / `{Name}Write` schema and `interface Tables`; the output is deterministic. `--schema <url|path>` can be used as a universal input alias for `--url` or `--file`. Options for remote fetches: `--header 'Name: value'` (repeatable), `SP_API_TOKEN` (sent as a bearer token), `--tenant <id>` (with `--tenant-header <name>`, default `X-Tenant-ID`) and `--timeout <seconds>` (default 30). Credentials in the URL itself are refused. Exit codes: 0 ok, 1 usage, 2 failure (including a timeout); errors never print tokens or headers. Private docs answer 404 to any token, so use `--file` or `--schema <path>`. The backend marks only non-nullable columns as `required` and emits no `nullable` flag, so every other column is typed `name?: T | null` (safe, if sometimes wider than the column), `id` is always present on rows, JSON columns are `unknown`, and computed attributes are not in the schema (add them to your type and list them in `select`). A table name missing from `Tables` falls back to `Table<unknown>` rather than failing to compile, and the modules (`bulk` etc.) type writes with the read type. See [src/docs/README.md](src/docs/README.md).

## Backend compatibility

| `@sokpheak/sp-laravel-api` | `sopheak/sp-laravel-api` (Laravel) |
|---|---|
| `0.1` to `0.3` | `^0.5.06` |
| next minor (unreleased) | `^0.5.06` |

Hosts older than 0.5.06 work with `quoting: false` (see above).

The next minor changes some defaults (see `.changeset/` and the changelog when it is released). **Breaking:** a 2xx `{ success: false }` response now throws `SpApiError` (set `treatSuccessFalseAsError: false` to keep the old behaviour); `lastPage()` without a `sort` throws `unencodable_value`; the message of a `network` / `timeout` error no longer includes the underlying error text (`err.cause` keeps it); attachment ids, record ids and `rpcPrefix` are guarded (an empty, `.` or `..` value throws `unencodable_value`); `RealtimeChange` gains a required `raw`. Cursor `direction` / `cursorColumn`, `rpc` / `fn` `query`, `responseType` `'blob'` / `'arrayBuffer'`, `attachments.viewBytes` / `viewBlob`, `isTransport` / `isHttp` and the realtime `onUnhandled` / `events` need nothing from the host beyond `^0.5.06`.

## License

MIT. Copyright (c) 2026 Sem Sopheak.
