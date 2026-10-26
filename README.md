# @sopheak/sp-laravel-api

Typed JavaScript client for the [`sopheak/sp-laravel-api`](https://packagist.org/packages/sopheak/sp-laravel-api) Laravel package. ESM and CJS, no runtime dependencies, runs in browsers, edge runtimes and Node 20+.

> Status: scaffold. Modules below are added one at a time.

## Install

```sh
npm install @sopheak/sp-laravel-api
```

## Modules

Each module is a function that takes the core client. Import only what you use; bundlers drop the rest.

| Backend module | Import path | Client provides |
|---|---|---|
| Records, functions | `@sopheak/sp-laravel-api` (core) | `createApi`, `table()`, query serializer, pages, `iterate`, errors, `api.fn()`, `api.rpc()` |
| `bulk_operations` | `@sopheak/sp-laravel-api/bulk` | `bulk(api.table('x'))` create / update / delete / upsert / mixed |
| `attachments` | `@sopheak/sp-laravel-api/attachments` | upload, direct and multipart upload, view and download URLs, folders |
| `audit` | `@sopheak/sp-laravel-api/audit` | list, stats, field timeline, field stats |
| `permissions` | `@sopheak/sp-laravel-api/permissions` | roles, permissions, assign, detach |
| `webhooks` | `@sopheak/sp-laravel-api/webhooks` | admin endpoints, subscriptions, deliveries; Node receiver `verifyWebhook` |
| Broadcasting | `@sopheak/sp-laravel-api/realtime` | change handler, channel and event names for Echo |
| `api_docs` | `@sopheak/sp-laravel-api/docs` and CLI `sp-laravel-api typegen` | OpenAPI, llms.txt, capabilities, type generation |

## Backend compatibility

| `@sopheak/sp-laravel-api` | `sopheak/sp-laravel-api` (Laravel) |
|---|---|
| `0.1` | `^0.5.06` |

## License

MIT. Copyright (c) 2026 Sem Sopheak.
