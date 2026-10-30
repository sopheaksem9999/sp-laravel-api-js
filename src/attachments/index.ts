import type { Api } from '../core/create-api';
import { SpApiError } from '../core/errors';
import { pathSegment } from '../core/fn';
import { buildPage } from '../core/page';
import type { Page } from '../core/page';
import type { Query, Where } from '../core/query-types';
import { serializeQuery } from '../core/serialize';
import { checkPartSize, directUploads, fileName, toSource } from './multipart';
import type { DirectUploadOptions, MultipartUploadOptions, UploadSource } from './multipart';
import { checkUploadFields, formOnlyFields, sharedFields } from './upload-fields';

export { DEFAULT_PART_SIZE, MAX_PART_SIZE, MAX_PARTS, MIN_PART_SIZE } from './multipart';
export type { DirectUploadOptions, MultipartState, MultipartUploadOptions, UploadProgress, UploadSource } from './multipart';

const MODULE = 'attachments';
const TABLE = 'sp_attachments';

/** Id of an attachment or folder (numeric or uuid, depending on the host's `record.id_type`). */
export type AttachmentId = number | string;

/** An attachment row as returned by the backend (`upload`, `cloneTemp`, link `attachment`). */
export interface Attachment {
  id: AttachmentId;
  /** Stored file name (the backend column is `filename`). */
  filename?: string;
  name?: string;
  title?: string | null;
  caption?: string | null;
  url?: string;
  download_url?: string;
  /** Signed, public URL; present only when the host enables previews. */
  preview_url?: string;
  mime_type?: string;
  size?: number;
  visibility?: string;
  [k: string]: unknown;
}

/** A link between an attachment and a record (`sp_attachment_links`). */
export interface AttachmentLink {
  id: AttachmentId;
  attachment_id: AttachmentId;
  record_type: string;
  record_id: AttachmentId;
  collection_name?: string;
  /** The linked attachment; only on `forRecord(...).list()`. */
  attachment?: Attachment | null;
  [k: string]: unknown;
}

/** An attachment folder (`sp_attachment_folders`). */
export interface AttachmentFolder {
  id: AttachmentId;
  name: string;
  parent_id?: AttachmentId | null;
  scope?: string;
  visibility?: string;
  [k: string]: unknown;
}

/** Writable folder fields (create / update). `name` is required on create. */
export interface AttachmentFolderInput {
  name?: string;
  parent_id?: AttachmentId | null;
  scope?: string;
  visibility?: string;
  owner_type?: string | null;
  owner_id?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

/** Visibility levels the backend accepts. */
export type AttachmentVisibility = 'private' | 'public' | 'temp_private' | 'temp_public';

/** Options for `upload`. The host's size limit (default 10 MB) is enforced by the backend, not here. */
export interface UploadOptions {
  visibility?: AttachmentVisibility;
  /** Table name to link the new attachment to (needs `recordId`). */
  recordType?: string;
  recordId?: AttachmentId;
  /** Link collection name (sent as `collection_name`). */
  collection?: string;
  /** File name sent with the file part. Defaults to the `File` name, or `'file'` for a bare `Blob` / `Uint8Array`. */
  name?: string;
  signal?: AbortSignal;
  /** Sent as `folder_id`. */
  folderId?: AttachmentId;
  /**
   * Sent as `replace_old`: replaces what is linked in the same `collection` (`default` when omitted) of this record. The old
   * links are deleted, and an old attachment's file and row too when no other link uses it. Needs `recordType` and `recordId`
   * (without them the server makes no link and ignores it, so the client throws). Only `true` is sent.
   */
  replaceOld?: boolean;
  title?: string;
  caption?: string;
  /**
   * Sent as `temp_timeout_minutes`: a positive integer, capped by the host's `attachments.max_temp_timeout_minutes`. Only for
   * a temporary upload (`asTemp: true` or a `temp_*` visibility); not together with `tempTimeoutAt`.
   */
  tempTimeoutMinutes?: number;
  /**
   * Sent as `temp_timeout_at`: a string is sent unchanged, a `Date` as `toISOString()`. Only for a temporary upload. The server
   * stores the clock time of the string and drops its offset, so a UTC string is only correct when the host's `app.timezone`
   * is UTC (the Laravel default).
   */
  tempTimeoutAt?: string | Date;
}

/** Options only the form upload can send: the file passes through the server, so it can resize it and mark it temporary. */
export interface FormUploadOptions {
  /** Sent as `w`, a positive integer; the server's own range (10 to 3000) is enforced by the server. */
  width?: number;
  /** Sent as `h`. */
  height?: number;
  fit?: 'crop' | 'contain';
  /** Sent as `size_name`, a key of the host's `attachments.image_sizes`; overrides `w`, `h` and `fit`, so it cannot be combined with them. */
  sizeName?: string;
  /**
   * Sent as `as_temp` (only `true`). The server then replaces a `private` / `public` visibility with its temporary default, so
   * `asTemp: true` with those throws. On `direct` and `multipart` uploads use `visibility: 'temp_private' | 'temp_public'` instead.
   */
  asTemp?: boolean;
}

/** Upload strategy for `upload`. */
export type UploadStrategy = 'auto' | 'form' | 'direct' | 'multipart';

/** Options for `upload`: the form upload by default, or another strategy. */
export interface UploadStrategyOptions extends MultipartUploadOptions, FormUploadOptions {
  /**
   * `'form'` (default): one `multipart/form-data` POST. `'direct'`: `uploadDirect`. `'multipart'`: `uploadMultipart`.
   * `'auto'`: multipart when the size is above `partSize` x 2 (or unknown, for streams); otherwise direct when
   * `directUpload` is true; otherwise the form upload. The backend is never probed to detect direct upload.
   */
  strategy?: UploadStrategy;
  /** For `'auto'`: the host has `direct_upload.enabled`. Overrides the module option. */
  directUpload?: boolean;
}

/** Options for `attachments(api, options)`. */
export interface AttachmentsOptions {
  /** The host has `direct_upload.enabled`; lets `upload(file, { strategy: 'auto' })` pick the direct upload. */
  directUpload?: boolean;
}

/** Options for `cloneTemp`. */
export interface CloneTempOptions {
  visibility?: 'temp_private' | 'temp_public';
  tempTimeoutMinutes?: number;
  recordType?: string;
  recordId?: AttachmentId;
  collection?: string;
  signal?: AbortSignal;
}

/** Resize options for `viewUrl`; the host must have `read_resizing` enabled for them to take effect. */
export interface ViewUrlOptions {
  /** Width, integer 32 to 2000. */
  w?: number;
  /** Height, integer 32 to 2000. */
  h?: number;
  fit?: 'contain' | 'crop';
  format?: 'webp' | 'jpg' | 'png' | 'gif';
}

/** Transport options for `viewBytes` / `viewBlob`. */
export interface ViewFetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Paging for `folders.list` / `folders.listPage`. `per_page` is always sent (this, else `defaults.perPage`, else 25).
 * `cursor: null` (or `''`) asks for the first cursor page (`cursor=0`); `page` is offset mode.
 */
export interface FolderPageOptions {
  perPage?: number;
  cursor?: string | null;
  page?: number;
  signal?: AbortSignal;
}

/** Links for one record. */
export interface RecordAttachments {
  /**
   * Sends `per_page` (spec §10), but the backend ignores the query on this route except `collection_name` and
   * answers at most its `record.default_per_page` links (default 25); there is no way to page further (backend
   * limitation, reported).
   */
  list(o?: { collection?: string; signal?: AbortSignal }): Promise<AttachmentLink[]>;
  /** Links one or more attachments. One request on backend >= 0.5.06; one request per id with `quoting: false`. */
  link(ids: AttachmentId | AttachmentId[], o?: { collection?: string; signal?: AbortSignal }): Promise<AttachmentLink[]>;
  unlink(attachmentId: AttachmentId, o?: { collection?: string; signal?: AbortSignal }): Promise<void>;
}

/** Folder calls. */
export interface AttachmentFolders {
  /**
   * One page of folders as an array (`listPage(...).data`). Filters are serialised with operators
   * (`parent_id=eq.1`); a bare value means `eq`. `per_page` is always sent.
   */
  list(where?: Where, o?: FolderPageOptions): Promise<AttachmentFolder[]>;
  /**
   * One page of folders with its cursors. `next` is set only when the host returns `meta.next_cursor` on a full
   * page; current backends answer folders without `meta`, so page them with `page` (offset) instead.
   */
  listPage(where?: Where, o?: FolderPageOptions): Promise<Page<AttachmentFolder>>;
  create(b: AttachmentFolderInput & { name: string }, o?: { signal?: AbortSignal }): Promise<AttachmentFolder>;
  update(id: AttachmentId, b: AttachmentFolderInput, o?: { signal?: AbortSignal }): Promise<AttachmentFolder>;
  /** A 409 (`status 409`) means the folder is not empty. */
  remove(id: AttachmentId, o?: { signal?: AbortSignal }): Promise<void>;
}

/** The attachments module. */
export interface Attachments {
  /** Form upload by default; see `UploadStrategyOptions.strategy`. A stream source needs another strategy. */
  upload(file: UploadSource, o?: UploadStrategyOptions): Promise<Attachment>;
  /** `create-upload-url` -> PUT to the signed URL (S3) or POST the file to `complete-upload` (local disk) -> `complete-upload`. */
  uploadDirect(file: UploadSource, o?: DirectUploadOptions): Promise<Attachment>;
  /** S3 multipart: `create-multipart-upload` -> per part `sign-multipart-part` + PUT -> `complete-multipart-upload`. */
  uploadMultipart(file: UploadSource, o?: MultipartUploadOptions): Promise<Attachment>;
  cloneTemp(id: AttachmentId, o?: CloneTempOptions): Promise<Attachment>;
  /** Builds `{baseUrl}/sp_attachments/{rpc}/{id}/view?...`; no network call. */
  viewUrl(id: AttachmentId, o?: ViewUrlOptions): string;
  /** Authenticated `GET .../{id}/view`; the exact response bytes (never decoded as text). */
  viewBytes(id: AttachmentId, o?: ViewUrlOptions & ViewFetchOptions): Promise<Uint8Array>;
  /** Like `viewBytes`, as a `Blob`. */
  viewBlob(id: AttachmentId, o?: ViewUrlOptions & ViewFetchOptions): Promise<Blob>;
  /** Builds `{baseUrl}/sp_attachments/{rpc}/{id}/download`; no network call. */
  downloadUrl(id: AttachmentId): string;
  forRecord(table: string, id: AttachmentId): RecordAttachments;
  folders: AttachmentFolders;
}

/** Core `pathSegment`: encodes, and rejects `''`, `.` and `..` (`unencodable_value`) so no request goes to a normalised route. */
const seg = pathSegment;

const bad = (message: string): SpApiError => new SpApiError({ status: 0, code: 'unencodable_value', message, module: MODULE });

function checkDim(name: 'w' | 'h', v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isInteger(v) || v < 32 || v > 2000) throw bad(`attachments.viewUrl: ${name} must be an integer from 32 to 2000`);
}

/** Drops `undefined` values. */
function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Ids go out as strings: the backend validates `record_id`, `parent_id` and attachment ids as strings. */
const str = (v: AttachmentId | undefined): string | undefined => (v === undefined ? undefined : String(v));

function folderBody(b: AttachmentFolderInput): Record<string, unknown> {
  const out = clean({ ...b });
  if (typeof out.parent_id === 'number') out.parent_id = String(out.parent_id);
  return out;
}

/**
 * Attachments for a client: upload, temp clones, URLs, record links and folders. Every call goes through
 * `api.request` (auth, tenant header, `SpApiError`) and errors carry `module: 'attachments'`.
 * A 404 is `module_disabled` only on calls with no lookup target (`upload` without `recordType`, `folders.list`,
 * `folders.create`); on every other call it stays `not_found` (missing record, link, attachment or folder).
 */
export function attachments(api: Api, options: AttachmentsOptions = {}): Attachments {
  const rpc = api.config.rpcPrefix ?? 'rpc';
  const base = api.config.baseUrl.replace(/\/+$/, '');
  /** `sp_attachments/{rpc}/...segments`, each segment encoded; an empty `rpcPrefix` has no segment. */
  const path = (...segs: Array<string | number>): string =>
    [seg(TABLE), ...(rpc === '' ? [] : [seg(rpc)]), ...segs.map(seg)].join('/');

  const call = async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    p: string,
    extra: { body?: unknown; query?: URLSearchParams | { where?: Where }; signal?: AbortSignal } = {},
    feature = false,
  ): Promise<T> => {
    // `feature`: the route has no lookup target, so a 404 can only mean the module is off (`module_disabled`).
    // Otherwise a 404 is a missing record, link, attachment or folder and stays `not_found`.
    const r = await api.request<T>({ method, path: p, ...extra, module: MODULE, disabledOn404: feature });
    return r.data;
  };

  const collectionQuery = (collection: string | undefined): URLSearchParams | undefined =>
    collection === undefined ? undefined : new URLSearchParams({ collection_name: collection });

  /** The core serializer, exactly as `api.request` / `table.list` use it: always adds `per_page`. */
  const serialize = (q: Query): URLSearchParams =>
    serializeQuery(q, { quoting: api.config.quoting ?? true, driver: api.config.driver, defaults: api.config.defaults });

  const folderPage = async (where: Where | undefined, o: FolderPageOptions = {}): Promise<Page<AttachmentFolder>> => {
    const q: Query = { where, perPage: o.perPage, cursor: o.cursor, page: o.page };
    const params = serialize(q);
    const perPage = Number(params.get('per_page'));
    const r = await api.request<AttachmentFolder[]>({
      method: 'GET',
      path: path('folders'),
      query: params,
      signal: o.signal,
      module: MODULE,
      disabledOn404: true,
    });
    return buildPage(r.data, r.meta, {
      perPage: Number.isFinite(perPage) && perPage > 0 ? perPage : Number.POSITIVE_INFINITY,
      offsetMode: o.page !== undefined && o.cursor === undefined,
      wantTotal: params.get('total') === 'true',
    });
  };

  /** Validates the resize options and builds the view query string. */
  const viewQuery = (o: ViewUrlOptions): URLSearchParams => {
    checkDim('w', o.w);
    checkDim('h', o.h);
    if (o.fit !== undefined && o.fit !== 'contain' && o.fit !== 'crop') throw bad('attachments.viewUrl: fit must be "contain" or "crop"');
    if (o.format !== undefined && !['webp', 'jpg', 'png', 'gif'].includes(o.format)) {
      throw bad('attachments.viewUrl: format must be one of webp, jpg, png, gif');
    }
    const qs = new URLSearchParams();
    if (o.w !== undefined) qs.set('w', String(o.w));
    if (o.h !== undefined) qs.set('h', String(o.h));
    if (o.fit !== undefined) qs.set('fit', o.fit);
    if (o.format !== undefined) qs.set('format', o.format);
    return qs;
  };

  const viewFetch = async <T>(id: AttachmentId, o: ViewUrlOptions & ViewFetchOptions, responseType: 'blob' | 'arrayBuffer'): Promise<T> => {
    const query = viewQuery(o);
    const r = await api.request<T>({
      method: 'GET',
      path: path(id, 'view'),
      query,
      signal: o.signal,
      headers: o.headers,
      timeoutMs: o.timeoutMs,
      module: MODULE,
      responseType,
    });
    return r.data;
  };

  const { uploadDirect, uploadMultipart } = directUploads(api, (fn) => path(fn));

  const formUpload = async (file: UploadSource, o: UploadOptions & FormUploadOptions): Promise<Attachment> => {
    checkUploadFields(o, 'form');
    const src = toSource(file);
    if (src === null || src.kind === 'stream') {
      throw bad("attachments.upload: the form upload needs a Blob, Uint8Array or ArrayBuffer; use strategy 'multipart' for streams");
    }
    const blob = src.kind === 'blob' ? src.blob : new Blob([src.bytes as BlobPart]);
    const fd = new FormData();
    fd.append('file', blob, fileName(file, o.name));
    const fields: Record<string, string | undefined> = {
      visibility: o.visibility,
      record_type: o.recordType,
      record_id: str(o.recordId),
      collection_name: o.collection,
    };
    for (const [k, v] of Object.entries({ ...fields, ...sharedFields(o), ...formOnlyFields(o) })) if (v !== undefined) fd.append(k, String(v));
    return call<Attachment>('POST', path('upload'), { body: fd, signal: o.signal }, o.recordType === undefined);
  };

  return {
    async upload(file, o = {}) {
      const strategy = o.strategy ?? 'form';
      if (strategy === 'form') return formUpload(file, o);
      if (strategy === 'direct') return uploadDirect(file, o);
      if (strategy === 'multipart') return uploadMultipart(file, o);
      if (strategy !== 'auto') throw bad("attachments.upload: strategy must be 'auto', 'form', 'direct' or 'multipart'");
      const partSize = checkPartSize(o.partSize);
      const src = toSource(file);
      if (src === null) throw bad('attachments.upload: file must be a Blob, Uint8Array, ArrayBuffer, async iterable or ReadableStream');
      // Resize and `asTemp` need the file to pass through the server: only the form upload can do that, at any size.
      if (o.width !== undefined || o.height !== undefined || o.fit !== undefined || o.sizeName !== undefined || o.asTemp === true) {
        if (src.kind === 'stream') throw bad('attachments.upload: resize options and asTemp need the form upload, which cannot take a stream');
        return formUpload(file, o);
      }
      if (src.size === null || src.size > partSize * 2) return uploadMultipart(file, o);
      if ((o.directUpload ?? options.directUpload) === true) return uploadDirect(file, o);
      return formUpload(file, o);
    },

    uploadDirect,
    uploadMultipart,

    cloneTemp(id, o = {}) {
      const body = clean({
        attachment_id: String(id),
        visibility: o.visibility,
        temp_timeout_minutes: o.tempTimeoutMinutes,
        record_type: o.recordType,
        record_id: str(o.recordId),
        collection_name: o.collection,
      });
      return call<Attachment>('POST', path('clone-temp'), { body, signal: o.signal });
    },

    viewUrl(id, o = {}) {
      const q = viewQuery(o).toString();
      return `${base}/${path(id, 'view')}${q === '' ? '' : `?${q}`}`;
    },

    async viewBytes(id, o = {}) {
      return new Uint8Array(await viewFetch<ArrayBuffer>(id, o, 'arrayBuffer'));
    },

    viewBlob: (id, o = {}) => viewFetch<Blob>(id, o, 'blob'),

    downloadUrl: (id) => `${base}/${path(id, 'download')}`,

    forRecord(table, recordId) {
      const rp = path('record', table, recordId);
      return {
        list: (o = {}) => {
          // per_page always (spec §10); the backend ignores it here and caps at its default page size.
          const query = serialize({});
          if (o.collection !== undefined) query.set('collection_name', o.collection);
          return call<AttachmentLink[]>('GET', rp, { query, signal: o.signal });
        },
        async link(ids, o = {}) {
          const list = (Array.isArray(ids) ? ids : [ids]).map(String);
          if (list.length === 0) return [];
          const collection = o.collection === undefined ? {} : { collection_name: o.collection };
          if (api.config.quoting === false) {
            // Hosts older than 0.5.06 only accept a single `attachment_id` per call.
            const links: AttachmentLink[] = [];
            for (const id of list) {
              links.push(await call<AttachmentLink>('POST', rp, { body: { attachment_id: id, ...collection }, signal: o.signal }));
            }
            return links;
          }
          return call<AttachmentLink[]>('POST', rp, { body: { attachment_ids: list, ...collection }, signal: o.signal });
        },
        async unlink(attachmentId, o = {}) {
          await call<unknown>('DELETE', `${rp}/${seg(attachmentId)}`, { query: collectionQuery(o.collection), signal: o.signal });
        },
      };
    },

    folders: {
      list: async (where, o = {}) => (await folderPage(where, o)).data,
      listPage: (where, o = {}) => folderPage(where, o),
      create: (b, o = {}) => call<AttachmentFolder>('POST', path('folders'), { body: folderBody(b), signal: o.signal }, true),
      update: (id, b, o = {}) => call<AttachmentFolder>('PUT', path('folders', id), { body: folderBody(b), signal: o.signal }),
      async remove(id, o = {}) {
        await call<unknown>('DELETE', path('folders', id), { signal: o.signal });
      },
    },
  };
}
