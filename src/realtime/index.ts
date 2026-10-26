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
}

/** Options of `handler`. */
export interface RealtimeHandlerOptions {
  /** Called for every valid broadcast. May return a promise (e.g. `invalidateQueries`); a throw or rejection is swallowed (see `handler`). */
  onChange: (change: RealtimeChange) => unknown;
}

/** What `realtime(api)` returns. */
export interface Realtime {
  /**
   * Builds a transport-free callback for the broadcast payload. Malformed payloads (not an object, empty or
   * non-string `table`, an `action` outside the five known ones) are ignored. The callback never throws: an
   * `onChange` that throws is swallowed and reported once through `api.config.onEvent` as
   * `{ type: 'realtime_handler_error' }` (a fixed message, no payload data); a rejected promise returned by `onChange` is reported the same way. Reading the payload never throws either: a throwing getter or Proxy trap (including on `record`) makes the payload ignored, silently.
   */
  handler(o: RealtimeHandlerOptions): (payload: unknown) => void;
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
  const report = (): void => {
    try {
      api.config.onEvent?.({ type: 'realtime_handler_error', message: 'onChange handler threw' });
    } catch {
      // A throwing onEvent must not break the transport either.
    }
  };
  return {
    handler({ onChange }) {
      return (payload) => {
        let change: RealtimeChange;
        try {
          // All payload access is guarded: throwing getters, throwing Proxy traps and the like are ignored.
          if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
          const p = payload as Record<string, unknown>;
          const table = p.table;
          const action = p.action;
          if (typeof table !== 'string' || table === '' || !isAction(action)) return;
          change = { table, action, record: p.record, queryKey: api.keys.table(table) };
        } catch {
          return;
        }
        try {
          const out: unknown = onChange(change);
          if (out !== null && (typeof out === 'object' || typeof out === 'function')) {
            const then = (out as { then?: unknown }).then;
            if (typeof then === 'function') (then as PromiseLike<unknown>['then']).call(out, undefined, report);
          }
        } catch {
          report();
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
