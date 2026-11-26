// Command go-analyzer loads a Go module and emits, as JSON:
//   - function/method ranges (from go/ast)
//   - a call graph built with VTA (golang.org/x/tools/go/callgraph/vta) on SSA,
//     which resolves interface calls to concrete implementations
//   - signature + doc for referenced symbols outside the module (scip-go does not emit these)
//
// Positions: 0-based lines, UTF-8 byte columns, paths relative to -root. The packer
// converts columns to UTF-16 and matches functions to SCIP symbols by definition position.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/callgraph"
	"golang.org/x/tools/go/callgraph/cha"
	"golang.org/x/tools/go/callgraph/vta"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
)

// Pos is a source position relative to the repo root.
type Pos struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
}

// Target identifies a function-like symbol: by definition position when it lives in
// the repo, or by an external key ("pkgpath|SCIP descriptor") otherwise.
type Target struct {
	Name string `json:"name"`
	Def  *Pos   `json:"def,omitempty"`
	Ext  string `json:"ext,omitempty"`
}

type Function struct {
	Target    int    `json:"target"`
	File      string `json:"file"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
}

type Edge struct {
	Caller  int  `json:"caller"`
	Callee  int  `json:"callee"`
	At      Pos  `json:"at"`
	EndCol  int  `json:"endCol"`
	Dynamic bool `json:"dynamic,omitempty"`
	// Abstract marks a call to an interface method (the static target). VTA-resolved
	// concrete edges for the same site, if any, are emitted alongside it.
	Abstract bool `json:"abstract,omitempty"`
}

type External struct {
	Key       string `json:"key"`
	Package   string `json:"package"`
	Version   string `json:"version,omitempty"`
	Signature string `json:"signature"`
	Doc       string `json:"doc,omitempty"`
	Kind      string `json:"kind"`
}

type Output struct {
	Tool string `json:"tool"`
	// PositionEncoding of all columns in this file: "utf8" (Go byte offsets).
	PositionEncoding string     `json:"positionEncoding"`
	Module           string     `json:"module"`
	ModuleDir        string     `json:"moduleDir"`
	GoVersion        string     `json:"goVersion"`
	Targets          []Target   `json:"targets"`
	Functions        []Function `json:"functions"`
	Edges            []Edge     `json:"edges"`
	Externals        []External `json:"externals"`
	Warnings         []string   `json:"warnings,omitempty"`
}

func main() {
	dir := flag.String("dir", ".", "module directory")
	root := flag.String("root", "", "repo root (paths are made relative to it; default: -dir)")
	out := flag.String("o", "-", "output file")
	tests := flag.Bool("tests", false, "include _test.go files")
	flag.Parse()
	if *root == "" {
		*root = *dir
	}
	absDir, _ := filepath.Abs(*dir)
	absRoot, _ := filepath.Abs(*root)
	res, err := analyze(absDir, absRoot, *tests)
	if err != nil {
		fmt.Fprintln(os.Stderr, "go-analyzer:", err)
		os.Exit(1)
	}
	w := os.Stdout
	if *out != "-" {
		f, err := os.Create(*out)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		defer f.Close()
		w = f
	}
	enc := json.NewEncoder(w)
	if err := enc.Encode(res); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type analyzer struct {
	fset      *token.FileSet
	root      string
	module    string
	modVers   map[string]string // package path prefix (module) → version
	out       *Output
	targetIdx map[string]int
	extSeen   map[string]bool
	// Doc comments of dependency declarations, parsed lazily per file (dependencies are
	// loaded from export data, which has positions but no comments).
	docFset  *token.FileSet
	docFiles map[string]map[docKey]*ast.CommentGroup
	goroot   string // export data writes stdlib paths as "$GOROOT/src/..."
}

type docKey struct {
	line int
	name string
}

func analyze(dir, root string, tests bool) (*Output, error) {
	// Only the module's own packages are parsed and type-checked from source; dependencies
	// come from compiler export data. Loading every dependency from source (LoadAllSyntax)
	// took several GB of memory on medium-sized repos and could get the job killed.
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes |
			packages.NeedTypesInfo | packages.NeedImports | packages.NeedModule,
		Dir:   dir,
		Tests: tests,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil, err
	}
	a := &analyzer{
		root:      root,
		modVers:   map[string]string{},
		out:       &Output{Tool: "go-analyzer", PositionEncoding: "utf8", ModuleDir: rel(root, dir)},
		targetIdx: map[string]int{},
		extSeen:   map[string]bool{},
		docFset:   token.NewFileSet(),
		docFiles:  map[string]map[docKey]*ast.CommentGroup{},
		goroot:    goEnv(dir, "GOROOT"),
	}
	for _, p := range pkgs {
		for _, e := range p.Errors {
			a.out.Warnings = append(a.out.Warnings, e.Error())
		}
	}
	// Module versions of dependencies (cheap: package metadata only, no type-checking).
	if deps, err := packages.Load(&packages.Config{
		Mode: packages.NeedName | packages.NeedImports | packages.NeedDeps | packages.NeedModule,
		Dir:  dir, Tests: tests,
	}, "./..."); err == nil {
		packages.Visit(deps, nil, func(p *packages.Package) {
			if p.Module != nil {
				a.modVers[p.Module.Path] = p.Module.Version
			}
		})
	}
	if len(pkgs) == 0 || pkgs[0].Module == nil {
		return nil, fmt.Errorf("no module found in %s", dir)
	}
	a.module = pkgs[0].Module.Path
	a.out.Module = a.module
	a.out.GoVersion = pkgs[0].Module.GoVersion
	a.fset = pkgs[0].Fset

	// Function ranges for module packages.
	inModule := func(p *types.Package) bool {
		return p != nil && (p.Path() == a.module || strings.HasPrefix(p.Path(), a.module+"/"))
	}
	seenFile := map[string]bool{}
	for _, p := range pkgs {
		for _, f := range p.Syntax {
			fname := a.fset.Position(f.Pos()).Filename
			if seenFile[fname] {
				continue
			}
			seenFile[fname] = true
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				obj := p.TypesInfo.Defs[fd.Name]
				if obj == nil {
					continue
				}
				t := a.target(obj)
				start, end := a.fset.Position(fd.Pos()), a.fset.Position(fd.End())
				a.out.Functions = append(a.out.Functions, Function{
					Target: t, File: rel(a.root, start.Filename), StartLine: start.Line - 1, EndLine: end.Line - 1,
				})
			}
		}
	}

	// Referenced external symbols (for hover).
	for _, p := range pkgs {
		for id, obj := range p.TypesInfo.Uses {
			if obj.Pkg() == nil || inModule(obj.Pkg()) {
				continue
			}
			_ = id
			a.external(obj)
		}
	}

	// Call graph.
	// SSA bodies for module packages only; dependency functions are body-less, so VTA
	// does not track values through dependency code (interface calls whose concrete type
	// it cannot see still get an abstract edge below).
	prog, _ := ssautil.Packages(pkgs, ssa.InstantiateGenerics)
	prog.Build()
	fns := ssautil.AllFunctions(prog)
	cg := vta.CallGraph(fns, cha.CallGraph(prog))
	deleteWrapperNodes(cg)

	type key struct {
		caller, callee int
		pos            token.Pos
	}
	seen := map[key]bool{}
	abstractDone := map[token.Pos]bool{}
	callerTarget := func(fn *ssa.Function) (int, bool) {
		for fn.Parent() != nil { // closures belong to their enclosing function
			fn = fn.Parent()
		}
		if fn.Origin() != nil {
			fn = fn.Origin()
		}
		obj, ok := fn.Object().(*types.Func)
		if !ok || !inModule(obj.Pkg()) || !fn.Pos().IsValid() {
			return 0, false
		}
		return a.target(obj), true
	}
	calleeTarget := func(fn *ssa.Function) (int, bool) {
		if fn.Parent() != nil {
			return 0, false // calling a closure: not a named function
		}
		if fn.Origin() != nil {
			fn = fn.Origin()
		}
		obj, ok := fn.Object().(*types.Func)
		if !ok || obj.Pkg() == nil {
			return 0, false
		}
		if !inModule(obj.Pkg()) {
			a.external(obj)
		}
		return a.target(obj), true
	}
	addEdge := func(caller, callee int, site ssa.CallInstruction, dyn, abstract bool) {
		pos := site.Pos()
		k := key{caller, callee, pos}
		if seen[k] || !pos.IsValid() {
			return
		}
		seen[k] = true
		p := a.fset.Position(pos)
		endCol := p.Column - 1
		if c := site.Common(); c.IsInvoke() {
			endCol += len(c.Method.Name())
		} else if f := c.StaticCallee(); f != nil {
			endCol += len(f.Name())
		}
		a.out.Edges = append(a.out.Edges, Edge{
			Caller: caller, Callee: callee, Dynamic: dyn, Abstract: abstract,
			At: Pos{File: rel(a.root, p.Filename), Line: p.Line - 1, Col: p.Column - 1}, EndCol: endCol,
		})
	}
	_ = callgraph.GraphVisitEdges(cg, func(e *callgraph.Edge) error {
		if e.Site == nil {
			return nil
		}
		caller, ok := callerTarget(e.Caller.Func)
		if !ok {
			return nil
		}
		callee, ok := calleeTarget(e.Callee.Func)
		if !ok {
			return nil
		}
		c := e.Site.Common()
		dyn := c.IsInvoke() || c.StaticCallee() == nil
		addEdge(caller, callee, e.Site, dyn, false)
		return nil
	})
	// Abstract edges: every interface method call site in module code, so the packer
	// can fall back to implementations when VTA found nothing.
	for fn := range fns {
		caller, ok := callerTarget(fn)
		if !ok {
			continue
		}
		for _, b := range fn.Blocks {
			for _, instr := range b.Instrs {
				site, ok := instr.(ssa.CallInstruction)
				if !ok || !site.Common().IsInvoke() || abstractDone[site.Pos()] {
					continue
				}
				abstractDone[site.Pos()] = true
				m := site.Common().Method
				if m.Pkg() != nil && !inModule(m.Pkg()) {
					a.external(m)
				}
				addEdge(caller, a.target(m), site, true, true)
			}
		}
	}

	sort.Slice(a.out.Functions, func(i, j int) bool {
		fi, fj := a.out.Functions[i], a.out.Functions[j]
		if fi.File != fj.File {
			return fi.File < fj.File
		}
		return fi.StartLine < fj.StartLine
	})
	sort.Slice(a.out.Edges, func(i, j int) bool {
		ei, ej := a.out.Edges[i], a.out.Edges[j]
		if ei.At.File != ej.At.File {
			return ei.At.File < ej.At.File
		}
		if ei.At.Line != ej.At.Line {
			return ei.At.Line < ej.At.Line
		}
		if ei.At.Col != ej.At.Col {
			return ei.At.Col < ej.At.Col
		}
		return ei.Callee < ej.Callee
	})
	return a.out, nil
}

// deleteWrapperNodes is callgraph.Graph.DeleteSyntheticNodes, except that it keeps
// dependency functions loaded from export data. Those have no syntax either (the
// original would delete them, and every call into a dependency with them), but no body,
// so there is nothing to inline: they are the real callees.
func deleteWrapperNodes(g *callgraph.Graph) {
	edges := make(map[callgraph.Edge]bool)
	for _, n := range g.Nodes {
		for _, e := range n.Out {
			edges[*e] = true
		}
	}
	for fn, n := range g.Nodes {
		if n == g.Root || fn.Syntax() != nil || len(fn.Blocks) == 0 || (fn.Pkg != nil && fn.Pkg.Func("init") == fn) {
			continue
		}
		for _, in := range n.In {
			for _, out := range n.Out {
				e := callgraph.Edge{Caller: in.Caller, Site: in.Site, Callee: out.Callee}
				if !edges[e] {
					callgraph.AddEdge(in.Caller, in.Site, out.Callee)
					edges[e] = true
				}
			}
		}
		g.DeleteNode(n)
	}
}

// target returns the index of the Target for obj, creating it if needed.
func (a *analyzer) target(obj types.Object) int {
	var t Target
	t.Name = qualifiedName(obj)
	inModule := obj.Pkg() != nil && (obj.Pkg().Path() == a.module || strings.HasPrefix(obj.Pkg().Path(), a.module+"/"))
	var k string
	if inModule && obj.Pos().IsValid() {
		p := a.fset.Position(obj.Pos())
		t.Def = &Pos{File: rel(a.root, p.Filename), Line: p.Line - 1, Col: p.Column - 1}
		k = fmt.Sprintf("%s:%d:%d", t.Def.File, t.Def.Line, t.Def.Col)
	} else {
		t.Ext = externalKey(obj)
		k = t.Ext
	}
	if i, ok := a.targetIdx[k]; ok {
		return i
	}
	a.targetIdx[k] = len(a.out.Targets)
	a.out.Targets = append(a.out.Targets, t)
	return len(a.out.Targets) - 1
}

func (a *analyzer) external(obj types.Object) {
	if obj.Pkg() == nil {
		return
	}
	switch obj.(type) {
	case *types.PkgName, *types.Label:
		return
	}
	k := externalKey(obj)
	if k == "" || a.extSeen[k] {
		return
	}
	a.extSeen[k] = true
	pkg := obj.Pkg()
	qual := func(p *types.Package) string {
		if p == pkg {
			return ""
		}
		return p.Name()
	}
	e := External{Key: k, Package: pkg.Path(), Kind: kindOf(obj), Signature: types.ObjectString(obj, qual)}
	if v, ok := obj.(*types.Var); ok && v.IsField() {
		e.Signature = "field " + v.Name() + " " + types.TypeString(v.Type(), qual)
	}
	if tn, ok := obj.(*types.TypeName); ok {
		e.Signature = typeSignature(tn, qual)
	}
	if cg := a.docFor(obj); cg != nil {
		e.Doc = cg.Text()
	}
	for mod, v := range a.modVers {
		if pkg.Path() == mod || strings.HasPrefix(pkg.Path(), mod+"/") {
			e.Version = v
		}
	}
	a.out.Externals = append(a.out.Externals, e)
}

// docFor finds obj's doc comment by parsing (once) the source file its position points
// to, matching on line and name since export data may not keep exact columns.
func (a *analyzer) docFor(obj types.Object) *ast.CommentGroup {
	if !obj.Pos().IsValid() {
		return nil
	}
	p := a.fset.Position(obj.Pos())
	file := p.Filename
	if rest, ok := strings.CutPrefix(file, "$GOROOT"); ok && a.goroot != "" {
		file = a.goroot + rest
	}
	if file == "" {
		return nil
	}
	docs, ok := a.docFiles[file]
	if !ok {
		docs = map[docKey]*ast.CommentGroup{}
		a.docFiles[file] = docs
		if f, err := parser.ParseFile(a.docFset, file, nil, parser.ParseComments|parser.SkipObjectResolution); err == nil {
			a.indexDocs(f, docs)
		}
	}
	return docs[docKey{p.Line, obj.Name()}]
}

func (a *analyzer) indexDocs(f *ast.File, docs map[docKey]*ast.CommentGroup) {
	put := func(id *ast.Ident, cg *ast.CommentGroup) {
		docs[docKey{a.docFset.Position(id.Pos()).Line, id.Name}] = cg
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch d := n.(type) {
		case *ast.FuncDecl:
			if d.Doc != nil {
				put(d.Name, d.Doc)
			}
			return false
		case *ast.GenDecl:
			for _, s := range d.Specs {
				doc := d.Doc
				switch s := s.(type) {
				case *ast.TypeSpec:
					if s.Doc != nil {
						doc = s.Doc
					}
					if doc != nil {
						put(s.Name, doc)
					}
					a.indexFieldDocs(s.Type, put)
				case *ast.ValueSpec:
					if s.Doc != nil {
						doc = s.Doc
					}
					if doc == nil {
						doc = s.Comment
					}
					for _, n := range s.Names {
						if doc != nil {
							put(n, doc)
						}
					}
				}
			}
			return false
		}
		return true
	})
}

func (a *analyzer) indexFieldDocs(t ast.Expr, put func(*ast.Ident, *ast.CommentGroup)) {
	var fl *ast.FieldList
	switch t := t.(type) {
	case *ast.StructType:
		fl = t.Fields
	case *ast.InterfaceType:
		fl = t.Methods
	}
	if fl == nil {
		return
	}
	for _, f := range fl.List {
		doc := f.Doc
		if doc == nil {
			doc = f.Comment
		}
		if doc == nil {
			continue
		}
		for _, n := range f.Names {
			put(n, doc)
		}
	}
}

// externalKey mirrors scip-go's descriptor syntax: "pkgpath|Name#Method()." etc.
func externalKey(obj types.Object) string {
	if obj.Pkg() == nil {
		return ""
	}
	return obj.Pkg().Path() + "|" + descriptor(obj)
}

func descriptor(obj types.Object) string {
	switch o := obj.(type) {
	case *types.Func:
		sig, _ := o.Type().(*types.Signature)
		if sig != nil && sig.Recv() != nil {
			if n := recvName(sig.Recv().Type()); n != "" {
				// Interface methods are "Iface#Method." in scip-go; concrete methods "T#Method()."
				if _, isIface := sig.Recv().Type().Underlying().(*types.Interface); isIface {
					return n + "#" + o.Name() + "."
				}
				return n + "#" + o.Name() + "()."
			}
		}
		return o.Name() + "()."
	case *types.TypeName:
		return o.Name() + "#"
	case *types.Var:
		if o.IsField() {
			return o.Name() + "." // owner unknown here; packer matches on suffix + package
		}
		return o.Name() + "."
	case *types.Const:
		return o.Name() + "."
	}
	return obj.Name() + "."
}

// typeSignature renders a named type the way a doc page would: exported struct
// fields and interface methods, one per line.
func typeSignature(tn *types.TypeName, qual types.Qualifier) string {
	head := "type " + tn.Name()
	if tn.IsAlias() {
		return head + " = " + types.TypeString(tn.Type(), qual)
	}
	switch u := tn.Type().Underlying().(type) {
	case *types.Struct:
		var b strings.Builder
		b.WriteString(head + " struct {")
		hidden := false
		for i := 0; i < u.NumFields(); i++ {
			f := u.Field(i)
			if !f.Exported() {
				hidden = true
				continue
			}
			if f.Embedded() {
				b.WriteString("\n    " + types.TypeString(f.Type(), qual))
			} else {
				b.WriteString("\n    " + f.Name() + " " + types.TypeString(f.Type(), qual))
			}
		}
		if hidden {
			b.WriteString("\n    // contains unexported fields")
		}
		if u.NumFields() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("}")
		return b.String()
	case *types.Interface:
		var b strings.Builder
		b.WriteString(head + " interface {")
		for i := 0; i < u.NumEmbeddeds(); i++ {
			b.WriteString("\n    " + types.TypeString(u.EmbeddedType(i), qual))
		}
		for i := 0; i < u.NumExplicitMethods(); i++ {
			m := u.ExplicitMethod(i)
			b.WriteString("\n    " + m.Name() + strings.TrimPrefix(types.TypeString(m.Type(), qual), "func"))
		}
		if u.NumEmbeddeds()+u.NumExplicitMethods() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("}")
		return b.String()
	}
	return head + " " + types.TypeString(tn.Type().Underlying(), qual)
}

func recvName(t types.Type) string {
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	switch n := t.(type) {
	case *types.Named:
		return n.Obj().Name()
	case *types.Alias:
		return n.Obj().Name()
	}
	return ""
}

func qualifiedName(obj types.Object) string {
	if f, ok := obj.(*types.Func); ok {
		if sig, _ := f.Type().(*types.Signature); sig != nil && sig.Recv() != nil {
			if n := recvName(sig.Recv().Type()); n != "" {
				return n + "." + f.Name()
			}
		}
	}
	if obj.Pkg() != nil {
		return obj.Pkg().Name() + "." + obj.Name()
	}
	return obj.Name()
}

func kindOf(obj types.Object) string {
	switch o := obj.(type) {
	case *types.Func:
		if sig, _ := o.Type().(*types.Signature); sig != nil && sig.Recv() != nil {
			return "method"
		}
		return "function"
	case *types.TypeName:
		if _, ok := o.Type().Underlying().(*types.Interface); ok {
			return "interface"
		}
		if _, ok := o.Type().Underlying().(*types.Struct); ok {
			return "struct"
		}
		return "type"
	case *types.Var:
		if o.IsField() {
			return "field"
		}
		return "variable"
	case *types.Const:
		return "constant"
	}
	return "unknown"
}

// goEnv runs "go env name" in dir, so it reports the toolchain that loaded the packages.
func goEnv(dir, name string) string {
	cmd := exec.Command("go", "env", name)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func rel(root, p string) string {
	r, err := filepath.Rel(root, p)
	if err != nil {
		return filepath.ToSlash(p)
	}
	return filepath.ToSlash(r)
}
