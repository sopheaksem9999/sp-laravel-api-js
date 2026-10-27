import { describe, expect, it } from 'vitest';
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { createApi } from '../../src';
import type { RealtimeChange } from '../../src/realtime';
import { echoPusherAuthorizer, subscribeTenant } from '../../src/realtime';

const reverbUrl = process.env.SP_REVERB_URL;
const contractUrl = process.env.SP_CONTRACT_URL ?? 'http://127.0.0.1:8000';
const token = process.env.SP_CONTRACT_TOKEN ?? 'test-token';

describe('realtime contract with real Reverb server', () => {
  it.skipIf(!reverbUrl)('connects to real Reverb, authorizes private channel and receives live broadcasts', async () => {
    // Make Pusher available globally for Echo
    (globalThis as unknown as { Pusher: typeof Pusher }).Pusher = Pusher;

    const url = new URL(reverbUrl!);
    const auth = { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) };
    const api = createApi({
      baseUrl: contractUrl,
      auth,
    });

    const echo = new Echo({
      broadcaster: 'reverb',
      key: process.env.REVERB_APP_KEY ?? 'reverb-test-key',
      wsHost: url.hostname,
      wsPort: parseInt(url.port || '8080', 10),
      forceTLS: url.protocol === 'wss:',
      enabledTransports: ['ws', 'wss'],
      authorizer: echoPusherAuthorizer(auth, {
        authEndpoint: `${contractUrl}/broadcasting/auth`,
      }),
    });

    const events: RealtimeChange[] = [];
    const unsubscribe = subscribeTenant(echo, api, {
      tenantId: 1,
      tables: ['invoices'],
      onChange: (change) => events.push(change),
    });

    const waitForEvent = (predicate: (c: RealtimeChange) => boolean, timeoutMs = 5000): Promise<RealtimeChange> => {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          const found = events.find(predicate);
          if (found) return resolve(found);
          if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for realtime event'));
          setTimeout(check, 50);
        };
        check();
      });
    };

    try {
      const invoices = api.table<{ id: number; ref_number: string; total: number }>('invoices');

      // 1. Create
      const created = await invoices.create({ ref_number: 'INV-LIVE', total: 50 });
      const createdEvt = await waitForEvent((c) => c.action === 'created');
      expect(createdEvt.table).toBe('invoices');
      expect(createdEvt.queryKey).toEqual(api.keys.table('invoices'));

      // 2. Update
      await invoices.update(created.id, { total: 75 });
      const updatedEvt = await waitForEvent((c) => c.action === 'updated');
      expect(updatedEvt.table).toBe('invoices');

      // 3. Upsert
      await invoices.upsert({ ref_number: 'INV-LIVE', total: 80 }, { matchOn: ['ref_number'] });
      const upsertedEvt = await waitForEvent((c) => c.action === 'upserted');
      expect(upsertedEvt.action).toBe('upserted');

      // 4. Remove
      await invoices.remove(created.id);
      const deletedEvt = await waitForEvent((c) => c.action === 'deleted');
      expect(deletedEvt.action).toBe('deleted');

      // 5. Restore
      await invoices.restore(created.id);
      const restoredEvt = await waitForEvent((c) => c.action === 'restored');
      expect(restoredEvt.action).toBe('restored');
    } finally {
      unsubscribe();
      echo.disconnect();
    }
  });
});
