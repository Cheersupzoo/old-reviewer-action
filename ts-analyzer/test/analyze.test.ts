import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as TS from 'typescript';
import { analyze } from '../src/analyze.ts';
import { loadSvelteTooling } from '../src/svelte.ts';

const ts = createRequire(import.meta.url)('typescript-api') as typeof TS;
const root = join(import.meta.dirname, '../../..');

describe('ts-analyzer on fixtures/ts-sample', () => {
  const out = analyze(ts, join(root, 'fixtures/ts-sample'), root);
  const name = (i: number) => out.targets[i]!.name;
  const edges = out.edges.map((e) => [name(e.caller), name(e.callee), !!e.abstract]);

  it('finds functions, methods, arrow functions and their ranges', () => {
    const fns = Object.fromEntries(out.functions.map((f) => [name(f.target), [f.file, f.startLine, f.endLine]]));
    expect(fns['DefaultOrderService.create']).toEqual(['fixtures/ts-sample/src/service.ts', 12, 15]);
    expect(fns['service.formatAmount']).toEqual(['fixtures/ts-sample/src/service.ts', 22, 22]);
    expect(fns['handler.createOrderHandler']).toBeDefined();
  });

  it('emits static calls and abstract interface calls', () => {
    expect(edges).toContainEqual(['handler.createOrderHandler', 'OrderService.create', true]);
    expect(edges).toContainEqual(['DefaultOrderService.create', 'OrderRepo.insert', true]);
    expect(edges).toContainEqual(['DefaultOrderService.create', 'service.validate', false]);
    // Calls inside the returned arrow belong to the enclosing named function.
    expect(edges).toContainEqual(['handler.createOrderHandler', 'service.formatAmount', false]);
  });

  it('uses definition positions that match the identifier (UTF-16)', () => {
    const t = out.targets.find((x) => x.name === 'OrderService.create')!;
    expect(t.def).toEqual({ file: 'fixtures/ts-sample/src/service.ts', line: 6, col: 2 });
  });

  it('records hover info for lib symbols keyed like scip-typescript', () => {
    const set = out.externals.find((x) => x.key === 'lib/lib.es2015.collection.d.ts|Map#set().');
    expect(set).toMatchObject({ package: 'typescript', signature: 'set(key: K, value: V): this' });
  });
});

describe('ts-analyzer on fixtures/react-sample (tsx, jsx, js)', () => {
  const out = analyze(ts, join(root, 'fixtures/react-sample'), root);
  const name = (i: number) => out.targets[i]!.name;
  const fns = Object.fromEntries(out.functions.map((f) => [name(f.target), [f.file, f.startLine, f.endLine]]));
  const edges = out.edges.map((e) => [name(e.caller), name(e.callee)]);

  it('names components wrapped in memo / forwardRef / useCallback', () => {
    expect(fns['Price.Price']).toEqual(['fixtures/react-sample/src/Price.jsx', 3, 3]);
    expect(fns['Cart.Cart']).toEqual(['fixtures/react-sample/src/Cart.tsx', 9, 25]);
    expect(fns['Cart.add']).toEqual(['fixtures/react-sample/src/Cart.tsx', 11, 13]);
    expect(fns['format.formatAmount']).toBeDefined(); // .js file
  });

  it('treats JSX elements as calls to the component, through wrappers', () => {
    expect(edges).toContainEqual(['Cart.Cart', 'Price.Price']);
    expect(edges).toContainEqual(['Cart.Cart', 'Cart.total']);
    expect(edges).toContainEqual(['Price.Price', 'format.formatAmount']);
    // Intrinsic elements are not calls.
    expect(edges.filter(([, callee]) => /^(div|span|button)$/.test(callee!))).toEqual([]);
  });

  it('does not turn values of ordinary calls into functions', () => {
    expect(Object.keys(fns)).not.toContain('Cart.items');
  });
});

describe('ts-analyzer on fixtures/svelte-sample', () => {
  const svelte = loadSvelteTooling(join(root, 'fixtures/svelte-sample'), join(import.meta.dirname, '..', 'node_modules'))!;
  const out = analyze(ts, join(root, 'fixtures/svelte-sample'), root, { svelte });
  const name = (i: number) => out.targets[i]!.name;
  const fns = Object.fromEntries(out.functions.map((f) => [name(f.target), [f.file, f.startLine, f.endLine]]));
  const edges = out.edges.map((e) => [name(e.caller), name(e.callee), `${e.at.line}:${e.at.col}-${e.endCol}`]);
  const cart = 'fixtures/svelte-sample/src/lib/Cart.svelte';

  it('finds svelte2tsx', () => expect(svelte).toBeDefined());

  it('maps components and script functions back to the .svelte file', () => {
    expect(fns['Cart']).toEqual([cart, 0, 23]);
    expect(fns['Cart.addItem']).toEqual([cart, 7, 10]);
    expect(fns['Cart.reset']).toEqual([cart, 12, 14]);
  });

  it('emits calls from the script and the template, including child components', () => {
    expect(edges).toContainEqual(['Cart.addItem', 'Cart.add', '8:9-12']);
    expect(edges).toContainEqual(['Cart', 'Cart.addItem', '17:23-30']); // onclick={() => addItem(500)}
    expect(edges).toContainEqual(['Cart', 'Price', '20:3-8']); // <Price {cents} />
    expect(edges).toContainEqual(['Price', 'format.formatAmount', '6:21-33']);
    // Nothing from svelte2tsx's generated code.
    expect(edges.filter(([, callee]) => callee!.includes('sveltets'))).toEqual([]);
  });

  it('emits occurrences for .svelte files', () => {
    const doc = out.documents!.find((d) => d.path === cart)!;
    const rows: string[] = [];
    for (let i = 0; i < doc.occurrences.length; i += 5) {
      const [l, c, ec, t, r] = doc.occurrences.slice(i, i + 5) as number[];
      rows.push(`${l}:${c}-${ec} ${name(t!)}${r ? ' def' : ''}`);
    }
    expect(rows).toContain('7:11-18 Cart.addItem def');
    expect(rows).toContain('17:23-30 Cart.addItem');
    expect(rows).toContain('20:3-8 Price');
    expect(rows).toContain('20:10-15 Cart.cents'); // shorthand {cents} is a reference
    expect(rows).toContain('22:19-24 Cart.total');
    const addItem = out.targets.find((t) => t.name === 'Cart.addItem')!;
    expect(addItem).toMatchObject({ kind: 'function', signature: 'addItem(cents: number): void' });
  });
});
