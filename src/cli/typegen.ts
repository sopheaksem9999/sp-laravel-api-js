// The `sp-laravel-api` command line (Node only). `main` is exported for tests; bin entry is index.ts.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TypegenError, generateTypes } from './generate';

/** Everything the CLI touches outside itself, injectable for tests. */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string): string;
  /** Writes the whole file (to a temporary sibling, then renamed over `path`), creating parent directories. */
  writeFile(path: string, text: string): void;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}

const nodeIo: CliIo = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, t) => {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, t);
      renameSync(tmp, p);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  },
  fetch: (...args) => globalThis.fetch(...args),
  env: process.env,
};

export const USAGE = `Usage:
  sp-laravel-api typegen (--url <url> | --file <path>) --out <path> [options]

Generates TypeScript types from the host's OpenAPI document: one interface per
{Name}Read / {Name}Write schema and \`interface Tables\` for createApi<Tables>().

Options:
  --url <url>             Fetch the document, e.g. https://host/api/v2/docs/openapi.json
  --file <path>           Read a local JSON export instead (works offline; use it when the
                          docs are private: php artisan sp-laravel-api:export-openapi)
  --out <path>            File to write (overwritten only after generation succeeded)
  --header 'Name: value'  Extra request header for --url (repeatable); put credentials
                          here or in SP_API_TOKEN, never in the URL
  --tenant <id>           Tenant header value for --url
  --tenant-header <name>  Tenant header name (default X-Tenant-ID)
  --timeout <seconds>     Give up on --url after this long (default 30)
  -h, --help              Show this help

Environment:
  SP_API_TOKEN            Sent as 'Authorization: Bearer <token>' with --url, unless a
                          --header sets Authorization.

Exit codes: 0 ok, 1 usage error, 2 fetch, parse, generation or write failure.
`;

class UsageError extends Error {}

interface Args {
  help: boolean;
  url?: string;
  file?: string;
  out?: string;
  headers: Array<[string, string]>;
  tenant?: string;
  tenantHeader: string;
  timeoutMs: number;
}

const VALUE_FLAGS = new Set(['--url', '--file', '--out', '--header', '--tenant', '--tenant-header', '--timeout']);
const DEFAULT_TIMEOUT_MS = 30_000;

function parse(argv: string[]): Args {
  const args: Args = { help: false, headers: [], tenantHeader: 'X-Tenant-ID', timeoutMs: DEFAULT_TIMEOUT_MS };
  const rest = [...argv];
  if (rest.length === 0) throw new UsageError('missing command (expected "typegen")');
  if (rest[0] === '--help' || rest[0] === '-h') return { ...args, help: true };
  const command = rest.shift();
  if (command !== 'typegen') throw new UsageError('unknown command (expected "typegen")');
  while (rest.length > 0) {
    const token = rest.shift() as string;
    if (token === '--help' || token === '-h') return { ...args, help: true };
    const eq = token.indexOf('=');
    const flag = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token;
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(token.startsWith('-') ? `unknown option ${flag}` : 'unexpected argument');
    let value: string | undefined;
    if (flag !== token) value = token.slice(eq + 1);
    else value = rest.shift();
    if (value === undefined || value === '') throw new UsageError(`${flag} needs a value`);
    switch (flag) {
      case '--url':
        args.url = value;
        break;
      case '--file':
        args.file = value;
        break;
      case '--out':
        args.out = value;
        break;
      case '--tenant':
        args.tenant = value;
        break;
      case '--tenant-header':
        args.tenantHeader = value;
        break;
      case '--timeout': {
        const secs = Number(value);
        if (!Number.isFinite(secs) || secs <= 0) throw new UsageError('--timeout must be a positive number of seconds');
        args.timeoutMs = Math.ceil(secs * 1000);
        break;
      }
      case '--header': {
        // The value may be a credential: never echo it.
        const colon = value.indexOf(':');
        const name = colon > 0 ? value.slice(0, colon).trim() : '';
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new UsageError("invalid --header (expected 'Name: value')");
        args.headers.push([name, value.slice(colon + 1).trim()]);
        break;
      }
    }
  }
  if ((args.url === undefined) === (args.file === undefined)) throw new UsageError('give exactly one of --url or --file');
  if (args.out === undefined) throw new UsageError('missing --out');
  if (args.url !== undefined) {
    let u: URL;
    try {
      u = new URL(args.url);
    } catch {
      throw new UsageError('--url is not an absolute URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError('--url must be http or https');
    // Never echo them: the message names the alternatives only.
    if (u.username !== '' || u.password !== '') {
      throw new UsageError('--url must not contain credentials; use --header or SP_API_TOKEN');
    }
  }
  return args;
}

/** The URL without credentials, query or fragment, for messages. */
function safeUrl(raw: string): string {
  const u = new URL(raw);
  return `${u.origin}${u.pathname}`;
}

function errCode(e: unknown): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'error';
}

async function load(args: Args, io: CliIo): Promise<string> {
  if (args.file !== undefined) {
    try {
      return io.readFile(args.file);
    } catch (e) {
      throw new TypegenError(`cannot read ${args.file} (${errCode(e)})`);
    }
  }
  const url = args.url as string;
  const headers = new Headers({ Accept: 'application/json' });
  const token = io.env.SP_API_TOKEN;
  if (token !== undefined && token !== '') headers.set('Authorization', `Bearer ${token}`);
  if (args.tenant !== undefined) headers.set(args.tenantHeader, args.tenant);
  for (const [name, value] of args.headers) headers.set(name, value);
  let res: Response;
  const signal = AbortSignal.timeout(args.timeoutMs);
  try {
    res = await io.fetch(url, { method: 'GET', headers, signal });
  } catch {
    // The underlying message can carry the URL (and its query); it is not printed.
    if (signal.aborted) throw new TypegenError(`could not fetch ${safeUrl(url)}: timed out after ${args.timeoutMs / 1000} s`);
    throw new TypegenError(`could not fetch ${safeUrl(url)} (network error)`);
  }
  if (!res.ok) {
    const hint =
      res.status === 404
        ? ' (docs private or wrong URL? use --file with an export from php artisan sp-laravel-api:export-openapi)'
        : '';
    throw new TypegenError(`could not fetch ${safeUrl(url)}: HTTP ${res.status}${hint}`);
  }
  try {
    return await res.text();
  } catch {
    if (signal.aborted) throw new TypegenError(`could not fetch ${safeUrl(url)}: timed out after ${args.timeoutMs / 1000} s`);
    throw new TypegenError(`could not read the response from ${safeUrl(url)}`);
  }
}

/**
 * Runs the CLI with `argv` (the arguments after the executable) and resolves the exit code. Never throws and
 * never prints a stack trace, a header value or a token.
 */
export async function main(argv: string[], io: Partial<CliIo> = {}): Promise<number> {
  const env: CliIo = { ...nodeIo, ...io };
  const fail = (code: number, message: string): number => {
    env.stderr(`sp-laravel-api: ${message}\n`);
    return code;
  };
  let args: Args;
  try {
    args = parse(argv);
  } catch (e) {
    const message = e instanceof UsageError ? e.message : 'invalid arguments';
    return fail(1, `${message}. Run "sp-laravel-api typegen --help".`);
  }
  if (args.help) {
    env.stdout(USAGE);
    return 0;
  }
  try {
    const source = args.file ?? safeUrl(args.url as string);
    const text = await load(args, env);
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new TypegenError(`${source} is not valid JSON (export with --format=json)`);
    }
    const output = generateTypes(doc);
    const out = args.out as string;
    try {
      env.writeFile(out, output);
    } catch (e) {
      throw new TypegenError(`cannot write ${out} (${errCode(e)})`);
    }
    const tables = (output.match(/^ {2}\S.*: \{ read: /gm) ?? []).length;
    env.stdout(`sp-laravel-api: wrote ${tables} tables to ${out}\n`);
    return 0;
  } catch (e) {
    return fail(2, e instanceof TypegenError ? e.message : 'unexpected error');
  }
}
