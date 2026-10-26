# `@sopheak/sp-laravel-api/bulk`

Bulk create, update, delete, upsert and mixed writes for one table, with automatic chunking.

```ts
import { createApi } from '@sopheak/sp-laravel-api';
import { bulk } from '@sopheak/sp-laravel-api/bulk';

const api = createApi({ baseUrl: 'https://host.example/api' });
const invoices = bulk(api.table<Invoice>('invoices'));

const r = await invoices.create(rows); // 2,500 rows -> 3 requests (1000 / 1000 / 500)
if (!('queued' in r)) console.log(r.affected, r.rows);

await invoices.update([{ id: 1, status: 'paid' }]);
await invoices.delete([1, 2, 3]);                   // ids ...
await invoices.delete([{ id: 4 }, { id: 5 }]);      // ... or rows carrying the primary key
await invoices.upsert(rows, { matchOn: ['number'] }); // -> { count }
await invoices.mixed({ create: newRows, update: changed, delete: [9] });
```

Every call goes through `table.api.request`, so auth, the tenant header, request ids and `SpApiError` all behave as in the core. Errors carry `module: 'bulk'`; a 404 on a bulk route (the host has `bulk_operations` off) becomes `code: 'module_disabled'`.

## Backend contract (verified against `sp-laravel-api` source, `HasBulkOperations.php`, `RecordService::bulkRecord`, `routes/api.php`)

| Method | Route | Notes |
|---|---|---|
| `create` | `POST {table}/bulk/create` | rows must NOT carry the primary key |
| `update` | `POST {table}/bulk/update` | every row needs the primary key plus at least one field |
| `delete` | `POST {table}/bulk/delete` | body is a list of ids (rows are reduced to their primary key) |
| `upsert` | `POST {table}/bulk/upsert?match_on=a,b` | every row must contain the `match_on` columns |
| `mixed` | `POST {table}/bulk` | the legacy dispatcher, see below |

The body is always a bare JSON array. (The backend also accepts a single object, `{data: [...]}` and `{items: [...]}`; this client never sends them.)

Routes only exist when the host config `record.bulk_operations` is true.

### The `mixed` body shape

`POST {table}/bulk` takes a bare array of rows. The backend decides the operation per row: an explicit `operation` field (`'create' | 'update' | 'delete' | 'upsert'`) wins; otherwise it infers it: no primary key means create, primary key plus other fields means update, primary key alone means delete. `mixed({ create, update, delete })` tags every row with `operation` explicitly (create rows, then update rows, then `{ [pk]: id, operation: 'delete' }` rows, in that order) so nothing is inferred. The whole request is one transaction.

Quirks of the mixed route, read from `RecordService::bulkRecord`:

- The response `data` holds created, updated and upserted rows only. Deleted rows are **not** returned and are **not** counted: `meta.affected` is the number of returned rows. A mixed result's `rows`/`affected` therefore exclude deletes.
- `mixed` does not support `?async=1` (there is no async branch on the route), so `async: true` is rejected with `unencodable_value`.
- It requires the three of create, update and delete to be enabled for the table, and checks all three permissions.
- The limit on that route is a 413 ("Batch too large"), not a 422.

## Results

- `create` / `update`: the backend answers `data: [<rows>]` and `meta.affected`. Rows from every chunk are concatenated in the original order and `affected` is the sum of `meta.affected` (falls back to the number of rows returned). `update` returns only rows that changed.
- `delete`: `rows` is `[{ [pk]: id }]` for each record actually deleted (ids that did not exist are skipped); `affected` the count.
- `upsert`: `{ count }`, summed across chunks. Bulk upsert is one `INSERT ... ON CONFLICT` statement: it runs **no per-row hooks, triggers, audit rows or per-record broadcasts**; realtime clients hear one batched `upserted` event with the match keys (spec section 11 L12). Because the backend has no async branch for it, `async` is ignored by `upsert`.
- Empty input resolves `{ rows: [], affected: 0 }` (`{ count: 0 }` for upsert) without any request.
- A body-less or 204 response is tolerated and counts as zero rows.

## Chunking and limits

More than `chunkSize` items (default 1000, the backend default of `record.bulk_max`) are split into chunks sent sequentially (`concurrency: 1`). With `concurrency: n` up to n chunks are in flight at once; results are still concatenated in the original order. `chunkSize` must be a positive integer; if it exceeds the host's `bulk_max` the host answers 422 for that chunk. Set it to match a host that lowered `bulk_max`.

**Each chunk is its own transaction on the backend.** If chunk 2 fails, chunk 1 stays committed. The client stops (no further chunks are started, in-flight ones are aborted) and throws the failing chunk's `SpApiError` with `error.completedChunks` set to the number of chunks that succeeded. Use that to resume from `completedChunks * chunkSize` (with `concurrency: 1`; with higher concurrency in-flight chunks may also have succeeded, so completed chunks are not necessarily a prefix).

`signal` aborts the whole call: no further chunks start and the promise rejects with the abort reason.

## Async

`{ async: true }` sends `?async=1`. The backend queues the work and answers `202 { status: 'queued' }` with **no job id**, so the result is `{ queued: true }` (for chunked input every chunk is queued first). Completion can only be observed through realtime events or by re-reading the table; a future job handle is tracked as LF1. Async applies to `create`, `update` and `delete`.
