// Guard: dist/ must not import Node built-ins (`node:` specifiers), so the
// package runs in browsers and edge runtimes. dist/cli/ is exempt (Node-only CLI).
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const NODE_IMPORT = /(from|require\()\s*["']node:/;
const bad = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      if (rel === 'cli') continue;
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
  console.error(`check-dist: node: imports found in dist:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

// The core import graph must hold no module code (bundle-size acceptance: importing only the main entry
// pulls in no module). Follow every relative import/require from the two main entries.
// Each marker must be a literal that really appears in that module's own dist file (guarded below, so a
// marker that the bundler never emits cannot pass vacuously).
const MODULE_MARKERS_BY_MODULE = {
  bulk: ['bulk/create', 'bulk/upsert'],
  attachments: ['sp_attachments', 'clone-temp', 'attachment_ids'],
};
const MODULE_MARKERS = Object.values(MODULE_MARKERS_BY_MODULE).flat();
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
console.log('check-dist: ok');
