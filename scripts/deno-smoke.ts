// Runtime smoke test for Deno and Bun (spec §7 runtime matrix). Imports the BUILT ESM entries by file URL (no npm
// resolution, no Node globals needed) and runs a tiny flow against a fake fetch:
//   deno run --allow-read scripts/deno-smoke.ts      bun run scripts/deno-smoke.ts
// Needs `pnpm build` first. Any failed check throws, so the process exits non-zero.
const runtime = globalThis as { Deno?: { version?: { deno?: string } }; Bun?: { version?: string } };
const name = runtime.Bun ? `bun ${runtime.Bun.version}` : runtime.Deno ? `deno ${runtime.Deno.version?.deno}` : 'unknown runtime';

const entry = (file: string): string => new URL(`../dist/${file}`, import.meta.url).href;
const core = await import(entry('index.js'));
const hooks = await import(entry('webhooks.js'));

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`deno-smoke (${name}): ${what}`);
  console.log(`  ok  ${what}`);
}

console.log(`deno-smoke: @sokpheak/sp-laravel-api on ${name}`);
const seen: string[] = [];
const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
  seen.push(String(input));
  const body = seen.length === 1 ? { success: true, data: [{ id: 1 }, { id: 2 }], meta: { next_cursor: 'c2' } } : { success: true, data: [], meta: {} };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const api = core.createApi({ baseUrl: 'https://host.test/api', fetch: fakeFetch });
const page = await api.table('products').list({ perPage: 2, cursor: null });
check(page.data.length === 2 && page.next === 'c2', 'createApi().table().list() returns a cursor page');
const url = new URL(seen[0] ?? '');
check(url.searchParams.get('per_page') === '2' && url.searchParams.get('cursor') === '0', 'list sends per_page and cursor=0');

const failing = core.createApi({ baseUrl: 'https://host.test/api', fetch: async () => new Response('{}', { status: 404 }) });
const err = await failing.table('x').get(1).catch((e: unknown) => e);
check(err instanceof core.SpApiError && (err as { code?: string }).code === 'not_found', 'a 404 rejects with SpApiError not_found');

// verifyWebhook: HMAC-SHA256 hex of the raw body with Web Crypto, as the backend's hash_hmac('sha256', ...).
const secret = 'whsec_smoke';
const body = '{"event":"created"}';
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
check((await hooks.verifyWebhook(body, hex, secret)) === true, 'verifyWebhook accepts a valid signature');
check((await hooks.verifyWebhook(body, hex, 'other')) === false, 'verifyWebhook rejects a wrong secret');
console.log(`deno-smoke: ok (${name})`);
