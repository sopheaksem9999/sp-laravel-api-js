import type { Api } from '../core/create-api';
import type { Table } from '../core/table';

const MODULE = 'permissions';
const ROLES = 'sp_roles';
const PERMISSIONS = 'sp_permissions';

/** Id of a role or permission (numeric or uuid, depending on the host's `record.id_type`). */
export type PermissionsId = number | string;

/** A role row (`sp_roles`). */
export interface Role {
  id: PermissionsId;
  name: string;
  key?: string | null;
  guard_name?: string | null;
  description?: string | null;
  is_system?: boolean;
  is_master?: boolean;
  is_default?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  /** Attached permissions, only when requested through `include`. */
  permissions?: Permission[];
  [k: string]: unknown;
}

/** A permission row (`sp_permissions`). */
export interface Permission {
  id: PermissionsId;
  name: string;
  group?: string | null;
  guard_name?: string;
  description?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [k: string]: unknown;
}

/** The permissions module returned by `permissions(api)`. */
export interface Permissions {
  /** Full CRUD on `sp_roles`. */
  roles: Table<Role>;
  /** `sp_permissions` is registered from the host's config: only list, get and update (the backend refuses create and delete). */
  permissions: Pick<Table<Permission>, 'list' | 'get' | 'update'>;
  /**
   * Attaches permissions to a role: `PUT sp_roles/{roleId}` with `{ permissions: [ids] }`. Links not listed stay
   * attached. Ids are de-duplicated. With no ids no write is made and the current role is fetched instead.
   */
  assign(roleId: PermissionsId, permissionIds: PermissionsId[]): Promise<Role>;
  /**
   * Detaches permissions from a role: `PUT sp_roles/{roleId}` with `{ permissions: [{ id, _delete: true }] }`. On this
   * many-to-many relation the backend removes the pivot link only, never the permission row. Ids are de-duplicated.
   * With no ids no write is made and the current role is fetched instead.
   */
  detach(roleId: PermissionsId, permissionIds: PermissionsId[]): Promise<Role>;
}

const seg = (s: string | number): string => encodeURIComponent(String(s));

function unique(ids: PermissionsId[]): PermissionsId[] {
  const seen = new Set<string>();
  const out: PermissionsId[] = [];
  for (const id of ids) {
    const k = String(id);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(id);
    }
  }
  return out;
}

/**
 * Role and permission management for a client. `assign` and `detach` are writes on a specific role, so a 404 there
 * is `not_found` (missing role), never `module_disabled`. Errors from them carry `module: 'permissions'`.
 */
export function permissions(api: Api): Permissions {
  const roles = api.table<Role>(ROLES);
  const perms = api.table<Permission>(PERMISSIONS);
  const path = (roleId: PermissionsId): string => `${seg(ROLES)}/${seg(roleId)}`;

  const write = async (roleId: PermissionsId, body: unknown): Promise<Role> =>
    (await api.request<Role>({ method: 'PUT', path: path(roleId), body, module: MODULE })).data;
  const current = async (roleId: PermissionsId): Promise<Role> =>
    (await api.request<Role>({ method: 'GET', path: path(roleId), module: MODULE })).data;

  return {
    roles,
    permissions: { list: perms.list, get: perms.get, update: perms.update },
    async assign(roleId, permissionIds) {
      const ids = unique(permissionIds);
      return ids.length === 0 ? current(roleId) : write(roleId, { permissions: ids });
    },
    async detach(roleId, permissionIds) {
      const ids = unique(permissionIds);
      return ids.length === 0 ? current(roleId) : write(roleId, { permissions: ids.map((id) => ({ id, _delete: true })) });
    },
  };
}
