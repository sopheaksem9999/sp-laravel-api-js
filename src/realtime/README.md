# `@sokpheak/sp-laravel-api/realtime`

Realtime helpers for Laravel broadcasting (`RecordMutated`).

The module is **transport-free by design**: it does not open a socket itself and adds no runtime dependencies. It provides two high-level helpers:
- **`subscribeTenant(echo, api, options)`**: binds all 5 mutation actions (`created`, `updated`, `deleted`, `restored`, `upserted`) for your specified tables with the required leading dot, attaches to `tenant.{id}` or `tenant.global`, and returns an unsubscribe function.
- **`echoPusherAuthorizer(auth, options)`**: custom authorizer for Laravel Echo and Pusher-compatible broadcasters that signs private channel requests via `/broadcasting/auth` using the client's `ApiAuth` token with automatic 401 retry.

For low-level integrations, `realtime(api).handler({ onChange, onUnhandled? })` returns a `(payload, eventName?) => void` callback that can be wired to any custom WebSocket or SSE connection.

## Quick Start (with Laravel Echo & Reverb)

```ts
// illustrative
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { createApi } from '@sokpheak/sp-laravel-api';
import { echoPusherAuthorizer, subscribeTenant } from '@sokpheak/sp-laravel-api/realtime';

const api = createApi({
  baseUrl: 'https://api.example.com/api/v2',
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
});

const echo = new Echo({
  broadcaster: 'reverb',
  key: 'reverb-app-key',
  wsHost: 'api.example.com',
  wsPort: 8080,
  wssPort: 443,
  forceTLS: true,
  enabledTransports: ['ws', 'wss'],
  authorizer: echoPusherAuthorizer(api.config.auth, {
    authEndpoint: 'https://api.example.com/broadcasting/auth',
  }),
});

// Subscribes to private-tenant.5 on the wire, listening to .invoices.created, .invoices.updated, etc.
const unsubscribe = subscribeTenant(echo, api, {
  tenantId: 5,
  tables: ['invoices'],
  onChange: (change) => {
    console.log(change.table, change.action, change.record);
    queryClient.invalidateQueries({ queryKey: change.queryKey });
  },
});

// Later, to clean up:
unsubscribe();
```

## Custom events, `onUnhandled`, `eventName` and `raw`

`onChange` only receives valid record events: an object with a non-empty string `table` and one of the five actions. It gets a `RealtimeChange`: `{ table, action, record, queryKey, raw, eventName? }`, where `raw` is the payload exactly as received (the same object, not a copy) and `eventName` is the bound event name without the leading dot (`orders.updated`), set when the transport passes it (`subscribeTenant` always does). A `RealtimeChange` you build by hand (a test, a custom transport) must include `raw`.

Every other payload (not an object, no string `table`, an unknown `action`, a custom event) is passed to the optional `onUnhandled({ eventName, payload })`, with the same rules as `onChange`: it never throws into the transport, and a throw or rejection is swallowed and reported once through `api.config.onEvent` as `{ type: 'realtime_handler_error' }`. Without `onUnhandled` those payloads are ignored.

`subscribeTenant` takes `events`, a list of custom Echo event names that are bound as-is (add the leading dot if Echo needs it). Their payloads go through the same check, so a custom event with a record-shaped payload reaches `onChange`, and anything else `onUnhandled`.

```ts
// typecheck
import { subscribeTenant, realtime, type EchoLike } from '@sokpheak/sp-laravel-api/realtime';

export function setupLiveCourier(echo: EchoLike) {
  return subscribeTenant(echo, api, {
    tenantId: 5,
    tables: ['orders'],
    events: ['.courier_location.moved'],
    onChange: (change) => console.log(change.eventName, change.action, change.raw),
    onUnhandled: ({ eventName, payload }) => console.log(eventName, payload),
  });
}

// Low level: wire the callback to any transport and pass the event name yourself.
const onMessage = realtime(api).handler({
  onChange: (change) => console.log(change.table),
  onUnhandled: ({ eventName, payload }) => console.log(eventName, payload),
});
onMessage({ table: 'orders', action: 'created', record: { id: 1 } }, 'orders.created');
```

## Framework Integration

### React

```tsx
// typecheck
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EchoLike } from '@sokpheak/sp-laravel-api/realtime';
import { subscribeTenant } from '@sokpheak/sp-laravel-api/realtime';

export function useRealtime(echo: EchoLike, tenantId: number | null, tables: string[]) {
  const queryClient = useQueryClient();
  useEffect(() => {
    return subscribeTenant(echo, api, {
      tenantId,
      tables,
      onChange: (change) => {
        queryClient.invalidateQueries({ queryKey: change.queryKey });
      },
    });
  }, [echo, tenantId, queryClient, tables]);
}
```

### Vue

```ts
// typecheck
import { watchEffect, type Ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import type { EchoLike } from '@sokpheak/sp-laravel-api/realtime';
import { subscribeTenant } from '@sokpheak/sp-laravel-api/realtime';

export function useRealtime(echo: EchoLike, tenantId: Ref<number | null>, tables: string[]) {
  const queryClient = useQueryClient();
  watchEffect((onCleanup) => {
    const unsubscribe = subscribeTenant(echo, api, {
      tenantId: tenantId.value,
      tables,
      onChange: (change) => {
        queryClient.invalidateQueries({ queryKey: change.queryKey });
      },
    });
    onCleanup(unsubscribe);
  });
}
```

## Broadcasting Services Support Matrix

| Broadcaster / Server | Echo Broadcaster | Authorizer | Notes |
|---|---|---|---|
| **Laravel Reverb** | `'reverb'` | `echoPusherAuthorizer` | Verified against real Reverb server |
| **Pusher Channels** (Hosted) | `'pusher'` | `echoPusherAuthorizer` | Pass `cluster: 'mt1'`, `forceTLS: true` |
| **Soketi / laravel-websockets** | `'pusher'` | `echoPusherAuthorizer` | Custom `wsHost`, `wsPort`, `disableStats: true` |
| **Ably** | `'pusher'` | Ably API key / client | Use `@ably/laravel-echo` or Ably Pusher-compatible endpoint |
| **Redis / Socket.IO** | `'socket.io'` | Socket.IO client | Use `client: io`, pass Bearer token in socket auth |

### Setup Examples

#### 1. Laravel Reverb
```ts
// illustrative
const echo = new Echo({
  broadcaster: 'reverb',
  key: 'reverb-key',
  wsHost: 'api.example.com',
  wsPort: 8080,
  wssPort: 443,
  forceTLS: true,
  enabledTransports: ['ws', 'wss'],
  authorizer: echoPusherAuthorizer(api.config.auth, { authEndpoint: 'https://api.example.com/broadcasting/auth' }),
});
```

#### 2. Pusher Channels (Hosted)
```ts
// illustrative
const echo = new Echo({
  broadcaster: 'pusher',
  key: 'pusher-key',
  cluster: 'mt1',
  forceTLS: true,
  authorizer: echoPusherAuthorizer(api.config.auth, { authEndpoint: 'https://api.example.com/broadcasting/auth' }),
});
```

#### 3. Soketi / laravel-websockets (Self-Hosted)
```ts
// illustrative
const echo = new Echo({
  broadcaster: 'pusher',
  key: 'soketi-app-key',
  wsHost: '127.0.0.1',
  wsPort: 6001,
  forceTLS: false,
  disableStats: true,
  enabledTransports: ['ws', 'wss'],
  authorizer: echoPusherAuthorizer(api.config.auth, { authEndpoint: '/broadcasting/auth' }),
});
```

#### 4. Ably
```ts
// illustrative
import * as Ably from 'ably';

const echo = new Echo({
  broadcaster: 'pusher',
  client: new Ably.Realtime({ key: 'ably-api-key' }),
});
```

#### 5. Redis / Socket.IO
```ts
// illustrative
import io from 'socket.io-client';

const echo = new Echo({
  broadcaster: 'socket.io',
  client: io,
  host: 'https://socket.example.com',
});
```

## Host-Side Requirements

1. **Enable Broadcasts:** Set `SP_BROADCAST_EVENTS=true` in `.env` (or configure `record.broadcast_events` in `config/sp-laravel-api.php`).
2. **Channel Authorization Callback:** In `routes/channels.php`:
   ```php
   Broadcast::channel('tenant.{id}', function ($user, $id) {
       return (int) $user->tenant_id === (int) $id;
   });
   ```
3. **Broadcasting Auth Route:** Ensure `/broadcasting/auth` is registered behind your API authentication guard.

## Technical Details

- **Leading dot:** The backend event is named `{table}.{action}` via `broadcastAs()`. In Echo, custom event names require a leading dot (`.invoices.created`). `subscribeTenant` prefixes this automatically.
- **Channel names:** The wire channel is `private-tenant.{id}` (or `private-tenant.global` when tenant ID is null, empty, `0` or `'0'`). Echo's `echo.private()` adds the `private-` prefix.
- **Payload format:** `{ table, action, record, tenant_id, timestamp }`.
- **Actions:** `created`, `updated`, `deleted`, `restored`, and batched `upserted` (`record = { count, match_on, keys }`).
- **Error handling:** Malformed payloads, unknown actions and custom events go to `onUnhandled` when given, and are ignored otherwise. A throwing (or rejecting) `onChange` or `onUnhandled` handler is swallowed and reported to `api.config.onEvent({ type: 'realtime_handler_error' })` without breaking the WebSocket connection.
