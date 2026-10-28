---
"@sokpheak/sp-laravel-api": minor
---

Added: `api.rpc` and `api.fn` accept a `query` option (a `URLSearchParams` or a plain record; null/undefined entries are skipped, booleans become `'true'`/`'false'`, and no `per_page` is added). `api.request` gains `responseType: 'blob' | 'arrayBuffer'`, which returns the raw body without envelope parsing. `attachments(api)` gains `viewBytes(id, options?)` and `viewBlob(id, options?)`: an authenticated `GET sp_attachments/{rpc}/{id}/view` that returns the exact bytes, so private images can be fetched with the client's auth and tenant headers.
