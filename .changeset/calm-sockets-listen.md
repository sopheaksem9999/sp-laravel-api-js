---
'@sopheak/sp-laravel-api': minor
---

Add the `@sopheak/sp-laravel-api/realtime` subpath module. `realtime(api)` is transport-free: `handler({ onChange })` turns a `RecordMutated` broadcast payload into `{ table, action, record, queryKey }` (`queryKey` is `api.keys.table(table)`, for `queryClient.invalidateQueries`), ignores malformed payloads and unknown actions, and never throws (an `onChange` that throws is swallowed and reported through `onEvent` as `realtime_handler_error`). `channelName(tenantId)` gives `tenant.{id}` / `tenant.global` and `eventName(table, action)` gives `{table}.{action}`. Bulk upsert broadcasts once, batched, as `upserted`. The README shows Laravel Echo wiring for Vue and React.
