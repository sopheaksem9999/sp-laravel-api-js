---
"@sokpheak/sp-laravel-api": minor
---

Cursor paging: new `direction?: 'next' | 'prev'` and `cursorColumn?: string` query options, sent as `direction=` and `cursor_column=` (both validated; `cursorColumn` follows the same rules as aggregate column names). `createCursorPagination` / `table.cursorPagination` take a `cursorColumn` option. `''` and `null` cursors still send `cursor=0`.

Fixed: `prevPage()` did not send `direction=prev`, so it returned the rows after the cursor instead of the rows before it; it now does. `lastPage()` assumed `sort: id asc` when the query had no `sort`, which could silently return the wrong rows: it now needs a `sort` and throws `SpApiError` `unencodable_value` without sending a request (the host's default sort depends on the table, so the client cannot know it). An omitted `order` in the `sort` is now treated as the host default (`desc`) when reversing. `lastPage()` on an empty or single short page returns `prev: null`.
