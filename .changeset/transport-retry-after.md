---
"@sokpheak/sp-laravel-api": minor
---

`SpApiError` gains `isTransport` (status 0 with code `network` or `timeout`; not other local errors such as `unencodable_value`) and `isHttp` (status above 0).

`retryAfter` now resolves from the `Retry-After` header (any status, numeric seconds `>= 0`; it was only read for 429, so it is now set for non-429 statuses that carry the header), then body `retry_after`, then `errors.retry_after_seconds` (first element or bare value, number or numeric string, must be above 0). Garbage, empty and non-positive values give `null`. `fieldErrors.retry_after_seconds` is kept, also for a bare number (`['12']`). This applies to both HTTP errors and `200 { success: false }` errors.

BREAKING: the message of a `network` / `timeout` error no longer includes the underlying error text (it may carry URLs or tokens); the original error stays on `err.cause`.
