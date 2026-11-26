#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli.ts
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join as join2, resolve, dirname as dirname2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/analyze.ts
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
function analyze(ts, projectDir, repoRoot) {
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
  const programs = createPrograms(ts, projectDir, warnings);
  const targetIdx = /* @__PURE__ */ new Map();
  const extSeen = /* @__PURE__ */ new Set();
  const fnSeen = /* @__PURE__ */ new Set();
  const edgeSeen = /* @__PURE__ */ new Set();
  const pkgVersion = /* @__PURE__ */ new Map();
  const rel = (f) => toPosix(relative(repoRoot, f));
  const isProjectFile = (sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/") && !relative(repoRoot, sf.fileName).startsWith("..");
  for (const program of programs) {
    const checker = program.getTypeChecker();
    const posOf = (node) => {
      const sf = node.getSourceFile();
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return { file: rel(sf.fileName), line: lc.line, col: lc.character };
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
    const recordExternal = (decl, key, pkg) => {
      if (extSeen.has(key)) return;
      extSeen.add(key);
      const name = nameNodeOf(decl);
      const sym = name ? checker.getSymbolAtLocation(name) : void 0;
      let signature = "";
      try {
        if (sym) {
          const t = checker.getTypeOfSymbolAtLocation(sym, decl);
          const sigs = t.getCallSignatures();
          signature = ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) ? `${ts.isClassDeclaration(decl) ? "class" : "interface"} ${sym.getName()}` : sigs.length && sigs[0] ? `${sym.getName()}${checker.signatureToString(sigs[0])}` : `${sym.getName()}: ${checker.typeToString(t)}`;
        }
      } catch {
      }
      if (!pkgVersion.has(pkg)) pkgVersion.set(pkg, readPkgVersion(decl.getSourceFile().fileName, pkg));
      out.externals.push({
        key,
        package: pkg,
        version: pkgVersion.get(pkg),
        signature,
        doc: sym ? ts.displayPartsToString(sym.getDocumentationComment(checker)) || void 0 : void 0,
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
      const base = decl.getSourceFile().fileName.split("/").at(-1).replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
      return `${base}.${own}`;
    };
    const namedDeclOf = (fn) => {
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        const p = fn.parent;
        if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === fn && ts.isIdentifier(p.name)) return p;
        if (ts.isFunctionExpression(fn) && fn.name) return fn;
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
      if (ts.isVariableDeclaration(decl) && !(decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)))) {
        if (isProjectFile(decl.getSourceFile())) return void 0;
      }
      const abstract = isProjectFile(decl.getSourceFile()) && (ts.isMethodSignature(decl) || ts.isPropertySignature(decl) || (ts.isMethodDeclaration(decl) || ts.isPropertyDeclaration(decl)) && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract) !== 0);
      return { decl, abstract };
    };
    for (const sf of program.getSourceFiles()) {
      if (!isProjectFile(sf)) continue;
      const stack = [];
      const visit = (node) => {
        let pushed = false;
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          const named = node.body ? namedDeclOf(node) : void 0;
          if (named) {
            const t = declTarget(named, displayName(named));
            if (t !== void 0) {
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
        let calleeExpr;
        let site;
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          calleeExpr = node.expression;
          site = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        } else if (ts.isTaggedTemplateExpression(node)) {
          calleeExpr = node.tag;
          site = node.tag;
        } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (!/^[a-z]/.test(node.tagName.getText())) {
            calleeExpr = node.tagName;
            site = node.tagName;
          }
        }
        const caller = stack.at(-1);
        if (calleeExpr && site && caller !== void 0) {
          const r = resolveCallee(calleeExpr);
          if (r) {
            const callee = declTarget(r.decl, displayName(r.decl));
            if (callee !== void 0) {
              const at = posOf(site);
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
        if (ts.isIdentifier(node) && node.parent?.name !== node) {
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
function createPrograms(ts, dir, warnings) {
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    warnings.push("no tsconfig.json found; analyzing *.ts files with defaults");
    const files = ts.sys.readDirectory(dir, [".ts", ".tsx", ".mts", ".cts"], ["**/node_modules/**", "**/*.d.ts"], ["**/*"]);
    return [ts.createProgram(files, { allowJs: false, jsx: ts.JsxEmit.Preserve, noEmit: true, skipLibCheck: true })];
  }
  const seen = /* @__PURE__ */ new Set();
  const programs = [];
  const load = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const parsed = ts.getParsedCommandLineOfConfigFile(path, { noEmit: true }, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => warnings.push(ts.flattenDiagnosticMessageText(d.messageText, "\n"))
    });
    if (!parsed) return;
    if (parsed.fileNames.length) {
      programs.push(ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true }, projectReferences: parsed.projectReferences }));
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
  return "variable";
}
function readPkgVersion(file, pkg) {
  let dir = dirname(file);
  while (dir.includes("node_modules")) {
    if (toPosix(dir).endsWith(`/node_modules/${pkg}`)) {
      try {
        return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      } catch {
        return void 0;
      }
    }
    dir = dirname(dir);
  }
  return void 0;
}
var toPosix = (p) => p.split(sep).join("/");

// src/cli.ts
function loadTypeScript(projectDir, fallback) {
  const here = dirname2(fileURLToPath(import.meta.url));
  for (const base of [projectDir, here, join2(here, "..")]) {
    try {
      const ts = createRequire(join2(base, "noop.js"))("typescript");
      if (typeof ts.createProgram === "function") return ts;
    } catch {
    }
  }
  if (fallback) {
    const ts = createRequire(join2(projectDir, "noop.js"))(resolve(fallback));
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
  const dir = resolve(get("--dir") ?? ".");
  const root = resolve(get("--root") ?? dir);
  const outFile = get("-o") ?? get("--out");
  const ts = loadTypeScript(dir, get("--typescript"));
  const res = analyze(ts, dir, root);
  const json = JSON.stringify(res);
  if (outFile) writeFileSync(outFile, json);
  else process.stdout.write(json + "\n");
  console.error(`ts-analyzer: TypeScript ${ts.version}, ${res.functions.length} functions, ${res.edges.length} edges, ${res.externals.length} externals`);
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
