---
'@sopheak/sp-laravel-api': minor
---

Add the `@sopheak/sp-laravel-api/bulk` subpath module: `bulk(table)` with `create`, `update`, `delete`, `upsert` and `mixed`, automatic chunking (`chunkSize`, `concurrency`), `async` queueing and `signal` abort. `SpApiError` gains an optional `completedChunks` set when a chunked call fails part-way. The build now splits shared code so `instanceof SpApiError` holds across entries in CJS.
