/**
 * ts-analyzer: function ranges + call edges for a TypeScript project, in the same JSON
 * schema as go-analyzer (see indexer/packer/src/build.ts `Analysis`).
 *
 * Positions are 0-based lines and UTF-16 columns (TypeScript's native encoding).
 * Calls through interface members are emitted as `abstract` edges; the packer expands
 * them to implementations using scip-typescript's `is_implementation` relationships.
 */
import type * as TS from 'typescript';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export interface Pos {
  file: string;
  line: number;
  col: number;
}
export interface Target {
  name: string;
  def?: Pos;
  ext?: string;
}
export interface Output {
  tool: 'ts-analyzer';
  positionEncoding: 'utf16';
  projectDir: string;
  targets: Target[];
  functions: { target: number; file: string; startLine: number; endLine: number }[];
  edges: { caller: number; callee: number; at: Pos; endCol: number; dynamic?: boolean; abstract?: boolean }[];
  externals: { key: string; package: string; version?: string; signature: string; doc?: string; kind: string }[];
  warnings?: string[];
}

type FnNode =
  | TS.FunctionDeclaration
  | TS.MethodDeclaration
  | TS.ConstructorDeclaration
  | TS.GetAccessorDeclaration
  | TS.SetAccessorDeclaration
  | TS.ArrowFunction
  | TS.FunctionExpression;

export function analyze(ts: typeof TS, projectDir: string, repoRoot: string): Output {
  const out: Output = {
    tool: 'ts-analyzer',
    positionEncoding: 'utf16',
    projectDir: toPosix(relative(repoRoot, projectDir)) || '.',
    targets: [],
    functions: [],
    edges: [],
    externals: [],
  };
  const warnings: string[] = [];
  const programs = createPrograms(ts, projectDir, warnings);
  const targetIdx = new Map<string, number>();
  const extSeen = new Set<string>();
  const fnSeen = new Set<string>();
  const edgeSeen = new Set<string>();
  const pkgVersion = new Map<string, string | undefined>();

  const rel = (f: string) => toPosix(relative(repoRoot, f));
  const isProjectFile = (sf: TS.SourceFile) =>
    !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/') && !relative(repoRoot, sf.fileName).startsWith('..');

  for (const program of programs) {
    const checker = program.getTypeChecker();

    const posOf = (node: TS.Node): Pos => {
      const sf = node.getSourceFile();
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return { file: rel(sf.fileName), line: lc.line, col: lc.character };
    };

    const target = (key: string, t: Target): number => {
      let i = targetIdx.get(key);
      if (i === undefined) {
        i = out.targets.length;
        out.targets.push(t);
        targetIdx.set(key, i);
      }
      return i;
    };

    /** Identifier-ish node whose position matches scip-typescript's definition occurrence. */
    const nameNodeOf = (decl: TS.Node): TS.Node | undefined => {
      if (ts.isConstructorDeclaration(decl)) return decl.getChildren().find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword);
      const n = (decl as { name?: TS.Node }).name;
      if (n) return n;
      return undefined;
    };

    const declTarget = (decl: TS.Declaration, display: string): number | undefined => {
      const sf = decl.getSourceFile();
      if (isProjectFile(sf)) {
        const name = nameNodeOf(decl);
        if (!name) return undefined;
        const def = posOf(name);
        return target(`${def.file}:${def.line}:${def.col}`, { name: display, def });
      }
      const ext = externalKey(ts, decl);
      if (!ext) return undefined;
      recordExternal(decl, ext.key, ext.pkg);
      return target(ext.key, { name: display, ext: ext.key });
    };

    const recordExternal = (decl: TS.Declaration, key: string, pkg: string) => {
      if (extSeen.has(key)) return;
      extSeen.add(key);
      const name = nameNodeOf(decl);
      const sym = name ? checker.getSymbolAtLocation(name) : undefined;
      let signature = '';
      try {
        if (sym) {
          const t = checker.getTypeOfSymbolAtLocation(sym, decl);
          const sigs = t.getCallSignatures();
          signature =
            ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)
              ? `${ts.isClassDeclaration(decl) ? 'class' : 'interface'} ${sym.getName()}`
              : sigs.length && sigs[0]
                ? `${sym.getName()}${checker.signatureToString(sigs[0])}`
                : `${sym.getName()}: ${checker.typeToString(t)}`;
        }
      } catch {
        /* type printing can throw on exotic declarations */
      }
      if (!pkgVersion.has(pkg)) pkgVersion.set(pkg, readPkgVersion(decl.getSourceFile().fileName, pkg));
      out.externals.push({
        key,
        package: pkg,
        version: pkgVersion.get(pkg),
        signature,
        doc: sym ? ts.displayPartsToString(sym.getDocumentationComment(checker)) || undefined : undefined,
        kind: kindOf(ts, decl),
      });
    };

    const displayName = (decl: TS.Node): string => {
      const own = ts.isConstructorDeclaration(decl) ? 'constructor' : ((decl as { name?: TS.Node }).name?.getText() ?? 'anonymous');
      let p: TS.Node | undefined = decl.parent;
      while (p) {
        if ((ts.isClassLike(p) || ts.isInterfaceDeclaration(p)) && p.name) return `${p.name.getText()}.${own}`;
        if (ts.isSourceFile(p)) break;
        p = p.parent;
      }
      const base = decl.getSourceFile().fileName.split('/').at(-1)!.replace(/\.(d\.)?[cm]?[jt]sx?$/, '');
      return `${base}.${own}`;
    };

    /** The declaration that names a function-like node (itself, or the variable/property it's assigned to). */
    const namedDeclOf = (fn: FnNode): TS.Declaration | undefined => {
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        const p = fn.parent;
        if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === fn && ts.isIdentifier(p.name)) return p;
        if (ts.isFunctionExpression(fn) && fn.name) return fn;
        return undefined; // anonymous: belongs to its enclosing function
      }
      return fn;
    };

    const resolveCallee = (expr: TS.Node): { decl: TS.Declaration; abstract: boolean } | undefined => {
      const at = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isElementAccessExpression(expr) ? expr.argumentExpression : expr;
      let sym = checker.getSymbolAtLocation(at);
      if (!sym) return undefined;
      if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      let decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) return undefined;
      // `new C()` → constructor if declared, else the class.
      if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) {
        const ctor = decl.members.find(ts.isConstructorDeclaration);
        if (ctor) decl = ctor;
      }
      if (ts.isParameter(decl) || ts.isBindingElement(decl)) return undefined; // callback parameter: unknown target
      if (ts.isVariableDeclaration(decl) && !(decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)))) {
        if (isProjectFile(decl.getSourceFile())) return undefined; // variable holding a value we can't see through
      }
      const abstract =
        isProjectFile(decl.getSourceFile()) &&
        (ts.isMethodSignature(decl) ||
        ts.isPropertySignature(decl) ||
        ((ts.isMethodDeclaration(decl) || ts.isPropertyDeclaration(decl)) &&
          (ts.getCombinedModifierFlags(decl as TS.Declaration) & ts.ModifierFlags.Abstract) !== 0));
      return { decl, abstract };
    };

    for (const sf of program.getSourceFiles()) {
      if (!isProjectFile(sf)) continue;
      const stack: number[] = [];
      const visit = (node: TS.Node) => {
        let pushed = false;
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isConstructorDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)
        ) {
          const named = node.body ? namedDeclOf(node) : undefined;
          if (named) {
            const t = declTarget(named, displayName(named));
            if (t !== undefined) {
              const host = named === node ? node : named;
              const start = sf.getLineAndCharacterOfPosition(host.getStart(sf)).line;
              const end = sf.getLineAndCharacterOfPosition(host.getEnd()).line;
              const k = `${t}:${start}`;
              if (!fnSeen.has(k)) {
                fnSeen.add(k);
                out.functions.push({ target: t, file: rel(sf.fileName), startLine: start, endLine: end });
              }
              stack.push(t);
              pushed = true;
            }
          }
        }

        let calleeExpr: TS.Node | undefined;
        let site: TS.Node | undefined;
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          calleeExpr = node.expression;
          site = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        } else if (ts.isTaggedTemplateExpression(node)) {
          calleeExpr = node.tag;
          site = node.tag;
        } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          // JSX element = call to the component (intrinsic lowercase tags are not calls).
          if (!/^[a-z]/.test(node.tagName.getText())) {
            calleeExpr = node.tagName;
            site = node.tagName;
          }
        }
        const caller = stack.at(-1);
        if (calleeExpr && site && caller !== undefined) {
          const r = resolveCallee(calleeExpr);
          if (r) {
            const callee = declTarget(r.decl, displayName(r.decl));
            if (callee !== undefined) {
              const at = posOf(site);
              const k = `${caller}:${callee}:${at.file}:${at.line}:${at.col}`;
              if (!edgeSeen.has(k)) {
                edgeSeen.add(k);
                out.edges.push({
                  caller,
                  callee,
                  at,
                  endCol: at.col + site.getWidth(sf),
                  ...(r.abstract ? { dynamic: true, abstract: true } : {}),
                });
              }
            }
          }
        }

        // Externals referenced anywhere (for hover), not only calls.
        if (ts.isIdentifier(node) && (node.parent as { name?: TS.Node } | undefined)?.name !== node) {
          let sym = checker.getSymbolAtLocation(node);
          if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
          const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
          if (decl && !isProjectFile(decl.getSourceFile())) {
            const ext = externalKey(ts, decl);
            if (ext) recordExternal(decl, ext.key, ext.pkg);
          }
        }

        ts.forEachChild(node, visit);
        if (pushed) stack.pop();
      };
      visit(sf);
    }
  }
  out.functions.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
  if (warnings.length) out.warnings = warnings;
  return out;
}

function createPrograms(ts: typeof TS, dir: string, warnings: string[]): TS.Program[] {
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    warnings.push('no tsconfig.json found; analyzing *.ts files with defaults');
    const files = ts.sys.readDirectory(dir, ['.ts', '.tsx', '.mts', '.cts'], ['**/node_modules/**', '**/*.d.ts'], ['**/*']);
    return [ts.createProgram(files, { allowJs: false, jsx: ts.JsxEmit.Preserve, noEmit: true, skipLibCheck: true })];
  }
  const seen = new Set<string>();
  const programs: TS.Program[] = [];
  const load = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const parsed = ts.getParsedCommandLineOfConfigFile(path, { noEmit: true }, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => warnings.push(ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    });
    if (!parsed) return;
    if (parsed.fileNames.length) {
      programs.push(ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true }, projectReferences: parsed.projectReferences }));
    }
    // Solution-style configs: follow references.
    for (const ref of parsed.projectReferences ?? []) {
      const p = ts.resolveProjectReferencePath(ref);
      load(p);
    }
  };
  load(configPath);
  return programs;
}

/** "pkg-relative/path.d.ts|Descriptor" — mirrors scip-typescript's namespace + descriptor text. */
export function externalKey(ts: typeof TS, decl: TS.Node): { key: string; pkg: string } | undefined {
  const file = toPosix(decl.getSourceFile().fileName);
  const i = file.lastIndexOf('/node_modules/');
  if (i < 0) return undefined;
  const after = file.slice(i + '/node_modules/'.length);
  const parts = after.split('/');
  const pkg = parts[0]!.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
  const within = parts.slice(pkg.split('/').length).join('/');
  const chain: string[] = [];
  let leaf = decl;
  if (ts.isConstructorDeclaration(leaf)) {
    chain.unshift('`<constructor>`().');
    leaf = leaf.parent;
    const n = (leaf as { name?: TS.Node }).name?.getText();
    if (n) chain.unshift(`${n}#`);
    leaf = leaf.parent;
  } else {
    const name = (leaf as { name?: TS.Node }).name?.getText();
    if (!name) return undefined;
    chain.unshift(
      ts.isFunctionLike(leaf)
        ? `${name}().`
        : ts.isClassLike(leaf) || ts.isInterfaceDeclaration(leaf) || ts.isTypeAliasDeclaration(leaf) || ts.isEnumDeclaration(leaf)
          ? `${name}#`
          : `${name}.`,
    );
    leaf = leaf.parent;
  }
  for (let p: TS.Node | undefined = leaf; p && !ts.isSourceFile(p); p = p.parent) {
    if ((ts.isClassLike(p) || ts.isInterfaceDeclaration(p) || ts.isEnumDeclaration(p)) && p.name) chain.unshift(`${p.name.getText()}#`);
    else if (ts.isModuleDeclaration(p)) chain.unshift(`${escapeName(p.name.getText())}/`);
  }
  return { key: `${within}|${chain.join('')}`, pkg };
}

const escapeName = (s: string) => (/^[\w$+-]+$/.test(s) ? s : '`' + s.replace(/`/g, '``') + '`');

function kindOf(ts: typeof TS, d: TS.Node): string {
  if (ts.isClassLike(d)) return 'class';
  if (ts.isInterfaceDeclaration(d)) return 'interface';
  if (ts.isTypeAliasDeclaration(d)) return 'type';
  if (ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isConstructorDeclaration(d)) return 'method';
  if (ts.isFunctionLike(d)) return 'function';
  if (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) return 'field';
  if (ts.isEnumDeclaration(d)) return 'type';
  return 'variable';
}

function readPkgVersion(file: string, pkg: string): string | undefined {
  let dir = dirname(file);
  while (dir.includes('node_modules')) {
    if (toPosix(dir).endsWith(`/node_modules/${pkg}`)) {
      try {
        return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version;
      } catch {
        return undefined;
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

const toPosix = (p: string) => p.split(sep).join('/');
