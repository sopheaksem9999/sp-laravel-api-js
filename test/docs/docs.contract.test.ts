// Contract tests for `docs(api)` and `capabilities(api)` against the sp-laravel-api-example backend (see contract/README.md).
// Live when SP_CONTRACT_URL is set; otherwise replays test/fixtures/<backend-version>/. With neither a
// backend nor fixtures the whole suite is SKIPPED (never silently passing).
import { describe, expect, it } from 'vitest';
import { SpApiError, createApi } from '../../src';
import { capabilities, docs } from '../../src/docs';
import { generateTypes } from '../../src/cli/generate';
import { liveOrReplay } from '../support/replay';

const { fetch: contractFetch, mode, baseUrl, hasFixtures } = liveOrReplay();
const token = process.env.SP_CONTRACT_TOKEN ?? 'replay-token';

const api = createApi({
  baseUrl,
  fetch: contractFetch,
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${token}` }) },
});

const docsPrivate = process.env.SP_CONTRACT_DOCS_PRIVATE === '1';

describe.skipIf((mode !== 'live' && !hasFixtures) || docsPrivate)('docs contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it('reads the OpenAPI document with per-table Read/Write schemas', async () => {
    const doc = (await docs(api).openapi()) as { openapi: string; paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    expect(doc.openapi).toBe('3.0.3');
    expect(typeof doc.paths).toBe('object');
    expect(Object.keys(doc.components.schemas).some((k) => k.endsWith('Read'))).toBe(true);
    expect(Object.keys(doc.components.schemas).some((k) => k.endsWith('Write'))).toBe(true);
  });

  it('reads llms.txt as markdown text', async () => {
    const text = await docs(api).llms();
    expect(typeof text).toBe('string');
    expect(text).toContain('# SP Laravel API Agent Contract');
  });

  it('capabilities() reports booleans and typegen accepts the live document', async () => {
    const caps = await capabilities(api);
    expect(caps).not.toBe('unknown');
    if (caps === 'unknown') return;
    expect(caps.docs).toBe(true);
    expect(caps.permissions).toBe(true);
    expect(typeof caps.audit).toBe('boolean');
    const out = generateTypes(await docs(api).openapi());
    expect(out).toContain('export interface Tables {');
  });
});

// Private-docs case: needs a host with `record.api_docs.is_private` true. Gated on an explicit env flag.
describe('docs private contract (sp-laravel-api-example)', () => {
  // UNVERIFIED-CONTRACT: never run against a live backend yet; fixtures not recorded.
  it.skipIf((mode !== 'live' && !hasFixtures) || !docsPrivate)("openapi() -> module_disabled; capabilities() -> 'unknown'", async () => {
    const e = await docs(api)
      .openapi()
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(SpApiError);
    expect((e as SpApiError).code).toBe('module_disabled');
    expect((e as SpApiError).module).toBe('docs');
    expect(await capabilities(api, { refresh: true })).toBe('unknown');
  });
});
