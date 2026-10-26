// Bin entry of `sp-laravel-api` (built to dist/cli/index.js with a `#!/usr/bin/env node` banner).
import { main } from './typegen';

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
