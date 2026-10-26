---
'@sopheak/sp-laravel-api': patch
---

`@sopheak/sp-laravel-api/attachments`: `folders.list()` now always sends `per_page` (it sent none without a filter, so the backend silently applied its default page size), and accepts paging options as its second argument (`{ perPage, cursor, page, signal }`). New `folders.listPage(where?, options?)` returns the core `Page` (`data`, `next`, `prev`, `total`, `meta`). `forRecord(table, id).list()` also sends `per_page`; the backend ignores it on that route and returns at most its default page of links (documented).
