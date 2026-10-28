import type { Api } from '../core/create-api';

/** The mutation actions the backend broadcasts (`RecordMutated`). Bulk upsert broadcasts `upserted` once, batched. */
export type RealtimeAction = 'created' | 'updated' | 'deleted' | 'restored' | 'upserted';

/** A validated broadcast, ready to drive cache invalidation. */
export interface RealtimeChange {
  table: string;
  action: RealtimeAction;
  /**
   * The record as broadcast, passed through untouched. For `upserted` it is the batched shape
   * `{ count, match_on, keys }` (the match keys of every upserted row), not a full row.
   */
  record: unknown;
  /** `api.keys.table(table)`: the TanStack Query prefix key of every list/get key for that table. */
  queryKey: readonly unknown[];
  /** The bound event name without the leading dot (e.g. `orders.updated`), when the transport supplied it. */
  eventName?: string;
  /** The payload exactly as received (same object, not a copy). */
  raw: unknown;
}

/** A payload that is not a valid record event (e.g. a custom event), as passed to `onUnhandled`. */
export interface RealtimeUnhandled {
  /** The bound event name without the leading dot, when the transport supplied it. */
  eventName?: string;
  /** The payload exactly as received (same object, not a copy). */
  payload: unknown;
}

/** Options of `handler`. */
export interface RealtimeHandlerOptions {
  /** Called for every valid broadcast. May return a promise (e.g. `invalidateQueries`); a throw or rejection is swallowed (see `handler`). */
  onChange: (change: RealtimeChange) => unknown;
  /**
   * Called for payloads that are not valid record events (non-object, no string `table`, unknown action, custom
   * events). Same swallow-and-report-once rules as `onChange`. Without it such payloads are ignored.
   */
  onUnhandled?: (e: RealtimeUnhandled) => unknown;
}

/** What `realtime(api)` returns. */
export interface Realtime {
  /**
   * Builds a transport-free callback `(payload, eventName?)` for the broadcast payload. A valid record event (an
   * object with a non-empty string `table` and an `action` among the five known ones) goes to `onChange` as a
   * `RealtimeChange` (with `raw` and, when the transport passes it, `eventName`). Anything else (not an object, empty or
   * non-string `table`, an unknown `action`, a custom event) goes to `onUnhandled({ eventName, payload })`, or is ignored
   * when no `onUnhandled` was given. The callback never throws: a callback that throws is swallowed and reported once
   * through `api.config.onEvent` as `{ type: 'realtime_handler_error' }` (a fixed message, no payload data); a rejected
   * promise it returns is reported the same way. Reading the payload never throws either: a throwing getter or Proxy
   * trap (including on `record`) makes the payload unhandled (it goes to `onUnhandled` as received, which is yours to read).
   */
  handler(o: RealtimeHandlerOptions): (payload: unknown, eventName?: string) => void;
  /** `tenant.{id}`, or `tenant.global` when the id is empty (the backend's `empty($tenantId)`: null, '', 0, '0'). */
  channelName(tenantId?: string | number | null): string;
  /** `{table}.{action}`, the backend's `broadcastAs()` (custom name: Echo needs a leading dot, see the README). */
  eventName(table: string, action: string): string;
}

const ACTIONS: ReadonlySet<string> = new Set(['created', 'updated', 'deleted', 'restored', 'upserted']);

function isAction(v: unknown): v is RealtimeAction {
  return typeof v === 'string' && ACTIONS.has(v);
}

/**
 * Realtime helpers for the backend's `RecordMutated` broadcast. Transport-free: wire `handler` to Laravel
 * Echo, Pusher, SSE or anything else. The module makes no HTTP call and throws no `SpApiError`.
 */
export function realtime(api: Api): Realtime {
  const report = (message: string): void => {
    try {
      api.config.onEvent?.({ type: 'realtime_handler_error', message });
    } catch {
      // A throwing onEvent must not break the transport either.
    }
  };
  const invoke = <T>(fn: (arg: T) => unknown, arg: T, message: string): void => {
    const fail = (): void => report(message);
    try {
      const out: unknown = fn(arg);
      if (out !== null && (typeof out === 'object' || typeof out === 'function')) {
        const then = (out as { then?: unknown }).then;
        if (typeof then === 'function') (then as PromiseLike<unknown>['then']).call(out, undefined, fail);
      }
    } catch {
      fail();
    }
  };
  return {
    handler({ onChange, onUnhandled }) {
      return (payload, eventName) => {
        let change: RealtimeChange | undefined;
        try {
          // All payload access is guarded: throwing getters, throwing Proxy traps and the like are not record events.
          if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
            const p = payload as Record<string, unknown>;
            const table = p.table;
            const action = p.action;
            if (typeof table === 'string' && table !== '' && isAction(action)) {
              change = { table, action, record: p.record, queryKey: api.keys.table(table), raw: payload };
              if (typeof eventName === 'string') change.eventName = eventName;
            }
          }
        } catch {
          change = undefined;
        }
        if (change !== undefined) {
          invoke(onChange, change, 'onChange handler threw');
        } else if (typeof onUnhandled === 'function') {
          const e: RealtimeUnhandled = { payload };
          if (typeof eventName === 'string') e.eventName = eventName;
          invoke(onUnhandled, e, 'onUnhandled handler threw');
        }
      };
    },
    channelName(tenantId) {
      const empty = tenantId === null || tenantId === undefined || tenantId === '' || tenantId === 0 || tenantId === '0';
      return empty ? 'tenant.global' : `tenant.${String(tenantId)}`;
    },
    eventName: (table, action) => `${table}.${action}`,
  };
}

/**
 * Minimal structural type representing an Echo channel.
 */
export interface EchoChannelLike {
  listen(event: string, callback: (payload: unknown) => void): EchoChannelLike;
  stopListening?(event: string, callback?: (payload: unknown) => void): EchoChannelLike;
}

/**
 * Minimal structural type representing Laravel Echo.
 */
export interface EchoLike {
  private(name: string): EchoChannelLike;
  leave(name: string): void;
}

/**
 * Options for `subscribeTenant`.
 */
export interface SubscribeTenantOptions {
  /** Tenant ID to subscribe to. Null, 0, or empty string falls back to 'tenant.global'. */
  tenantId?: string | number | null;
  /** Tables to listen to. Each specified table will have listeners bound for all 5 mutation actions. If empty or omitted, no event listeners are bound. */
  tables?: readonly string[];
  /** Handler called for each mutation event. */
  onChange: (change: RealtimeChange) => unknown;
  /** Called for payloads that are not valid record events (see `RealtimeHandlerOptions.onUnhandled`). */
  onUnhandled?: (e: RealtimeUnhandled) => unknown;
  /** Custom Echo event names to bind as-is (include the leading dot if Echo needs it). A record-shaped payload goes to `onChange`; other payloads go to `onUnhandled` with the name. */
  events?: readonly string[];
}

/**
 * Subscribes an Echo-compatible client to a tenant's private channel and binds the five mutation actions
 * (`created`, `updated`, `deleted`, `restored`, `upserted`) with leading dots for all specified tables.
 * Returns an unsubscription function that removes listeners and leaves the channel.
 */
export function subscribeTenant(
  echo: EchoLike,
  api: Api,
  options: SubscribeTenantOptions,
): () => void {
  const rt = realtime(api);
  let rawId = options.tenantId;
  if (typeof rawId === 'string') {
    if (rawId.startsWith('private-')) {
      rawId = rawId.slice('private-'.length);
    }
    if (rawId.startsWith('tenant.')) {
      rawId = rawId.slice('tenant.'.length);
    }
  }
  const channelName = rt.channelName(rawId);
  const handler = rt.handler({ onChange: options.onChange, onUnhandled: options.onUnhandled });
  const channel = echo.private(channelName);
  const tables = options.tables;
  const actions: readonly RealtimeAction[] = ['created', 'updated', 'deleted', 'restored', 'upserted'];
  const bound: Array<{ event: string; cb: (payload: unknown) => void }> = [];
  const bind = (event: string): void => {
    const name = event.startsWith('.') ? event.slice(1) : event;
    const cb = (payload: unknown): void => handler(payload, name);
    channel.listen(event, cb);
    bound.push({ event, cb });
  };

  if (tables !== undefined) {
    for (const table of tables) {
      for (const action of actions) {
        bind('.' + rt.eventName(table, action));
      }
    }
  }
  if (options.events !== undefined) {
    for (const event of options.events) bind(event);
  }

  return () => {
    if (typeof channel.stopListening === 'function') {
      for (const { event, cb } of bound) {
        channel.stopListening(event, cb);
      }
    }
    echo.leave(channelName);
  };
}

export type {
  PusherAuthData,
  PusherAuthorizerCallback,
  PusherAuthorizer,
  EchoPusherAuthorizerOptions,
} from './authorizer';
export { echoPusherAuthorizer } from './authorizer';
