---
'@sopheak/sp-laravel-api': minor
---

`@sopheak/sp-laravel-api/attachments`: add `uploadDirect` (`create-upload-url` -> PUT to the signed URL, or POST to `complete-upload` on a local disk -> `complete-upload`) and `uploadMultipart` (S3 multipart with `partSize` (default 8 MiB, minimum 5 MiB), `concurrency`, `onProgress`, `signal`, resumable `onState` / `resume`; aborts the remote upload on failure). `upload(file, { strategy })` accepts `'form'` (default, unchanged), `'direct'`, `'multipart'` or `'auto'`. Sources can be `Blob`, `Uint8Array`, `ArrayBuffer`, async iterables and `ReadableStream`. A 404 on the direct upload routes is `module_disabled` with `module: 'attachments.direct_upload'`.
