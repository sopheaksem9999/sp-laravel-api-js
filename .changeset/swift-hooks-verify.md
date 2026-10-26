---
'@sopheak/sp-laravel-api': minor
---

Add the `@sopheak/sp-laravel-api/webhooks` subpath module. Receiver helpers that need no network and no `node:` import: `verifyWebhook(rawBody, signatureHeader, secret)` (hex HMAC-SHA256 of the raw body through `crypto.subtle.verify`; returns `false`, never throws, on a bad or missing header) and `parseWebhook({ headers, rawBody })` (Fetch `Headers` or Node-style headers; returns `{ table, action, record }`; bad input throws `SpApiError` `unknown` / 400 with a fixed message). Admin: `webhooks(api)` with `endpoints` (the backend never returns or generates the `secret`: `create` generates a 32-byte hex secret when none is passed and returns `{ endpoint, secret }` once, `rotateSecret(id)`, and `secret` is stripped from every result), `subscriptions` (CRUD) and read-only `deliveries`.
