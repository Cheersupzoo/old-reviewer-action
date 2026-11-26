/**
 * ts-analyzer: function ranges + call edges for a TypeScript project, in the same JSON
 * schema as go-analyzer (see indexer/packer/src/build.ts `Analysis`).
 *
 * Positions are 0-based lines and UTF-16 columns (TypeScript's native encoding).
 * Calls through interface members are emitted as `abstract` edges; the packer expands
 * them to implementations using scip-typescript's `is_implementation` relationships.
 *
 * `.svelte` components (see svelte.ts) are analyzed through svelte2tsx: each component is a
 * target defined at 0:0 (matching scip-typescript's module symbol) whose range is the whole
 * file, so script top level and template calls belong to it. For those files the analyzer
 * also emits occurrences (`documents`) and definitions (targets with `kind`/`signature`);
 * the packer uses them only where scip-typescript didn't index the file.
 */
import type * as TS from 'typescript';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { SvelteFiles, type SvelteTooling } from './svelte.ts';

export interface Pos {
  file: string;
  line: number;
  col: number;
}
export interface Target {
  name: string;
  def?: Pos & { endCol?: number };
  ext?: string;
  /** Set for definitions in `.svelte` files, for when no SCIP index covers them (`documents`). */
  kind?: string;
  signature?: string;
  doc?: string;
  local?: boolean;
}
/** Occurrences for a `.svelte` file: flat [line, col, endCol, target, role(1 = definition)]. */
export interface Document {
  path: string;
  language: string;
  occurrences: number[];
}
export interface Output {
  tool: 'ts-analyzer';
  positionEncoding: 'utf16';
  projectDir: string;
  targets: Target[];
  functions: { target: number; file: string; startLine: number; endLine: number }[];
  edges: { caller: number; callee: number; at: Pos; endCol: number; dynamic?: boolean; abstract?: boolean }[];
  externals: { key: string; package: string; version?: string; signature: string; doc?: string; kind: string }[];
  documents?: Document[];
  warnings?: string[];
}

export interface AnalyzeOptions {
  /** svelte2tsx and its shims; `.svelte` files are skipped without it. */
  svelte?: SvelteTooling;
}

type FnNode =
  | TS.FunctionDeclaration
  | TS.MethodDeclaration
  | TS.ConstructorDeclaration
  | TS.GetAccessorDeclaration
  | TS.SetAccessorDeclaration
  | TS.ArrowFunction
  | TS.FunctionExpression;

export function analyze(ts: typeof TS, projectDir: string, repoRoot: string, opts: AnalyzeOptions = {}): Output {
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
  const svelte = opts.svelte ? new SvelteFiles(opts.svelte) : undefined;
  const programs = createPrograms(ts, projectDir, warnings, svelte);
  const documents = new Map<string, Document>();
  const targetIdx = new Map<string, number>();
  const extSeen = new Set<string>();
  const fnSeen = new Set<string>();
  const edgeSeen = new Set<string>();
  const pkgVersion = new Map<string, string | undefined>();

  const isVirtual = (f: string) => !!svelte?.isVirtual(f);
  const realFile = (f: string) => (svelte?.isVirtual(f) ? svelte.toReal(f) : f);
  const rel = (f: string) => toPosix(relative(repoRoot, realFile(f)));
  const isProjectFile = (sf: TS.SourceFile) =>
    !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/') && !relative(repoRoot, sf.fileName).startsWith('..');

  for (const program of programs) {
    const checker = program.getTypeChecker();

    /** Start of `node` in the file the user wrote; undefined for svelte2tsx-generated code. */
    const posOf = (node: TS.Node): Pos | undefined => {
      const sf = node.getSourceFile();
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      if (!isVirtual(sf.fileName)) return { file: rel(sf.fileName), line: lc.line, col: lc.character };
      const text = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : undefined;
      const o = svelte!.toOriginal(sf.fileName, lc.line, lc.character, text);
      return o && { file: rel(sf.fileName), line: o.line, col: o.col };
    };
    /** Line of a generated position in the `.svelte` file (no text check, for ranges). */
    const lineOf = (sf: TS.SourceFile, pos: number): number | undefined => {
      const lc = sf.getLineAndCharacterOfPosition(pos);
      return isVirtual(sf.fileName) ? svelte!.toOriginal(sf.fileName, lc.line, lc.character)?.line : lc.line;
    };

    /** svelte2tsx's generated default export (`const Foo__SvelteComponent_ = …`) stands for the component. */
    const isComponentExport = (decl: TS.Declaration) => {
      if (!isVirtual(decl.getSourceFile().fileName)) return false;
      const n = (decl as { name?: TS.Node }).name;
      return !!n && ts.isIdentifier(n) && /__SvelteComponent_$/.test(n.text);
    };

    /** One target per component, standing for the whole `.svelte` file (definition at 0:0). */
    const componentTarget = (sf: TS.SourceFile): number => {
      const file = rel(sf.fileName);
      return target(`${file}:component`, {
        name: componentName(file),
        def: { file, line: 0, col: 0, endCol: 0 },
        kind: 'function',
        signature: `component ${componentName(file)}`,
      });
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
      if (isVirtual(sf.fileName)) {
        const name = nameNodeOf(decl);
        const def = name && posOf(name);
        if (def && name) {
          return target(`${def.file}:${def.line}:${def.col}`, {
            name: display,
            def: { ...def, endCol: def.col + name.getWidth(sf) },
            kind: kindOf(ts, decl),
            ...hoverOf(decl, name),
            ...(isNested(decl) ? { local: true } : {}),
          });
        }
        if (isComponentExport(decl)) return componentTarget(sf);
        return undefined;
      }
      if (isProjectFile(sf)) {
        const name = nameNodeOf(decl);
        if (!name) return undefined;
        const def = posOf(name)!;
        return target(`${def.file}:${def.line}:${def.col}`, { name: display, def });
      }
      const ext = externalKey(ts, decl);
      if (!ext) return undefined;
      recordExternal(decl, ext.key, ext.pkg);
      return target(ext.key, { name: display, ext: ext.key });
    };

    /** Signature and doc comment for hovers. */
    const hoverOf = (decl: TS.Declaration, name: TS.Node | undefined): { signature?: string; doc?: string } => {
      const sym = name ? checker.getSymbolAtLocation(name) : undefined;
      if (!sym) return {};
      let signature = '';
      try {
        const t = checker.getTypeOfSymbolAtLocation(sym, decl);
        const sigs = t.getCallSignatures();
        signature =
          ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)
            ? `${ts.isClassDeclaration(decl) ? 'class' : 'interface'} ${sym.getName()}`
            : ts.isTypeAliasDeclaration(decl)
              ? `type ${sym.getName()} = ${checker.typeToString(checker.getDeclaredTypeOfSymbol(sym))}`
              : sigs.length && sigs[0]
                ? `${sym.getName()}${checker.signatureToString(sigs[0])}`
                : `${sym.getName()}: ${checker.typeToString(t)}`;
      } catch {
        /* type printing can throw on exotic declarations */
      }
      const doc = ts.displayPartsToString(sym.getDocumentationComment(checker)) || undefined;
      return { ...(signature ? { signature } : {}), ...(doc ? { doc } : {}) };
    };

    const recordExternal = (decl: TS.Declaration, key: string, pkg: string) => {
      if (extSeen.has(key)) return;
      extSeen.add(key);
      const hover = hoverOf(decl, nameNodeOf(decl));
      if (!pkgVersion.has(pkg)) pkgVersion.set(pkg, readPkgVersion(decl.getSourceFile().fileName, pkg));
      out.externals.push({
        key,
        package: pkg,
        version: pkgVersion.get(pkg),
        signature: hover.signature ?? '',
        doc: hover.doc,
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
      const fileName = realFile(decl.getSourceFile().fileName);
      const base = fileName.endsWith('.svelte') ? componentName(fileName) : fileName.split('/').at(-1)!.replace(/\.(d\.)?[cm]?[jt]sx?$/, '');
      return `${base}.${own}`;
    };

    /** The declaration that names a function-like node (itself, or the variable/property it's assigned to). */
    const namedDeclOf = (fn: FnNode): TS.Declaration | undefined => {
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        if (ts.isFunctionExpression(fn) && fn.name) return fn;
        // `const X = () => …`, also through wrappers: `const X = memo(forwardRef((p, ref) => …))`,
        // `const onClick = useCallback(() => …, [])`, `(… ) as T`, `… satisfies T`.
        let p: TS.Node = fn.parent;
        let child: TS.Node = fn;
        for (;;) {
          if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) {
            child = p;
            p = p.parent;
          } else if (ts.isCallExpression(p) && p.arguments[0] === child && isFunctionWrapper(ts, p)) {
            child = p;
            p = p.parent;
          } else break;
        }
        if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === child && ts.isIdentifier(p.name)) return p;
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
      if (ts.isVariableDeclaration(decl) && !(decl.initializer && wrapsFunction(ts, decl.initializer)) && !isComponentExport(decl)) {
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
      const virtual = isVirtual(sf.fileName);
      const stack: number[] = [];
      const occ: number[] = [];
      if (virtual) {
        // Script top level and template belong to the component.
        const c = componentTarget(sf);
        const file = rel(sf.fileName);
        const end = svelte!.lineCount(realFile(sf.fileName)) - 1;
        if (!fnSeen.has(`${c}:0`)) {
          fnSeen.add(`${c}:0`);
          out.functions.push({ target: c, file, startLine: 0, endLine: end });
        }
        stack.push(c);
      }
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
            const host = named === node ? node : named;
            const start = t === undefined ? undefined : lineOf(sf, host.getStart(sf));
            if (t !== undefined && start !== undefined) {
              const last = host.getLastToken(sf);
              const end = Math.max(start, (last && lineOf(sf, last.getStart(sf))) ?? start);
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
        if (virtual && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments[0] &&
          /^__sveltets_\d+_ensureComponent$/.test(node.expression.text)) {
          // svelte2tsx turns `<Child …/>` into `__sveltets_2_ensureComponent(Child)`.
          const arg = node.arguments[0];
          calleeExpr = arg;
          site = ts.isPropertyAccessExpression(arg) ? arg.name : arg;
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          calleeExpr = node.expression;
          site = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        } else if (ts.isTaggedTemplateExpression(node)) {
          calleeExpr = node.tag;
          site = node.tag;
        } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          // JSX element = call to the component. Intrinsic tags (`div`, `my-element`,
          // `svg:rect`) are not calls; `Foo`, `Foo.Bar`, `ctx.Provider` are.
          const tag = node.tagName;
          if (!(ts.isIdentifier(tag) && /^[a-z]|-/.test(tag.text)) && !(ts.isJsxNamespacedName?.(tag) ?? false)) {
            calleeExpr = tag;
            site = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
          }
        }
        const caller = stack.at(-1);
        if (calleeExpr && site && caller !== undefined) {
          const r = resolveCallee(calleeExpr);
          const at = r && posOf(site);
          if (r && at) {
            const callee = declTarget(r.decl, displayName(r.decl));
            if (callee !== undefined) {
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

        if (virtual && ts.isIdentifier(node)) {
          // Occurrences for the viewer (no SCIP index covers .svelte files).
          const at = posOf(node);
          if (at) {
            // `<Child {value} />` becomes `{ value }`: a reference to the variable, not a new property.
            let sym = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
              ? checker.getShorthandAssignmentValueSymbol(node.parent)
              : checker.getSymbolAtLocation(node);
            if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
            const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
            if (decl) {
              const isDef = nameNodeOf(decl) === node;
              const t = declTarget(decl, displayName(decl));
              if (t !== undefined) occ.push(at.line, at.col, at.col + node.text.length, t, isDef ? 1 : 0);
              if (!isProjectFile(decl.getSourceFile()) && !isVirtual(decl.getSourceFile().fileName)) {
                const ext = externalKey(ts, decl);
                if (ext) recordExternal(decl, ext.key, ext.pkg);
              }
            }
          }
        } else if (ts.isIdentifier(node) && (node.parent as { name?: TS.Node } | undefined)?.name !== node) {
          // Externals referenced anywhere (for hover), not only calls.
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
      if (virtual) {
        const path = rel(sf.fileName);
        if (!documents.has(path)) documents.set(path, { path, language: 'svelte', occurrences: dedupeOcc(occ) });
      }
    }
  }
  out.functions.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
  if (documents.size) out.documents = [...documents.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (svelte) warnings.push(...svelte.warnings);
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** Sorted, without repeats (svelte2tsx can emit one template identifier more than once). */
function dedupeOcc(occ: number[]): number[] {
  const rows: number[][] = [];
  for (let i = 0; i < occ.length; i += 5) rows.push(occ.slice(i, i + 5));
  rows.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || b[4]! - a[4]!);
  const outRows = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1]![0] || r[1] !== rows[i - 1]![1]);
  return outRows.flat();
}

/** `() => …`, `function () {}`, or one wrapped in calls / parens / `as`: `memo(forwardRef(() => …))`. */
function wrapsFunction(ts: typeof TS, e: TS.Expression): boolean {
  for (;;) {
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e) && e.arguments[0] && isFunctionWrapper(ts, e)) e = e.arguments[0];
    else return false;
  }
}

/** Calls whose result is (a wrapped version of) their first argument: React's `memo`, `forwardRef`, … */
const WRAPPERS = /^(memo|forwardRef|lazy|observer|useCallback|useEffectEvent|debounce|throttle|once)$/;
function isFunctionWrapper(ts: typeof TS, call: TS.CallExpression): boolean {
  const e = call.expression;
  const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
  return WRAPPERS.test(name);
}

/** Declared inside a function (not at the top level of a module or a component's script). */
function isNested(decl: TS.Node): boolean {
  for (let p = decl.parent; p; p = p.parent) {
    // FunctionDeclaration, FunctionExpression, ArrowFunction, MethodDeclaration, Constructor, accessors
    if ('body' in p && 'parameters' in p) {
      const name = (p as { name?: { getText(): string } }).name?.getText();
      if (name === '$$render') return false; // svelte2tsx's wrapper around the instance script
      return true;
    }
  }
  return false;
}

/** `src/lib/Button.svelte` → `Button`, `src/routes/+page.svelte` → `+page`. */
function componentName(file: string): string {
  return file.split('/').at(-1)!.replace(/\.svelte$/, '');
}

const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const IGNORED_DIRS = ['**/node_modules/**', '**/*.d.ts', '**/dist/**', '**/build/**', '**/.svelte-kit/**'];

function createPrograms(ts: typeof TS, dir: string, warnings: string[], svelte?: SvelteFiles): TS.Program[] {
  const make = (rootNames: string[], options: TS.CompilerOptions, projectReferences?: readonly TS.ProjectReference[]) => {
    options = { ...options, noEmit: true };
    let host = ts.createCompilerHost(options, true);
    const svelteRoots = rootNames.filter((f) => f.endsWith('.svelte'));
    rootNames = rootNames.filter((f) => !f.endsWith('.svelte'));
    if (svelte && svelteRoots.length) {
      host = svelte.wrapHost(ts, host, options);
      rootNames = [...rootNames, ...svelte.shims, ...svelteRoots.map(svelte.toVirtual)];
    } else if (svelteRoots.length) {
      warnings.push(`svelte2tsx not found; ${svelteRoots.length} .svelte files skipped`);
    }
    return ts.createProgram({ rootNames, options, projectReferences, host });
  };
  const svelteExt: TS.FileExtensionInfo[] = [{ extension: 'svelte', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }];
  // tsconfig.json, else jsconfig.json (JavaScript projects).
  const configPath =
    ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json') ?? ts.findConfigFile(dir, ts.sys.fileExists, 'jsconfig.json');
  if (!configPath) {
    warnings.push('no tsconfig.json or jsconfig.json found; analyzing source files with defaults');
    const exts = [...SOURCE_EXTS, '.svelte'];
    const files = ts.sys.readDirectory(dir, exts, IGNORED_DIRS, ['**/*']);
    return [
      make(files, {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
        skipLibCheck: true,
      }),
    ];
  }
  const seen = new Set<string>();
  const programs: TS.Program[] = [];
  const load = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      path,
      { noEmit: true, ...(path.endsWith('jsconfig.json') ? { allowJs: true } : {}) },
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => warnings.push(ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      },
      undefined,
      undefined,
      svelteExt,
    );
    if (!parsed) return;
    if (parsed.fileNames.length) {
      programs.push(make(parsed.fileNames, parsed.options, parsed.projectReferences));
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
  if (ts.isVariableDeclaration(d) && d.initializer && wrapsFunction(ts, d.initializer)) return 'function';
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
