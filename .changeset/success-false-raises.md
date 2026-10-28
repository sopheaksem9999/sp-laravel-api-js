---
"@sokpheak/sp-laravel-api": minor
---

BREAKING (default): a 2xx response whose JSON body is an object with `success: false` now throws `SpApiError` instead of resolving with the body as `data`. `status` stays 2xx; `errorCode` and `message` come from the body; `code` follows the envelope `error_code` (10002 `unauthenticated`, 10008 `forbidden`, 10009 `not_found`, 10004 `validation`, 10010 `server`, otherwise `unknown`); a 10004 keyed by the tenant header is `tenant_required`. Bodies that are arrays, strings or `null`, and `responseType: 'text'` calls, are untouched. To keep the old behaviour set `createApi({ treatSuccessFalseAsError: false })`.

A `200` with `error_code` 10002 now calls `auth.handleUnauthorized` once and retries once, like a 401; without a hook, or when it resolves `false`, the error is thrown at once. A throwing hook propagates unchanged.

Fixed: a 401 that arrived after a network or status retry never called `handleUnauthorized` (the refresh was tied to the first attempt); one refresh per call is now allowed whenever the 401 happens.
