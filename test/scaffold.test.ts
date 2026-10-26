import { describe, expect, it } from 'vitest';
// JSON import (not node:fs) so this test also runs in the edge-runtime project.
import pkg from '../package.json';
import { VERSION } from '../src/index';

describe('scaffold', () => {
  it('exports a VERSION string', () => {
    expect(typeof VERSION).toBe('string');
  });

  it('package.json carries the binding constraints', () => {
    expect(pkg.engines.node).toBe('>=20');
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.license).toBe('MIT');
  });
});
