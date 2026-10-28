// Contract test for `realtime(api)`. This module makes no HTTP calls, so there is no replayed/live HTTP
// contract. The contract is the broadcast payload of the backend event class
// (sp-laravel-api src/Events/RecordMutated.php): channel `private-tenant.{id}` / `tenant.global` (empty
// tenant id), `broadcastAs` = `{table}.{action}`, `broadcastWith` = { table, action, record, tenant_id, timestamp }.
// The cases below are fixture-free: they feed that exact payload shape to the handler.
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src';
import { realtime } from '../../src/realtime';

const api = createApi({ baseUrl: 'https://host.test/api' });
const rt = realtime(api);

describe('realtime contract (RecordMutated broadcast payload)', () => {
  it('handles the broadcastWith shape for every backend action', () => {
    for (const action of ['created', 'updated', 'deleted', 'restored', 'upserted']) {
      const onChange = vi.fn();
      rt.handler({ onChange })({
        table: 'invoices',
        action,
        record: { id: 1 },
        tenant_id: 'acme',
        timestamp: '2026-10-26T00:00:00.000000Z',
      });
      expect(onChange).toHaveBeenCalledWith({
        table: 'invoices',
        action,
        record: { id: 1 },
        queryKey: api.keys.table('invoices'),
        raw: expect.objectContaining({ tenant_id: 'acme' }),
      });
    }
  });

  it('handles the batched bulk-upsert payload: record = { count, match_on, keys }', () => {
    const onChange = vi.fn();
    const record = { count: 2, match_on: ['ref'], keys: [{ ref: 'a' }, { ref: 'b' }] };
    rt.handler({ onChange })({ table: 'invoices', action: 'upserted', record, tenant_id: null, timestamp: 't' });
    expect(onChange.mock.calls[0]![0].record).toEqual(record);
  });

  it('names the channel and event like broadcastOn / broadcastAs', () => {
    expect(rt.channelName(null)).toBe('tenant.global'); // empty(tenantId) -> 'global'
    expect(rt.channelName(12)).toBe('tenant.12');
    expect(rt.eventName('invoices', 'created')).toBe('invoices.created');
  });

  // UNVERIFIED-CONTRACT: needs a live Reverb/Pusher server with record.broadcast_events = true.
  it.skip('receives a real broadcast through Laravel Echo', () => {});
});
