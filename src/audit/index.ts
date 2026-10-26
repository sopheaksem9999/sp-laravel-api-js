import type { Api } from '../core/create-api';
import type { Page, Table } from '../core/table';
import type { Query } from '../core/query-types';

const MODULE = 'audit';
const TABLE = 'sp_audit_logs';

/** An audit log row (`sp_audit_logs`); the host may add or hide columns, hence the passthrough. */
export interface AuditLog {
  id: number | string;
  entity_name?: string | null;
  /** Table name of the audited record. */
  entity_type?: string | null;
  /** Id of the audited record, always a string (uuid or numeric). */
  entity_id?: string | null;
  user_id?: string | number | null;
  event?: string | null;
  title?: string | null;
  subject?: string | null;
  recap?: string | null;
  old_data?: unknown;
  new_data?: unknown;
  metadata?: unknown;
  ip_address?: string | null;
  user_agent?: string | null;
  request_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** The related user, only when requested through `include`. */
  user?: unknown;
  [k: string]: unknown;
}

/** Result of `stats`: counts keyed by event, user id and entity type. */
export interface AuditStats {
  total: number;
  by_event: Record<string, number>;
  by_user: Record<string, number>;
  by_entity: Record<string, number>;
  [k: string]: unknown;
}

/**
 * Filters for `stats`. There is deliberately no tenant option: the tenant always comes from the tenant header
 * configured on the client, and the backend pins every audit read to it.
 */
export interface AuditStatsOptions {
  /** Inclusive lower bound on `created_at` (sent as `start_date`). */
  startDate?: string;
  /** Inclusive upper bound on `created_at` (sent as `end_date`). */
  endDate?: string;
  /** Only this user's events (sent as `user_id`). */
  userId?: string | number;
  /** Table name or model class of the audited entity (sent as `entity_type`). */
  entityType?: string;
  /** Event name, for example `created`, `updated`, `deleted`. */
  event?: string;
  signal?: AbortSignal;
}

/** One change of a field, newest first. */
export interface FieldTimelineEntry {
  audit_log_id: number | string;
  event: string;
  user_id: string | number | null;
  created_at: string | null;
  old_value: unknown;
  new_value: unknown;
  [k: string]: unknown;
}

/** Aggregated changes of one field of one entity. */
export interface FieldStats {
  total_changes: number;
  changed_by_users: Record<string, number>;
  value_frequency: Record<string, number>;
  current_value: unknown;
  first_changed_at: string | null;
  last_changed_at: string | null;
  [k: string]: unknown;
}

/** Options for `fieldTimeline`. */
export interface FieldTimelineOptions {
  /** Maximum entries returned (the backend default is 50). */
  limit?: number;
  signal?: AbortSignal;
}

/** The audit module returned by `audit(api)`. */
export interface Audit {
  /** Lists `sp_audit_logs` (read-only table; relation `user`) with the usual query options. */
  list(q?: Query, o?: { signal?: AbortSignal }): Promise<Page<AuditLog>>;
  /** `GET sp_audit_logs/{rpc}/stats`: counts by event, user and entity type. */
  stats(o?: AuditStatsOptions): Promise<AuditStats>;
  /** `GET sp_audit_logs/{rpc}/field-timeline/{entityType}/{entityId}/{field}`: the changes of one field, newest first. */
  fieldTimeline(entityType: string, entityId: string | number, field: string, o?: FieldTimelineOptions): Promise<FieldTimelineEntry[]>;
  /** `GET sp_audit_logs/{rpc}/field-stats/{entityType}/{entityId}/{field}`: aggregated changes of one field. */
  fieldStats(entityType: string, entityId: string | number, field: string, o?: { signal?: AbortSignal }): Promise<FieldStats>;
}

const seg = (s: string | number): string => encodeURIComponent(String(s));

/**
 * Audit log reads for a client. Needs the host's audit routes enabled (off by default) and a user the
 * `manage-audit-logs` gate allows: 401 is `unauthenticated`, 403 is `forbidden`.
 *
 * A 404 on `stats` / `fieldTimeline` / `fieldStats` (no record lookup involved) is `module_disabled`.
 */
export function audit(api: Api): Audit {
  const table: Table<AuditLog> = api.table<AuditLog>(TABLE);
  const prefix = api.config.rpcPrefix ?? 'rpc';

  async function call<T>(tail: string, query: URLSearchParams | undefined, signal: AbortSignal | undefined): Promise<T> {
    const path = `${seg(TABLE)}/${prefix === '' ? '' : `${seg(prefix)}/`}${tail}`;
    const r = await api.request<T>({
      method: 'GET',
      path,
      query: query !== undefined && query.toString() !== '' ? query : undefined,
      signal,
      module: MODULE,
      disabledOn404: true,
    });
    return r.data;
  }

  const entityPath = (name: string, type: string, id: string | number, field: string): string =>
    `${name}/${seg(type)}/${seg(id)}/${seg(field)}`;

  return {
    list: (q, o) => table.list(q, o),
    stats(o) {
      // Whitelist: only documented filters are sent, never a tenant.
      const query = new URLSearchParams();
      const put = (k: string, v: string | number | undefined): void => {
        if (v !== undefined && v !== '') query.set(k, String(v));
      };
      put('start_date', o?.startDate);
      put('end_date', o?.endDate);
      put('user_id', o?.userId);
      put('entity_type', o?.entityType);
      put('event', o?.event);
      return call<AuditStats>('stats', query, o?.signal);
    },
    fieldTimeline(entityType, entityId, field, o) {
      const query = new URLSearchParams();
      if (o?.limit !== undefined) query.set('limit', String(o.limit));
      return call<FieldTimelineEntry[]>(entityPath('field-timeline', entityType, entityId, field), query, o?.signal);
    },
    fieldStats: (entityType, entityId, field, o) =>
      call<FieldStats>(entityPath('field-stats', entityType, entityId, field), undefined, o?.signal),
  };
}
