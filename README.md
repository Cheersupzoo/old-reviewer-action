# PR review indexer

A composite GitHub Action that builds the code-intelligence pack the PR review viewer reads.
It runs in the reviewed repo's CI, needs **no secrets**, and works for forked PRs.

## Add it to a repo

Create `.github/workflows/prv-index.yml`:

```yaml
name: PR review index
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

concurrency:
  group: prv-index-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  index:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      # Check out the PR HEAD (not the merge commit) so line numbers match the PR.
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0 # merge-base + changed-function detection

      # ---- Go ----
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
      - run: go mod download
      # If generated code (gqlgen, protoc, sqlc, mockgen) is NOT committed:
      # - run: go generate ./...

      # ---- TypeScript / JavaScript / React / Svelte (delete if not needed) ----
      # - uses: actions/setup-node@v4
      #   with: { node-version: 22, cache: npm }
      # - run: npm ci
      # - run: npm run codegen --if-present
      # SvelteKit: `svelte-kit sync` runs automatically when .svelte-kit/tsconfig.json is missing.

      - name: Build review index
        uses: Cheersupzoo/old-reviewer-action@main
        with:
          languages: go # "go", "typescript" (also JS, React, Svelte), or "go,typescript"
          head-sha: ${{ github.event.pull_request.head.sha }}
          base-sha: ${{ github.event.pull_request.base.sha }}
          output-dir: prv-out

      - uses: actions/upload-artifact@v4
        with:
          name: prv-index-${{ github.event.pull_request.head.sha }}
          path: prv-out/pack.bin # single file → zip entry "pack.bin"
          compression-level: 0 # REQUIRED: stored entry so the browser can range-read it
          retention-days: 90 # the index is read from the artifact; viewers cache it after first open
          if-no-files-found: error
```

### Contract

- Artifact name `prv-index-{headSha}` containing one stored (uncompressed) entry `pack.bin`.
- **Alternative:** `actions/upload-artifact@v7` with `archive: false` and
  `path: prv-out/prv-index-{headSha}.bin`. The action writes that copy for you. The viewer accepts
  either form: it checks the first bytes for `PK\x03\x04` (zip) or `PRVPACK`.
- The viewer reads the artifact **directly from the browser**: it follows GitHub's download
  redirect to the signed blob URL and range-reads it. Readers need **Actions: read** on the repo
  (fine-grained token) or the GitHub App installed.

### Inputs

| Input | Default | |
|---|---|---|
| `languages` | `go` | `go`, `typescript`, or both, comma-separated. `typescript` covers `.ts`, `.tsx`, `.js`, `.jsx` and `.svelte`; `javascript`, `react` and `svelte` are accepted as aliases |
| `head-sha`, `base-sha` | (required) | from `github.event.pull_request` |
| `output-dir` | `prv-out` | where `pack.bin` is written |
| `go-modules` | `.` | comma-separated module dirs, e.g. `./svc-a,./svc-b` (indexes are merged) |
| `ts-projects` | `.` | comma-separated TS project dirs |

### Troubleshooting

- **Private modules:** set `GOPRIVATE` and configure git credentials before `go mod download`
  (e.g. `git config --global url."https://x-access-token:${{ secrets.TOKEN }}@github.com/".insteadOf "https://github.com/"`).
- **cgo / build failures:** the pack is still produced. Failed steps are listed in the manifest
  `warnings` and shown in the viewer as a partial index.
- **"Index failed: … is compressed"**: the artifact was uploaded without `compression-level: 0`.
- **Private action repo:** if the viewer repo is private, enable *Settings → Actions → General →
  Access → "Accessible from repositories owned by …"* there so reviewed repos can `uses:` it.
- **JavaScript-only projects:** without a `tsconfig.json`, scip-typescript runs with
  `--infer-tsconfig` and ts-analyzer reads `jsconfig.json` (or uses `allowJs` defaults).
- **Svelte:** `.svelte` components are compiled with svelte2tsx. scip-typescript indexes them when
  the tsconfig includes them (SvelteKit's does). ts-analyzer adds the call graph and changed
  components, and fills in occurrences for components scip-typescript didn't index. It uses the
  project's svelte2tsx if installed, else the pinned one. Install dependencies first so imports
  resolve.
- **Debug a pack:** `node packer/dist/index.js inspect pack.bin [blobKey]`.

## Pinned tools

Pinned in `run.sh`: `scip-go` v0.2.10 (the module is now `github.com/scip-code/scip-go`),
`@sourcegraph/scip-typescript` 0.6.2, `svelte2tsx` 0.7.63 (for ts-analyzer, only when the repo has
`.svelte` files).

On Linux amd64/arm64 runners, `run.sh` downloads prebuilt `scip-go` (its GitHub release) and
`go-analyzer` (the `go-analyzer-vN` release of `Cheersupzoo/old-reviewer-action`) and checks
both against the sha256 sums pinned in `run.sh`. It builds a tool from source instead when the
download or check fails, when the repo's Go is newer than the one `go-analyzer` was built with,
or with `PREBUILT=0`.

**When `go-analyzer/` changes**, publish a new binary: run *Release go-analyzer* in
`old-reviewer-action` (Actions tab, or push a `go-analyzer-vN` tag) from a commit with the new
source, then set `GO_ANALYZER_RELEASE` and the two `GO_ANALYZER_SHA256_*` sums in `run.sh` from
its `SHA256SUMS`. Until then, runs keep using the old binary.


## Layout

| Path | |
|---|---|
| `action.yml` | composite action (thin wrapper around `run.sh`) |
| `run.sh` | the pipeline; runnable locally with `HEAD_SHA= BASE_SHA= REPO= ./run.sh` |
| `go-analyzer/` | Go: function ranges, VTA call graph, external symbol docs → JSON |
| `ts-analyzer/` | TS/JS/JSX/Svelte: function ranges, call edges → JSON (same schema); occurrences for `.svelte` files |
| `packer/` | merges SCIP + analyzer JSON + git diff → `pack.bin`; `dist/` is committed |
