#!/usr/bin/env node
/**
 * prv-pack — build and inspect PR review packs.
 *
 *   prv-pack build --repo o/r --head SHA --base SHA --merge-base SHA \
 *     --scip index.scip[:projectRoot[:utf8|utf16]] ... --analysis go-analysis.json ... \
 *     --diff changes.diff --root . --tool scip-go=v0.2.10 -o prv-out/pack.bin
 *
 *   prv-pack inspect pack.bin [blobKey] [--json]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PackReader, bufferSource, bucketOf, type SymTab, type Changed, type SymBucket, type CallsBucket } from '@prv/pack-format';
import { buildPack, type Analysis, type Encoding, type ScipInput } from './build.ts';

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--') || a === '-o') {
      const k = a === '-o' ? 'out' : a.slice(2);
      const v = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
      (opts[k] ??= []).push(v);
    } else pos.push(a);
  }
  return { pos, opts, one: (k: string) => opts[k]?.at(-1) };
}

function build(args: ReturnType<typeof parseArgs>) {
  const need = (k: string) => {
    const v = args.one(k);
    if (!v) throw new Error(`--${k} is required`);
    return v;
  };
  const root = args.one('root') ?? '.';
  const warnings: string[] = [];
  const scip: ScipInput[] = [];
  for (const spec of args.opts['scip'] ?? []) {
    const [path, projRoot = '', enc] = spec.split(':');
    if (!existsSync(path!)) {
      warnings.push(`missing SCIP index ${path}`);
      continue;
    }
    scip.push({ data: readFileSync(path!), root: projRoot, defaultEncoding: enc as Encoding | undefined });
  }
  const analyses: Analysis[] = [];
  for (const p of args.opts['analysis'] ?? []) {
    if (!existsSync(p)) {
      warnings.push(`missing analysis ${p}`);
      continue;
    }
    try {
      analyses.push(JSON.parse(readFileSync(p, 'utf8')) as Analysis);
    } catch (e) {
      warnings.push(`bad analysis ${p}: ${(e as Error).message}`);
    }
  }
  for (const w of args.opts['warning'] ?? []) warnings.push(w);
  const diffPath = args.one('diff');
  const tools = Object.fromEntries((args.opts['tool'] ?? []).map((t) => t.split('=') as [string, string]));
  const { pack, stats } = buildPack({
    repo: need('repo'),
    headSha: need('head'),
    baseSha: need('base'),
    mergeBaseSha: args.one('merge-base') ?? need('base'),
    scip,
    analyses,
    diff: diffPath && existsSync(diffPath) ? readFileSync(diffPath, 'utf8') : undefined,
    tools,
    warnings,
    readFile: (p) => {
      try {
        return readFileSync(join(root, p), 'utf8');
      } catch {
        return undefined;
      }
    },
  });
  const out = args.one('out') ?? 'prv-out/pack.bin';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, pack);
  console.log(`wrote ${out}`, JSON.stringify(stats));
  if (warnings.length) console.warn(`warnings:\n  ${warnings.join('\n  ')}`);
}

async function inspect(args: ReturnType<typeof parseArgs>) {
  const file = args.pos[1];
  if (!file) throw new Error('usage: prv-pack inspect pack.bin [key]');
  const r = await PackReader.open(bufferSource(readFileSync(file)));
  const key = args.pos[2];
  if (key) {
    console.log(JSON.stringify(await r.get(key), null, 2));
    return;
  }
  const m = r.manifest;
  const blobs = Object.entries(m.blobs);
  const total = blobs.reduce((n, [, [, l]]) => n + l, 0);
  console.log(`${m.repo}@${m.headSha.slice(0, 12)} (base ${m.baseSha.slice(0, 12)}, merge-base ${m.mergeBaseSha.slice(0, 12)})`);
  console.log(`format v${m.formatVersion}, generated ${m.generatedAt}, languages ${m.languages.join(', ')}`);
  console.log(`tools: ${Object.entries(m.tools).map(([k, v]) => `${k}@${v}`).join(', ') || '-'}`);
  console.log(`${m.files.length} files, ${m.symbolCount} symbols, ${blobs.length} blobs, ${total} blob bytes`);
  if (m.warnings?.length) console.log(`warnings:\n  ${m.warnings.join('\n  ')}`);
  if (args.one('json')) return;

  const symtab = await r.get('symtab') as SymTab;
  const changed = await r.get('changed') as Changed;
  const label = (s: number) => symtab.label[s] ?? `#${s}`;
  console.log(`\nchanged functions (${changed.functions.length}):`);
  for (const f of changed.functions) console.log(`  ${f.status.padEnd(8)} ${label(f.s)}  ${m.files[f.file]}:${f.start + 1}-${f.end + 1}`);
  if (changed.deleted.length) console.log(`deleted: ${changed.deleted.map((d) => `${d.name} (${d.path})`).join(', ')}`);

  console.log('\ncall edges:');
  for (let b = 0; b <= bucketOf(m.symbolCount - 1); b++) {
    const calls = await r.get(`calls:${b}`) as CallsBucket;
    for (const [s, c] of Object.entries(calls)) {
      for (const e of c.callees) {
        const tags = [e.dyn && 'dynamic', e.approx && 'approx'].filter(Boolean).join(',');
        console.log(`  ${label(+s)} -> ${label(e.s)}${tags ? ` [${tags}]` : ''}  ${m.files[e.at[0]]}:${e.at[1] + 1}`);
      }
    }
  }
  console.log('\nsymbols with docs (first 15):');
  let shown = 0;
  for (let b = 0; b <= bucketOf(m.symbolCount - 1) && shown < 15; b++) {
    const sb = await r.get(`sym:${b}`) as SymBucket;
    for (const s of Object.values(sb)) {
      if (!s.docs || shown++ >= 15) continue;
      const where = s.defs[0] ? `${m.files[s.defs[0][0]]}:${s.defs[0][1] + 1}` : (s.external?.url ?? 'external');
      console.log(`  ${s.label}  [${where}]  ${s.signature?.split('\n')[0] ?? ''}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.pos[0];
  if (cmd === 'build') build(args);
  else if (cmd === 'inspect') await inspect(args);
  else {
    console.error('usage: prv-pack build ... | prv-pack inspect pack.bin [key]');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`prv-pack: ${(e as Error).message}`);
  process.exit(1);
});
