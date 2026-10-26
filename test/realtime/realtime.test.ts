import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src';
import type { RealtimeChange } from '../../src/realtime';
import { realtime } from '../../src/realtime';

function setup(onEvent?: (e: { type: string; [k: string]: unknown }) => void) {
  const api = createApi({ baseUrl: 'https://host.test/api', onEvent });
  return { api, rt: realtime(api) };
}

const payload = (action: string, extra: Record<string, unknown> = {}) => ({
  table: 'invoices',
  action,
  record: { id: 7, total: 10 },
  tenant_id: 5,
  timestamp: '2026-10-26T00:00:00.000000Z',
  ...extra,
});

describe('realtime handler', () => {
  it('maps a payload to onChange with the table prefix key', () => {
    const { api, rt } = setup();
    const seen: RealtimeChange[] = [];
    rt.handler({ onChange: (c) => seen.push(c) })(payload('created'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      table: 'invoices',
      action: 'created',
      record: { id: 7, total: 10 },
      queryKey: api.keys.table('invoices'),
    });
  });

  it.each(['created', 'updated', 'deleted', 'restored', 'upserted'])('accepts the %s action', (action) => {
    const { rt } = setup();
    const onChange = vi.fn();
    rt.handler({ onChange })(payload(action));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].action).toBe(action);
  });

  it('passes the batched upserted record through as is', () => {
    const { rt } = setup();
    const onChange = vi.fn();
    const record = { count: 2, match_on: ['ref'], keys: [{ ref: 'a' }, { ref: 'b' }] };
    rt.handler({ onChange })(payload('upserted', { record }));
    expect(onChange.mock.calls[0]![0].record).toBe(record);
  });

  it('passes record untouched when the payload has extra fields', () => {
    const { rt } = setup();
    const onChange = vi.fn();
    const record = { id: 1, nested: { a: [1, 2] } };
    rt.handler({ onChange })(payload('updated', { record, extra: 'x', more: { y: 1 } }));
    expect(onChange.mock.calls[0]![0].record).toBe(record);
    expect(Object.keys(onChange.mock.calls[0]![0]).sort()).toEqual(['action', 'queryKey', 'record', 'table']);
  });

  it('allows any record value', () => {
    const { rt } = setup();
    const onChange = vi.fn();
    rt.handler({ onChange })({ table: 't', action: 'deleted' });
    expect(onChange.mock.calls[0]![0].record).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'invoices.created'],
    ['a number', 5],
    ['an array', [payload('created')]],
    ['a missing table', { action: 'created', record: {} }],
    ['an empty table', payload('created', { table: '' })],
    ['a non-string table', payload('created', { table: 5 })],
    ['an unknown action', payload('exploded')],
    ['a missing action', { table: 'invoices', record: {} }],
    ['a non-string action', payload('created', { action: 1 })],
  ])('ignores %s without throwing', (_name, bad) => {
    const events: unknown[] = [];
    const { rt } = setup((e) => events.push(e));
    const onChange = vi.fn();
    const h = rt.handler({ onChange });
    expect(() => h(bad)).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('swallows an onChange that throws and reports realtime_handler_error without payload data', () => {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const { rt } = setup((e) => events.push(e));
    const h = rt.handler({
      onChange: () => {
        throw new Error('secret-record-value 12345');
      },
    });
    expect(() => h(payload('created'))).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('realtime_handler_error');
    const s = JSON.stringify(events[0]);
    expect(s).not.toContain('secret-record-value');
    expect(s).not.toContain('12345');
    expect(s).not.toContain('invoices');
  });

  it('does not break when onEvent itself throws or is absent', () => {
    const boom = setup(() => {
      throw new Error('x');
    });
    const h = boom.rt.handler({
      onChange: () => {
        throw new Error('y');
      },
    });
    expect(() => h(payload('created'))).not.toThrow();
    const none = setup();
    expect(() =>
      none.rt.handler({
        onChange: () => {
          throw new Error('y');
        },
      })(payload('created')),
    ).not.toThrow();
  });

  it('is reusable across many payloads, including after an error', () => {
    const { rt } = setup();
    const tables: string[] = [];
    let n = 0;
    const h = rt.handler({
      onChange: (c) => {
        if (++n === 2) throw new Error('once');
        tables.push(c.table);
      },
    });
    for (const t of ['a', 'b', 'c', 'd']) h({ table: t, action: 'updated', record: {} });
    expect(tables).toEqual(['a', 'c', 'd']);
  });
});

describe('realtime hostile payloads', () => {
  const boom = (): never => {
    throw new Error('hostile');
  };
  const getter = (key: string) => {
    const o: Record<string, unknown> = { table: 'invoices', action: 'created', record: {} };
    Object.defineProperty(o, key, { get: boom, enumerable: true });
    return o;
  };
  const circular: Record<string, unknown> = { table: 'invoices', action: 'created' };
  circular.record = circular;
  const cases: Array<[string, unknown]> = [
    ['table getter', getter('table')],
    ['action getter', getter('action')],
    ['record getter', getter('record')],
    ['proxy get trap', new Proxy({}, { get: boom })],
    ['proxy has trap', new Proxy({}, { has: boom, get: boom })],
    ['proxy ownKeys trap', new Proxy({}, { ownKeys: boom, get: boom })],
    ['array proxy', new Proxy([], { get: boom })],
  ];
  it.each(cases)('ignores a %s silently', (_n, bad) => {
    const events: unknown[] = [];
    const { rt } = setup((e) => events.push(e));
    const onChange = vi.fn();
    expect(() => rt.handler({ onChange })(bad)).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('handles a circular record without traversing it', () => {
    const { rt } = setup();
    const onChange = vi.fn();
    rt.handler({ onChange })(circular);
    expect(onChange.mock.calls[0]![0].record).toBe(circular);
  });

  it('reports a rejected promise from onChange once, without payload data', async () => {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const { rt } = setup((e) => events.push(e));
    const h = rt.handler({ onChange: () => Promise.reject(new Error('secret-value')) });
    expect(() => h(payload('created'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('realtime_handler_error');
    expect(JSON.stringify(events[0])).not.toContain('secret-value');
  });

  it('accepts an onChange returning a resolved promise without reporting', async () => {
    const events: unknown[] = [];
    const { rt } = setup((e) => events.push(e));
    rt.handler({ onChange: () => Promise.resolve(1) })(payload('created'));
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([]);
  });

  it('does not propagate a throwing onEvent from a rejected promise', async () => {
    const { rt } = setup(boom);
    rt.handler({ onChange: () => Promise.reject(new Error('x')) })(payload('created'));
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('realtime names', () => {
  const { rt } = setup();

  it('channelName falls back to tenant.global', () => {
    expect(rt.channelName(null)).toBe('tenant.global');
    expect(rt.channelName(undefined)).toBe('tenant.global');
    expect(rt.channelName()).toBe('tenant.global');
  });

  it('channelName mirrors the backend empty() check for blank ids', () => {
    expect(rt.channelName('')).toBe('tenant.global');
    expect(rt.channelName(0)).toBe('tenant.global');
    expect(rt.channelName('0')).toBe('tenant.global');
  });

  it('channelName uses the raw id', () => {
    expect(rt.channelName(5)).toBe('tenant.5');
    expect(rt.channelName('abc')).toBe('tenant.abc');
  });

  it('eventName is {table}.{action}', () => {
    expect(rt.eventName('invoices', 'created')).toBe('invoices.created');
    expect(rt.eventName('invoices', 'upserted')).toBe('invoices.upserted');
  });
});
