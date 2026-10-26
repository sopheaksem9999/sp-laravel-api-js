// CJS consumers must see one SpApiError class across the main entry and every subpath module.
// Needs a built dist/ (`pnpm build`; `pnpm check` builds first); skipped when dist is absent.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = join(process.cwd(), 'dist');
const built = existsSync(join(dist, 'bulk.cjs')) && existsSync(join(dist, 'index.cjs'));

describe.skipIf(!built)('CJS build', () => {
  const require = createRequire(import.meta.url);

  it('an error thrown by bulk passes instanceof SpApiError from the main entry', async () => {
    const core = require(join(dist, 'index.cjs')) as typeof import('../../src');
    const mod = require(join(dist, 'bulk.cjs')) as typeof import('../../src/bulk');
    const api = core.createApi({ baseUrl: 'https://x.test', fetch: async () => new Response('{}', { status: 422 }) });
    const err = await mod.bulk(api.table('t')).create([{}]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(core.SpApiError);
    expect(err).toMatchObject({ module: 'bulk', completedChunks: 0 });
  });

  it('the main entry does not contain bulk code', () => {
    expect(readFileSync(join(dist, 'index.cjs'), 'utf8')).not.toContain('bulk/create');
    expect(readFileSync(join(dist, 'index.js'), 'utf8')).not.toContain('bulk/create');
  });
});
