import { SpApiError } from '../core/errors';
import type { FormUploadOptions, UploadOptions } from './index';

type UploadFieldOptions = UploadOptions & FormUploadOptions;

/** The upload paths a field can go through. Resize and `asTemp` are form-only: the other two send the file straight to storage. */
export type UploadFieldStrategy = 'form' | 'direct' | 'multipart';

const bad = (message: string): SpApiError =>
  new SpApiError({ status: 0, code: 'unencodable_value', message: `attachments.upload: ${message}`, module: 'attachments' });

const isTemp = (visibility: string | undefined): boolean => visibility === 'temp_private' || visibility === 'temp_public';
const positiveInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * Throws `unencodable_value` (no request is made) when the server would silently ignore or override an option:
 * resize or `asTemp` on a direct upload, a timeout without a temporary upload, `replaceOld` without a record, and so on.
 * Only a truthy flag counts: `replaceOld: false` and `asTemp: false` with a non-temporary visibility are no-ops.
 * The server's own ranges (width and height, title length, timeout cap) are left to its 422.
 */
export function checkUploadFields(o: UploadFieldOptions, strategy: UploadFieldStrategy): void {
  if (strategy !== 'form') {
    for (const k of ['width', 'height', 'fit', 'sizeName'] as const) {
      if (o[k] !== undefined) throw bad(`${k} needs the form upload: the '${strategy}' strategy sends the file straight to storage, so it cannot be resized`);
    }
    if (o.asTemp === true) {
      throw bad(`asTemp is only for the form upload; with the '${strategy}' strategy use visibility 'temp_private' or 'temp_public'`);
    }
  }

  for (const k of ['width', 'height'] as const) {
    if (o[k] !== undefined && !positiveInt(o[k])) throw bad(`${k} must be a positive integer`);
  }
  if (o.fit !== undefined && o.fit !== 'crop' && o.fit !== 'contain') throw bad('fit must be "crop" or "contain"');
  if (o.sizeName !== undefined) {
    if (typeof o.sizeName !== 'string' || o.sizeName === '') throw bad('sizeName must be a non-empty string');
    if (o.width !== undefined || o.height !== undefined || o.fit !== undefined) {
      throw bad("sizeName cannot be combined with width, height or fit: the host's configured size overrides them");
    }
  }

  if (o.replaceOld === true && (o.recordType === undefined || o.recordId === undefined)) {
    throw bad('replaceOld needs recordType and recordId: without a record the server makes no link and ignores it');
  }

  if (o.asTemp === true && o.visibility !== undefined && !isTemp(o.visibility)) {
    throw bad(`asTemp: true contradicts visibility '${o.visibility}': the server would replace it with its temporary default`);
  }
  if (o.asTemp === false && isTemp(o.visibility)) {
    throw bad(`asTemp: false contradicts visibility '${String(o.visibility)}': a temp_* visibility is always temporary`);
  }

  if (o.tempTimeoutMinutes !== undefined && !positiveInt(o.tempTimeoutMinutes)) {
    throw bad('tempTimeoutMinutes must be a positive integer');
  }
  if (o.tempTimeoutAt !== undefined) {
    const at = o.tempTimeoutAt;
    const valid = typeof at === 'string' ? at.trim() !== '' : at instanceof Date && !Number.isNaN(at.getTime());
    if (!valid) throw bad('tempTimeoutAt must be a non-empty string or a valid Date');
  }
  if (o.tempTimeoutMinutes !== undefined && o.tempTimeoutAt !== undefined) {
    throw bad('tempTimeoutMinutes and tempTimeoutAt together: the server uses tempTimeoutAt and ignores the minutes');
  }
  if ((o.tempTimeoutMinutes !== undefined || o.tempTimeoutAt !== undefined) && !(o.asTemp === true || isTemp(o.visibility))) {
    throw bad("a timeout only applies to a temporary upload: set asTemp: true or visibility 'temp_private' / 'temp_public'");
  }
}

/** Wire fields every strategy can send (on the final call): `replace_old` (only when `true`), `folder_id`, `title`, `caption` and the temp timeouts. */
export function sharedFields(o: UploadOptions): Record<string, string | boolean | undefined> {
  return {
    replace_old: o.replaceOld === true ? true : undefined,
    folder_id: o.folderId === undefined ? undefined : String(o.folderId),
    title: o.title,
    caption: o.caption,
    temp_timeout_minutes: o.tempTimeoutMinutes === undefined ? undefined : String(o.tempTimeoutMinutes),
    temp_timeout_at: o.tempTimeoutAt === undefined ? undefined : o.tempTimeoutAt instanceof Date ? o.tempTimeoutAt.toISOString() : o.tempTimeoutAt,
  };
}

/** Wire fields only the form upload can send: `w`, `h`, `fit`, `size_name` and `as_temp` (only when `true`). */
export function formOnlyFields(o: FormUploadOptions): Record<string, string | boolean | undefined> {
  return {
    w: o.width === undefined ? undefined : String(o.width),
    h: o.height === undefined ? undefined : String(o.height),
    fit: o.fit,
    size_name: o.sizeName,
    as_temp: o.asTemp === true ? true : undefined,
  };
}
