import type { Api } from '../core/create-api';
import { SpApiError } from '../core/errors';
import type { Where } from '../core/query-types';

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

/** Links for one record. */
export interface RecordAttachments {
  list(o?: { collection?: string; signal?: AbortSignal }): Promise<AttachmentLink[]>;
  /** Links one or more attachments. One request on backend >= 0.5.06; one request per id with `quoting: false`. */
  link(ids: AttachmentId | AttachmentId[], o?: { collection?: string; signal?: AbortSignal }): Promise<AttachmentLink[]>;
  unlink(attachmentId: AttachmentId, o?: { collection?: string; signal?: AbortSignal }): Promise<void>;
}

/** Folder calls. */
export interface AttachmentFolders {
  /** Filters are serialised with operators (`parent_id=eq.1`); a bare value means `eq`. */
  list(where?: Where, o?: { signal?: AbortSignal }): Promise<AttachmentFolder[]>;
  create(b: AttachmentFolderInput & { name: string }, o?: { signal?: AbortSignal }): Promise<AttachmentFolder>;
  update(id: AttachmentId, b: AttachmentFolderInput, o?: { signal?: AbortSignal }): Promise<AttachmentFolder>;
  /** A 409 (`status 409`) means the folder is not empty. */
  remove(id: AttachmentId, o?: { signal?: AbortSignal }): Promise<void>;
}

/** The attachments module. */
export interface Attachments {
  upload(file: Blob | Uint8Array, o?: UploadOptions): Promise<Attachment>;
  cloneTemp(id: AttachmentId, o?: CloneTempOptions): Promise<Attachment>;
  /** Builds `{baseUrl}/sp_attachments/{rpc}/{id}/view?...`; no network call. */
  viewUrl(id: AttachmentId, o?: ViewUrlOptions): string;
  /** Builds `{baseUrl}/sp_attachments/{rpc}/{id}/download`; no network call. */
  downloadUrl(id: AttachmentId): string;
  forRecord(table: string, id: AttachmentId): RecordAttachments;
  folders: AttachmentFolders;
}

const seg = (s: string | number): string => encodeURIComponent(String(s));

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
 * All routes are feature routes: a 404 means the host has the module off (`module_disabled`).
 */
export function attachments(api: Api): Attachments {
  const rpc = api.config.rpcPrefix ?? 'rpc';
  const base = api.config.baseUrl.replace(/\/+$/, '');
  /** `sp_attachments/{rpc}/...segments`, each segment encoded; an empty `rpcPrefix` has no segment. */
  const path = (...segs: Array<string | number>): string =>
    [seg(TABLE), ...(rpc === '' ? [] : [seg(rpc)]), ...segs.map(seg)].join('/');

  const call = async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    p: string,
    extra: { body?: unknown; query?: URLSearchParams | { where?: Where }; signal?: AbortSignal } = {},
  ): Promise<T> => {
    const r = await api.request<T>({ method, path: p, ...extra, module: MODULE, disabledOn404: true });
    return r.data;
  };

  const collectionQuery = (collection: string | undefined): URLSearchParams | undefined =>
    collection === undefined ? undefined : new URLSearchParams({ collection_name: collection });

  return {
    upload(file, o = {}) {
      const blob = file instanceof Blob ? file : new Blob([file as BlobPart]);
      const fd = new FormData();
      const filename = o.name ?? (typeof File !== 'undefined' && file instanceof File ? file.name : 'file');
      fd.append('file', blob, filename);
      const fields: Record<string, string | undefined> = {
        visibility: o.visibility,
        record_type: o.recordType,
        record_id: str(o.recordId),
        collection_name: o.collection,
      };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, v);
      return call<Attachment>('POST', path('upload'), { body: fd, signal: o.signal });
    },

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
      const q = qs.toString();
      return `${base}/${path(id, 'view')}${q === '' ? '' : `?${q}`}`;
    },

    downloadUrl: (id) => `${base}/${path(id, 'download')}`,

    forRecord(table, recordId) {
      const rp = path('record', table, recordId);
      return {
        list: (o = {}) => call<AttachmentLink[]>('GET', rp, { query: collectionQuery(o.collection), signal: o.signal }),
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
      list: (where, o = {}) =>
        call<AttachmentFolder[]>('GET', path('folders'), { query: where === undefined ? undefined : { where }, signal: o.signal }),
      create: (b, o = {}) => call<AttachmentFolder>('POST', path('folders'), { body: folderBody(b), signal: o.signal }),
      update: (id, b, o = {}) => call<AttachmentFolder>('PUT', path('folders', id), { body: folderBody(b), signal: o.signal }),
      async remove(id, o = {}) {
        await call<unknown>('DELETE', path('folders', id), { signal: o.signal });
      },
    },
  };
}
