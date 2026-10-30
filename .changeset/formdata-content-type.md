---
"@sokpheak/sp-laravel-api": patch
---

A hand-set `Content-Type` on a `FormData` body is now dropped, so the runtime adds `multipart/form-data; boundary=...` itself. A `Content-Type` set by hand (per call, or returned by `auth.getHeaders()`, in any letter case) can never carry the boundary the runtime generates, so those uploads were rejected by the backend. String, `Blob` and `URLSearchParams` bodies keep the `Content-Type` you choose.
