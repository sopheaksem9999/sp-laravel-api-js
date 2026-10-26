# `@sopheak/sp-laravel-api/audit`

Read the host's audit log: the `sp_audit_logs` table plus the `stats`, `field-timeline` and `field-stats` functions.

```ts
// typecheck
import { createApi } from '@sopheak/sp-laravel-api';
import { audit } from '@sopheak/sp-laravel-api/audit';

const api = createApi({ baseUrl: 'https://host.example/api', tenant: { header: 'X-Tenant-ID', value: () => tenantId } });
const log = audit(api);

// read-only table; embed the related user through select
const page = await log.list({ select: ['*', { user: ['id', 'name'] }], sort: { by: 'created_at', order: 'desc' } });
const s = await log.stats({ startDate: '2026-01-01', entityType: 'invoices', event: 'updated' });
// { total, by_event: {...}, by_user: {...}, by_entity: {...} }
const history = await log.fieldTimeline('invoices', 42, 'status', { limit: 20 }); // newest first
const summary = await log.fieldStats('invoices', 42, 'status');
```

`audit(api)` exposes only `list`, `stats`, `fieldTimeline` and `fieldStats`. The table is read-only on the backend (`canCreate`, `canUpdate`, `canDelete` all false), so no write methods are offered.

## Backend contract (verified against `sp-laravel-api` source: `config/sp-audit.php`, `AuditLogController`, `AuditLogService`, `routes/api.php`)

| Method | Route | Params |
|---|---|---|
| `list` | `GET sp_audit_logs` | the usual table query; relation `user` (embed it with `select: ['*', { user: [...] }]`; there is no `include` parameter) |
| `stats` | `GET sp_audit_logs/{rpc}/stats` | `start_date`, `end_date`, `user_id`, `entity_type`, `event` (camelCase options are sent as these snake_case names; see the date note below) |
| `fieldTimeline` | `GET sp_audit_logs/{rpc}/field-timeline/{entityType}/{entityId}/{field}` | `limit` (default 50) |
| `fieldStats` | `GET sp_audit_logs/{rpc}/field-stats/{entityType}/{entityId}/{field}` | none |

`{rpc}` is the client's `rpcPrefix` (default `rpc`; omitted when `''`). Each path segment is URL-encoded; an empty, `.` or `..` segment throws `unencodable_value` before any request. `entityId` is `string | number` (uuid entities) and is always sent as a string. `entityType` is a table name or a model class.

`startDate` / `endDate` are passed through as given and compared by the backend against `created_at` (`>=` / `<=`). A date-only `endDate` such as `'2026-01-31'` is read as `2026-01-31 00:00:00`, so events later that day are **excluded**; pass `'2026-01-31 23:59:59'` (or the next day as an exclusive bound) to include the whole day. The client does not rewrite the value.

Results: `stats` is `{ total, by_event, by_user, by_entity }` (counts keyed by event, user id, entity type). `fieldTimeline` is a list of `{ audit_log_id, event, user_id, created_at, old_value, new_value }`, newest first, holding only events where the field really changed (or was set on creation). `fieldStats` is `{ total_changes, changed_by_users, value_frequency, current_value, first_changed_at, last_changed_at }`. A field the host hides or excludes from auditing yields an empty timeline / zeroed stats, not an error.

Code differs from the brief in one place: the backend route needs `entityId` for `fieldStats` too (it is not optional), so the signature is `fieldStats(entityType, entityId, field)`.

## Tenancy

The tenant comes from the tenant header configured on the client (`createApi({ tenant })`). **The client never sends a `tenant_id` parameter and the options have no `tenantId` key**; only the documented filters are put on the query, so even a stray key cast in is dropped. With multi-tenancy on, the backend pins every audit read to the header tenant. A missing header is a 422 surfaced as `code: 'tenant_required'`; a `tenant_id` that differs from the header tenant (not possible through this client) is a 403.

## Access and errors

Every call needs a user allowed by the Gate `manage-audit-logs`: no user is 401 (`unauthenticated`), a user the gate denies is 403 (`forbidden`). `stats`, `fieldTimeline` and `fieldStats` carry `module: 'audit'`.

The audit routes are off by default. A 404 on `stats` / `fieldTimeline` / `fieldStats` (calls with no record lookup) is `code: 'module_disabled'`. `list` is a plain table call (`module` is null); with audit off, the host answers its unknown-table 404, which the core reports as `not_found`. To find out up front whether the host has audit on, use `capabilities(api)` from `@sopheak/sp-laravel-api/docs` (`audit: true | false`).
