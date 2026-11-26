/**
 * Svelte support for ts-analyzer: each `.svelte` file is compiled to TypeScript with
 * svelte2tsx (the same transform svelte-check and the Svelte language server use) and
 * served to the TypeScript program as a virtual `<file>.svelte.__prv.ts`. Positions in
 * the generated code are mapped back to the `.svelte` file through svelte2tsx's source map.
 */
import type * as TS from 'typescript';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const VIRTUAL_SUFFIX = '.__prv.ts';

type Svelte2tsx = (
  code: string,
  opts: { filename?: string; isTsFile?: boolean; mode?: 'ts' | 'dts'; version?: string; emitOnTemplateError?: boolean },
) => { code: string; map: { mappings: string } };

export interface SvelteTooling {
  svelte2tsx: Svelte2tsx;
  /** Ambient declarations the generated code relies on (`svelteHTML`, `__sveltets_2_*`). */
  shims: string[];
  /** Svelte version of the analyzed project, if known (selects Svelte 4 or 5 output). */
  version?: string;
}

/** Prefer the project's svelte2tsx; fall back to the one next to `fallback` (a node_modules dir). */
export function loadSvelteTooling(projectDir: string, fallback?: string): SvelteTooling | undefined {
  const bases = [projectDir, ...(fallback ? [fallback] : [])];
  let version: string | undefined;
  try {
    const req = createRequire(join(projectDir, 'noop.js'));
    version = (JSON.parse(readFileSync(req.resolve('svelte/package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    /* project has no svelte installed */
  }
  for (const base of bases) {
    try {
      const req = createRequire(join(resolve(base), 'noop.js'));
      const entry = req.resolve('svelte2tsx');
      const mod = req(entry) as { svelte2tsx?: Svelte2tsx };
      if (typeof mod.svelte2tsx !== 'function') continue;
      const pkgDir = dirname(entry);
      const isV5 = !version || Number(version.split('.')[0]) >= 5;
      const shims = (isV5 ? ['svelte-shims-v4.d.ts', 'svelte-jsx-v4.d.ts'] : ['svelte-shims.d.ts', 'svelte-jsx.d.ts'])
        .map((f) => join(pkgDir, f))
        .filter((f) => existsSync(f));
      return { svelte2tsx: mod.svelte2tsx, shims, version };
    } catch {
      /* try next */
    }
  }
  return undefined;
}

interface Compiled {
  code: string;
  /** Original source lines (for text checks). */
  lines: string[];
  /** Per generated line: flat [genCol, srcLine, srcCol, ...] sorted by genCol. */
  segments: number[][];
  /** Generated code line start offsets. */
  lineStarts: number[];
}

/** Virtual files for the `.svelte` components of one TypeScript program. */
export class SvelteFiles {
  private cache = new Map<string, Compiled | null>();
  readonly warnings: string[] = [];

  private readonly tooling: SvelteTooling;
  constructor(tooling: SvelteTooling) {
    this.tooling = tooling;
  }

  get shims() {
    return this.tooling.shims;
  }

  isVirtual = (f: string) => f.endsWith('.svelte' + VIRTUAL_SUFFIX);
  toVirtual = (real: string) => real + VIRTUAL_SUFFIX;
  toReal = (virtual: string) => virtual.slice(0, -VIRTUAL_SUFFIX.length);

  compiled(real: string): Compiled | undefined {
    if (!this.cache.has(real)) this.cache.set(real, this.compile(real));
    return this.cache.get(real) ?? undefined;
  }

  private compile(real: string): Compiled | null {
    let text: string;
    try {
      text = readFileSync(real, 'utf8');
    } catch {
      return null;
    }
    try {
      const isTsFile = /<script\b[^>]*\blang\s*=\s*["']?(ts|typescript)\b/.test(text);
      const res = this.tooling.svelte2tsx(text, {
        filename: real,
        isTsFile,
        mode: 'ts',
        emitOnTemplateError: true,
        ...(this.tooling.version ? { version: this.tooling.version } : {}),
      });
      const lineStarts = [0];
      for (let i = 0; i < res.code.length; i++) if (res.code.charCodeAt(i) === 10) lineStarts.push(i + 1);
      return { code: res.code, lines: text.split(/\r?\n/), segments: decodeMappings(res.map.mappings), lineStarts };
    } catch (e) {
      if (this.warnings.length < 20) this.warnings.push(`svelte2tsx failed for ${real}: ${(e as Error).message.split('\n')[0]}`);
      return null;
    }
  }

  /** Map a generated position back to the `.svelte` file. `text`, when given, must appear there. */
  toOriginal(virtual: string, line: number, col: number, text?: string): { line: number; col: number } | undefined {
    const c = this.compiled(this.toReal(virtual));
    const segs = c?.segments[line];
    if (!c || !segs?.length) return undefined;
    // Last segment starting at or before col.
    let lo = 0;
    let hi = segs.length / 3 - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid * 3]! <= col) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return undefined;
    const pos = { line: segs[best * 3 + 1]!, col: segs[best * 3 + 2]! + (col - segs[best * 3]!) };
    if (text !== undefined && c.lines[pos.line]?.slice(pos.col, pos.col + text.length) !== text) return undefined;
    return pos;
  }

  lineCount(real: string): number {
    return this.compiled(real)?.lines.length ?? 1;
  }

  /** Wraps a compiler host so `.svelte` imports resolve to the virtual files. */
  wrapHost(ts: typeof TS, host: TS.CompilerHost, options: TS.CompilerOptions): TS.CompilerHost {
    const self = this;
    const servable = (f: string) => self.isVirtual(f) && !f.includes('/node_modules/') && self.compiled(self.toReal(f)) !== undefined;
    const fileExists = (f: string) => (self.isVirtual(f) ? servable(f) : host.fileExists(f));
    const readFile = (f: string) => (self.isVirtual(f) ? self.compiled(self.toReal(f))?.code : host.readFile(f));
    const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), (s) => host.getCanonicalFileName(s), options);
    const resHost: TS.ModuleResolutionHost = { ...host, fileExists, readFile };
    const resolveOne = (
      name: string,
      containingFile: string,
      opts: TS.CompilerOptions,
      redirected: TS.ResolvedProjectReference | undefined,
      mode: TS.ResolutionMode,
    ): TS.ResolvedModuleWithFailedLookupLocations => {
      if (name.endsWith('.svelte')) {
        const r = ts.resolveModuleName(name + VIRTUAL_SUFFIX.slice(0, -3), containingFile, opts, resHost, cache, redirected, mode);
        if (r.resolvedModule && servable(r.resolvedModule.resolvedFileName)) return r;
      }
      return ts.resolveModuleName(name, containingFile, opts, resHost, cache, redirected, mode);
    };
    return {
      ...host,
      fileExists,
      readFile,
      getSourceFile(fileName, languageVersion, onError, shouldCreate) {
        if (self.isVirtual(fileName)) {
          const code = readFile(fileName);
          return code === undefined ? undefined : ts.createSourceFile(fileName, code, languageVersion, true, ts.ScriptKind.TS);
        }
        return host.getSourceFile(fileName, languageVersion, onError, shouldCreate);
      },
      resolveModuleNameLiterals(literals, containingFile, redirected, opts, containingSourceFile) {
        return literals.map((lit) => {
          let mode: TS.ResolutionMode;
          try {
            mode = (ts.getModeForUsageLocation as (f: TS.SourceFile, u: TS.StringLiteralLike, o: TS.CompilerOptions) => TS.ResolutionMode)(
              containingSourceFile,
              lit,
              opts,
            );
          } catch {
            mode = undefined;
          }
          return resolveOne(lit.text, containingFile, redirected?.commandLine.options ?? opts, redirected, mode);
        });
      },
    };
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Decodes source map `mappings` into per-line [genCol, srcLine, srcCol] triples (single source). */
export function decodeMappings(mappings: string): number[][] {
  const lines: number[][] = [];
  let cur: number[] = [];
  let genCol = 0;
  let srcLine = 0;
  let srcCol = 0;
  let i = 0;
  const vals: number[] = [];
  const readVlq = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const d = B64_INDEX.get(mappings[i++]!);
      if (d === undefined) throw new Error('bad VLQ');
      result += (d & 31) << shift;
      if (!(d & 32)) break;
      shift += 5;
    }
    return result & 1 ? -(result >>> 1) : result >>> 1;
  };
  while (i <= mappings.length) {
    const c = mappings[i];
    if (c === undefined || c === ';') {
      sortTriples(cur);
      lines.push(cur);
      cur = [];
      genCol = 0;
      i++;
      if (c === undefined) break;
      continue;
    }
    if (c === ',') {
      i++;
      continue;
    }
    vals.length = 0;
    while (i < mappings.length && mappings[i] !== ',' && mappings[i] !== ';') vals.push(readVlq());
    genCol += vals[0]!;
    if (vals.length >= 4) {
      srcLine += vals[2]!;
      srcCol += vals[3]!;
      cur.push(genCol, srcLine, srcCol);
    }
  }
  return lines;
}

function sortTriples(a: number[]) {
  const n = a.length / 3;
  let sorted = true;
  for (let k = 1; k < n; k++) if (a[k * 3]! < a[(k - 1) * 3]!) sorted = false;
  if (sorted) return;
  const t: number[][] = [];
  for (let k = 0; k < n; k++) t.push(a.slice(k * 3, k * 3 + 3));
  t.sort((x, y) => x[0]! - y[0]!);
  a.splice(0, a.length, ...t.flat());
}
