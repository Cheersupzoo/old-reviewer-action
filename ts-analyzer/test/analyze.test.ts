import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as TS from 'typescript';
import { analyze } from '../src/analyze.ts';

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
