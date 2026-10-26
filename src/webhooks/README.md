# `@sopheak/sp-laravel-api/webhooks`

Two halves in one subpath: **admin** for the three webhook tables, and **receiver helpers** that verify and read a delivery on any server runtime (Node 20+, Deno, Bun, Workers, Vercel Edge). Everything uses Web Crypto; there is no `node:` import and the receiver helpers make no network call.

## Receiver

```ts
import { verifyWebhook, parseWebhook } from '@sopheak/sp-laravel-api/webhooks';

// Express: receive Laravel webhooks (raw body)
app.post('/hooks/laravel', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!(await verifyWebhook(req.body, req.get('X-Webhook-Signature'), process.env.SP_WEBHOOK_SECRET!)))
    return res.status(401).end();
  const { table, action, record } = parseWebhook({ headers: req.headers, rawBody: req.body });
  res.status(204).end();
});
```

- `verifyWebhook(rawBody, signatureHeader, secret): Promise<boolean>`: `rawBody` is a `string` or `Uint8Array` (a Node `Buffer` is one). Uses `crypto.subtle.verify('HMAC', ...)`, which compares in constant time, so the result is async. It returns `false` and never throws for a missing, empty, non-hex, odd-length, wrong-length or whitespace-padded header, an empty secret, or a body that is not a string or `Uint8Array`. Hex digits may be upper or lower case.
- `parseWebhook({ headers, rawBody })`: `headers` is a Fetch `Headers` or a plain Node object (`req.headers`: lowercase keys, `string | string[] | undefined`; names are matched case-insensitively, arrays use the first value). Returns `{ table, action, record }`. It does **not** verify: call `verifyWebhook` first with the same raw body.
- Bad input (missing or malformed `X-Webhook-Event`, malformed JSON, a body that is not a string or `Uint8Array`) throws `SpApiError` with `code: 'unknown'`, `status: 400`, `module: 'webhooks'` and a fixed message. The body text is never put into the error.

### Use the raw body

The signature is over the exact bytes Laravel sent. A body that a framework parsed and serialised again has different bytes (whitespace, key order, number and unicode formatting) and fails the check. Get the unparsed body per framework:

| Framework | Raw body |
|---|---|
| Express | `express.raw({ type: 'application/json' })` on the webhook route, then `req.body` |
| NestJS | `NestFactory.create(App, { rawBody: true })`, then `req.rawBody` |
| Next.js route handler, SvelteKit `+server.ts`, Astro endpoint, Remix action, Cloudflare Workers | `await request.text()` |
| Nuxt / h3 | `await readRawBody(event)` |

Fastify, Hono, Deno and Bun give you the same thing through their raw-text accessors.

## Admin

```ts
import { webhooks } from '@sopheak/sp-laravel-api/webhooks';

const w = webhooks(api);

const { endpoint, secret } = await w.endpoints.create({ name: 'Billing sync', url: 'https://app.example/hooks/laravel' });
// `secret` is shown ONCE, here. Store it yourself (e.g. SP_WEBHOOK_SECRET): no read returns it again.
await w.subscriptions.create({ endpoint_id: endpoint.id, table_name: 'invoices', event: 'created' }); // '*' matches all
const rotated = await w.endpoints.rotateSecret(endpoint.id); // new secret, shown once
const recent = await w.deliveries.list({ sort: ['-created_at'] }); // read-only
```

- `endpoints`: `list`, `get`, `update`, `patch`, `remove`, `restore` pass through to `sp_webhook_endpoints`; `create` and `rotateSecret` generate secrets (below). A `secret` that an older host still returns is stripped from every result.
- `subscriptions`: full CRUD on `sp_webhook_subscriptions`. `event` is `created | updated | deleted | '*'`, and `table_name` accepts `'*'`.
- `deliveries`: only `list` and `get` exist, at runtime and in the type (`Pick<Table<Delivery>, 'list' | 'get'>`). The backend refuses writes (`isAuthWrite: false`).
- Errors carry `module: 'webhooks'`. The three tables are plain table routes, so with the module off they answer 404, which is `not_found` here (never `module_disabled`); `capabilities(api)` from `@sopheak/sp-laravel-api/docs` is the detector.

### Secret handling (L11)

The backend never generates the secret and never returns it: `secret` is a hidden column on `sp_webhook_endpoints` (`config/sp-webhooks.php:62`, `columnHiddens: ['secret']`), hidden on every read including the create response, and the column is required (`'nullable' => false`, line 52; migration `2024_01_01_000001_create_sp_webhooks_tables.php`). So the client sends it:

- `endpoints.create({ url, name, secret? })` sends the `secret` you pass, or a generated one (32 bytes from `crypto.getRandomValues`, 64 lowercase hex chars, also when `secret` is `''`), and returns `{ endpoint, secret }` once.
- `endpoints.rotateSecret(id)` is `update(id, { secret: <new> })` and returns `{ endpoint, secret }` once. The old secret stops working at once, so update the receiver before or together with the rotation.
- The backend also requires `name` (non-null); omit it and the host answers a 422 `validation` error.
- Keep secrets out of logs and source control.

## Backend contract (verified against `sp-laravel-api` source)

- **Config:** `config/sp-webhooks.php` (merged as `webhooks` in `src/CoreSpLaravelApiProvider.php:71`): `webhooks.enabled` (line 19, env `SP_LARAVEL_API_WEBHOOKS_ENABLED`, default **false**), `queue_name` (line 20), `max_payload_bytes` (line 21, default 1 MiB; a larger payload is not sent and the delivery is `failed` with 413).
- **Events:** only `created`, `updated` and `deleted` fire (`src/Triggers/WebhookTrigger.php:28,36,54`); there is no `restored` event. Changes to `sp_webhook_*` tables never fire webhooks (line 85). Subscriptions match `table_name in (table, '*')` and `event in (action, '*')` (lines 95-98); only endpoints with `is_active = true` get a delivery (lines 107-110).
- **Request:** `POST` to the endpoint URL, `Content-Type: application/json`, headers `X-Webhook-Event: {table}.{action}` and `X-Webhook-Signature` (`src/Jobs/DispatchWebhookJob.php:84-85`), 10 s timeout, 3 tries with 1, 5 and 10 minute back-off, retried on any non-2xx.
- **Signature:** `hash_hmac('sha256', json_encode($payload), $secret)`, lowercase hex, **no prefix** (`DispatchWebhookJob.php:78`). Laravel then posts the same array as JSON, so the signed string equals the sent bytes (read from the code; not yet confirmed against a live host).
- **Body:** the record itself, not a wrapper: the stored row with hidden columns stripped (`WebhookTrigger.php:90`); for `deleted` the previous row. `parseWebhook` therefore returns the parsed body as `record`, and `table` / `action` come from the header, split on the last dot.
- **Deliveries:** `sp_webhook_deliveries.payload` holds `json_encode($payload)` (a JSON string inside the json column); `status` is `pending`, `success` or `failed`; `response_body` holds the receiver's response (or the exception message).
