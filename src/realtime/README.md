# `@sokpheak/sp-laravel-api/realtime`

```ts
// typecheck
import { realtime } from '@sokpheak/sp-laravel-api/realtime';

const rt = realtime(api);
const onBroadcast = rt.handler({
  onChange: (change) => queryClient.invalidateQueries({ queryKey: change.queryKey }),
});
```

The module is transport-free: `handler` returns a callback that takes the broadcast payload `{ table, action, record, tenant_id, timestamp }` and calls `onChange({ table, action, record, queryKey })`, where `queryKey` is `api.keys.table(table)` (the prefix of every list and get key of that table). Wire it to Laravel Echo (Reverb or Pusher), plain Pusher, SSE or anything else. The host must have `record.broadcast_events` on; the private channel `tenant.{id}` is authorised by the host's `/broadcasting/auth` route, which your Echo config must call with the same bearer token and tenant header as the API.

React:

```tsx
// typecheck
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { realtime } from '@sokpheak/sp-laravel-api/realtime';

function useRealtime(echo: Echo, tenantId: number | null, tables: string[]) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const rt = realtime(api);
    const onBroadcast = rt.handler({
      onChange: (c) => queryClient.invalidateQueries({ queryKey: c.queryKey }),
    });
    const name = rt.channelName(tenantId); // 'tenant.5' or 'tenant.global'
    const channel = echo.private(name);
    for (const t of tables)
      for (const a of ['created', 'updated', 'deleted', 'restored', 'upserted'])
        channel.listen('.' + rt.eventName(t, a), onBroadcast); // leading dot: the name is custom, not a class name
    return () => echo.leave(name);
  }, [tenantId, queryClient, tables]);
}
```

Vue:

```ts
// typecheck
import { watchEffect, type Ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { realtime } from '@sokpheak/sp-laravel-api/realtime';

export function useRealtime(echo: Echo, tenantId: Ref<number | null>, tables: string[]) {
  const queryClient = useQueryClient();
  const rt = realtime(api);
  const onBroadcast = rt.handler({
    onChange: (c) => queryClient.invalidateQueries({ queryKey: c.queryKey }),
  });
  watchEffect((onCleanup) => {
    const name = rt.channelName(tenantId.value);
    const channel = echo.private(name);
    for (const t of tables)
      for (const a of ['created', 'updated', 'deleted', 'restored', 'upserted'])
        channel.listen('.' + rt.eventName(t, a), onBroadcast);
    onCleanup(() => echo.leave(name));
  });
}
```

- The backend event is named `{table}.{action}` through `broadcastAs()`, so Echo needs the **leading dot** (`.invoices.created`); without it Echo prefixes its own namespace and never matches.
- The channel is `private-tenant.{id}` on the wire; Echo adds `private-` itself. With no tenant id (empty, `0`, `'0'`) the backend uses `tenant.global`, and so does `channelName`.
- Bulk upsert broadcasts once, as one batched `upserted` event, with `record = { count, match_on, keys }` (the match keys of every upserted row; no full rows). Treat it as "this table changed" and invalidate. Hosts older than 0.5.06 do not broadcast bulk upsert at all. Force delete broadcasts `deleted`.
- A malformed payload, or an `action` the client does not know, is ignored. The callback never throws; an `onChange` that throws is swallowed and reported through `onEvent` as `{ type: 'realtime_handler_error' }` with a fixed message and no payload data.
- With `bulk(table).*({ async: true })` the only way to see completion is the realtime events (or re-reading).
