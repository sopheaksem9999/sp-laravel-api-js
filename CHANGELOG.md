# Changelog

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
