// Contract of the `@sokpheak/sp-laravel-api/logging` subpath: what core may rely on (the `RequestLogger` shape),
// without a backend. The main entry must not carry the logging code (guarded by check-dist and check-bundle markers).
import { describe, expect, it } from 'vitest';
import * as main from '../../src';
import { createLogger } from '../../src/logging';

describe('logging subpath contract', () => {
  it('exposes createLogger and nothing logging-related leaks into the main entry', () => {
    expect(typeof createLogger).toBe('function');
    expect(Object.keys(main).filter((k) => /log/i.test(k))).toEqual([]);
  });

  it('createLogger returns an object core can drive through start() and finish()', () => {
    const got: unknown[] = [];
    const logger = createLogger({ sink: (e) => void got.push(e), mode: 'all' });
    const attempt = logger.start({ method: 'GET', url: 'https://api.example.com/api/x?token=T1', log: undefined, body: undefined, tenantHeader: undefined });
    expect(attempt).toBeDefined();
    attempt?.finish({ attempt: 1, t0: Date.now(), sent: new Headers(), kind: 'network' });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ method: 'GET', url: 'https://api.example.com/api/x?token=<redacted>', status: null, code: 'network', attempt: 1 });
  });

  it('start returns undefined when the mode or the call says no', () => {
    const ctx = { method: 'GET', url: 'https://a.example.com/x', body: undefined, tenantHeader: undefined };
    expect(createLogger({ sink: () => {}, mode: 'off' }).start({ ...ctx, log: true })).toBeUndefined();
    expect(createLogger({ sink: () => {} }).start({ ...ctx, log: undefined })).toBeUndefined();
    expect(createLogger({ sink: () => {} }).start({ ...ctx, log: true })).toBeDefined();
  });
});
