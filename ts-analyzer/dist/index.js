#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli.ts
import { createRequire as createRequire2 } from "node:module";
import { writeFileSync } from "node:fs";
import { join as join3, resolve as resolve2, dirname as dirname3 } from "node:path";
import { fileURLToPath } from "node:url";

// src/analyze.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2, relative, sep } from "node:path";

// src/svelte.ts
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
var VIRTUAL_SUFFIX = ".__prv.ts";
function loadSvelteTooling(projectDir, fallback) {
  const bases = [projectDir, ...fallback ? [fallback] : []];
  let version;
  try {
    const req = createRequire(join(projectDir, "noop.js"));
    version = JSON.parse(readFileSync(req.resolve("svelte/package.json"), "utf8")).version;
  } catch {
  }
  for (const base of bases) {
    try {
      const req = createRequire(join(resolve(base), "noop.js"));
      const entry = req.resolve("svelte2tsx");
      const mod = req(entry);
      if (typeof mod.svelte2tsx !== "function") continue;
      const pkgDir = dirname(entry);
      const isV5 = !version || Number(version.split(".")[0]) >= 5;
      const shims = (isV5 ? ["svelte-shims-v4.d.ts", "svelte-jsx-v4.d.ts"] : ["svelte-shims.d.ts", "svelte-jsx.d.ts"]).map((f) => join(pkgDir, f)).filter((f) => existsSync(f));
      return { svelte2tsx: mod.svelte2tsx, shims, version };
    } catch {
    }
  }
  return void 0;
}
var SvelteFiles = class {
  cache = /* @__PURE__ */ new Map();
  warnings = [];
  tooling;
  constructor(tooling) {
    this.tooling = tooling;
  }
  get shims() {
    return this.tooling.shims;
  }
  isVirtual = (f) => f.endsWith(".svelte" + VIRTUAL_SUFFIX);
  toVirtual = (real) => real + VIRTUAL_SUFFIX;
  toReal = (virtual) => virtual.slice(0, -VIRTUAL_SUFFIX.length);
  compiled(real) {
    if (!this.cache.has(real)) this.cache.set(real, this.compile(real));
    return this.cache.get(real) ?? void 0;
  }
  compile(real) {
    let text;
    try {
      text = readFileSync(real, "utf8");
    } catch {
      return null;
    }
    try {
      const isTsFile = /<script\b[^>]*\blang\s*=\s*["']?(ts|typescript)\b/.test(text);
      const res = this.tooling.svelte2tsx(text, {
        filename: real,
        isTsFile,
        mode: "ts",
        emitOnTemplateError: true,
        ...this.tooling.version ? { version: this.tooling.version } : {}
      });
      const lineStarts = [0];
      for (let i = 0; i < res.code.length; i++) if (res.code.charCodeAt(i) === 10) lineStarts.push(i + 1);
      return { code: res.code, lines: text.split(/\r?\n/), segments: decodeMappings(res.map.mappings), lineStarts };
    } catch (e) {
      if (this.warnings.length < 20) this.warnings.push(`svelte2tsx failed for ${real}: ${e.message.split("\n")[0]}`);
      return null;
    }
  }
  /** Map a generated position back to the `.svelte` file. `text`, when given, must appear there. */
  toOriginal(virtual, line, col, text) {
    const c = this.compiled(this.toReal(virtual));
    const segs = c?.segments[line];
    if (!c || !segs?.length) return void 0;
    let lo = 0;
    let hi = segs.length / 3 - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (segs[mid * 3] <= col) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return void 0;
    const pos = { line: segs[best * 3 + 1], col: segs[best * 3 + 2] + (col - segs[best * 3]) };
    if (text !== void 0 && c.lines[pos.line]?.slice(pos.col, pos.col + text.length) !== text) return void 0;
    return pos;
  }
  lineCount(real) {
    return this.compiled(real)?.lines.length ?? 1;
  }
  /** Wraps a compiler host so `.svelte` imports resolve to the virtual files. */
  wrapHost(ts, host, options) {
    const self = this;
    const servable = (f) => self.isVirtual(f) && !f.includes("/node_modules/") && self.compiled(self.toReal(f)) !== void 0;
    const fileExists = (f) => self.isVirtual(f) ? servable(f) : host.fileExists(f);
    const readFile = (f) => self.isVirtual(f) ? self.compiled(self.toReal(f))?.code : host.readFile(f);
    const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), (s) => host.getCanonicalFileName(s), options);
    const resHost = { ...host, fileExists, readFile };
    const resolveOne = (name, containingFile, opts, redirected, mode) => {
      if (name.endsWith(".svelte")) {
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
          return code === void 0 ? void 0 : ts.createSourceFile(fileName, code, languageVersion, true, ts.ScriptKind.TS);
        }
        return host.getSourceFile(fileName, languageVersion, onError, shouldCreate);
      },
      resolveModuleNameLiterals(literals, containingFile, redirected, opts, containingSourceFile) {
        return literals.map((lit) => {
          let mode;
          try {
            mode = ts.getModeForUsageLocation(
              containingSourceFile,
              lit,
              opts
            );
          } catch {
            mode = void 0;
          }
          return resolveOne(lit.text, containingFile, redirected?.commandLine.options ?? opts, redirected, mode);
        });
      }
    };
  }
};
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_INDEX = new Map([...B64].map((c, i) => [c, i]));
function decodeMappings(mappings) {
  const lines = [];
  let cur = [];
  let genCol = 0;
  let srcLine = 0;
  let srcCol = 0;
  let i = 0;
  const vals = [];
  const readVlq = () => {
    let result = 0;
    let shift = 0;
    for (; ; ) {
      const d = B64_INDEX.get(mappings[i++]);
      if (d === void 0) throw new Error("bad VLQ");
      result += (d & 31) << shift;
      if (!(d & 32)) break;
      shift += 5;
    }
    return result & 1 ? -(result >>> 1) : result >>> 1;
  };
  while (i <= mappings.length) {
    const c = mappings[i];
    if (c === void 0 || c === ";") {
      sortTriples(cur);
      lines.push(cur);
      cur = [];
      genCol = 0;
      i++;
      if (c === void 0) break;
      continue;
    }
    if (c === ",") {
      i++;
      continue;
    }
    vals.length = 0;
    while (i < mappings.length && mappings[i] !== "," && mappings[i] !== ";") vals.push(readVlq());
    genCol += vals[0];
    if (vals.length >= 4) {
      srcLine += vals[2];
      srcCol += vals[3];
      cur.push(genCol, srcLine, srcCol);
    }
  }
  return lines;
}
function sortTriples(a) {
  const n = a.length / 3;
  let sorted = true;
  for (let k = 1; k < n; k++) if (a[k * 3] < a[(k - 1) * 3]) sorted = false;
  if (sorted) return;
  const t = [];
  for (let k = 0; k < n; k++) t.push(a.slice(k * 3, k * 3 + 3));
  t.sort((x, y) => x[0] - y[0]);
  a.splice(0, a.length, ...t.flat());
}

// src/analyze.ts
function analyze(ts, projectDir, repoRoot, opts = {}) {
  const out = {
    tool: "ts-analyzer",
    positionEncoding: "utf16",
    projectDir: toPosix(relative(repoRoot, projectDir)) || ".",
    targets: [],
    functions: [],
    edges: [],
    externals: []
  };
  const warnings = [];
  const svelte = opts.svelte ? new SvelteFiles(opts.svelte) : void 0;
  const programs = createPrograms(ts, projectDir, warnings, svelte);
  const documents = /* @__PURE__ */ new Map();
  const targetIdx = /* @__PURE__ */ new Map();
  const extSeen = /* @__PURE__ */ new Set();
  const fnSeen = /* @__PURE__ */ new Set();
  const edgeSeen = /* @__PURE__ */ new Set();
  const pkgVersion = /* @__PURE__ */ new Map();
  const isVirtual = (f) => !!svelte?.isVirtual(f);
  const realFile = (f) => svelte?.isVirtual(f) ? svelte.toReal(f) : f;
  const rel = (f) => toPosix(relative(repoRoot, realFile(f)));
  const isProjectFile = (sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/") && !relative(repoRoot, sf.fileName).startsWith("..");
  for (const program of programs) {
    const checker = program.getTypeChecker();
    const posOf = (node) => {
      const sf = node.getSourceFile();
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      if (!isVirtual(sf.fileName)) return { file: rel(sf.fileName), line: lc.line, col: lc.character };
      const text = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : void 0;
      const o = svelte.toOriginal(sf.fileName, lc.line, lc.character, text);
      return o && { file: rel(sf.fileName), line: o.line, col: o.col };
    };
    const lineOf = (sf, pos) => {
      const lc = sf.getLineAndCharacterOfPosition(pos);
      return isVirtual(sf.fileName) ? svelte.toOriginal(sf.fileName, lc.line, lc.character)?.line : lc.line;
    };
    const isComponentExport = (decl) => {
      if (!isVirtual(decl.getSourceFile().fileName)) return false;
      const n = decl.name;
      return !!n && ts.isIdentifier(n) && /__SvelteComponent_$/.test(n.text);
    };
    const componentTarget = (sf) => {
      const file = rel(sf.fileName);
      return target(`${file}:component`, {
        name: componentName(file),
        def: { file, line: 0, col: 0, endCol: 0 },
        kind: "function",
        signature: `component ${componentName(file)}`
      });
    };
    const target = (key, t) => {
      let i = targetIdx.get(key);
      if (i === void 0) {
        i = out.targets.length;
        out.targets.push(t);
        targetIdx.set(key, i);
      }
      return i;
    };
    const nameNodeOf = (decl) => {
      if (ts.isConstructorDeclaration(decl)) return decl.getChildren().find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword);
      const n = decl.name;
      if (n) return n;
      return void 0;
    };
    const declTarget = (decl, display) => {
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
            ...isNested(decl) ? { local: true } : {}
          });
        }
        if (isComponentExport(decl)) return componentTarget(sf);
        return void 0;
      }
      if (isProjectFile(sf)) {
        const name = nameNodeOf(decl);
        if (!name) return void 0;
        const def = posOf(name);
        return target(`${def.file}:${def.line}:${def.col}`, { name: display, def });
      }
      const ext = externalKey(ts, decl);
      if (!ext) return void 0;
      recordExternal(decl, ext.key, ext.pkg);
      return target(ext.key, { name: display, ext: ext.key });
    };
    const hoverOf = (decl, name) => {
      const sym = name ? checker.getSymbolAtLocation(name) : void 0;
      if (!sym) return {};
      let signature = "";
      try {
        const t = checker.getTypeOfSymbolAtLocation(sym, decl);
        const sigs = t.getCallSignatures();
        signature = ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) ? `${ts.isClassDeclaration(decl) ? "class" : "interface"} ${sym.getName()}` : ts.isTypeAliasDeclaration(decl) ? `type ${sym.getName()} = ${checker.typeToString(checker.getDeclaredTypeOfSymbol(sym))}` : sigs.length && sigs[0] ? `${sym.getName()}${checker.signatureToString(sigs[0])}` : `${sym.getName()}: ${checker.typeToString(t)}`;
      } catch {
      }
      const doc = ts.displayPartsToString(sym.getDocumentationComment(checker)) || void 0;
      return { ...signature ? { signature } : {}, ...doc ? { doc } : {} };
    };
    const recordExternal = (decl, key, pkg) => {
      if (extSeen.has(key)) return;
      extSeen.add(key);
      const hover = hoverOf(decl, nameNodeOf(decl));
      if (!pkgVersion.has(pkg)) pkgVersion.set(pkg, readPkgVersion(decl.getSourceFile().fileName, pkg));
      out.externals.push({
        key,
        package: pkg,
        version: pkgVersion.get(pkg),
        signature: hover.signature ?? "",
        doc: hover.doc,
        kind: kindOf(ts, decl)
      });
    };
    const displayName = (decl) => {
      const own = ts.isConstructorDeclaration(decl) ? "constructor" : decl.name?.getText() ?? "anonymous";
      let p = decl.parent;
      while (p) {
        if ((ts.isClassLike(p) || ts.isInterfaceDeclaration(p)) && p.name) return `${p.name.getText()}.${own}`;
        if (ts.isSourceFile(p)) break;
        p = p.parent;
      }
      const fileName = realFile(decl.getSourceFile().fileName);
      const base = fileName.endsWith(".svelte") ? componentName(fileName) : fileName.split("/").at(-1).replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
      return `${base}.${own}`;
    };
    const namedDeclOf = (fn) => {
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        if (ts.isFunctionExpression(fn) && fn.name) return fn;
        let p = fn.parent;
        let child = fn;
        for (; ; ) {
          if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) {
            child = p;
            p = p.parent;
          } else if (ts.isCallExpression(p) && p.arguments[0] === child && isFunctionWrapper(ts, p)) {
            child = p;
            p = p.parent;
          } else break;
        }
        if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === child && ts.isIdentifier(p.name)) return p;
        return void 0;
      }
      return fn;
    };
    const resolveCallee = (expr) => {
      const at = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isElementAccessExpression(expr) ? expr.argumentExpression : expr;
      let sym = checker.getSymbolAtLocation(at);
      if (!sym) return void 0;
      if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      let decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) return void 0;
      if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) {
        const ctor = decl.members.find(ts.isConstructorDeclaration);
        if (ctor) decl = ctor;
      }
      if (ts.isParameter(decl) || ts.isBindingElement(decl)) return void 0;
      if (ts.isVariableDeclaration(decl) && !(decl.initializer && wrapsFunction(ts, decl.initializer)) && !isComponentExport(decl)) {
        if (isProjectFile(decl.getSourceFile())) return void 0;
      }
      const abstract = isProjectFile(decl.getSourceFile()) && (ts.isMethodSignature(decl) || ts.isPropertySignature(decl) || (ts.isMethodDeclaration(decl) || ts.isPropertyDeclaration(decl)) && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract) !== 0);
      return { decl, abstract };
    };
    for (const sf of program.getSourceFiles()) {
      if (!isProjectFile(sf)) continue;
      const virtual = isVirtual(sf.fileName);
      const stack = [];
      const occ = [];
      if (virtual) {
        const c = componentTarget(sf);
        const file = rel(sf.fileName);
        const end = svelte.lineCount(realFile(sf.fileName)) - 1;
        if (!fnSeen.has(`${c}:0`)) {
          fnSeen.add(`${c}:0`);
          out.functions.push({ target: c, file, startLine: 0, endLine: end });
        }
        stack.push(c);
      }
      const visit = (node) => {
        let pushed = false;
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          const named = node.body ? namedDeclOf(node) : void 0;
          if (named) {
            const t = declTarget(named, displayName(named));
            const host = named === node ? node : named;
            const start = t === void 0 ? void 0 : lineOf(sf, host.getStart(sf));
            if (t !== void 0 && start !== void 0) {
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
        let calleeExpr;
        let site;
        if (virtual && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments[0] && /^__sveltets_\d+_ensureComponent$/.test(node.expression.text)) {
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
          const tag = node.tagName;
          if (!(ts.isIdentifier(tag) && /^[a-z]|-/.test(tag.text)) && !(ts.isJsxNamespacedName?.(tag) ?? false)) {
            calleeExpr = tag;
            site = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
          }
        }
        const caller = stack.at(-1);
        if (calleeExpr && site && caller !== void 0) {
          const r = resolveCallee(calleeExpr);
          const at = r && posOf(site);
          if (r && at) {
            const callee = declTarget(r.decl, displayName(r.decl));
            if (callee !== void 0) {
              const k = `${caller}:${callee}:${at.file}:${at.line}:${at.col}`;
              if (!edgeSeen.has(k)) {
                edgeSeen.add(k);
                out.edges.push({
                  caller,
                  callee,
                  at,
                  endCol: at.col + site.getWidth(sf),
                  ...r.abstract ? { dynamic: true, abstract: true } : {}
                });
              }
            }
          }
        }
        if (virtual && ts.isIdentifier(node)) {
          const at = posOf(node);
          if (at) {
            let sym = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
            if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
            const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
            if (decl) {
              const isDef = nameNodeOf(decl) === node;
              const t = declTarget(decl, displayName(decl));
              if (t !== void 0) occ.push(at.line, at.col, at.col + node.text.length, t, isDef ? 1 : 0);
              if (!isProjectFile(decl.getSourceFile()) && !isVirtual(decl.getSourceFile().fileName)) {
                const ext = externalKey(ts, decl);
                if (ext) recordExternal(decl, ext.key, ext.pkg);
              }
            }
          }
        } else if (ts.isIdentifier(node) && node.parent?.name !== node) {
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
        if (!documents.has(path)) documents.set(path, { path, language: "svelte", occurrences: dedupeOcc(occ) });
      }
    }
  }
  out.functions.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
  if (documents.size) out.documents = [...documents.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (svelte) warnings.push(...svelte.warnings);
  if (warnings.length) out.warnings = warnings;
  return out;
}
function dedupeOcc(occ) {
  const rows = [];
  for (let i = 0; i < occ.length; i += 5) rows.push(occ.slice(i, i + 5));
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[4] - a[4]);
  const outRows = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0] || r[1] !== rows[i - 1][1]);
  return outRows.flat();
}
function wrapsFunction(ts, e) {
  for (; ; ) {
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e) && e.arguments[0] && isFunctionWrapper(ts, e)) e = e.arguments[0];
    else return false;
  }
}
var WRAPPERS = /^(memo|forwardRef|lazy|observer|useCallback|useEffectEvent|debounce|throttle|once)$/;
function isFunctionWrapper(ts, call) {
  const e = call.expression;
  const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
  return WRAPPERS.test(name);
}
function isNested(decl) {
  for (let p = decl.parent; p; p = p.parent) {
    if ("body" in p && "parameters" in p) {
      const name = p.name?.getText();
      if (name === "$$render") return false;
      return true;
    }
  }
  return false;
}
function componentName(file) {
  return file.split("/").at(-1).replace(/\.svelte$/, "");
}
var SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
var IGNORED_DIRS = ["**/node_modules/**", "**/*.d.ts", "**/dist/**", "**/build/**", "**/.svelte-kit/**"];
function createPrograms(ts, dir, warnings, svelte) {
  const make = (rootNames, options, projectReferences) => {
    options = { ...options, noEmit: true };
    let host = ts.createCompilerHost(options, true);
    const svelteRoots = rootNames.filter((f) => f.endsWith(".svelte"));
    rootNames = rootNames.filter((f) => !f.endsWith(".svelte"));
    if (svelte && svelteRoots.length) {
      host = svelte.wrapHost(ts, host, options);
      rootNames = [...rootNames, ...svelte.shims, ...svelteRoots.map(svelte.toVirtual)];
    } else if (svelteRoots.length) {
      warnings.push(`svelte2tsx not found; ${svelteRoots.length} .svelte files skipped`);
    }
    return ts.createProgram({ rootNames, options, projectReferences, host });
  };
  const svelteExt = [{ extension: "svelte", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }];
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json") ?? ts.findConfigFile(dir, ts.sys.fileExists, "jsconfig.json");
  if (!configPath) {
    warnings.push("no tsconfig.json or jsconfig.json found; analyzing source files with defaults");
    const exts = [...SOURCE_EXTS, ".svelte"];
    const files = ts.sys.readDirectory(dir, exts, IGNORED_DIRS, ["**/*"]);
    return [
      make(files, {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
        skipLibCheck: true
      })
    ];
  }
  const seen = /* @__PURE__ */ new Set();
  const programs = [];
  const load = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      path,
      { noEmit: true, ...path.endsWith("jsconfig.json") ? { allowJs: true } : {} },
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => warnings.push(ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      },
      void 0,
      void 0,
      svelteExt
    );
    if (!parsed) return;
    if (parsed.fileNames.length) {
      programs.push(make(parsed.fileNames, parsed.options, parsed.projectReferences));
    }
    for (const ref of parsed.projectReferences ?? []) {
      const p = ts.resolveProjectReferencePath(ref);
      load(p);
    }
  };
  load(configPath);
  return programs;
}
function externalKey(ts, decl) {
  const file = toPosix(decl.getSourceFile().fileName);
  const i = file.lastIndexOf("/node_modules/");
  if (i < 0) return void 0;
  const after = file.slice(i + "/node_modules/".length);
  const parts = after.split("/");
  const pkg = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  const within = parts.slice(pkg.split("/").length).join("/");
  const chain = [];
  let leaf = decl;
  if (ts.isConstructorDeclaration(leaf)) {
    chain.unshift("`<constructor>`().");
    leaf = leaf.parent;
    const n = leaf.name?.getText();
    if (n) chain.unshift(`${n}#`);
    leaf = leaf.parent;
  } else {
    const name = leaf.name?.getText();
    if (!name) return void 0;
    chain.unshift(
      ts.isFunctionLike(leaf) ? `${name}().` : ts.isClassLike(leaf) || ts.isInterfaceDeclaration(leaf) || ts.isTypeAliasDeclaration(leaf) || ts.isEnumDeclaration(leaf) ? `${name}#` : `${name}.`
    );
    leaf = leaf.parent;
  }
  for (let p = leaf; p && !ts.isSourceFile(p); p = p.parent) {
    if ((ts.isClassLike(p) || ts.isInterfaceDeclaration(p) || ts.isEnumDeclaration(p)) && p.name) chain.unshift(`${p.name.getText()}#`);
    else if (ts.isModuleDeclaration(p)) chain.unshift(`${escapeName(p.name.getText())}/`);
  }
  return { key: `${within}|${chain.join("")}`, pkg };
}
var escapeName = (s) => /^[\w$+-]+$/.test(s) ? s : "`" + s.replace(/`/g, "``") + "`";
function kindOf(ts, d) {
  if (ts.isClassLike(d)) return "class";
  if (ts.isInterfaceDeclaration(d)) return "interface";
  if (ts.isTypeAliasDeclaration(d)) return "type";
  if (ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isConstructorDeclaration(d)) return "method";
  if (ts.isFunctionLike(d)) return "function";
  if (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) return "field";
  if (ts.isEnumDeclaration(d)) return "type";
  if (ts.isVariableDeclaration(d) && d.initializer && wrapsFunction(ts, d.initializer)) return "function";
  return "variable";
}
function readPkgVersion(file, pkg) {
  let dir = dirname2(file);
  while (dir.includes("node_modules")) {
    if (toPosix(dir).endsWith(`/node_modules/${pkg}`)) {
      try {
        return JSON.parse(readFileSync2(join2(dir, "package.json"), "utf8")).version;
      } catch {
        return void 0;
      }
    }
    dir = dirname2(dir);
  }
  return void 0;
}
var toPosix = (p) => p.split(sep).join("/");

// src/cli.ts
function loadTypeScript(projectDir, fallback) {
  const here = dirname3(fileURLToPath(import.meta.url));
  for (const base of [projectDir, here, join3(here, "..")]) {
    try {
      const ts = createRequire2(join3(base, "noop.js"))("typescript");
      if (typeof ts.createProgram === "function") return ts;
    } catch {
    }
  }
  if (fallback) {
    const ts = createRequire2(join3(projectDir, "noop.js"))(resolve2(fallback));
    if (typeof ts.createProgram === "function") return ts;
  }
  throw new Error("typescript (JS compiler API, <= 6.x) not found; pass --typescript <path to typescript package>");
}
function main() {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : void 0;
  };
  const dir = resolve2(get("--dir") ?? ".");
  const root = resolve2(get("--root") ?? dir);
  const outFile = get("-o") ?? get("--out");
  const ts = loadTypeScript(dir, get("--typescript"));
  const svelte = loadSvelteTooling(dir, get("--svelte-tools"));
  const res = analyze(ts, dir, root, { svelte });
  const json = JSON.stringify(res);
  if (outFile) writeFileSync(outFile, json);
  else process.stdout.write(json + "\n");
  console.error(`ts-analyzer: TypeScript ${ts.version}, ${res.functions.length} functions, ${res.edges.length} edges, ${res.externals.length} externals` + (res.documents?.length ? `, ${res.documents.length} svelte files` : ""));
}
try {
  main();
} catch (e) {
  console.error(`ts-analyzer: ${e.message}`);
  process.exit(1);
}
export {
  loadTypeScript
};
