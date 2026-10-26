import { SpApiError } from '../core/errors';
import type { Api } from '../core/create-api';
import type { Page } from '../core/page';
import type { Table, CallOptions, RestoreResult } from '../core/table';

export { parseWebhook, verifyWebhook } from './receiver';
export type { ParsedWebhook, WebhookHeaders } from './receiver';

const MODULE = 'webhooks';

/** Id of a webhook row (uuid; the backend always uses uuid for `sp_webhook_*`). */
export type WebhookId = string | number;

/** Events a subscription can match (`*` = all). */
export type WebhookEvent = 'created' | 'updated' | 'deleted' | '*';

/** An endpoint row (`sp_webhook_endpoints`). `secret` is write-only and never present on a read. */
export interface Endpoint {
  id: WebhookId;
  name: string;
  url: string;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  [k: string]: unknown;
}

/** What you send to create or update an endpoint (`secret` is write-only). */
export type EndpointInput = Partial<Omit<Endpoint, 'id'>> & { secret?: string };

/** A subscription row (`sp_webhook_subscriptions`): which table/event goes to which endpoint. */
export interface Subscription {
  id: WebhookId;
  endpoint_id: WebhookId;
  /** Table name, or `*` for every table. */
  table_name: string;
  event: WebhookEvent;
  created_at?: string | null;
  updated_at?: string | null;
  [k: string]: unknown;
}

/** A delivery row (`sp_webhook_deliveries`), written by the backend only. */
export interface Delivery {
  id: WebhookId;
  endpoint_id: WebhookId;
  /** `{table}.{action}` */
  event: string;
  /** The JSON-encoded payload (the backend stores `json_encode($payload)` in a json column). */
  payload: unknown;
  response_status?: number | null;
  response_body?: string | null;
  status: 'pending' | 'success' | 'failed' | (string & {});
  created_at?: string | null;
  updated_at?: string | null;
  [k: string]: unknown;
}

/** The endpoints table: pass-through CRUD with `secret` stripped from results, plus secret generation. */
export interface Endpoints {
  readonly name: string;
  list(q?: Parameters<Table<Endpoint>['list']>[0], o?: CallOptions): Promise<Page<Endpoint>>;
  get(id: WebhookId, o?: Parameters<Table<Endpoint>['get']>[1]): Promise<Endpoint>;
  update(id: WebhookId, body: EndpointInput, o?: CallOptions): Promise<Endpoint>;
  patch(id: WebhookId, body: EndpointInput, o?: CallOptions): Promise<Endpoint>;
  remove: Table<Endpoint>['remove'];
  restore(id: WebhookId, o?: CallOptions): Promise<RestoreResult>;
  /**
   * Creates an endpoint. The backend requires `name`, `url` and `secret` and never returns the secret, so when
   * `secret` is missing or empty a 32-byte random one (64 hex chars, Web Crypto) is generated and sent. The secret
   * is returned ONCE, here: store it yourself for `verifyWebhook`.
   */
  create(body: EndpointInput & { url: string }, o?: CallOptions): Promise<{ endpoint: Endpoint; secret: string }>;
  /** Generates a new secret, sends it with `update(id, { secret })` and returns it once with the endpoint. */
  rotateSecret(id: WebhookId, o?: CallOptions): Promise<{ endpoint: Endpoint; secret: string }>;
}

/** The webhooks admin module returned by `webhooks(api)`. */
export interface Webhooks {
  endpoints: Endpoints;
  /** Full CRUD on `sp_webhook_subscriptions`. */
  subscriptions: Table<Subscription>;
  /** `sp_webhook_deliveries` is read-only through the API (`isAuthWrite: false`): only `list` and `get`. */
  deliveries: Pick<Table<Delivery>, 'list' | 'get'>;
}

/** 32 random bytes from Web Crypto as 64 lowercase hex characters. */
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Drops a `secret` an older host may still return. */
function strip<T>(row: T): T {
  if (typeof row !== 'object' || row === null || !('secret' in row)) return row;
  const copy = { ...(row as Record<string, unknown>) };
  delete copy.secret;
  return copy as T;
}

/** Marks an error from a table call with this module's name (table routes carry none). */
function tagged<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e instanceof SpApiError && e.module === null) e.module = MODULE;
      throw e;
    }
  };
}

/**
 * Webhook administration. The three tables are plain table routes, so a 404 is `not_found` (the module being off
 * cannot be told apart from a missing row; `capabilities()` is the detector). Errors carry `module: 'webhooks'`.
 * The receiver helpers (`verifyWebhook`, `parseWebhook`) are separate and make no network call.
 */
export function webhooks(api: Api): Webhooks {
  const ep = api.table<Endpoint>('sp_webhook_endpoints');
  const sub = api.table<Subscription>('sp_webhook_subscriptions');
  const del = api.table<Delivery>('sp_webhook_deliveries');

  const update = tagged(async (id: WebhookId, body: EndpointInput, o?: CallOptions) => strip(await ep.update(id, body as Partial<Endpoint>, o)));

  const endpoints: Endpoints = {
    name: ep.name,
    list: tagged(async (q, o) => {
      const page = await ep.list(q, o);
      return { ...page, data: page.data.map(strip) };
    }),
    get: tagged(async (id, o) => strip(await ep.get(id, o))),
    update,
    patch: tagged(async (id, body, o) => strip(await ep.patch(id, body as Partial<Endpoint>, o))),
    remove: tagged(ep.remove),
    restore: tagged(async (id, o) => strip(await ep.restore(id, o))),
    create: tagged(async (body, o) => {
      const secret = typeof body.secret === 'string' && body.secret !== '' ? body.secret : generateSecret();
      const endpoint = strip(await ep.create({ ...body, secret } as Partial<Endpoint>, o));
      return { endpoint, secret };
    }),
    rotateSecret: tagged(async (id, o) => {
      const secret = generateSecret();
      return { endpoint: await update(id, { secret }, o), secret };
    }),
  };

  return {
    endpoints,
    subscriptions: wrapTable(sub),
    deliveries: { list: tagged(del.list), get: tagged(del.get) },
  };
}

function wrapTable<T>(t: Table<T>): Table<T> {
  return {
    ...t,
    list: tagged(t.list),
    get: tagged(t.get),
    create: tagged(t.create),
    update: tagged(t.update),
    patch: tagged(t.patch),
    remove: tagged(t.remove),
    restore: tagged(t.restore),
    upsert: tagged(t.upsert) as Table<T>['upsert'],
    aggregate: tagged(t.aggregate) as Table<T>['aggregate'],
  };
}
