# `@sokpheak/sp-laravel-api/logging`

Optional, redacted request logging. Off by default; silent unless a client is given a logger. The package never writes output itself: the sink is yours.

```ts
// typecheck
import { createApi } from '@sokpheak/sp-laravel-api';
import { createLogger } from '@sokpheak/sp-laravel-api/logging';

const api = createApi({
  baseUrl: 'https://api.example.com/api/v2',
  logger: createLogger({ sink: (entry) => console.log(entry), mode: 'perRequest' }),
});
await api.table('invoices').list({}, { log: { bodies: true } });
```

`createLogger({ sink, mode?, maxBodyLength? })`: `mode` is `'perRequest'` (default: only calls with `log` are logged; an unknown value also means this), `'all'` or `'off'`; `maxBodyLength` is the longest body kept (default 2048).

A hand-written `RequestLogger` (`{ start(ctx) { return { finish(attempt) { ... } } } }`) is also accepted. Its `finish` runs inline, once per attempt, and must not return a promise: nothing awaits it, so a rejection would be unhandled. A `start` or `finish` that throws is ignored and never changes the request result, retries included. See the main README ("Request logging") for the entry shape and caveats.

Redaction rules (they cannot be switched off; the shared fixture `test/vectors/log-redaction.json` is the reference):

- Header values are `<redacted>` for `Authorization`, `Cookie`, `Set-Cookie`, `X-CSRF-Token`, the tenant header, and any name containing `auth`, `token`, `key`, `secret`, `cookie`, `session`, `csrf`, `xsrf`, `password`, `credential`, `signature`, `pass`, `otp`, `jwt` or `bearer`. `Location`, `Content-Location`, `Referer` and `Origin`, each `<...>` URL of `Link` and the `url=` part of `Refresh` go through the URL rule.
- Body and query keys are compared lower-cased with `-` and `_` removed. Sensitive: exactly `password`, `secret`, `code`, `otp`, `jwt`, `token`, `apikey`, `accesstoken`, `refreshtoken`, `pin`, `pwd`, `pass`, `sig`, `authorization`, `cookie`; or ending in `(tokens?|secrets?|passwords?|passwd|passphrase|passcode|apikeys?|privatekey|secretkey|clientkey|signingkey|encryptionkey|signature|credential|otp|(otp|verification|auth|mfa|reset|recovery|backup)codes?)`; or starting with `password`. The whole value is replaced, at any depth and inside arrays.
- URLs: sensitive query values and fragment `key=value` values are replaced (a key is also sensitive when a `[bracket]` segment or a comma-separated `anyOf` part is); a filter group (`or`, `and`, `not.or`, `not.and`) or a `select` embed filter (`rel(cols,col=op.value)`) naming a sensitive column, at any depth, is replaced whole; credentials in the authority are replaced. Paths are kept verbatim.
