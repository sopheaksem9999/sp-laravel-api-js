# `@sopheak/sp-laravel-api/docs`

The host's `api_docs` routes, `capabilities()` (which backend modules the host exposes), and the `sp-laravel-api typegen` CLI that turns the OpenAPI document into TypeScript types.

```ts
import { createApi } from '@sopheak/sp-laravel-api';
import { capabilities, docs } from '@sopheak/sp-laravel-api/docs';

const api = createApi({ baseUrl: 'https://host.example/api/v2', rpcPrefix: 't', auth });

const doc = await docs(api).openapi(); // the OpenAPI 3.0.3 document (parsed JSON)
const text = await docs(api).llms();   // the agent contract, markdown text

const caps = await capabilities(api);
if (caps !== 'unknown' && caps.directUpload) showLargeUploadButton();
```

## Backend contract (verified against `sp-laravel-api` source: `routes/api.php`, `OpenApiService.php`, `ExportOpenApiCommand.php`, `RecordConfigService.php`)

| Method | Route | Result |
|---|---|---|
| `openapi()` | `GET docs/openapi.json` | the document as `response()->json($spec)` (content type `application/vnd.oai.openapi+json`), not wrapped in the `{ success, data }` envelope |
| `llms()` | `GET docs/llms.txt` | `text/markdown`, returned as a string (sent with `responseType: 'text'`, so it is never JSON-parsed) |

Both routes sit under the host's `api_prefix` (your `baseUrl`), outside the tenant middleware. With `record.api_docs.is_private` (env `SP_LARAVEL_API_DOCS_PRIVATE`) the host answers both with `404 { success: false, message: 'Not Found' }` **whatever the credentials** (the token-protected copy is the web route `/api-docs/openapi.json`, which needs a browser session). These routes have no lookup target, so a 404 is reported as `code: 'module_disabled'` with `module: 'docs'`: that is the "docs are private" signal, and it is what makes `capabilities()` resolve `'unknown'`. A failed generation is a 500 (`code: 'server'`, `message` from the backend). Every error carries `module: 'docs'`.

## `capabilities(api, { refresh?, signal? })`

Reads `docs/openapi.json` once and derives each module from the document's **path keys**. The backend only registers (and documents) a module's tables and functions when the module is on (`RecordConfigService::getTableConfig()` merges `attachments.tables`, `audit.tables`, `webhooks.tables` only when enabled, and strips the direct-upload functions when `direct_upload.enabled` is off), so a path's presence is the module's presence.

| Key | `true` when a path matches | Host switch |
|---|---|---|
| `bulk` | `…/{table}/bulk/create`, `bulk/update` or `bulk/delete` | `record.bulk_operations` |
| `attachments` | `…/sp_attachments/{rpc}/upload` | `attachments.enabled` |
| `directUpload` | `…/sp_attachments/{rpc}/create-upload-url` or `create-multipart-upload` | `attachments.direct_upload.enabled` |
| `audit` | any `sp_audit_logs` path | `audit.enabled` |
| `permissions` | any `sp_roles` or `sp_permissions` path | always registered |
| `webhooks` | any `sp_webhook_endpoints`, `sp_webhook_subscriptions` or `sp_webhook_deliveries` path | `webhooks.enabled` |
| `docs` | always `true` (the document was read) | `api_docs.is_private` |
| `realtime` | `true` when the document has `x-sp-realtime`, else `'unknown'` | `record.broadcast_events` |

- `{rpc}` is the client's `rpcPrefix` (`'rpc'` by default; with `''` there is no segment). A client whose `rpcPrefix` differs from the host's will not see `attachments` / `directUpload`; its function calls would fail anyway.
- `bulk/upsert` is **not** used for `bulk`: the backend documents it for every table that allows upsert, even with bulk operations off (`OpenApiService` ~L1540), although the route is only registered when they are on.
- `realtime` is never `false`: broadcasting has no HTTP route, and the host documents it (`x-sp-realtime`) only when `sp-laravel-api.openapi.realtime.enabled` is on as well, so its absence proves nothing.
- `directUpload` is an extra key beyond the module list, for the "hide Upload large file" case.

Result: `Capabilities` or `'unknown'`. It resolves `'unknown'` and never throws when the docs are private (404), when the host cannot be reached (`network` or `timeout`), and when the body is not an OpenAPI document. Any other failure (401, 403, 5xx) is rethrown as `SpApiError` (`module: 'docs'`); an abort rethrows the signal's reason.

Caching: the result is cached per client (`Api` instance, in a `WeakMap`, so it goes away with the client) for the client's lifetime; `refresh: true` reads the document again. The private-docs `'unknown'` is cached too; a network `'unknown'` and thrown errors are not, so the next call retries. Concurrent calls without a `signal` share one in-flight read (one fetch for N callers; a `refresh: true` call starts a new shared read); a call with a `signal` reads on its own, so its abort never reaches other callers.

What it cannot see: a module whose routes exist but which the host refuses by other means (a Gate such as `manage-audit-logs`, a host-specific flag, a permission) is reported as present; this detects routes, not access. The `sp-jwt-auth` module `enabled` flags are unrelated (and only informational there). With private docs the answer is `'unknown'`: fall back to handling `module_disabled` / `not_found` from the module calls. This is the detector the attachments, audit and webhooks READMEs point to for the calls where a disabled module reads as `not_found`.

## Type generation: `sp-laravel-api typegen`

```sh
npx sp-laravel-api typegen --url https://host/api/v2/docs/openapi.json --out src/types/sp-api.ts
# private docs: export on the host, then generate offline
php artisan sp-laravel-api:export-openapi --output=openapi.json
npx sp-laravel-api typegen --file openapi.json --out src/types/sp-api.ts
```

```ts
import { createApi } from '@sopheak/sp-laravel-api';
import type { Tables } from './types/sp-api';

const api = createApi<Tables>({ baseUrl: '/api/v2' });
const invoice = await api.table('invoices').get(7);    // InvoicesRead, no generic
await api.table('invoices').patch(7, { status: 'paid' }); // Partial<InvoicesWrite>
```

Options: `--url <url>` or `--file <path>` (exactly one), `--out <path>`, `--header 'Name: value'` (repeatable), `--tenant <id>` with `--tenant-header <name>` (default `X-Tenant-ID`), `--timeout <seconds>` (default 30; a timeout is exit 2 "timed out"), `--help`. With `--url`, `SP_API_TOKEN` is sent as `Authorization: Bearer …` unless a `--header` sets `Authorization`. A `--url` with credentials in it (`https://user:pass@…`) is refused as a usage error, without fetching: use `--header` or `SP_API_TOKEN`. Only JSON is read (export with the default `--format=json`). Exit codes: `0` ok, `1` usage error, `2` fetch, timeout, parse, generation or write failure; errors are one line, with no stack trace, and never contain a header value, a token or the URL's query string. The output is generated in memory, written to `<out>.tmp-<pid>` and renamed over `<out>` (the temporary file is removed on failure), so a failed run leaves an existing file untouched. The CLI is Node-only (Node 20+, global `fetch`); the rest of the package stays browser- and edge-safe.

What it emits (deterministic: schemas, properties and tables sorted by name, no timestamps, so two runs on the same document are byte-identical):

- For each `{Name}Read` / `{Name}Write` component schema pair (`OpenApiService::generateInternal()` emits `{Name}`, `{Name}Read` and `{Name}Write` per table, with `Name = str_replace(['-', ' '], '_', ucwords(strtolower($table)))`, e.g. `invoice_items` → `Invoice_itemsRead`), `export interface {Name}Read` / `{Name}Write`, plus every schema they reference through `$ref` (resolved, cycles allowed; an unresolvable `$ref` is a failure).
- `{Name}Read` gains `created_at?: string | null` / `updated_at?: string | null` when the full `{Name}` schema documents them (`OpenApiService::tableSchema` keeps them, lines 603-607; `tableSchemaRead` drops them, lines 709-710), because rows carry them.
- Generation fails (exit 2, one line) on an unresolved `$ref`, and when two schemas map to the same identifier or a referenced schema is named `Tables` (the output would not compile).
- `export interface Tables { <table>: { read: <Name>Read; write: <Name>Write } }`. The table name comes from the path that references the schemas (`/{api_prefix}/{table}…`), since `Name` loses the table's case; a table with no documented operation falls back to the lowercased `Name`.
- Header line `// Generated by sp-laravel-api typegen — do not edit.`

Mapping: `string` (any `format`, including `date` / `date-time`) → `string`; `integer` / `number` → `number`; `boolean`; `array` → `T[]`; `object` with properties → an object type; a bare `object` (no properties, no `additionalProperties`) → `unknown`, because that is how the backend documents a JSON column, which can hold any JSON value (array, scalar, object); `additionalProperties` alone → `Record<string, T>`, next to properties → an index signature `[key: string]: unknown` (a typed one would have to cover every property and might not compile); `enum` → a literal union; `allOf` → `&`, `oneOf` / `anyOf` → `|`; `nullable: true` or a `'null'` type → `| null`; anything else → `unknown`. `description` and `format` become JSDoc. `readOnly` properties are left out of the `Write` interfaces (the backend marks `columnWriteDisabled` columns `readOnly`, and ignores them on write).

Optional and null, in the table schemas (`{Name}Read` / `{Name}Write`): a property listed in `required` is `name: T`; any other is `name?: T | null`; `id` is never optional in `{Name}Read`. In every other schema, optional follows `required` and `| null` comes only from `nullable: true` or a `'null'` type.

### What the backend schema can and cannot tell (checked in `OpenApiService.php` 601-800)

- **`required` means "non-nullable column"** (`OpenApiService` lines 625, 728, 783), and `id`, `created_at`, `updated_at`, `deleted_at` are never required. The backend emits no `nullable` marker, so every column outside `required` may be `null`. typegen therefore emits it as `notes?: string | null`: reads must handle `null`, and `patch(id, { notes: null })` (clearing a column) type-checks. This is approximate in the safe direction (spec §5.6): the type can be wider than the column (for example the optional uuid `id` of a write type, which is never sent as `null`), never narrower, except where the document itself is wrong (driver type mapping, below).
- **`id`** is never in `required` but is always on a row, so it is non-optional in `{Name}Read` (`api.table('invoices').get(row.id)` needs no `!`). In `{Name}Write` it is omitted with integer ids and optional with uuid ids.
- **`{Name}Read` leaves out `created_at`, `updated_at`** (and `deleted_at`, and `columnHiddens` columns); typegen adds the two timestamps back from the full `{Name}` schema when it has them. `{Name}Write` leaves out the timestamps and, with integer ids, `id`.
- **Computed attributes are not marked, and are not in the schema at all.** The schemas are built from the table's columns only; model accessors / appended attributes do not appear, and nothing flags them. So typegen cannot mark them: a computed attribute is returned only when named in `select` (`*` does not include it), and you add it to your own type (`InvoicesRead & { balance: number }`) and list it in `select`.
- **Column types follow the database driver.** The mapping is by type-name prefix (MySQL names map best). For example a Postgres `boolean` or `timestamp without time zone` column is documented as a plain `string`, a MySQL `tinyint(1)` as `boolean`. typegen reproduces whatever the document says.
- **PATCH.** Hosts before 0.5.06 documented no `PATCH` operation (L13). The generated types do not depend on it: `api.table(name).patch()` always takes `Partial<{Name}Write>`.

### Typing glue (`createApi<Tables>()`)

`createApi<T>(cfg)` and `Api<T>` take an optional tables type; `api.table(name)` has two overloads: a name in `T` gives `Table<T[name]['read'], T[name]['write']>`, anything else (or an explicit generic, `api.table<Row>('x')`) gives `Table<Row>` as before. `Table<T, W = T>` gained a second, defaulted parameter for the write type: `create`, `update`, `patch` and `upsert` take `Partial<W>`, reads return `T`. Existing code (`Table<Row>`, `api.table<Row>(name)`) is unchanged, and a typed client still works with every module.

Limits:

- With `createApi<Tables>()`, a table name that is **not** in `Tables` (a typo, or a table added after generation) is not a compile error: it falls back to the untyped overload and gives `Table<unknown>`. Regenerate after the host's tables change.
- The modules type rows with the read type only: they take a `Table<T>` (or the `Api`) and use `Partial<T>` for writes, so `bulk(api.table('invoices')).create(rows)` takes `Partial<InvoicesRead>[]`, not the write type. The write type is not threaded through the modules.
