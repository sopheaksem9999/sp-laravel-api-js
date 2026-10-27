# `@sokpheak/sp-laravel-api/realtime`

Realtime helpers for Laravel broadcasting (`RecordMutated`).

The module is **transport-free by design**: it does not open a socket itself and adds no runtime dependencies. It provides two high-level helpers:
- **`subscribeTenant(echo, api, options)`**: binds all 5 mutation actions (`created`, `updated`, `deleted`, `restored`, `upserted`) for your specified tables with the required leading dot, attaches to `tenant.{id}` or `tenant.global`, and returns an unsubscribe function.
- **`echoPusherAuthorizer(auth, options)`**: custom authorizer for Laravel Echo and Pusher-compatible broadcasters that signs private channel requests via `/broadcasting/auth` using the client's `ApiAuth` token with automatic 401 retry.

For low-level integrations, `realtime(api).handler({ onChange })` can be wired to any custom WebSocket or SSE connection.

## Quick Start (with Laravel Echo & Reverb)

```ts
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
import * as Ably from 'ably';

const echo = new Echo({
  broadcaster: 'pusher',
  client: new Ably.Realtime({ key: 'ably-api-key' }),
});
```

#### 5. Redis / Socket.IO
```ts
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
- **Error handling:** Malformed payloads and unknown actions are ignored. A throwing `onChange` handler is swallowed and reported to `api.config.onEvent({ type: 'realtime_handler_error' })` without breaking the WebSocket connection.
