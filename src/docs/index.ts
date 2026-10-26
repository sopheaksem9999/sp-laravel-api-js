import type { Api } from '../core/create-api';
import { isSpApiError } from '../core/errors';

const MODULE = 'docs';
const OPENAPI_PATH = 'docs/openapi.json';
const LLMS_PATH = 'docs/llms.txt';

/** Options for the docs calls. */
export interface DocsCallOptions {
  signal?: AbortSignal;
}

/** The docs module returned by `docs(api)`. */
export interface Docs {
  /** `GET docs/openapi.json`: the host's OpenAPI 3.0.3 document, as parsed JSON (not enveloped). */
  openapi(o?: DocsCallOptions): Promise<unknown>;
  /** `GET docs/llms.txt`: the host's agent contract, as markdown text. */
  llms(o?: DocsCallOptions): Promise<string>;
}

/**
 * The host's `api_docs` routes. Both calls carry `module: 'docs'`. With `api_docs.is_private` the host answers
 * 404 to both whatever the credentials, which is reported as `code: 'module_disabled'` (these routes have no
 * lookup target, so a 404 can only mean the docs are switched off).
 */
export function docs(api: Api): Docs {
  return {
    async openapi(o) {
      const r = await api.request<unknown>({ method: 'GET', path: OPENAPI_PATH, signal: o?.signal, module: MODULE, disabledOn404: true });
      return r.data;
    },
    async llms(o) {
      const r = await api.request<string>({
        method: 'GET',
        path: LLMS_PATH,
        signal: o?.signal,
        module: MODULE,
        disabledOn404: true,
        responseType: 'text',
      });
      return r.data;
    },
  };
}

/**
 * Which backend modules the host exposes, read from the paths of its OpenAPI document.
 *
 * - `bulk`: `{table}/bulk/create|update|delete` (`record.bulk_operations`). `bulk/upsert` is not used: it is
 *   documented whenever a table allows upsert, even with bulk operations off.
 * - `attachments`: `sp_attachments/{rpc}/upload` (`attachments.enabled`).
 * - `directUpload`: `sp_attachments/{rpc}/create-upload-url` or `create-multipart-upload`
 *   (`attachments.direct_upload.enabled`; the `attachments.direct_upload` module of `uploadDirect` /
 *   `uploadMultipart`).
 * - `audit`: any `sp_audit_logs` path (`audit.enabled`).
 * - `permissions`: any `sp_roles` or `sp_permissions` path.
 * - `webhooks`: any `sp_webhook_endpoints`, `sp_webhook_subscriptions` or `sp_webhook_deliveries` path
 *   (`webhooks.enabled`).
 * - `docs`: always `true` (the document was read).
 * - `realtime`: `true` when the document carries `x-sp-realtime`; otherwise `'unknown'`, because the host
 *   documents realtime only when `sp-laravel-api.openapi.realtime.enabled` is also on, and broadcasting has no
 *   HTTP routes to look for.
 */
export interface Capabilities {
  bulk: boolean;
  attachments: boolean;
  directUpload: boolean;
  audit: boolean;
  permissions: boolean;
  webhooks: boolean;
  docs: boolean;
  realtime: true | 'unknown';
}

/** Options for `capabilities`. */
export interface CapabilitiesOptions {
  /** Ignore the cached result for this client and read the document again. */
  refresh?: boolean;
  signal?: AbortSignal;
}

const cache = new WeakMap<Api, Capabilities | 'unknown'>();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Derives the module flags from the document's path keys. */
function fromDocument(doc: Record<string, unknown>, paths: string[], rpcPrefix: string): Capabilities {
  const rpc = rpcPrefix === '' ? '' : `${escapeRe(rpcPrefix)}/`;
  const segment = (names: string[]): RegExp => new RegExp(`(^|/)(${names.join('|')})(/|$)`);
  const attachmentFn = (names: string[]): RegExp => new RegExp(`(^|/)sp_attachments/${rpc}(${names.join('|')})$`);
  const has = (re: RegExp): boolean => paths.some((p) => re.test(p));
  return {
    bulk: has(/\/bulk\/(create|update|delete)$/),
    attachments: has(attachmentFn(['upload'])),
    directUpload: has(attachmentFn(['create-upload-url', 'create-multipart-upload'])),
    audit: has(segment(['sp_audit_logs'])),
    permissions: has(segment(['sp_roles', 'sp_permissions'])),
    webhooks: has(segment(['sp_webhook_endpoints', 'sp_webhook_subscriptions', 'sp_webhook_deliveries'])),
    docs: true,
    realtime: doc['x-sp-realtime'] !== undefined ? true : 'unknown',
  };
}

/**
 * Reports which backend modules the host exposes, from the paths of its OpenAPI document (one
 * `GET docs/openapi.json` per call; the result is cached per client for the client's lifetime, `refresh: true`
 * reads it again).
 *
 * Resolves `'unknown'` (never throws) when the docs are private (404) or the host is unreachable (network
 * failure or timeout), and when the body is not an OpenAPI document. Only the private-docs `'unknown'` is
 * cached. Any other failure (401, 403, 5xx...) is rethrown as `SpApiError` with `module: 'docs'`; an abort
 * rethrows the signal's reason.
 *
 * A module whose routes exist but which the host refuses by some other means (a gate, a host-specific flag) is
 * reported as present: this detects routes, not permissions.
 */
export async function capabilities(api: Api, o: CapabilitiesOptions = {}): Promise<Capabilities | 'unknown'> {
  if (o.refresh !== true) {
    const hit = cache.get(api);
    if (hit !== undefined) return hit;
  }
  let doc: unknown;
  try {
    doc = await docs(api).openapi({ signal: o.signal });
  } catch (e) {
    if (isSpApiError(e) && e.code === 'module_disabled') {
      cache.set(api, 'unknown');
      return 'unknown';
    }
    if (isSpApiError(e) && (e.code === 'network' || e.code === 'timeout')) return 'unknown';
    throw e;
  }
  if (!isRecord(doc) || !isRecord(doc.paths)) return 'unknown';
  const result = fromDocument(doc, Object.keys(doc.paths), api.config.rpcPrefix ?? 'rpc');
  cache.set(api, result);
  return result;
}
