# Changelog

## 0.5.0

### Minor Changes

- Added `serializeFilters(query, { quoting, driver? })`: the query parameters for `select`, `where`, `or`, `search`, `aggregate`, `groupBy`, `distinct`, `trashed` and `sort`, without any paging. It quotes values exactly like `serializeQuery`, but never adds `per_page`, `page`, `cursor`, `direction`, `cursor_column` or `total`, for hosts that run their own list layer and set paging themselves. A paging key in an object literal is a type error, and a query that carries one (for example a `Query` variable) throws `unencodable_value`. `serializeQuery` is unchanged. The types `FilterQuery` and `FilterSerializeOptions` are exported.

- `attachments.upload()` can now send the fields the upload route validates. Resize (form upload only): `width`, `height`, `fit`, `sizeName` (sent as `w`, `h`, `fit`, `size_name`) and `asTemp`. Every strategy: `replaceOld`, `title`, `caption`, `tempTimeoutMinutes`, `tempTimeoutAt` and `folderId`, which moves up from `DirectUploadOptions` to `UploadOptions`. When the server would silently ignore or override an option, the client throws `unencodable_value` before any request: `asTemp: true` with a `private` / `public` visibility, a timeout without a temporary upload, both timeouts, `replaceOld: true` without `recordType` and `recordId`, `sizeName` together with `width`, `height` or `fit`, and a `width` or `height` that is not a positive integer. Only a truthy flag counts: `replaceOld: false` is not sent. `replaceOld` replaces what is in that `collection` (`default` when omitted) of the record and deletes old files nothing else links to. `tempTimeoutAt` is sent as given (a `Date` as ISO); the server drops the offset, so a UTC string is only right when the host's `app.timezone` is UTC. The server's own ranges (width and height 10 to 3000, title length, timeout cap) are not copied: the host's 422 reports them. `folderId` was already typed on the strategy options but the form upload (the default strategy, and small files under `auto`) ignored it; it now sends `folder_id`, so a stale or unknown folder id gets the host's 422 "Folder not found" instead of being dropped silently.

### Patch Changes

- A hand-set `Content-Type` on a `FormData` body is now dropped, so the runtime adds `multipart/form-data; boundary=...` itself. A `Content-Type` set by hand (per call, or returned by `auth.getHeaders()`, in any letter case) can never carry the boundary the runtime generates, so those uploads were rejected by the backend. String, `Blob` and `URLSearchParams` bodies keep the `Content-Type` you choose.

- Added `llms.txt` to the package: a short feature map, recipes and the defaults that bite, so an AI assistant (or a new developer) can learn the package's key features and usage quickly. It ships in the npm tarball, linked from the README. Its code blocks are type-checked with the README's.

## 0.4.0

### Minor Changes

- Cursor paging: new `direction?: 'next' | 'prev'` and `cursorColumn?: string` query options, sent as `direction=` and `cursor_column=` (both validated; `cursorColumn` follows the same rules as aggregate column names). `createCursorPagination` / `table.cursorPagination` take a `cursorColumn` option. `''` and `null` cursors still send `cursor=0`.

  BREAKING: `lastPage()` without a `sort` now throws (see below). Fixed: `prevPage()` did not send `direction=prev`, so it returned the rows after the cursor instead of the rows before it; it now does. `lastPage()` assumed `sort: id asc` when the query had no `sort`, which could silently return the wrong rows: it now needs a `sort` and throws `SpApiError` `unencodable_value` without sending a request (the host's default sort depends on the table, so the client cannot know it). An omitted `order` in the `sort` is now treated as the host default (`desc`) when reversing. `lastPage()` on an empty or single short page returns `prev: null`.

- Optional, redacted request logging (D1) in the new `@sokpheak/sp-laravel-api/logging` subpath. `createLogger({ sink, mode?, maxBodyLength? })` is passed as `createApi({ logger })`; calls opt in with a per-call `log: true | { headers?, bodies? }` on table methods, `cursorPagination`, `rpc`, `fn` and `request` (never sent to the server). `mode: 'perRequest'` (default) logs only those calls, `'all'` every call (except `log: false`), `'off'` none; an unknown mode means `'perRequest'`. Off by default and silent without a logger; the main entry only gains the types (`LogEntry`, `LogMode`, `LogOption`, `RequestLogger`).

  One entry per HTTP attempt, so a 401 refresh retry or a `retry` attempt gets its own entry: method, URL with redacted query, status (`null` without a response), duration, sanitised request id, 1-based attempt, error `code` / `errorCode`, plus redacted headers and bodies when asked for. Redaction cannot be switched off: sensitive header names (by pattern), the tenant header and the URLs in URL-valued headers (`Location`, `Content-Location`, `Referer`, `Origin`, `Link`, `Refresh`); sensitive body and query keys at any depth (also bracketed keys, comma-joined `anyOf` keys and dotted relation paths such as `sessions.pin`); `key=value` pairs in URL fragments; filter groups (`or`, `and`) and `select` embed filters on a sensitive column or relation column; credentials in URLs, also in a URL held by a query value. Bodies: only plain data is walked (other objects are `<object>`), too-deep bodies are `<unavailable>`, JSON text is recognised after a BOM or NBSP. Redaction is a denylist of key names, not a guarantee. Bodies are cut at 2048 characters (`maxBodyLength`); binary, multipart and stream bodies are described, not read. The sink runs inline; a sink, or a hand-written logger, that throws or rejects never changes a request result.

- Realtime: non-record events and the raw payload (L6, L7). `RealtimeChange` gains `raw` (the payload as received, same object) and `eventName` (the bound event name without the leading dot). `handler` and `subscribeTenant` accept an optional `onUnhandled({ eventName, payload })`, called for payloads that are not valid record events (non-object, no string `table`, unknown action, custom events), with the same swallow-and-report-once rules as `onChange`; without it such payloads are ignored as before. The callback returned by `handler` is now `(payload, eventName?)`. `subscribeTenant({ events })` binds custom Echo event names as-is. `onChange` keeps its meaning: it only receives valid record events. BREAKING: `raw` is required on `RealtimeChange`, so a hand-built `RealtimeChange` object (for example in a test) must now include it.

- Added: `api.rpc` and `api.fn` accept a `query` option (a `URLSearchParams` or a plain record; null/undefined entries are skipped, booleans become `'true'`/`'false'`, and no `per_page` is added). `api.request` gains `responseType: 'blob' | 'arrayBuffer'`, which returns the raw body without envelope parsing. `attachments(api)` gains `viewBytes(id, options?)` and `viewBlob(id, options?)`: an authenticated `GET sp_attachments/{rpc}/{id}/view` that returns the exact bytes, so private images can be fetched with the client's auth and tenant headers.

  BREAKING (fix): attachment ids, record ids and the `rpcPrefix` now go through the same path-segment guard as `api.rpc`: an empty, `.` or `..` value throws `unencodable_value` with no request sent, instead of being normalised by the URL parser to a different route. Normal ids are encoded as before.

- BREAKING (default): a 2xx response whose JSON body is an object with `success: false` now throws `SpApiError` instead of resolving with the body as `data`. `status` stays 2xx; `errorCode` and `message` come from the body; `code` follows the envelope `error_code` (10002 `unauthenticated`, 10008 `forbidden`, 10009 `not_found`, 10004 `validation`, 10010 `server`, otherwise `unknown`); a 10004 keyed by the tenant header is `tenant_required`. Bodies that are arrays, strings or `null`, and `responseType: 'text'` calls, are untouched. To keep the old behaviour set `createApi({ treatSuccessFalseAsError: false })`.

  A `200` with `error_code` 10002 now calls `auth.handleUnauthorized` once and retries once, like a 401; without a hook, or when it resolves `false`, the error is thrown at once. A throwing hook propagates unchanged.

  Fixed: a 401 that arrived after a network or status retry never called `handleUnauthorized` (the refresh was tied to the first attempt); one refresh per call is now allowed whenever the 401 happens.

- `SpApiError` gains `isTransport` (status 0 with code `network` or `timeout`; not other local errors such as `unencodable_value`) and `isHttp` (status above 0).

  `retryAfter` now resolves from the `Retry-After` header (any status, numeric seconds `>= 0`; it was only read for 429, so it is now set for non-429 statuses that carry the header), then body `retry_after`, then `errors.retry_after_seconds` (first element or bare value, number or numeric string, must be above 0). Garbage, empty and non-positive values give `null`. `fieldErrors.retry_after_seconds` is kept, also for a bare number (`['12']`). This applies to both HTTP errors and `200 { success: false }` errors.

  BREAKING: the message of a `network` / `timeout` error no longer includes the underlying error text (it may carry URLs or tokens); the original error stays on `err.cause`.

## 0.3.0

### Minor Changes

- Enhanced network resilience, CLI flexibility, and cursor pagination:
  - Added configurable idempotent request retry policy (`RetryConfig`) with exponential backoff, full jitter, `Retry-After` header parsing, and `AbortSignal` cancellation support.
  - Added `--schema` flag to typegen CLI supporting both remote OpenAPI URLs and local file paths with automatic dispatch.
  - Added `createCursorPagination` adapter and `table.cursorPagination()` helper with inverted sorting on reverse traversals (`lastPage`).

## 0.2.0

### Minor Changes

- Realtime multi-broadcaster support in `@sokpheak/sp-laravel-api/realtime`:
  - Added `subscribeTenant(echo, api, options)` helper with structural `EchoLike` interface and zero runtime dependencies.
  - Added `echoPusherAuthorizer(auth, options)` helper for Pusher and Laravel Reverb channel authorization with automatic 401 retry recovery.
  - Documented setup configurations for Laravel Reverb, Pusher Channels, Soketi, Ably, and Redis / Socket.IO with compiled and typechecked snippets.
  - Added real-server Reverb contract test suite (`test/realtime/reverb.contract.test.ts`).
  - Verified publish hygiene, clean neutral vocabulary, and secret scanning with Gitleaks.

## 0.1.0

### Minor Changes

- 4d2771d: First release (0.1): a typed JavaScript client for the `sopheak/sp-laravel-api` Laravel package (`^0.5.06`; older hosts with `quoting: false`). ESM and CJS, no runtime dependencies; runs in browsers, edge runtimes, Deno, Bun and Node 20+.
  
  **Core** (main entry). `createApi({ baseUrl, rpcPrefix, auth, tenant, defaults, fetch, timeoutMs, quoting, driver, debug, onEvent })` with `table()` (`list`, `get`, `create`, `update`, `patch`, `remove`, `restore`, `upsert`, `aggregate`, cursor `iterate`), `fn()` / `rpc()` and the low-level `request()`. A query serializer (`where`, `or`, lists as `in.(...)`, value quoting, `any` / `all` modifiers, embeds via `select`, `sort: { by, order }`, search, `raw`, aggregates, cursor and offset paging, always-sent `per_page`) that throws `unencodable_value` rather than send a filter the host would misread. `keys` for TanStack Query; one `SpApiError` type with machine-readable codes; per-request timeout; tenant header; an `ApiAuth` seam with retry-once on 401. `createApi<Tables>()` types `api.table(name)` from generated types without generics. `table.restore()` resolves the backend's `{ restored: number }` (`RestoreResult`), not the row.
  
  **Modules** (subpath imports, tree-shaken from the main entry):
  
  - `/bulk`: `bulk(table)` with `create`, `update`, `delete`, `upsert` and `mixed`, chunking (`chunkSize`, `concurrency`), `async` queueing and `signal`; a part-way failure carries `error.completedChunks` (each request is its own backend transaction).
  - `/attachments`: form `upload`, `uploadDirect` (signed PUT or local POST) and resumable S3 `uploadMultipart` (`partSize`, `concurrency`, `onProgress`, `onState` / `resume`, `signal`), `upload(file, { strategy })`, `cloneTemp`, `viewUrl` / `downloadUrl`, `forRecord(table, id)` (`list`, `link`, `unlink`) and `folders` (`list`, `listPage`, `create`, `update`, `remove`).
  - `/audit`: `list` (read-only `sp_audit_logs`), `stats`, `fieldTimeline`, `fieldStats`; the tenant always comes from the tenant header.
  - `/permissions`: `roles` (CRUD), `permissions` (list / get / update), `assign` and `detach`.
  - `/webhooks`: admin (`endpoints` with client-generated secrets returned once, `rotateSecret`, `subscriptions`, read-only `deliveries`) and runtime-neutral receiver helpers `verifyWebhook` (constant-time HMAC-SHA256 via Web Crypto) and `parseWebhook`.
  - `/realtime`: a transport-free broadcast handler that maps record events to TanStack Query keys, plus `channelName` / `eventName` for Laravel Echo.
  - `/docs`: `docs(api).openapi()` / `.llms()` and `capabilities(api)` (which modules the host has on, from its OpenAPI document).
  
  **CLI**: `sp-laravel-api typegen (--url | --file) --out` (Node 20+) generates `{Name}Read` / `{Name}Write` interfaces and `interface Tables` deterministically from the host's OpenAPI document.
  
  **Caveats.** The backend contract was read from the `sp-laravel-api` source and is covered by unit tests on fake `fetch` responses; it has **not yet been verified against a live host** (the contract suites exist but skip until a backend or recorded fixtures are available), notably the webhook signature bytes and the direct/multipart upload flow. Node 20 is supported at runtime and for the CLI; the package's own test suite needs Node 22.12+ (Vitest 5), so CI tests on Node 22 and 24 and only builds and smoke-imports on Node 20.

## Unreleased

- Repository scaffold and build guards.
