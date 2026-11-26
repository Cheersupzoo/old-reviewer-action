import { readFileSync } from 'node:fs';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@scip-code/scip';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PackReader, bufferSource, type CallsBucket, type Changed, type SymBucket, type SymTab, type DocShard } from '@prv/pack-format';
import { buildPack, type Analysis } from '../src/build.ts';
import { parseSymbol, labelOf, externalUrl } from '../src/symbol.ts';
import { parseUnifiedDiff, covers } from '../src/diff.ts';

const repoRoot = join(import.meta.dirname, '../../..');
const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);

async function fixturePack() {
  const { pack } = buildPack({
    repo: 'acme/go-sample',
    headSha: 'h',
    baseSha: 'b',
    mergeBaseSha: 'm',
    scip: [{ data: readFileSync(fx('go-sample.scip')), root: 'fixtures/go-sample' }],
    analyses: [JSON.parse(readFileSync(fx('go-sample.analysis.json'), 'utf8')) as Analysis],
    diff: readFileSync(fx('go-sample.diff'), 'utf8'),
    tools: { 'scip-go': 'v0.2.10' },
    readFile: (p) => readFileSync(join(repoRoot, p), 'utf8'),
  });
  const r = await PackReader.open(bufferSource(pack));
  const symtab = (await r.get('symtab')) as SymTab;
  const find = (label: string) => {
    const i = symtab.label.indexOf(label);
    if (i < 0) throw new Error(`no symbol ${label}`);
    return i;
  };
  return { r, symtab, find };
}

describe('buildPack on fixtures/go-sample', () => {
  it('traces resolver → service impl → repo impl through interfaces', async () => {
    const { r, find } = await fixturePack();
    const calls = (await r.get('calls:0')) as CallsBucket;
    const callees = (s: number) => calls[s]?.callees.map((e) => ({ s: e.s, dyn: !!e.dyn }));
    expect(callees(find('MutationResolver.CreateOrder'))).toContainEqual({ s: find('orderService.Create'), dyn: true });
    expect(callees(find('orderService.Create'))).toContainEqual({ s: find('MemoryOrderRepo.Insert'), dyn: true });
    expect(callees(find('orderService.Create'))).toContainEqual({ s: find('service.validate'), dyn: false });
    expect(calls[find('MemoryOrderRepo.Insert')]!.callers.map((e) => e.s)).toContain(find('orderService.Create'));
  });

  it('records implementations both ways and hover info for stdlib', async () => {
    const { r, find } = await fixturePack();
    const sym = (await r.get('sym:0')) as SymBucket;
    const iface = sym[find('OrderService.Create')]!;
    expect(iface.implementedBy).toEqual([find('orderService.Create')]);
    expect(sym[find('orderService.Create')]!.implementations).toEqual([find('OrderService.Create')]);
    const bg = sym[find('context.Background')]!;
    expect(bg.signature).toBe('func Background() Context');
    expect(bg.docs).toMatch(/^Background returns a non-nil, empty/);
    expect(bg.external?.url).toBe('https://pkg.go.dev/context#Background');
    expect(sym[find('OrderService.Create')]!.docs).toBe('Create validates and stores a new order.');
  });

  it('detects changed and deleted functions', async () => {
    const { r, symtab } = await fixturePack();
    const changed = (await r.get('changed')) as Changed;
    const byLabel = Object.fromEntries(changed.functions.map((f) => [symtab.label[f.s], f.status]));
    expect(byLabel).toEqual({ 'MutationResolver.CreateOrder': 'added', 'orderService.Create': 'modified' });
    expect(changed.deleted).toEqual([{ name: 'legacyValidate', path: 'fixtures/go-sample/service/order.go' }]);
  });

  it('stores occurrences in UTF-16 sorted order with function ranges', async () => {
    const { r } = await fixturePack();
    const files = r.manifest.files;
    const f = files.indexOf('fixtures/go-sample/service/order.go');
    const shard = (await r.get(`doc:${f}`)) as DocShard;
    const src = readFileSync(join(repoRoot, shard.path), 'utf8').split('\n');
    for (let i = 0; i < shard.occ.length; i += 6) {
      const [sl, sc, el, ec] = shard.occ.slice(i, i + 4) as [number, number, number, number];
      if (sl === el) expect(src[sl]!.slice(sc, ec)).toMatch(/^[\w./"-]+$/);
      if (i) expect(sl > shard.occ[i - 6]! || (sl === shard.occ[i - 6]! && sc >= shard.occ[i - 5]!)).toBe(true);
    }
    expect(shard.functions.length / 3).toBe(4);
  });
});

describe('symbol parsing', () => {
  it('parses Go symbols', () => {
    const p = parseSymbol('scip-go gomod example.com/go-sample . `example.com/go-sample/service`/OrderService#Create.');
    expect(labelOf(p)).toEqual({ name: 'Create', label: 'OrderService.Create', pkg: 'example.com/go-sample/service' });
    const std = parseSymbol('scip-go gomod github.com/golang/go/src go1.22 `net/http`/Client#Do().');
    expect(externalUrl(std)).toBe('https://pkg.go.dev/net/http#Client.Do');
    const dep = parseSymbol('scip-go gomod github.com/foo/bar v1.2.3 `github.com/foo/bar/x`/New().');
    expect(externalUrl(dep)).toBe('https://pkg.go.dev/github.com/foo/bar/x@v1.2.3#New');
  });
  it('parses TS symbols', () => {
    const p = parseSymbol('scip-typescript npm my-app 1.0.0 src/`orders.ts`/OrderService#create().');
    expect(labelOf(p).label).toBe('OrderService.create');
    expect(externalUrl(parseSymbol('scip-typescript npm react 18.3.1 `index.d.ts`/useState().'))).toBe(
      'https://www.npmjs.com/package/react/v/18.3.1',
    );
  });
});

describe('diff parsing', () => {
  it('handles pure deletions, new files and multi-hunks', () => {
    const d = parseUnifiedDiff(
      [
        'diff --git a/x.go b/x.go',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/x.go',
        '@@ -0,0 +1,3 @@',
        '+a',
        '+b',
        '+c',
        'diff --git a/y.go b/y.go',
        '--- a/y.go',
        '+++ b/y.go',
        '@@ -3,2 +2,0 @@',
        '-gone',
        '-gone2',
        '@@ -10 +9 @@',
        '-x',
        '+y',
      ].join('\n'),
    );
    expect(d.get('x.go')).toMatchObject({ oldPath: null, added: [[0, 2]] });
    expect(d.get('y.go')!.added).toEqual([[8, 8]]);
    expect(covers([[0, 2], [3, 5]], 1, 5)).toBe(true);
    expect(covers([[0, 2], [4, 5]], 1, 5)).toBe(false);
  });
});

describe('buildPack with Go + TypeScript', () => {
  async function multiPack() {
    const { pack } = buildPack({
      repo: 'acme/mono',
      headSha: 'h',
      baseSha: 'b',
      mergeBaseSha: 'm',
      scip: [
        { data: readFileSync(fx('go-sample.scip')), root: 'fixtures/go-sample' },
        { data: readFileSync(fx('ts-sample.scip')), root: 'fixtures/ts-sample' },
      ],
      analyses: [
        JSON.parse(readFileSync(fx('go-sample.analysis.json'), 'utf8')) as Analysis,
        JSON.parse(readFileSync(fx('ts-sample.analysis.json'), 'utf8')) as Analysis,
      ],
      tools: {},
      readFile: (p) => readFileSync(join(repoRoot, p), 'utf8'),
    });
    const r = await PackReader.open(bufferSource(pack));
    const symtab = (await r.get('symtab')) as SymTab;
    const find = (label: string) => {
      const i = symtab.label.indexOf(label);
      if (i < 0) throw new Error(`no symbol ${label}`);
      return i;
    };
    const all = async <T,>(prefix: string) => {
      const merged: Record<string, T> = {};
      for (let b = 0; b <= (r.manifest.symbolCount - 1) >> 10; b++) Object.assign(merged, await r.get(`${prefix}:${b}`));
      return merged;
    };
    return { r, find, all };
  }

  it('merges languages and expands TS interface calls to implementations', async () => {
    const { r, find, all } = await multiPack();
    expect(r.manifest.languages).toEqual(['go', 'typescript']);
    const calls = await all<{ callees: { s: number; dyn?: 1; approx?: 1 }[] }>('calls');
    const callees = (s: number) => calls[s]?.callees.map((e) => ({ s: e.s, dyn: !!e.dyn, approx: !!e.approx }));
    expect(callees(find('handler.createOrderHandler'))).toEqual(
      expect.arrayContaining([
        { s: find('OrderService.create'), dyn: true, approx: false },
        { s: find('DefaultOrderService.create'), dyn: true, approx: true },
        { s: find('service.formatAmount'), dyn: false, approx: false },
      ]),
    );
    expect(callees(find('DefaultOrderService.create'))).toEqual(
      expect.arrayContaining([{ s: find('MemoryOrderRepo.insert'), dyn: true, approx: true }]),
    );
    // Go edges still present.
    expect(callees(find('orderService.Create'))?.map((e) => e.s)).toContain(find('MemoryOrderRepo.Insert'));
  });

  it('uses scip-typescript signatures and analyzer hover for TS lib symbols', async () => {
    const { find, all } = await multiPack();
    const sym = await all<{ signature?: string; signatureLang?: string; docs?: string; external?: { url?: string } }>('sym');
    expect(sym[find('OrderService.create')]).toMatchObject({
      signature: '(method) create(input: CreateOrderInput): Promise<Order>',
      signatureLang: 'ts',
      docs: 'Validates and stores a new order.',
    });
    const set = sym[find('Map.set')]!;
    expect(set.signature).toBe('set(key: K, value: V): this');
    expect(set.docs).toMatch(/Adds a new element/);
  });
});

describe('buildPack with Svelte', () => {
  const svelteDiff = [
    'diff --git a/fixtures/svelte-sample/src/lib/Cart.svelte b/fixtures/svelte-sample/src/lib/Cart.svelte',
    '--- a/fixtures/svelte-sample/src/lib/Cart.svelte',
    '+++ b/fixtures/svelte-sample/src/lib/Cart.svelte',
    '@@ -9 +9 @@',
    '-    cart.add(cents * 1);',
    '+    cart.add(cents);',
    '',
  ].join('\n');
  /** `withSvelteScip: false` drops scip-typescript's .svelte documents (e.g. tsconfig doesn't include them). */
  async function sveltePack(withSvelteScip: boolean) {
    let scip = new Uint8Array(readFileSync(fx('svelte-sample.scip')));
    if (!withSvelteScip) {
      const index = fromBinary(IndexSchema, scip);
      index.documents = index.documents.filter((d) => !d.relativePath.endsWith('.svelte'));
      scip = toBinary(IndexSchema, index);
    }
    const { pack } = buildPack({
      repo: 'acme/svelte-sample',
      headSha: 'h',
      baseSha: 'b',
      mergeBaseSha: 'm',
      scip: [{ data: scip, root: 'fixtures/svelte-sample' }],
      analyses: [JSON.parse(readFileSync(fx('svelte-sample.analysis.json'), 'utf8')) as Analysis],
      diff: svelteDiff,
      tools: {},
      readFile: (p) => readFileSync(join(repoRoot, p), 'utf8'),
    });
    const r = await PackReader.open(bufferSource(pack));
    const symtab = (await r.get('symtab')) as SymTab;
    const sym = (await r.get('sym:0')) as SymBucket;
    const calls = (await r.get('calls:0')) as CallsBucket;
    const files = r.manifest.files;
    const shard = (await r.get(`doc:${files.indexOf(cartPath)}`)) as DocShard;
    /** Symbol defined at line:col of a file. */
    const defAt = (file: string, line: number, col: number) => {
      const i = Object.keys(sym).find((k) => sym[+k]!.defs.some((d) => files[d[0]] === file && d[1] === line && d[2] === col));
      if (i === undefined) throw new Error(`no definition at ${file}:${line}:${col}`);
      return +i;
    };
    const occAt = (line: number, col: number) => {
      for (let i = 0; i < shard.occ.length; i += 6) if (shard.occ[i] === line && shard.occ[i + 1] === col) return shard.occ.slice(i, i + 6);
      return undefined;
    };
    return { r, symtab, sym, calls, shard, defAt, occAt };
  }
  const cartPath = 'fixtures/svelte-sample/src/lib/Cart.svelte';
  const pricePath = 'fixtures/svelte-sample/src/lib/Price.svelte';
  const formatPath = 'fixtures/svelte-sample/src/lib/format.ts';

  for (const withSvelteScip of [true, false]) {
    describe(withSvelteScip ? '.svelte documents from scip-typescript' : '.svelte documents from ts-analyzer', () => {
      it('links components, script functions and template calls', async () => {
        const { calls, defAt } = await sveltePack(withSvelteScip);
        const cart = defAt(cartPath, 0, 0);
        const price = defAt(pricePath, 0, 0);
        const addItem = defAt(cartPath, 7, 11);
        expect(calls[cart]!.callees.map((e) => e.s)).toEqual(expect.arrayContaining([price, addItem, defAt(formatPath, 10, 2)]));
        expect(calls[price]!.callers.map((e) => e.s)).toContain(cart);
        expect(calls[addItem]!.callees.map((e) => e.s)).toContain(defAt(formatPath, 7, 2)); // cart.add()
        expect(calls[price]!.callees.map((e) => e.s)).toContain(defAt(formatPath, 1, 16)); // formatAmount()
      });

      it('has occurrences for the .svelte file', async () => {
        const { shard, occAt, defAt } = await sveltePack(withSvelteScip);
        expect(shard.language).toBe('svelte');
        const addItem = defAt(cartPath, 7, 11);
        expect(occAt(7, 11)?.slice(4)).toEqual([addItem, 1]);
        expect(occAt(17, 23)?.slice(0, 5)).toEqual([17, 23, 17, 30, addItem]);
        expect(occAt(22, 19)?.[4]).toBe(defAt(formatPath, 10, 2)); // cart.total() → the .ts method
        expect(occAt(20, 3)?.[4]).toBe(defAt(pricePath, 0, 0)); // <Price>
      });

      it('resolves `import Cart from "./Cart.svelte"` in .ts files to the component', async () => {
        const { r, defAt } = await sveltePack(withSvelteScip);
        const refs = (await r.get('refs:0')) as Record<string, unknown[][]>;
        const main = r.manifest.files.indexOf('fixtures/svelte-sample/src/main.ts');
        expect(refs[defAt(cartPath, 0, 0)]!.some((l) => l[0] === main)).toBe(true);
      });

      it('detects changed functions in .svelte files', async () => {
        const { r, defAt } = await sveltePack(withSvelteScip);
        const changed = (await r.get('changed')) as Changed;
        expect(changed.functions.map((f) => [f.s, f.status])).toEqual(
          expect.arrayContaining([
            [defAt(cartPath, 0, 0), 'modified'],
            [defAt(cartPath, 7, 11), 'modified'],
          ]),
        );
      });
    });
  }

  it('uses ts-analyzer hover info where it indexes the file itself', async () => {
    const { sym, defAt } = await sveltePack(false);
    expect(sym[defAt(cartPath, 7, 11)]).toMatchObject({ label: 'Cart.addItem', signature: 'addItem(cents: number): void' });
  });
});
