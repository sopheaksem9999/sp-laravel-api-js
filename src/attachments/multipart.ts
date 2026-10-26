import type { Api } from '../core/create-api';
import { SpApiError } from '../core/errors';
import type { Attachment, AttachmentId, UploadOptions } from './index';

/** S3's minimum part size (every part but the last). The backend enforces no other minimum. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
/** Default multipart part size: 8 MiB (the spec does not fix one; chosen above S3's 5 MiB floor). */
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
/** S3's maximum part size (5 GiB). */
export const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;
/** S3's maximum number of parts per upload. */
export const MAX_PARTS = 10000;
/** Upper bound for the best-effort `abort-multipart-upload` cleanup call. */
const ABORT_CLEANUP_TIMEOUT_MS = 10000;

const MODULE = 'attachments';
const DIRECT_MODULE = 'attachments.direct_upload';

/**
 * A file to upload. `Blob`/`File`, `Uint8Array` (Node `Buffer` included) and `ArrayBuffer` are seekable;
 * an async iterable of bytes (a Node `Readable` included) or a `ReadableStream` is read once, in order.
 */
export type UploadSource = Blob | Uint8Array | ArrayBuffer | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/**
 * Everything needed to resume a multipart upload, as delivered by `onState`. `upload_token` is a credential (it
 * authorises signing and completing parts for this key): store it like a session token.
 *
 * - `expires_at`: unix timestamp in **seconds**, as the backend returns it; a state already past it is rejected.
 * - `part_size`, `size`, `visibility`: recorded so a resume cuts the same byte ranges and sends the same visibility
 *   (the token is bound to the disk). On resume they are the defaults; an explicit, different `partSize` or
 *   `visibility`, or a source of a different size, is rejected with `unencodable_value`. `size` is `null` when the
 *   upload started from a stream.
 */
export interface MultipartState {
  key: string;
  upload_id: string;
  upload_token: string;
  expires_at: number;
  part_size: number;
  size: number | null;
  visibility: string;
  parts: { number: number; etag: string }[];
}

/** Upload progress. `total` is `null` while the size of a stream source is unknown. */
export interface UploadProgress {
  loaded: number;
  total: number | null;
}

/** Options for `uploadDirect`. */
export interface DirectUploadOptions extends UploadOptions {
  /** Sent as `content_type`. Defaults to the `Blob` type when it has one. */
  contentType?: string;
  /** Sent as `folder_id`. */
  folderId?: AttachmentId;
}

/** Options for `uploadMultipart`. */
export interface MultipartUploadOptions extends DirectUploadOptions {
  /**
   * Bytes per part, an integer from 5 MiB (`MIN_PART_SIZE`) to 5 GiB. Default 8 MiB (on resume: `resume.part_size`).
   * At most 10,000 parts: use a larger partSize for big streams.
   */
  partSize?: number;
  /** Parts uploaded at once, a positive integer. Default 4. */
  concurrency?: number;
  /** Called after the upload is created and after every part completes. */
  onProgress?: (p: UploadProgress) => void;
  /** Continue an upload from a saved `onState` snapshot (seekable sources only). */
  resume?: MultipartState;
  /**
   * Receives a fresh copy of the state after the upload is created and after every part completes.
   * A callback that throws fails the upload (the remote upload is aborted), like `onProgress`.
   */
  onState?: (s: MultipartState) => void;
}

interface Part {
  number: number;
  body: Blob | Uint8Array;
  size: number;
}

type Source =
  | { kind: 'blob'; blob: Blob; size: number }
  | { kind: 'bytes'; bytes: Uint8Array; size: number }
  | { kind: 'stream'; open: () => AsyncIterator<Uint8Array>; size: null };

const bad = (message: string): SpApiError => new SpApiError({ status: 0, code: 'unencodable_value', message, module: MODULE });

/** Classifies an upload source; `null` when it is not one. */
export function toSource(file: unknown): Source | null {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return { kind: 'blob', blob: file, size: file.size };
  if (file instanceof ArrayBuffer) return { kind: 'bytes', bytes: new Uint8Array(file), size: file.byteLength };
  if (ArrayBuffer.isView(file)) {
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    return { kind: 'bytes', bytes, size: bytes.byteLength };
  }
  if (typeof file === 'object' && file !== null) {
    const rs = file as ReadableStream<Uint8Array>;
    if (typeof rs.getReader === 'function') {
      return {
        kind: 'stream',
        size: null,
        open: () => {
          const reader = rs.getReader();
          return {
            next: () => reader.read() as Promise<IteratorResult<Uint8Array>>,
            return: async () => {
              await reader.cancel().catch(() => undefined);
              return { done: true, value: undefined };
            },
          };
        },
      };
    }
    const it = file as AsyncIterable<Uint8Array>;
    if (typeof it[Symbol.asyncIterator] === 'function') return { kind: 'stream', size: null, open: () => it[Symbol.asyncIterator]() };
  }
  return null;
}

/** Validates `partSize` (integer from 5 MiB to 5 GiB); returns the default when unset. */
export function checkPartSize(v: number | undefined): number {
  if (v === undefined) return DEFAULT_PART_SIZE;
  if (!Number.isInteger(v) || v < MIN_PART_SIZE || v > MAX_PART_SIZE) {
    throw bad(`attachments: partSize must be an integer from ${MIN_PART_SIZE} (5 MiB) to ${MAX_PART_SIZE} (5 GiB) bytes`);
  }
  return v;
}

function checkConcurrency(v: number | undefined): number {
  if (v === undefined) return 4;
  if (!Number.isInteger(v) || v < 1) throw bad('attachments: concurrency must be a positive integer');
  return v;
}

/**
 * Validates a `resume` state against the call: shape, expiry, part size, visibility, source size and part numbers.
 * Returns the copied state; its `part_size` and `visibility` are the ones to use.
 */
function checkState(s: MultipartState, o: { partSize?: number; visibility?: string }, sourceSize: number): MultipartState {
  const ok =
    typeof s === 'object' &&
    s !== null &&
    typeof s.key === 'string' &&
    typeof s.upload_id === 'string' &&
    typeof s.upload_token === 'string' &&
    typeof s.expires_at === 'number' &&
    Number.isFinite(s.expires_at) &&
    typeof s.part_size === 'number' &&
    (s.size === null || (Number.isInteger(s.size) && s.size >= 0)) &&
    typeof s.visibility === 'string' &&
    Array.isArray(s.parts) &&
    s.parts.every((p) => typeof p === 'object' && p !== null && typeof p.etag === 'string');
  if (!ok) {
    throw bad('attachments: resume must be a MultipartState { key, upload_id, upload_token, expires_at, part_size, size, visibility, parts }');
  }
  if (s.expires_at * 1000 <= Date.now()) throw bad('attachments: resume state has expired (expires_at is past); start a new upload');
  const partSize = checkPartSize(s.part_size);
  if (o.partSize !== undefined && checkPartSize(o.partSize) !== partSize) {
    throw bad(`attachments: partSize ${o.partSize} differs from the resumed upload's part_size ${partSize}`);
  }
  if (o.visibility !== undefined && o.visibility !== s.visibility) {
    throw bad(`attachments: visibility "${o.visibility}" differs from the resumed upload's visibility "${s.visibility}"`);
  }
  if (s.size !== null && s.size !== sourceSize) {
    throw bad(`attachments: the source has ${sourceSize} bytes but the resumed upload has ${s.size}`);
  }
  const count = Math.max(1, Math.ceil(sourceSize / partSize));
  const seen = new Set<number>();
  for (const p of s.parts) {
    if (!Number.isInteger(p.number) || p.number < 1 || p.number > count) {
      throw bad(`attachments: resume part number ${String(p.number)} is outside 1..${count}`);
    }
    if (seen.has(p.number)) throw bad(`attachments: resume part number ${p.number} appears twice`);
    seen.add(p.number);
  }
  return copyState(s);
}

const copyState = (s: MultipartState): MultipartState => ({
  key: s.key,
  upload_id: s.upload_id,
  upload_token: s.upload_token,
  expires_at: s.expires_at,
  part_size: s.part_size,
  size: s.size,
  visibility: s.visibility,
  parts: s.parts.map((p) => ({ number: p.number, etag: p.etag })),
});

/** Default file name: the `File` name, else `'file'`. */
export function fileName(file: unknown, name: string | undefined): string {
  if (name !== undefined) return name;
  if (typeof File !== 'undefined' && file instanceof File && file.name !== '') return file.name;
  return 'file';
}

function blobType(file: unknown): string | undefined {
  return typeof Blob !== 'undefined' && file instanceof Blob && file.type !== '' ? file.type : undefined;
}

function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Re-evaluated at each call site so TypeScript does not narrow `aborted` across awaits. */
const isAborted = (s: AbortSignal | undefined): boolean => s?.aborted === true;

const str = (v: AttachmentId | undefined): string | undefined => (v === undefined ? undefined : String(v));

/** Yields parts in order. Seekable sources are sliced lazily (no copy); streams are re-chunked to exactly `partSize`. */
async function* partsOf(src: Source, partSize: number, skip: ReadonlySet<number>): AsyncGenerator<Part> {
  if (src.kind !== 'stream') {
    const count = Math.max(1, Math.ceil(src.size / partSize));
    for (let n = 1; n <= count; n++) {
      if (skip.has(n)) continue;
      const start = (n - 1) * partSize;
      const end = Math.min(src.size, start + partSize);
      const body = src.kind === 'blob' ? src.blob.slice(start, end) : src.bytes.subarray(start, end);
      yield { number: n, body, size: end - start };
    }
    return;
  }
  const it = src.open();
  const buf: Uint8Array[] = [];
  let len = 0;
  let n = 0;
  const take = (k: number): Uint8Array => {
    const out = new Uint8Array(k);
    let off = 0;
    while (off < k) {
      const c = buf[0]!;
      const need = k - off;
      if (c.byteLength <= need) {
        out.set(c, off);
        off += c.byteLength;
        buf.shift();
      } else {
        out.set(c.subarray(0, need), off);
        buf[0] = c.subarray(need);
        off = k;
      }
    }
    len -= k;
    return out;
  };
  let finished = false;
  try {
    for (;;) {
      const r = await it.next();
      if (r.done === true) break;
      const chunk: unknown = r.value;
      if (!(chunk instanceof Uint8Array)) throw bad('attachments: a stream source must yield Uint8Array chunks');
      if (chunk.byteLength === 0) continue;
      buf.push(chunk);
      len += chunk.byteLength;
      while (len >= partSize) yield { number: ++n, body: take(partSize), size: partSize };
    }
    finished = true;
    if (len > 0 || n === 0) {
      const size = len;
      yield { number: ++n, body: take(size), size };
    }
  } finally {
    if (!finished) await it.return?.().catch(() => undefined);
  }
}

/** Replaces URLs (signed URLs are credentials) in a message. */
const redact = (s: string): string => s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted-url]');

/** Headers the backend asks the client to send to storage. Values may be PSR-7 arrays; Host/Content-Length are set by the runtime. */
function storageHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof h !== 'object' || h === null || Array.isArray(h)) return out;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length') continue;
    if (Array.isArray(v)) out[k] = v.map(String).join(', ');
    else if (v !== null && v !== undefined) out[k] = String(v);
  }
  return out;
}

interface CreateUploadUrlResult {
  key: string;
  upload_url: string | null;
  headers?: unknown;
  method?: string;
  upload_token: string;
  expires_at: number;
  complete_endpoint?: string;
}

interface CreateMultipartResult {
  key: string;
  upload_id: string;
  upload_token: string;
  expires_at: number;
}

interface SignedPart {
  url: string;
  headers?: unknown;
}

/** Direct (presigned PUT, or local POST) and S3 multipart upload for `attachments(api)`. */
export function directUploads(api: Api, path: (fn: string) => string) {
  const call = async <T>(fn: string, body: unknown, signal: AbortSignal | undefined, feature: boolean, timeoutMs?: number): Promise<T> => {
    // `feature`: create/sign routes have no lookup target; their only 404 is "direct upload disabled".
    const r = await api.request<T>({ method: 'POST', path: path(fn), body, signal, module: DIRECT_MODULE, disabledOn404: feature, timeoutMs });
    return r.data;
  };

  /** Sends bytes to a signed storage URL with the injected fetch: no auth, tenant or request-id headers. */
  const storagePut = async (
    url: string,
    method: string,
    headers: unknown,
    body: Blob | Uint8Array,
    signal: AbortSignal | undefined,
    what: string,
  ): Promise<Response> => {
    const doFetch = api.config.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(url, { method, headers: storageHeaders(headers), body: body as BodyInit, signal });
    } catch (e) {
      if (signal?.aborted === true) throw signal.reason;
      const cause = new Error(redact(e instanceof Error ? e.message : String(e)));
      if (e instanceof Error) cause.name = e.name;
      throw new SpApiError({ status: 0, code: 'network', message: `Storage upload (${what}) failed: network error`, module: DIRECT_MODULE, cause });
    }
    if (!res.ok) {
      // The storage body (e.g. an S3 error document) may echo the signature; it is not kept.
      await res.body?.cancel().catch(() => undefined);
      throw new SpApiError({
        status: res.status,
        code: res.status >= 500 ? 'server' : 'unknown',
        message: `Storage upload (${what}) failed with status ${res.status}`,
        module: DIRECT_MODULE,
      });
    }
    return res;
  };

  async function uploadDirect(file: UploadSource, o: DirectUploadOptions = {}): Promise<Attachment> {
    const src = toSource(file);
    if (src === null) throw bad('attachments.uploadDirect: file must be a Blob, Uint8Array, ArrayBuffer, async iterable or ReadableStream');
    if (o.signal?.aborted === true) throw o.signal.reason;
    let body: Blob | Uint8Array;
    if (src.kind === 'blob') body = src.blob;
    else if (src.kind === 'bytes') body = src.bytes;
    else {
      // A single PUT needs the whole body; direct uploads are bounded by the host's max_upload_size.
      const chunks: Uint8Array[] = [];
      for await (const p of partsOf(src, Number.MAX_SAFE_INTEGER, new Set())) chunks.push(p.body as Uint8Array);
      body = chunks[0] ?? new Uint8Array(0);
    }
    const filename = fileName(file, o.name);
    const contentType = o.contentType ?? blobType(file);
    const visibility = o.visibility ?? 'private';
    const folderId = str(o.folderId);
    const created = await call<CreateUploadUrlResult>(
      'create-upload-url',
      clean({ filename, content_type: contentType, visibility, folder_id: folderId }),
      o.signal,
      true,
    );
    const fields = clean({
      key: created.key,
      upload_token: created.upload_token,
      expires_at: created.expires_at,
      filename,
      content_type: contentType,
      visibility,
      folder_id: folderId,
      record_type: o.recordType,
      record_id: str(o.recordId),
      collection_name: o.collection,
    });
    if (typeof created.upload_url === 'string' && created.upload_url !== '') {
      await storagePut(created.upload_url, created.method ?? 'PUT', created.headers, body, o.signal, 'direct');
      return call<Attachment>('complete-upload', fields, o.signal, false);
    }
    // Local / non-S3 disk: the backend answers `upload_url: null` and a `complete_endpoint` (its own
    // `complete-upload` route); the file is posted there through the API with the token fields.
    const fd = new FormData();
    fd.append('file', body instanceof Blob ? body : new Blob([body as BlobPart]), filename);
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    return call<Attachment>('complete-upload', fd, o.signal, false);
  }

  async function uploadMultipart(file: UploadSource, o: MultipartUploadOptions = {}): Promise<Attachment> {
    const concurrency = checkConcurrency(o.concurrency);
    const src = toSource(file);
    if (src === null) throw bad('attachments.uploadMultipart: file must be a Blob, Uint8Array, ArrayBuffer, async iterable or ReadableStream');
    if (o.resume !== undefined && src.kind === 'stream') {
      throw bad('attachments.uploadMultipart: resume needs a seekable source (Blob, Uint8Array or ArrayBuffer)');
    }
    const resumed = o.resume === undefined || src.size === null ? null : checkState(o.resume, o, src.size);
    const partSize = resumed?.part_size ?? checkPartSize(o.partSize);
    if (src.size !== null && Math.ceil(src.size / partSize) > MAX_PARTS) {
      throw bad(`attachments.uploadMultipart: more than ${MAX_PARTS} parts; use a larger partSize`);
    }
    if (o.signal?.aborted === true) throw o.signal.reason;

    const visibility = resumed?.visibility ?? o.visibility ?? 'private';
    const filename = fileName(file, o.name);
    const folderId = str(o.folderId);
    const emitState = (s: MultipartState): void => o.onState?.(copyState(s));

    let state: MultipartState;
    if (resumed !== null) state = resumed;
    else {
      const r = await call<CreateMultipartResult>(
        'create-multipart-upload',
        clean({ filename, content_type: o.contentType ?? blobType(file), visibility, folder_id: folderId }),
        o.signal,
        true,
      );
      state = {
        key: r.key,
        upload_id: r.upload_id,
        upload_token: r.upload_token,
        expires_at: r.expires_at,
        part_size: partSize,
        size: src.size,
        visibility,
        parts: [],
      };
    }
    // The token is bound to key, disk (from visibility), tenant, upload id and expiry: send them identically.
    const token = { key: state.key, upload_id: state.upload_id, upload_token: state.upload_token, expires_at: state.expires_at };

    const ctl = new AbortController();
    const onAbort = (): void => ctl.abort(o.signal?.reason);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    // The signal may have fired while `create-multipart-upload` was answering.
    if (isAborted(o.signal)) onAbort();
    const done = new Set(state.parts.map((p) => p.number));
    const parts = partsOf(src, partSize, done);
    let failure: { e: unknown } | null = null;

    try {
      if (resumed === null) emitState(state);
      let loaded = 0;
      if (src.size !== null) {
        for (const n of done) loaded += Math.max(0, Math.min(src.size, n * partSize) - (n - 1) * partSize);
      }
      const total = src.size;

      // A stream may stall; stop waiting for it once the upload is cancelled.
      const stopped = new Promise<never>((_, reject) => {
        if (ctl.signal.aborted) reject(ctl.signal.reason);
        ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
      });
      stopped.catch(() => undefined);

      const worker = async (): Promise<void> => {
        while (failure === null) {
          const r = await Promise.race([parts.next(), stopped]);
          if (r.done === true) return;
          const part = r.value;
          if (part.number > MAX_PARTS) throw bad(`attachments.uploadMultipart: more than ${MAX_PARTS} parts; use a larger partSize`);
          // Signed lazily, right before the PUT: signed URLs expire.
          const signed = await call<SignedPart>('sign-multipart-part', { ...token, part_number: part.number, visibility }, ctl.signal, true);
          const res = await storagePut(signed.url, 'PUT', signed.headers, part.body, ctl.signal, `part ${part.number}`);
          const etag = res.headers.get('ETag');
          await res.body?.cancel().catch(() => undefined);
          if (etag === null || etag === '') {
            throw new SpApiError({
              status: res.status,
              code: 'unknown',
              message: `Storage response for part ${part.number} has no ETag header; the bucket CORS policy must expose it (ExposeHeaders: ETag)`,
              module: DIRECT_MODULE,
            });
          }
          if (failure !== null) return;
          state.parts.push({ number: part.number, etag });
          state.parts.sort((a, b) => a.number - b.number);
          loaded += part.size;
          o.onProgress?.({ loaded, total });
          emitState(state);
        }
      };

      await Promise.all(
        Array.from({ length: concurrency }, () =>
          worker().catch((e: unknown) => {
            if (failure === null) {
              failure = { e };
              ctl.abort(new Error('multipart upload stopped'));
            }
          }),
        ),
      );
      if (failure !== null) throw (failure as { e: unknown }).e;
      if (total === null) o.onProgress?.({ loaded, total: loaded });

      return await call<Attachment>(
        'complete-multipart-upload',
        clean({
          ...token,
          parts: state.parts.map((p) => ({ part_number: p.number, etag: p.etag })),
          filename,
          visibility,
          folder_id: folderId,
          record_type: o.recordType,
          record_id: str(o.recordId),
          collection_name: o.collection,
        }),
        o.signal,
        false,
      );
    } catch (e) {
      // Best-effort cleanup; never masks the original error.
      try {
        // Not tied to the caller's signal (it may be aborted), but bounded so it cannot hold the rejection long.
        await call<unknown>('abort-multipart-upload', { ...token, visibility }, undefined, false, ABORT_CLEANUP_TIMEOUT_MS);
      } catch {
        // ignored
      }
      if (isAborted(o.signal)) throw o.signal?.reason;
      throw e;
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
      // Releases the source (closes the stream); not awaited, a stalled read would block it.
      parts.return(undefined).catch(() => undefined);
    }
  }

  return { uploadDirect, uploadMultipart };
}
