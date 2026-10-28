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

`createLogger({ sink, mode?, maxBodyLength? })`: `mode` is `'perRequest'` (default: only calls with `log` are logged), `'all'` or `'off'`; `maxBodyLength` is the longest body kept (default 2048). See the main README ("Request logging") for the entry shape, redaction rules and caveats.
