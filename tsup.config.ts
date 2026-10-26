import { defineConfig } from 'tsup';

// Each module task adds its own entry here and its subpath in package.json "exports".
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    bulk: 'src/bulk/index.ts',
    attachments: 'src/attachments/index.ts',
    audit: 'src/audit/index.ts',
    permissions: 'src/permissions/index.ts',
    webhooks: 'src/webhooks/index.ts',
  },
  // Share core code (SpApiError) between entries in CJS too, so `instanceof` works across subpaths.
  splitting: true,
  format: ['esm', 'cjs'],
  target: 'es2020',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
