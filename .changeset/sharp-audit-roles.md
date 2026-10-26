---
'@sopheak/sp-laravel-api': minor
---

Add the `@sopheak/sp-laravel-api/audit` and `@sopheak/sp-laravel-api/permissions` subpath modules. `audit(api)`: `list` (read-only `sp_audit_logs`), `stats`, `fieldTimeline` and `fieldStats` (no tenant option: the tenant comes from the tenant header; a 404 on the function routes is `module_disabled`). `permissions(api)`: `roles` (`sp_roles` CRUD), `permissions` (`sp_permissions`, list/get/update only), `assign` and `detach` (nested `permissions` write on the role; detach removes the link only).
