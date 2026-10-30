import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

// Type-checks every fenced ```ts / ```tsx block of the READMEs against the package source.
//
// Every such block must start with a marker line:
//   // typecheck     the block is compiled (as its own module, with top-level await) against src/;
//   // illustrative  the block is shown for reference only and is not compiled.
// Identifiers a block uses without defining (`api`, `invoices`, `app`, a framework's hooks...) come from the
// ambient stubs below; a block's own declarations shadow them. Node-only (fs, the TypeScript compiler API).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODULES = ['attachments', 'audit', 'bulk', 'docs', 'logging', 'permissions', 'realtime', 'webhooks'];
const FILES = ['README.md', 'llms.txt', ...MODULES.map((m) => `src/${m}/README.md`)];

interface Block {
  file: string;
  line: number; // 1-based line of the first code line (the marker) in the markdown file
  lang: 'ts' | 'tsx';
  marker: 'typecheck' | 'illustrative' | null;
  code: string;
}

function blocks(file: string): Block[] {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(ts|tsx)\s*$/.exec(lines[i] as string);
    if (open === null) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !/^```\s*$/.test(lines[end] as string)) end++;
    const body = lines.slice(start, end);
    const first = (body[0] ?? '').trim();
    const marker = first === '// typecheck' ? 'typecheck' : first === '// illustrative' ? 'illustrative' : null;
    out.push({ file, line: start + 1, lang: open[1] as 'ts' | 'tsx', marker, code: body.join('\n') });
    i = end;
  }
  return out;
}

const STUBS = `
type SpApi = import('@sokpheak/sp-laravel-api').Api;
type SpTable<T> = import('@sokpheak/sp-laravel-api').Table<T>;
type SpAuth = import('@sokpheak/sp-laravel-api').ApiAuth;

interface Invoice {
  id: number;
  number?: string;
  ref_number: string;
  total: number;
  status: string;
}

declare const api: SpApi;
declare const invoices: SpTable<Invoice>;
declare const att: ReturnType<typeof import('@sokpheak/sp-laravel-api/attachments').attachments>;
declare const auth: SpAuth;
declare const serviceAccountAuth: SpAuth;
declare const tenantId: number;
declare const rows: Partial<Invoice>[];
declare const newRows: Partial<Invoice>[];
declare const changed: Array<Partial<Invoice> & { id: number }>;
declare const blob: Blob;
declare const file: File;
declare const bigFile: File;
declare const video: File;
declare const id: number;
declare const img: { src: string };
declare const controller: AbortController;
declare const loading: { set(on: boolean): void };
declare const queryClient: { invalidateQueries(f: { queryKey: readonly unknown[] }): Promise<void> };
declare function show(loaded: number, total: number | null): void;
declare function render(loaded: number, total: number | null): void;
declare function hideLargeUploadButton(): void;
declare function showLargeUploadButton(): void;

/** Laravel Echo, reduced to what the realtime examples call. */
interface Echo {
  private(name: string): { listen(event: string, cb: (payload: unknown) => void): unknown };
  leave(name: string): void;
}

/** Express, reduced to what the examples call. */
interface ExpressRequest {
  headers: Record<string, string | string[] | undefined> & { authorization?: string };
  body: Uint8Array;
  get(name: string): string | undefined;
  laravel?: SpApi;
}
interface ExpressResponse {
  status(code: number): { end(): void };
}
type ExpressHandler = (req: ExpressRequest, res: ExpressResponse, next: () => void) => unknown;
declare const app: {
  use(handler: ExpressHandler): void;
  post(path: string, ...handlers: ExpressHandler[]): void;
};
declare const express: { raw(o: { type: string }): ExpressHandler };

declare module '@tanstack/react-query' {
  export function useQuery<T>(o: { queryKey: readonly unknown[]; queryFn: () => Promise<T> }): { data: T | undefined };
  export function useMutation<V, T>(o: { mutationFn: (v: V) => Promise<T>; onSuccess?: () => unknown }): { mutate(v: V): void };
  export function useQueryClient(): { invalidateQueries(f: { queryKey: readonly unknown[] }): Promise<void> };
}
declare module '@tanstack/vue-query' {
  export function useQueryClient(): { invalidateQueries(f: { queryKey: readonly unknown[] }): Promise<void> };
}
declare module 'react' {
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
declare module 'vue' {
  export interface Ref<T> { value: T }
  export function watchEffect(effect: (onCleanup: (fn: () => void) => void) => void): void;
}
declare module '@sokpheak/sp-jwt-auth' {
  export function createJwtAuth(o: Record<string, unknown>): {
    getHeaders(): Promise<Record<string, string>>;
    getState(): { companyId: number | null };
    subscribe(listener: () => void): () => void;
  };
}
`;

/** What `sp-laravel-api typegen` would emit for an `invoices` table (used by `import type { Tables } from './types/sp-api'`). */
const GENERATED = `
export interface InvoicesRead { id: number; status?: string | null; total?: number | null; created_at?: string | null }
export interface InvoicesWrite { status?: string | null; total?: number | null }
export interface Tables { invoices: { read: InvoicesRead; write: InvoicesWrite } }
`;

const all = FILES.flatMap(blocks);
const checked = all.filter((b) => b.marker === 'typecheck');
const dir = mkdtempSync(join(tmpdir(), 'sp-readme-typecheck-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('README code blocks', () => {
  it('every ts/tsx block is tagged // typecheck or // illustrative', () => {
    const untagged = all.filter((b) => b.marker === null).map((b) => `${b.file}:${b.line}`);
    expect(untagged).toEqual([]);
  });

  it('covers the main README and every module README', () => {
    for (const f of FILES) expect(checked.some((b) => b.file === f), f).toBe(true);
  });

  it('every // typecheck block compiles against the package source', () => {
    writeFileSync(join(dir, 'stubs.d.ts'), STUBS);
    mkdirSync(join(dir, 'types'));
    writeFileSync(join(dir, 'types', 'sp-api.ts'), GENERATED);
    const map = new Map<string, Block>();
    checked.forEach((b, n) => {
      const name = join(dir, `block-${n}-${b.file.replace(/[^a-z0-9]+/gi, '_')}-${b.line}.${b.lang}`);
      // `export {}` makes every block a module, so its declarations shadow the stubs instead of clashing.
      writeFileSync(name, `${b.code}\nexport {};\n`);
      map.set(name, b);
    });

    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      types: ['node'],
      typeRoots: [join(ROOT, 'node_modules/@types')],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      jsx: ts.JsxEmit.Preserve,
      paths: {
        '@sokpheak/sp-laravel-api': [join(ROOT, 'src/index.ts')],
        ...Object.fromEntries(MODULES.map((m) => [`@sokpheak/sp-laravel-api/${m}`, [join(ROOT, `src/${m}/index.ts`)]])),
      },
    };
    const program = ts.createProgram([join(dir, 'stubs.d.ts'), ...map.keys()], options);
    const problems = ts.getPreEmitDiagnostics(program).map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      if (d.file === undefined || d.start === undefined) return msg;
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      const b = map.get(resolve(d.file.fileName));
      return b === undefined ? `${relative(ROOT, d.file.fileName)}:${line + 1}: ${msg}` : `${b.file}:${b.line + line}: ${msg}`;
    });
    expect(problems).toEqual([]);
  }, 60_000);
});
