---
"@sokpheak/sp-laravel-api": minor
---

Added: `api.rpc` and `api.fn` accept a `query` option (a `URLSearchParams` or a plain record; null/undefined entries are skipped, booleans become `'true'`/`'false'`, and no `per_page` is added). `api.request` gains `responseType: 'blob' | 'arrayBuffer'`, which returns the raw body without envelope parsing. `attachments(api)` gains `viewBytes(id, options?)` and `viewBlob(id, options?)`: an authenticated `GET sp_attachments/{rpc}/{id}/view` that returns the exact bytes, so private images can be fetched with the client's auth and tenant headers.

Fixed (patch note): attachment ids, record ids and the `rpcPrefix` now go through the same path-segment guard as `api.rpc`: an empty, `.` or `..` value throws `unencodable_value` with no request sent, instead of being normalised by the URL parser to a different route. Normal ids are encoded as before.
