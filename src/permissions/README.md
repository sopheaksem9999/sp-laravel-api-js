# `@sopheak/sp-laravel-api/permissions`

Manage roles, read permissions, and attach or detach permissions on a role.

```ts
// typecheck
import { createApi } from '@sopheak/sp-laravel-api';
import { permissions } from '@sopheak/sp-laravel-api/permissions';

const api = createApi({ baseUrl: 'https://host.example/api' });
const p = permissions(api);

const role = await p.roles.create({ name: 'Auditor' });   // sp_roles: full CRUD
const all = await p.permissions.list({ perPage: 200 });   // sp_permissions: list / get / update only
await p.assign(role.id, [1, 2]);                          // PUT sp_roles/{id}  { permissions: [1, 2] }
await p.detach(role.id, [2]);                             // PUT sp_roles/{id}  { permissions: [{ id: 2, _delete: true }] }
```

- `roles` is `api.table('sp_roles')`.
- `permissions` is a restricted view of `api.table('sp_permissions')`: only `list`, `get` and `update` exist, at runtime and in the type (`Pick<Table<Permission>, 'list' | 'get' | 'update'>`). The backend registers permissions from config (`canCreate: false`, `canDelete: false`).
- `assign(roleId, ids)` and `detach(roleId, ids)` return the role row from the backend response. Ids may be numbers or strings (uuid) and are de-duplicated. Role ids are URL-encoded.
- Empty `ids`: no write is made; the role is fetched once (`GET sp_roles/{id}`) and returned.

## Backend contract (verified against `sp-laravel-api` source: `config/sp-permissions.php`, `RelationshipResolverUtils`)

`sp_roles` has a many-to-many `permissions` relation over `sp_role_permissions`. A nested write on `PUT sp_roles/{id}`:

- a bare id (or `{ id }`) **attaches** the existing permission; links you leave out are **kept** (so `assign` adds, it does not replace);
- `{ id, _delete: true }` on a many-to-many relation **deletes only the pivot row** (the link). It does not delete the permission. `detach` relies on this and is therefore the exact body the brief specified.

The `PUT` response is the role row; it contains `permissions` only if the host's response includes that relation, so re-read with `roles.get(id, { select: [...] })` when you need the current list.

## Errors

`assign` and `detach` (and their empty-ids fetch) carry `module: 'permissions'`. 401 is `unauthenticated`, 403 `forbidden`, 422 `validation`. They are calls on a specific role, so a 404 stays `not_found` (the role does not exist); it is never mapped to `module_disabled`. The `roles` and `permissions` tables are plain core tables (`module` is null).
