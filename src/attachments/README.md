# `@sopheak/sp-laravel-api/attachments`

Upload files (form, direct to storage, or S3 multipart for large files), clone temp files, build view/download URLs, link attachments to records and manage folders.

```ts
import { createApi } from '@sopheak/sp-laravel-api';
import { attachments } from '@sopheak/sp-laravel-api/attachments';

const api = createApi({ baseUrl: 'https://host.example/api' });
const att = attachments(api);

const file = await att.upload(blob, { name: 'photo.png', visibility: 'private' }); // Blob, File or Uint8Array
await att.forRecord('products', 7).link([file.id], { collection: 'gallery' });
const links = await att.forRecord('products', 7).list({ collection: 'gallery' });
await att.forRecord('products', 7).unlink(file.id);

const thumb = att.viewUrl(file.id, { w: 200, fit: 'crop', format: 'webp' }); // string
const dl = att.downloadUrl(file.id);

const folder = await att.folders.create({ name: 'Invoices' });
const children = await att.folders.list({ parent_id: folder.id }); // sent as parent_id=eq.<id>
```

Every call goes through `api.request`, so auth, the tenant header, request ids and `SpApiError` behave as in the core. Errors carry `module: 'attachments'`.

## Backend contract (verified against `AttachmentUploadController.php` and `config/sp-attachments.php`)

The routes are table functions on `sp_attachments`: `{baseUrl}/sp_attachments/{rpcPrefix}/...` (`rpcPrefix: ''` drops that segment).

| Call | Route | Notes |
|---|---|---|
| `upload(file, o)` | `POST …/upload` | `multipart/form-data`: `file`, optional `visibility`, `record_type`, `record_id`, `collection_name`. The client sets no `Content-Type`; the runtime adds the boundary. |
| `cloneTemp(id, o)` | `POST …/clone-temp` | JSON `{ attachment_id, visibility?, temp_timeout_minutes?, record_type?, record_id?, collection_name? }` |
| `forRecord(t, id).list({ collection })` | `GET …/record/{t}/{id}?collection_name=` | returns links, each with an `attachment` |
| `forRecord(t, id).link(ids, { collection })` | `POST …/record/{t}/{id}` | one request `{ attachment_ids: [...], collection_name? }` (backend >= 0.5.06, idempotent per id); with `quoting: false` (older hosts) one `{ attachment_id }` request per id, in order; returns the combined links |
| `forRecord(t, id).unlink(attachmentId)` | `DELETE …/record/{t}/{id}/{attachmentId}` | |
| `folders.list(where)` | `GET …/folders` | filters carry operators; a bare value is sent as `eq` (`parent_id=eq.1`); the backend ignores a literal `parent_id=1` |
| `folders.create(b)` / `update(id, b)` / `remove(id)` | `POST …/folders`, `PUT …/folders/{id}`, `DELETE …/folders/{id}` | `remove` answers 409 when the folder is not empty |

Differences from the older docs: the backend field is `collection_name` (the client option is `collection`); `name` on `upload` is the file name of the multipart part (the backend has no `name` field; it also accepts `title` and `caption`); ids are sent as strings because the backend validates them as strings.

Direct and multipart upload routes are listed under [Direct and multipart upload](#direct-and-multipart-upload).

Limits: the default maximum upload size is 10 MB (`max_upload_size`, a host setting). The client does not check it; an oversize file fails with a 422.

## URLs

`viewUrl(id, { w, h, fit, format })` and `downloadUrl(id)` build `{baseUrl}/sp_attachments/{rpc}/{id}/view|download` locally (no request). `w`/`h` are integers 32 to 2000, `fit` is `contain` or `crop`, `format` is `webp`, `jpg`, `png` or `gif`; anything else throws `SpApiError` with `code: 'unencodable_value'`. Resizing only takes effect when the host enables `read_resizing`. Ids are URL-encoded.

From backend 0.5.06 the `url` / `download_url` fields in responses include the rpc segment and can be used as is; the helpers stay for resize options and older hosts.

Protected files need the auth header, which `<img src>` cannot send. Fetch the URL with the header and use a blob URL:

```ts
const res = await fetch(att.viewUrl(id, { w: 400 }), { headers: await auth.getHeaders() });
img.src = URL.createObjectURL(await res.blob());
```

or use the signed, public `preview_url` when the host enables previews.

## Errors

- 404 depends on the call. Calls with no lookup target are feature routes, so a 404 becomes `code: 'module_disabled'` (the host has `attachments` off): `upload` without `recordType`, `folders.list` and `folders.create`. Lookup-style calls keep `code: 'not_found'`, because the backend answers a plain `{ message }` 404 for a missing target record, attachment, link or folder: `cloneTemp`, `forRecord(...).list/link/unlink`, `folders.update/remove`, and `upload` with `recordType`. A module switched off therefore reads as `not_found` on those calls; do not hide the attachments UI on `not_found`. `capabilities(api)` from `@sopheak/sp-laravel-api/docs` is the reliable way to detect a disabled module (`attachments`, and `directUpload` for direct/multipart uploads).
- 410: a temp attachment has expired (`cloneTemp` of an expired file). Surfaces with `status: 410`.
- 409: `folders.remove` on a folder that is not empty. Surfaces with `status: 409` (`code: 'unknown'`).
- 422: validation failures (size, visibility, missing file) with `fieldErrors`.

## Direct and multipart upload

Both need `attachments.direct_upload.enabled` on the host (off by default). When it is off the backend removes the routes, so a 404 on `create-upload-url` or `create-multipart-upload` (and `sign-multipart-part`) throws `SpApiError` with `code: 'module_disabled'` and `module: 'attachments.direct_upload'`. Every error from these flows carries `module: 'attachments.direct_upload'`; option validation errors carry `module: 'attachments'` and `code: 'unencodable_value'`.

```ts
// Direct: create-upload-url -> PUT to the signed URL (S3/R2) or POST the file (local disk) -> complete-upload
const a = await att.uploadDirect(file, { visibility: 'private', contentType: 'image/png' });

// Multipart (S3/R2 only): create-multipart-upload -> sign-multipart-part + PUT per part -> complete-multipart-upload
const b = await att.uploadMultipart(bigFile, {
  partSize: 8 * 1024 * 1024, // default 8 MiB; integer from 5 MiB (MIN_PART_SIZE) to 5 GiB (MAX_PART_SIZE)
  concurrency: 4,            // default 4
  visibility: 'private',
  signal: controller.signal,
  onProgress: ({ loaded, total }) => render(loaded, total), // total is null for a stream of unknown size
  onState: (s) => localStorage.setItem('upload', JSON.stringify(s)), // after create and after every part
});

// Pick one: 'form' (default, unchanged), 'direct', 'multipart' or 'auto'
await att.upload(file, { strategy: 'auto', directUpload: true });
```

| Call | Route | Body |
|---|---|---|
| `uploadDirect` | `POST …/create-upload-url` | `{ filename, content_type?, visibility, folder_id? }` |
| | `PUT {upload_url}` (S3/R2) | the file, with the `headers` the backend returned; sent with the injected `fetch`, never through `api.request` |
| | `POST …/complete-upload` | JSON `{ key, upload_token, expires_at, filename, content_type?, visibility, folder_id?, record_type?, record_id?, collection_name? }`; on a local disk (`upload_url: null`) the same fields plus `file` as `multipart/form-data` |
| `uploadMultipart` | `POST …/create-multipart-upload` | `{ filename, content_type?, visibility, folder_id? }` -> `{ key, upload_id, upload_token, expires_at, part_size }` |
| | `POST …/sign-multipart-part` | `{ key, upload_id, upload_token, expires_at, part_number, visibility }` -> `{ url, headers }` |
| | `PUT {url}` | the part bytes; the `ETag` response header is collected |
| | `POST …/complete-multipart-upload` | `{ key, upload_id, upload_token, expires_at, parts: [{ part_number, etag }], filename, visibility, folder_id?, record_type?, record_id?, collection_name? }` |
| | `POST …/abort-multipart-upload` | `{ key, upload_id, upload_token, expires_at, visibility }` (on any failure or abort) |

Backend facts (verified against `AttachmentUploadController.php`, `AttachmentPresignService.php` and `config/sp-attachments.php`; the code wins over older docs):

- **Visibility is sent identically on every call.** The upload token is an HMAC over key, disk, tenant, upload id and expiry, and the disk comes from the visibility. A different visibility (or tenant) on a later call fails with 422 "Invalid or expired upload token". The client sends `visibility` (default `'private'`, the backend default) on every call; `abort-multipart-upload` requires it.
- **Local disk.** For a disk without presigned uploads `create-upload-url` answers `upload_url: null`, `method: 'POST'` and a `complete_endpoint`. That endpoint is the backend's own `complete-upload` route; the client posts the file to `…/complete-upload` built from its `baseUrl` (with auth and tenant), not to the server-built absolute URL, so proxies and base paths keep working.
- **Signed URLs.** The PUT goes to the storage host with the runtime's `fetch` (`config.fetch ?? globalThis.fetch`) and only the headers the backend returned (PSR-7 arrays are joined with `, `; `Host` and `Content-Length` are left to the runtime). It never carries `Authorization`, the tenant header or `X-Request-ID`, and has no client timeout (use `signal`).
- **Size limits.** A direct upload is still bounded by `max_upload_size` (default 10 MB): the backend checks the stored object at `complete-upload` and deletes an oversize one (422). Multipart uploads are bounded only by the bucket.
- **Part size.** S3 needs at least 5 MiB per part (except the last), at most 5 GiB per part and at most 10,000 parts; the backend enforces no other limit. The client rejects a `partSize` outside 5 MiB to 5 GiB with `unencodable_value`, and fails a stream that needs more than 10,000 parts: use a larger `partSize` for big streams. `create-multipart-upload` returns `part_size` (the host's `min_multipart_size_bytes`, default 100 MiB, documented as the file size above which multipart is used); the client does not use it and keeps its own `partSize` (default 8 MiB).
- **Expiry.** `expires_at` is an integer unix timestamp in seconds, `presign_ttl_seconds` (default 1800) after creation. The token, and so a resume, stops working after it; `resume` with a state whose `expires_at` is already past fails at once with `unencodable_value`, before any request.
- **404s.** Only the create/sign routes map a 404 to `module_disabled`. `complete-upload` answers 404 "File not found on disk" when the PUT did not land; that stays `not_found`.

### CORS

Browser uploads need a CORS policy on the bucket that allows `PUT` from your origin and **exposes `ETag`** (`"ExposeHeaders": ["ETag"]`). Without it the browser hides the header, and a multipart part fails with `SpApiError` `code: 'unknown'` naming `ExposeHeaders: ETag`. A direct (single PUT) upload does not read the `ETag`.

### Sources and streaming

`file` is a `Blob`/`File`, `Uint8Array` (Node `Buffer` included), `ArrayBuffer`, an async iterable of `Uint8Array` (a Node `Readable` included) or a `ReadableStream<Uint8Array>`. Multipart never buffers the whole file: a `Blob` is sliced per part, bytes are viewed per part, and a stream is re-chunked into exactly `partSize` bytes (the last part may be smaller). At most `concurrency` parts are read and in flight at once, and each part is signed right before its PUT (signed URLs expire). `uploadDirect` sends one body, so it collects a stream into memory first (bounded by `max_upload_size`). The form upload (`upload` without a strategy) takes `Blob`, `Uint8Array` or `ArrayBuffer` only. Progress is reported per completed part.

### Strategy `auto`

`upload(file, { strategy: 'auto' })` uses multipart when the size is above `partSize × 2` (16 MiB by default) or unknown (a stream). Otherwise it uses `uploadDirect` **only when `directUpload: true`** is passed (per call, or `attachments(api, { directUpload: true })`), and otherwise the form upload. The client never probes the backend to find out whether direct upload is on. Without `strategy` (or with `'form'`) `upload` is the form upload, as before.

### Abort, failures and resume

- Any failure (sign, PUT, missing `ETag`, complete) cancels the other in-flight PUTs, calls `abort-multipart-upload` (best effort: its own failure is ignored) and rethrows the original `SpApiError`.
- The cleanup `abort-multipart-upload` call has a 10 s timeout, so it cannot hold the rejection longer than that.
- An `onState` or `onProgress` callback that throws fails the upload the same way (remote upload aborted, the thrown error rethrown).
- Aborting `signal` (also while `create-multipart-upload` is answering) cancels in-flight PUTs, calls `abort-multipart-upload` and rejects with `signal.reason`. **Abort cancels the remote upload**; it is not a pause. To pause, stop the process (or drop the promise) and keep the last `onState` snapshot.
- `onState(state)` receives a copy of `MultipartState = { key, upload_id, upload_token, expires_at, part_size, size, visibility, parts: [{ number, etag }] }` after the upload is created and after every part. Pass it back as `resume` with the same source: parts already in `state.parts` are skipped and only the rest is uploaded. `resume` needs a seekable source (`Blob`, `Uint8Array`, `ArrayBuffer`); a stream throws `unencodable_value`.
- A resume reuses the recorded `part_size` and `visibility`, so the options need not repeat them. Everything that would make the parts not line up is rejected with `unencodable_value` before any request: an explicit `partSize` or `visibility` that differs from the state, a source whose size differs from `state.size` (`null` when the upload started from a stream), duplicate part numbers, or a part number outside `1..ceil(size / part_size)`. Without these checks a different part size would make S3 stitch overlapping byte ranges into a corrupt object.

```ts
const saved = localStorage.getItem('upload');
// part_size and visibility come from the saved state; a mismatching option is rejected.
await att.uploadMultipart(file, {
  resume: saved ? (JSON.parse(saved) as MultipartState) : undefined,
  onState: (s) => localStorage.setItem('upload', JSON.stringify(s)),
});
localStorage.removeItem('upload');
```

**The upload token is a credential.** `upload_token` (with the key and upload id) lets anyone holding it sign parts and complete the upload as your tenant until `expires_at`, and signed URLs grant write access to the bucket. Store `onState` snapshots like a session token and delete them when the upload ends. The client never puts signed URLs or the token in error messages or `cause`; `onState` is the only place the token is handed out.
