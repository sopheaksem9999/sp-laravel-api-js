// Guard: dist/ must not import Node built-ins, so the package runs in browsers and edge runtimes. Catches static
// (`from "node:x"`), side-effect (`import "node:x"`), dynamic (`import("node:x")`) and CJS (`require("node:x")`)
// forms, with the `node:` prefix or as a bare builtin (`from "fs"`, `require("path")`; list in module-markers.mjs).
// dist/cli/ is exempt (Node-only CLI).
//
// Module markers (MODULE_MARKERS_BY_MODULE) live in scripts/module-markers.mjs, shared with check-bundle.mjs;
// a new module adds its markers there (see the steps at the top of that file), never here.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULE_MARKERS, MODULE_MARKERS_BY_MODULE, NODE_IMPORT_RE, NODE_ONLY_DIST_DIRS } from './module-markers.mjs';

// CHECK_DIST_ROOT: point the guard at another directory (used only to demonstrate it fails on a planted file).
const root = process.env.CHECK_DIST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const NODE_IMPORT = NODE_IMPORT_RE;
const bad = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      if (NODE_ONLY_DIST_DIRS.includes(rel)) continue;
      walk(full);
    } else if (NODE_IMPORT.test(readFileSync(full, 'utf8'))) {
      bad.push(rel.split(sep).join('/'));
    }
  }
}

try {
  walk(root);
} catch (e) {
  console.error(`check-dist: cannot read dist/ (${e.message}). Run the build first.`);
  process.exit(1);
}
if (bad.length) {
  console.error(`check-dist: Node built-in imports found in dist (node:x or a bare builtin):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

// The core import graph must hold no module code (bundle-size acceptance: importing only the main entry
// pulls in no module). Follow every relative import/require from the two main entries.
// Each marker must be a literal that really appears in that module's own dist file (guarded below, so a
// marker that the bundler never emits cannot pass vacuously).
const vacuous = [];
for (const [mod, markers] of Object.entries(MODULE_MARKERS_BY_MODULE)) {
  for (const ext of ['js', 'cjs']) {
    const text = readFileSync(join(root, `${mod}.${ext}`), 'utf8');
    for (const m of markers) if (!text.includes(m)) vacuous.push(`dist/${mod}.${ext} lacks marker "${m}"`);
  }
}
if (vacuous.length) {
  console.error(`check-dist: vacuous module markers (not emitted in their own module file):\n  ${vacuous.join('\n  ')}`);
  process.exit(1);
}
const seen = new Set();
const leaks = [];
function follow(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const m of MODULE_MARKERS) if (text.includes(m)) leaks.push(`${relative(root, file)} contains "${m}"`);
  for (const m of text.matchAll(/(?:from|require\()\s*["'](\.[^"']+)["']/g)) follow(resolve(dirname(file), m[1]));
  for (const m of text.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) follow(resolve(dirname(file), m[1]));
}
try {
  follow(join(root, 'index.js'));
  follow(join(root, 'index.cjs'));
} catch (e) {
  console.error(`check-dist: cannot follow the core import graph (${e.message}).`);
  process.exit(1);
}
if (leaks.length) {
  console.error(`check-dist: module code reachable from the main entry:\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
const cliHit = [...seen].filter((f) => relative(root, f).split(sep)[0] === 'cli');
if (cliHit.length) {
  console.error(`check-dist: the main entry reaches the Node-only CLI:\n  ${cliHit.map((f) => relative(root, f)).join('\n  ')}`);
  process.exit(1);
}

// The bin: dist/cli/index.js exists, is a Node script, and is self-contained (imports no package entry or chunk,
// so the CLI never drags module code along and the entries never depend on it).
let cli;
try {
  cli = readFileSync(join(root, 'cli', 'index.js'), 'utf8');
} catch (e) {
  console.error(`check-dist: dist/cli/index.js is missing (${e.message}).`);
  process.exit(1);
}
if (!cli.startsWith('#!/usr/bin/env node\n')) {
  console.error('check-dist: dist/cli/index.js does not start with the "#!/usr/bin/env node" shebang');
  process.exit(1);
}
if (/(?:from|require\(|import\()\s*["']\./.test(cli)) {
  console.error('check-dist: dist/cli/index.js imports relative files; the CLI must be bundled self-contained');
  process.exit(1);
}

// One SpApiError class across entries in CJS: an error thrown by a module must pass `instanceof` from the main entry.
const require = createRequire(import.meta.url);
const core = require(join(root, 'index.cjs'));
const mod = require(join(root, 'bulk.cjs'));
const api = core.createApi({ baseUrl: 'https://x.test', fetch: async () => new Response('{}', { status: 422 }) });
const thrown = await mod.bulk(api.table('t')).create([{}]).catch((e) => e);
if (!(thrown instanceof core.SpApiError)) {
  console.error('check-dist: bulk.cjs throws an SpApiError that is not instanceof the main entry SpApiError (splitting off?)');
  process.exit(1);
}
const att = require(join(root, 'attachments.cjs'));
const attApi = core.createApi({ baseUrl: 'https://x.test', fetch: async () => new Response('{}', { status: 422 }) });
const attThrown = await att.attachments(attApi).cloneTemp(1).catch((e) => e);
if (!(attThrown instanceof core.SpApiError)) {
  console.error('check-dist: attachments.cjs throws an SpApiError that is not instanceof the main entry SpApiError (splitting off?)');
  process.exit(1);
}
const aud = require(join(root, 'audit.cjs'));
const audApi = core.createApi({ baseUrl: 'https://x.test', fetch: async () => new Response('{}', { status: 403 }) });
const audThrown = await aud.audit(audApi).stats().catch((e) => e);
if (!(audThrown instanceof core.SpApiError)) {
  console.error('check-dist: audit.cjs throws an SpApiError that is not instanceof the main entry SpApiError (splitting off?)');
  process.exit(1);
}
const perm = require(join(root, 'permissions.cjs'));
const permApi = core.createApi({ baseUrl: 'https://x.test', fetch: async () => new Response('{}', { status: 403 }) });
const permThrown = await perm.permissions(permApi).assign(1, [1]).catch((e) => e);
if (!(permThrown instanceof core.SpApiError)) {
  console.error('check-dist: permissions.cjs throws an SpApiError that is not instanceof the main entry SpApiError (splitting off?)');
  process.exit(1);
}
const hook = require(join(root, 'webhooks.cjs'));
const hookThrown = (() => {
  try {
    hook.parseWebhook({ headers: {}, rawBody: '{}' });
  } catch (e) {
    return e;
  }
  return null;
})();
if (!(hookThrown instanceof core.SpApiError)) {
  console.error('check-dist: webhooks.cjs throws an SpApiError that is not instanceof the main entry SpApiError (splitting off?)');
  process.exit(1);
}
const docsMod = require(join(root, 'docs.cjs'));
const docsApi = core.createApi({ baseUrl: 'https://x.test', fetch: async () => new Response('{}', { status: 403 }) });
const docsThrown = await docsMod.capabilities(docsApi).catch((e) => e);
if (!(docsThrown instanceof core.SpApiError)) {
  console.error('check-dist: docs.cjs throws an SpApiError that is not instanceof the main entry SpApiError (splitting off?)');
  process.exit(1);
}
// realtime throws no SpApiError (no HTTP, never throws), so it has no CJS instanceof check.
console.log('check-dist: ok');
