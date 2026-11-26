#!/usr/bin/env node
/** ts-analyzer --dir <project> --root <repo root> -o out.json */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TS from 'typescript';
import { analyze } from './analyze.ts';

/** Prefer the project's own TypeScript (same semantics as its build); fall back to ours. */
export function loadTypeScript(projectDir: string, fallback?: string): typeof TS {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const base of [projectDir, here, join(here, '..')]) {
    try {
      const ts = createRequire(join(base, 'noop.js'))('typescript') as typeof TS;
      if (typeof ts.createProgram === 'function') return ts; // TS 7 (native) has no JS compiler API
    } catch {
      /* try next */
    }
  }
  if (fallback) {
    const ts = createRequire(join(projectDir, 'noop.js'))(resolve(fallback)) as typeof TS;
    if (typeof ts.createProgram === 'function') return ts;
  }
  throw new Error('typescript (JS compiler API, <= 6.x) not found; pass --typescript <path to typescript package>');
}

function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = resolve(get('--dir') ?? '.');
  const root = resolve(get('--root') ?? dir);
  const outFile = get('-o') ?? get('--out');
  const ts = loadTypeScript(dir, get('--typescript'));
  const res = analyze(ts, dir, root);
  const json = JSON.stringify(res);
  if (outFile) writeFileSync(outFile, json);
  else process.stdout.write(json + '\n');
  console.error(`ts-analyzer: TypeScript ${ts.version}, ${res.functions.length} functions, ${res.edges.length} edges, ${res.externals.length} externals`);
}

try {
  main();
} catch (e) {
  console.error(`ts-analyzer: ${(e as Error).message}`);
  process.exit(1);
}
