import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src';
import type { EchoChannelLike, EchoLike } from '../../src/realtime';
import { subscribeTenant } from '../../src/realtime';

function createMockEcho(): {
  echo: EchoLike;
  channels: Map<string, { channel: EchoChannelLike; listeners: Map<string, Array<(payload: unknown) => void>> }>;
  leftChannels: string[];
} {
  const leftChannels: string[] = [];
  const channels = new Map<
    string,
    { channel: EchoChannelLike; listeners: Map<string, Array<(payload: unknown) => void>> }
  >();

  const echo: EchoLike = {
    private(name: string) {
      if (!channels.has(name)) {
        const listeners = new Map<string, Array<(payload: unknown) => void>>();
        const channel: EchoChannelLike = {
          listen(event: string, callback: (p: unknown) => void) {
            const list = listeners.get(event) ?? [];
            list.push(callback);
            listeners.set(event, list);
            return channel;
          },
          stopListening(event: string, callback?: (p: unknown) => void) {
            if (!callback) {
              listeners.delete(event);
            } else {
              const list = listeners.get(event);
              if (list) {
                const idx = list.indexOf(callback);
                if (idx !== -1) list.splice(idx, 1);
              }
            }
            return channel;
          },
        };
        channels.set(name, { channel, listeners });
      }
      return channels.get(name)!.channel;
    },
    leave(name: string) {
      leftChannels.push(name);
    },
  };

  return { echo, channels, leftChannels };
}

describe('subscribeTenant', () => {
  const api = createApi({ baseUrl: 'https://api.example.com' });

  it('subscribes to echo.private with tenant.{id}', () => {
    const { echo, channels } = createMockEcho();
    const onChange = vi.fn();

    subscribeTenant(echo, api, {
      tenantId: 5,
      tables: ['invoices'],
      onChange,
    });

    expect(channels.has('tenant.5')).toBe(true);
    const entry = channels.get('tenant.5')!;
    expect(entry.listeners.has('.invoices.created')).toBe(true);
    expect(entry.listeners.has('.invoices.updated')).toBe(true);
    expect(entry.listeners.has('.invoices.deleted')).toBe(true);
    expect(entry.listeners.has('.invoices.restored')).toBe(true);
    expect(entry.listeners.has('.invoices.upserted')).toBe(true);
  });

  it('falls back to tenant.global when tenantId is empty or 0', () => {
    const { echo, channels } = createMockEcho();
    subscribeTenant(echo, api, {
      tenantId: null,
      tables: ['invoices'],
      onChange: vi.fn(),
    });
    expect(channels.has('tenant.global')).toBe(true);
  });

  it('normalizes redundant private- prefix if passed as tenantId or channel name', () => {
    const { echo, channels } = createMockEcho();
    subscribeTenant(echo, api, {
      tenantId: 'private-tenant.42' as unknown as number,
      tables: ['invoices'],
      onChange: vi.fn(),
    });
    expect(channels.has('tenant.42')).toBe(true);
    expect(channels.has('private-tenant.42')).toBe(false);
  });

  it('binds all 5 mutation actions across specified tables with leading dots', () => {
    const { echo, channels } = createMockEcho();
    const onChange = vi.fn();

    subscribeTenant(echo, api, {
      tenantId: 10,
      tables: ['invoices', 'products'],
      onChange,
    });

    const entry = channels.get('tenant.10')!;
    for (const table of ['invoices', 'products']) {
      for (const action of ['created', 'updated', 'deleted', 'restored', 'upserted']) {
        expect(entry.listeners.has(`.${table}.${action}`)).toBe(true);
      }
    }
  });

  it('binds nothing when tables array is empty', () => {
    const { echo, channels } = createMockEcho();
    subscribeTenant(echo, api, {
      tenantId: 1,
      tables: [],
      onChange: vi.fn(),
    });

    const entry = channels.get('tenant.1')!;
    expect(entry.listeners.size).toBe(0);
  });

  it('delivers change payloads to onChange when event fires', () => {
    const { echo, channels } = createMockEcho();
    const onChange = vi.fn();

    subscribeTenant(echo, api, {
      tenantId: 7,
      tables: ['invoices'],
      onChange,
    });

    const listeners = channels.get('tenant.7')!.listeners.get('.invoices.created')!;
    expect(listeners).toHaveLength(1);

    listeners[0]!({
      table: 'invoices',
      action: 'created',
      record: { id: 100, total: 200 },
      tenant_id: 7,
      timestamp: '2026-10-27T00:00:00Z',
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      table: 'invoices',
      action: 'created',
      record: { id: 100, total: 200 },
      queryKey: api.keys.table('invoices'),
      eventName: 'invoices.created',
      raw: expect.objectContaining({ tenant_id: 7 }),
    });
  });

  it('returns an unsubscribe function that removes listeners and leaves channel', () => {
    const { echo, channels, leftChannels } = createMockEcho();
    const unsubscribe = subscribeTenant(echo, api, {
      tenantId: 5,
      tables: ['invoices'],
      onChange: vi.fn(),
    });

    const entry = channels.get('tenant.5')!;
    expect(entry.listeners.get('.invoices.created')).toHaveLength(1);

    unsubscribe();

    expect(entry.listeners.get('.invoices.created')).toHaveLength(0);
    expect(leftChannels).toContain('tenant.5');
  });

  it('swallows throwing onChange and delegates to onEvent', () => {
    const events: unknown[] = [];
    const eventApi = createApi({
      baseUrl: 'https://api.example.com',
      onEvent: (e) => events.push(e),
    });

    const { echo, channels } = createMockEcho();
    subscribeTenant(echo, eventApi, {
      tenantId: 1,
      tables: ['invoices'],
      onChange: () => {
        throw new Error('onChange explosion');
      },
    });

    const listener = channels.get('tenant.1')!.listeners.get('.invoices.created')![0]!;
    expect(() =>
      listener({
        table: 'invoices',
        action: 'created',
        record: {},
      }),
    ).not.toThrow();

    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('realtime_handler_error');
  });

  it('binds custom events as-is, delivers to onUnhandled with the name, and unsubscribes exactly them', () => {
    const { echo, channels } = createMockEcho();
    const onChange = vi.fn();
    const onUnhandled = vi.fn();
    const unsub = subscribeTenant(echo, api, {
      tenantId: 1,
      tables: ['orders'],
      events: ['.courier_location.updated'],
      onChange,
      onUnhandled,
    });
    const l = channels.get('tenant.1')!.listeners;
    expect(l.get('.courier_location.updated')).toHaveLength(1);
    const p = { courier_id: 3, lat: 1, lng: 2 };
    l.get('.courier_location.updated')![0]!(p);
    expect(onChange).not.toHaveBeenCalled();
    expect(onUnhandled.mock.calls[0]![0].payload).toBe(p);
    expect(onUnhandled.mock.calls[0]![0].eventName).toBe('courier_location.updated');
    unsub();
    expect(l.get('.courier_location.updated')).toHaveLength(0);
    expect(l.get('.orders.created')).toHaveLength(0);
  });
});
