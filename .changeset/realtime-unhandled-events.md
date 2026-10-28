---
"@sokpheak/sp-laravel-api": minor
---

Realtime: non-record events and the raw payload (L6, L7). `RealtimeChange` gains `raw` (the payload as received, same object) and `eventName` (the bound event name without the leading dot). `handler` and `subscribeTenant` accept an optional `onUnhandled({ eventName, payload })`, called for payloads that are not valid record events (non-object, no string `table`, unknown action, custom events), with the same swallow-and-report-once rules as `onChange`; without it such payloads are ignored as before. The callback returned by `handler` is now `(payload, eventName?)`. `subscribeTenant({ events })` binds custom Echo event names as-is. `onChange` keeps its meaning: it only receives valid record events. BREAKING: `raw` is required on `RealtimeChange`, so a hand-built `RealtimeChange` object (for example in a test) must now include it.
