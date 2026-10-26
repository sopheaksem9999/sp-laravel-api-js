---
'@sopheak/sp-laravel-api': minor
---

First feature release (0.1): the core client. `createApi({ baseUrl, rpcPrefix, auth, tenant, ... })` with `table()` (list, get, create, update, patch, remove, restore, upsert, aggregate, cursor `iterate`), `fn()` / `rpc()`, a query serializer (where, or, in, quoting, cursor, always-sent `per_page`, embeds, sorting, search, raw), `keys` for TanStack Query, one `SpApiError` type with codes, per-request timeout, tenant header, `ApiAuth` seam with retry-once on 401, and a README covering quick start, framework glue, server usage and backend compatibility (`^0.5.06`). `table.restore()` resolves `{ restored: number }` (exported as `RestoreResult`), exactly what the backend returns, not the row; call `get(id)` afterwards if you need it. Feature modules (bulk, attachments, audit, permissions, webhooks, realtime, docs) are not in this release.
