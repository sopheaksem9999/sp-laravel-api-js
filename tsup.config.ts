import { defineConfig } from 'tsup';

// Each module task adds its own entry here and its subpath in package.json "exports".
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      bulk: 'src/bulk/index.ts',
      attachments: 'src/attachments/index.ts',
      audit: 'src/audit/index.ts',
      permissions: 'src/permissions/index.ts',
      webhooks: 'src/webhooks/index.ts',
      realtime: 'src/realtime/index.ts',
      docs: 'src/docs/index.ts',
    },
    // Share core code (SpApiError) between entries in CJS too, so `instanceof` works across subpaths.
    splitting: true,
    format: ['esm', 'cjs'],
    target: 'es2020',
    dts: true,
    // dist/cli/ belongs to the CLI build below (built concurrently): never clean it from here.
    clean: ['!cli/**'],
    sourcemap: true,
    treeshake: true,
  },
  {
    // The `sp-laravel-api` bin (Node only, may use node: imports; check-dist exempts dist/cli/).
    // Self-contained: it bundles its own code and imports nothing from the package entries above.
    entry: { index: 'src/cli/index.ts' },
    outDir: 'dist/cli',
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    splitting: false,
    dts: false,
    clean: true,
    sourcemap: false,
    treeshake: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
