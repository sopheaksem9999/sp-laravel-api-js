---
"@sokpheak/sp-laravel-api": minor
---

Added `serializeFilters(query, { quoting, driver? })`: the query parameters for `select`, `where`, `or`, `search`, `aggregate`, `groupBy`, `distinct`, `trashed` and `sort`, without any paging. It quotes values exactly like `serializeQuery`, but never adds `per_page`, `page`, `cursor`, `direction`, `cursor_column` or `total`, for hosts that run their own list layer and set paging themselves. A paging key in an object literal is a type error, and a query that carries one (for example a `Query` variable) throws `unencodable_value`. `serializeQuery` is unchanged. The types `FilterQuery` and `FilterSerializeOptions` are exported.
