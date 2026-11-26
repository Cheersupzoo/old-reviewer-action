import { fromBinary } from '@bufbuild/protobuf';
import { IndexSchema, PositionEncoding, type Occurrence, type SymbolInformation } from '@scip-code/scip';
import {
  BUCKET_SHIFT,
  Role,
  utf8ColToUtf16,
  utf32ColToUtf16,
  type CallEdge,
  type Changed,
  type DocShard,
  type Loc,
  type SymBucket,
  type SymTab,
  type ExternalRef,
} from '@prv/pack-format';
import { PackWriter } from '@prv/pack-format/writer';
import { externalUrl, labelOf, parseSymbol, splitNamespace } from './symbol.ts';
import { covers, overlaps, parseUnifiedDiff, removedFunctionNames } from './diff.ts';

export type Encoding = 'utf8' | 'utf16' | 'utf32';

export interface ScipInput {
  /** index.scip bytes */
  data: Uint8Array;
  /** Directory of the indexed project, relative to the repo root ('' for the root). */
  root: string;
  /** Fallback when documents don't declare a position encoding. */
  defaultEncoding?: Encoding;
}

/** Language-neutral analyzer output (go-analyzer, ts-analyzer). */
export interface Analysis {
  tool: string;
  positionEncoding?: Encoding;
  targets: { name: string; def?: { file: string; line: number; col: number }; ext?: string }[];
  functions: { target: number; file: string; startLine: number; endLine: number }[];
  edges: {
    caller: number;
    callee: number;
    at: { file: string; line: number; col: number };
    endCol: number;
    dynamic?: boolean;
    abstract?: boolean;
  }[];
  externals: { key: string; package: string; version?: string; signature: string; doc?: string; kind: string }[];
  warnings?: string[];
}

export interface BuildInput {
  repo: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  scip: ScipInput[];
  analyses: Analysis[];
  /** `git diff --unified=0 <merge-base> <head>` output. */
  diff?: string;
  tools: Record<string, string>;
  /** Reads a repo-relative file at HEAD (for column conversion). */
  readFile: (path: string) => string | undefined;
  generatedAt?: string;
  warnings?: string[];
}

interface SymRec {
  key: string;
  name: string;
  label: string;
  pkg: string;
  kind: number;
  local: boolean;
  signature?: string;
  signatureLang?: string;
  docs?: string;
  defs: Loc[];
  impls: Set<number>;
  implBy: Set<number>;
  refs: Loc[];
  external?: ExternalRef;
  callers: CallEdge[];
  callees: CallEdge[];
}

const KIND_BY_NAME: Record<string, number> = {
  function: 17,
  method: 26,
  interface: 21,
  struct: 49,
  type: 54,
  field: 15,
  variable: 61,
  constant: 8,
  class: 7,
};

const joinPath = (root: string, p: string) => (root ? `${root.replace(/\/$/, '')}/${p}` : p);

const LANG_BY_EXT: Record<string, string> = {
  go: 'go',
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
};

export function buildPack(input: BuildInput): { pack: Buffer; stats: Record<string, number> } {
  const warnings = [...(input.warnings ?? [])];
  const files: string[] = [];
  const fileIdx = new Map<string, number>();
  const fileOf = (p: string) => {
    let i = fileIdx.get(p);
    if (i === undefined) {
      i = files.length;
      files.push(p);
      fileIdx.set(p, i);
    }
    return i;
  };

  // ---- column conversion -------------------------------------------------------------
  const lineCache = new Map<string, string[] | null>();
  const linesOf = (path: string): string[] | null => {
    if (!lineCache.has(path)) {
      const t = input.readFile(path);
      lineCache.set(path, t === undefined ? null : t.split(/\r?\n/));
    }
    return lineCache.get(path)!;
  };
  const toUtf16 = (path: string, line: number, col: number, enc: Encoding): number => {
    if (enc === 'utf16') return col;
    const text = linesOf(path)?.[line];
    if (text === undefined) return col;
    return enc === 'utf8' ? utf8ColToUtf16(text, col) : utf32ColToUtf16(text, col);
  };

  // ---- symbols -------------------------------------------------------------------------
  const syms: SymRec[] = [];
  const symIdx = new Map<string, number>();
  const symOf = (key: string, displayName?: string): number => {
    let i = symIdx.get(key);
    if (i !== undefined) return i;
    const local = key.startsWith('local ');
    const parsed = parseSymbol(local ? key.slice(key.indexOf('#') + 1) : key);
    const { name, label, pkg } = labelOf(parsed, displayName);
    i = syms.length;
    syms.push({
      key,
      name,
      label,
      pkg,
      kind: 0,
      local,
      defs: [],
      impls: new Set(),
      implBy: new Set(),
      refs: [],
      callers: [],
      callees: [],
    });
    symIdx.set(key, i);
    return i;
  };
  // Locals are per-document in SCIP; namespace them by file.
  const keyFor = (sym: string, path: string) => (sym.startsWith('local ') ? `local ${path}#local ${sym.slice(6)}` : sym);

  const applyInfo = (i: number, info: SymbolInformation) => {
    const r = syms[i]!;
    if (info.kind) r.kind = info.kind;
    if (info.displayName) {
      r.name = info.displayName;
      if (r.local) r.label = info.displayName;
    }
    let docs = [...info.documentation];
    if (info.signatureDocumentation?.text) {
      r.signature = info.signatureDocumentation.text;
      r.signatureLang = info.signatureDocumentation.language || undefined;
    } else if (docs[0]?.startsWith('```')) {
      // scip-typescript puts the signature in documentation[0] as a fenced block.
      const m = /^```(\w*)\n([\s\S]*?)\n?```$/.exec(docs[0].trim());
      if (m) {
        r.signature = m[2];
        r.signatureLang = m[1] || undefined;
        docs = docs.slice(1);
      }
    }
    const d = docs.join('\n\n').trim();
    if (d) r.docs = d;
  };

  const relationships: { from: number; to: string; path: string }[] = [];
  const defByPos = new Map<string, number>(); // "path:line:utf16col" → symbolIdx
  const shards = new Map<number, DocShard>();

  for (const sc of input.scip) {
    const index = fromBinary(IndexSchema, sc.data);
    const toolName = index.metadata?.toolInfo?.name ?? 'scip';
    const fallback: Encoding = sc.defaultEncoding ?? (toolName.includes('typescript') ? 'utf16' : 'utf8');
    for (const doc of index.documents) {
      const path = joinPath(sc.root, doc.relativePath);
      const enc: Encoding =
        doc.positionEncoding === PositionEncoding.UTF8CodeUnitOffsetFromLineStart
          ? 'utf8'
          : doc.positionEncoding === PositionEncoding.UTF16CodeUnitOffsetFromLineStart
            ? 'utf16'
            : doc.positionEncoding === PositionEncoding.UTF32CodeUnitOffsetFromLineStart
              ? 'utf32'
              : fallback;
      const f = fileOf(path);
      const ext = path.split('.').at(-1) ?? '';
      const shard: DocShard = { path, language: (doc.language || LANG_BY_EXT[ext] || ext).toLowerCase(), occ: [], functions: [] };
      shards.set(f, shard);

      for (const info of doc.symbols) {
        const i = symOf(keyFor(info.symbol, path), info.displayName);
        applyInfo(i, info);
        for (const rel of info.relationships) {
          if (rel.isImplementation) relationships.push({ from: i, to: rel.symbol, path });
        }
      }

      const occs: number[][] = [];
      for (const o of doc.occurrences) {
        if (!o.symbol) continue;
        const r = rangeOf(o);
        if (!r) continue;
        const [sl, sc0, el, ec0] = r;
        const sc1 = toUtf16(path, sl, sc0, enc);
        const ec1 = toUtf16(path, el, ec0, enc);
        const i = symOf(keyFor(o.symbol, path));
        const loc: Loc = [f, sl, sc1, el, ec1];
        if (o.symbolRoles & Role.Definition) {
          syms[i]!.defs.push(loc);
          defByPos.set(`${path}:${sl}:${sc1}`, i);
        } else {
          syms[i]!.refs.push(loc);
        }
        occs.push([sl, sc1, el, ec1, i, o.symbolRoles]);
      }
      occs.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
      shard.occ = occs.flat();
    }
    for (const info of index.externalSymbols) {
      applyInfo(symOf(info.symbol, info.displayName), info);
    }
  }

  for (const rel of relationships) {
    const to = symIdx.get(keyFor(rel.to, rel.path)) ?? symOf(rel.to);
    syms[rel.from]!.impls.add(to);
    syms[to]!.implBy.add(rel.from);
  }

  // External symbol lookup for analyzer output: "pkgpath|descriptor-rest" → symbolIdx
  const extIndex = new Map<string, number>();
  syms.forEach((s, i) => {
    if (s.local) return;
    const p = parseSymbol(s.key);
    const { ns, restRaw } = splitNamespace(p);
    if (ns) extIndex.set(`${ns}|${restRaw}`, i);
    if (!s.defs.length) {
      const url = externalUrl(p);
      s.external = { ...(url ? { url } : {}), ...(ns ? { package: ns } : {}) };
    }
  });

  // ---- analyzer output -----------------------------------------------------------------
  const allFunctions: { s: number; file: number; start: number; end: number }[] = [];
  for (const an of input.analyses) {
    warnings.push(...(an.warnings ?? []).slice(0, 20).map((w) => `${an.tool}: ${w}`));
    const enc = an.positionEncoding ?? 'utf8';
    const extByKey = new Map(an.externals.map((e) => [e.key, e]));
    const targetSym = an.targets.map((t): number | undefined => {
      if (t.def) {
        const col = toUtf16(t.def.file, t.def.line, t.def.col, enc);
        return defByPos.get(`${t.def.file}:${t.def.line}:${col}`);
      }
      if (t.ext) {
        let i = extIndex.get(t.ext);
        if (i === undefined) {
          // Not referenced by name anywhere in the index (e.g. only called via an interface).
          i = symOf(`prv-ext ${t.ext}`);
          const [path, desc] = t.ext.split('|');
          const meta = extByKey.get(t.ext);
          const pkg = meta?.package ?? path ?? '';
          const r = syms[i]!;
          r.name = t.name.split('.').at(-1) ?? t.name;
          r.label = t.name;
          r.pkg = pkg;
          const anchor = (desc ?? '').replace(/[#.()`<>]+/g, '.').replace(/^\.|\.$/g, '');
          r.external = {
            package: pkg,
            url: an.tool.startsWith('go')
              ? `https://pkg.go.dev/${pkg}${anchor ? '#' + anchor : ''}`
              : pkg
                ? `https://www.npmjs.com/package/${pkg}${meta?.version ? '/v/' + meta.version : ''}`
                : undefined,
          };
          extIndex.set(t.ext, i);
        }
        return i;
      }
      return undefined;
    });
    // Hover info for externals the SCIP indexer left blank.
    for (const [key, e] of extByKey) {
      const i = extIndex.get(key);
      if (i === undefined) continue;
      const r = syms[i]!;
      if (!r.signature) {
        r.signature = e.signature;
        r.signatureLang = an.tool.startsWith('go') ? 'go' : 'typescript';
      }
      if (!r.docs && e.doc) r.docs = e.doc.trim();
      if (!r.kind) r.kind = KIND_BY_NAME[e.kind] ?? 0;
    }
    for (const fn of an.functions) {
      const s = targetSym[fn.target];
      if (s === undefined) continue;
      const f = fileIdx.get(fn.file);
      if (f === undefined) continue;
      shards.get(f)!.functions.push(s, fn.startLine, fn.endLine);
      allFunctions.push({ s, file: f, start: fn.startLine, end: fn.endLine });
    }

    // Group edges by call site to decide between VTA-resolved and abstract targets.
    const bySite = new Map<string, Analysis['edges']>();
    for (const e of an.edges) {
      const k = `${e.at.file}:${e.at.line}:${e.at.col}:${e.caller}`;
      let list = bySite.get(k);
      if (!list) bySite.set(k, (list = []));
      list.push(e);
    }
    for (const site of bySite.values()) {
      const concrete = site.filter((e) => !e.abstract);
      const abstract = site.filter((e) => e.abstract);
      const first = site[0]!;
      const caller = targetSym[first.caller];
      if (caller === undefined) continue;
      const fi = fileOf(first.at.file);
      const sc = toUtf16(first.at.file, first.at.line, first.at.col, enc);
      const ec = toUtf16(first.at.file, first.at.line, first.endCol, enc);
      const at: Loc = [fi, first.at.line, sc, first.at.line, ec];
      const add = (callee: number, dyn: boolean, approx: boolean) => {
        if (syms[caller]!.callees.some((c) => c.s === callee && sameLoc(c.at, at))) return;
        const edge = { at, ...(dyn ? { dyn: 1 as const } : {}), ...(approx ? { approx: 1 as const } : {}) };
        syms[caller]!.callees.push({ s: callee, ...edge });
        syms[callee]!.callers.push({ s: caller, ...edge });
      };
      if (concrete.length) {
        for (const e of concrete) {
          const callee = targetSym[e.callee];
          if (callee !== undefined) add(callee, !!e.dynamic, false);
        }
      } else {
        for (const e of abstract) {
          const iface = targetSym[e.callee];
          if (iface === undefined) continue;
          add(iface, true, false);
          for (const impl of syms[iface]!.implBy) add(impl, true, true);
        }
      }
    }
  }

  // ---- changed functions -----------------------------------------------------------------
  const changed: Changed = { functions: [], deleted: [], ranges: {} };
  if (input.diff) {
    const diffs = parseUnifiedDiff(input.diff);
    for (const [path, d] of diffs) {
      if (!d.newPath) continue;
      if (d.added.length) changed.ranges[path] = d.added;
    }
    const byFile = new Map<number, typeof allFunctions>();
    for (const fn of allFunctions) {
      let l = byFile.get(fn.file);
      if (!l) byFile.set(fn.file, (l = []));
      l.push(fn);
    }
    for (const [path, d] of diffs) {
      if (!d.newPath) {
        // Whole file deleted.
        for (const name of removedFunctionNames(d)) changed.deleted.push({ name, path: d.oldPath ?? path });
        continue;
      }
      const f = fileIdx.get(path);
      const fns = f === undefined ? [] : (byFile.get(f) ?? []);
      const removed = new Set(removedFunctionNames(d));
      for (const fn of fns) {
        if (!overlaps(d.added, fn.start, fn.end)) continue;
        const name = syms[fn.s]!.name;
        const isNew = !d.oldPath || (covers(d.added, fn.start, fn.end) && !removed.has(name));
        changed.functions.push({ s: fn.s, file: fn.file, start: fn.start, end: fn.end, status: isNew ? 'added' : 'modified' });
      }
      const present = new Set(fns.map((fn) => syms[fn.s]!.name));
      for (const name of removed) if (!present.has(name)) changed.deleted.push({ name, path });
    }
  }

  // ---- write ---------------------------------------------------------------------------
  const w = new PackWriter();
  for (const [f, shard] of [...shards].sort((a, b) => a[0] - b[0])) {
    const fn: number[][] = [];
    for (let i = 0; i < shard.functions.length; i += 3) fn.push(shard.functions.slice(i, i + 3));
    fn.sort((a, b) => a[1]! - b[1]!);
    shard.functions = fn.flat();
    w.add(`doc:${f}`, shard);
  }

  const symtab: SymTab = { name: [], label: [], kind: [], def: [], pkg: [], flags: [] };
  for (const s of syms) {
    symtab.name.push(s.name);
    symtab.label.push(s.label);
    symtab.kind.push(s.kind);
    const d = s.defs[0];
    symtab.def.push(d ? d[0] : -1, d ? d[1] : 0, d ? d[2] : 0);
    symtab.pkg.push(s.pkg);
    symtab.flags.push((s.local ? 1 : 0) | (s.defs.length ? 0 : 2));
  }
  w.add('symtab', symtab);

  const buckets = Math.ceil(syms.length / (1 << BUCKET_SHIFT));
  let edgeCount = 0;
  for (let b = 0; b < buckets; b++) {
    const symB: SymBucket = {};
    const refsB: Record<string, Loc[]> = {};
    const callsB: Record<string, { callers: CallEdge[]; callees: CallEdge[] }> = {};
    for (let i = b << BUCKET_SHIFT; i < Math.min(syms.length, (b + 1) << BUCKET_SHIFT); i++) {
      const s = syms[i]!;
      symB[i] = {
        symbol: s.key,
        label: s.label,
        kind: s.kind,
        ...(s.signature ? { signature: s.signature } : {}),
        ...(s.signatureLang ? { signatureLang: s.signatureLang } : {}),
        ...(s.docs ? { docs: s.docs } : {}),
        defs: s.defs,
        implementations: [...s.impls],
        implementedBy: [...s.implBy],
        refCount: s.refs.length,
        ...(s.external ? { external: s.external } : {}),
      };
      if (s.refs.length) refsB[i] = s.refs;
      if (s.callers.length || s.callees.length) {
        callsB[i] = { callers: s.callers, callees: s.callees };
        edgeCount += s.callees.length;
      }
    }
    w.add(`sym:${b}`, symB);
    w.add(`refs:${b}`, refsB);
    w.add(`calls:${b}`, callsB);
  }
  w.add('changed', changed);

  const languages = [...new Set([...shards.values()].map((s) => s.language))].sort();
  const pack = w.finish({
    repo: input.repo,
    headSha: input.headSha,
    baseSha: input.baseSha,
    mergeBaseSha: input.mergeBaseSha,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    tools: input.tools,
    languages,
    files,
    symbolCount: syms.length,
    ...(warnings.length ? { warnings } : {}),
  });
  return {
    pack,
    stats: {
      files: files.length,
      symbols: syms.length,
      edges: edgeCount,
      changedFunctions: changed.functions.length,
      bytes: pack.length,
    },
  };
}

function rangeOf(o: Occurrence): [number, number, number, number] | undefined {
  const t = o.typedRange;
  if (t.case === 'singleLineRange') return [t.value.line, t.value.startCharacter, t.value.line, t.value.endCharacter];
  if (t.case === 'multiLineRange')
    return [t.value.startLine, t.value.startCharacter, t.value.endLine, t.value.endCharacter];
  const r = o.range;
  if (r.length === 3) return [r[0]!, r[1]!, r[0]!, r[2]!];
  if (r.length === 4) return [r[0]!, r[1]!, r[2]!, r[3]!];
  return undefined;
}

const sameLoc = (a: Loc, b: Loc) => a.every((v, i) => v === b[i]);
