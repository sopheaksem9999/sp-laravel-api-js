---
'@sopheak/sp-laravel-api': minor
---

Add the `@sopheak/sp-laravel-api/docs` subpath module and the `sp-laravel-api typegen` CLI. `docs(api)`: `openapi()` (`GET docs/openapi.json`) and `llms()` (`GET docs/llms.txt`, returned as text); private docs (404) are `module_disabled` with `module: 'docs'`. `capabilities(api)` reads the OpenAPI document once (cached per client, `refresh: true` re-reads) and reports `bulk`, `attachments`, `directUpload`, `audit`, `permissions`, `webhooks`, `docs` as booleans and `realtime` as `true | 'unknown'`; it resolves `'unknown'` when the docs are private or the host is unreachable. `sp-laravel-api typegen (--url | --file) --out` (Node 20+) generates an interface per `{Name}Read` / `{Name}Write` schema plus `interface Tables`, deterministically. Core: `createApi<Tables>()` types `api.table('invoices')` without generics (`Table<T, W = T>` gained a defaulted write-type parameter), and requests accept `responseType: 'text'`.
