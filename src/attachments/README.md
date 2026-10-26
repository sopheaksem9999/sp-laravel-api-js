# `@sopheak/sp-laravel-api/attachments`

Upload files, clone temp files, build view/download URLs, link attachments to records and manage folders. Direct and multipart (large file) upload are not in this release.

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

- All calls here are feature routes, so a 404 becomes `code: 'module_disabled'` (the host has `attachments` off). There is no lookup-by-id call in this module; a missing target record on `forRecord(...)` also answers 404 and is reported the same way, so check the message (`Target record not found`) in `error.message` to tell them apart.
- 410: a temp attachment has expired (`cloneTemp` of an expired file). Surfaces with `status: 410`.
- 409: `folders.remove` on a folder that is not empty. Surfaces with `status: 409` (`code: 'unknown'`).
- 422: validation failures (size, visibility, missing file) with `fieldErrors`.
