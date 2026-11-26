package main

import (
	"path/filepath"
	"testing"
)

func TestFixtureCallGraph(t *testing.T) {
	root, _ := filepath.Abs("../..")
	dir := filepath.Join(root, "fixtures/go-sample")
	out, err := analyze(dir, root, false)
	if err != nil {
		t.Fatal(err)
	}
	type e struct {
		from, to      string
		dyn, abstract bool
	}
	got := map[e]bool{}
	for _, ed := range out.Edges {
		got[e{out.Targets[ed.Caller].Name, out.Targets[ed.Callee].Name, ed.Dynamic, ed.Abstract}] = true
	}
	want := []e{
		{"MutationResolver.CreateOrder", "orderService.Create", true, false}, // interface hop resolved by VTA
		{"MutationResolver.CreateOrder", "OrderService.Create", true, true},  // static interface target
		{"orderService.Create", "MemoryOrderRepo.Insert", true, false},
		{"orderService.Create", "service.validate", false, false},
		{"orderService.Find", "MemoryOrderRepo.Get", true, false},
		{"main.main", "MutationResolver.CreateOrder", false, false},
	}
	for _, w := range want {
		if !got[w] {
			t.Errorf("missing edge %+v", w)
		}
	}
	for _, ed := range out.Edges {
		if ed.At.File == "" || ed.At.Line < 0 {
			t.Errorf("edge without position: %+v", ed)
		}
	}
	if out.ModuleDir != "fixtures/go-sample" {
		t.Errorf("moduleDir = %q", out.ModuleDir)
	}
	var create *Function
	for i, f := range out.Functions {
		if out.Targets[f.Target].Name == "orderService.Create" {
			create = &out.Functions[i]
		}
	}
	if create == nil || create.File != "fixtures/go-sample/service/order.go" || create.StartLine != 33 || create.EndLine != 38 {
		t.Errorf("orderService.Create range = %+v", create)
	}
	ext := map[string]External{}
	for _, x := range out.Externals {
		ext[x.Key] = x
	}
	if x, ok := ext["context|Context#"]; !ok || x.Doc == "" || x.Kind != "interface" {
		t.Errorf("context.Context external = %+v", x)
	}
	if x := ext["fmt|Sprintf()."]; x.Signature != "func Sprintf(format string, a ...any) string" {
		t.Errorf("fmt.Sprintf signature = %q", x.Signature)
	}
}
