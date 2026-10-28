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
- URLs: sensitive query values and fragment `key=value` values are replaced (a key is also sensitive when a part split on `[`, `]`, `,` or `.` is: `user[password]`, `api_token,email`, `sessions.pin`); a filter group (`or`, `and`, `not.or`, `not.and`) whose column path before the operator word has a sensitive segment, or a `select` embed filter (`rel(cols,path=op.value)`) on such a column, at any depth, is replaced whole; credentials in the authority are replaced; a value holding a URL (`redirect=https://...`) is redacted as a URL, up to 2 levels deep; percent-decoding is tolerant (invalid escapes and raw non-ASCII are kept, the rest decoded). Paths are kept verbatim.
- Bodies: only plain data is walked; any other object (class instance, model with `toJSON`, `Map`, `Set`, `Date`) is `<object>`; a body nested more than 100 levels is `<unavailable>`; a text body is parsed as JSON after whitespace, BOM and NBSP are trimmed.
- This is a denylist of key names, not a guarantee: do not log the bodies or URLs of sensitive endpoints in production.
