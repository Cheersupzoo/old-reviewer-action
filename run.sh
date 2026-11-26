#!/usr/bin/env bash
# Builds the PR review pack. Called by action.yml; also runnable locally:
#
#   HEAD_SHA=... BASE_SHA=... REPO=owner/name LANGUAGES=go OUTPUT_DIR=prv-out indexer/run.sh
#
# Tool versions are pinned here. A failing analysis step does not fail the run: the
# pack is still produced (partial index) and the failure is recorded in the manifest.
set -uo pipefail

SCIP_GO_VERSION="${SCIP_GO_VERSION:-v0.2.10}"
SCIP_GO_TOOLCHAIN="${SCIP_GO_TOOLCHAIN:-go1.26.11}"   # scip-go v0.2.10 needs Go >= 1.26
SCIP_TS_VERSION="${SCIP_TS_VERSION:-0.6.2}"
TS_API_VERSION="${TS_API_VERSION:-5.9.3}"           # for ts-analyzer

ACTION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(pwd)"
OUT="${OUTPUT_DIR:-prv-out}"
WORK="${RUNNER_TEMP:-/tmp}/prv-work"
LANGUAGES="${LANGUAGES:-go}"
GO_MODULES="${GO_MODULES:-.}"
TS_PROJECTS="${TS_PROJECTS:-.}"
: "${HEAD_SHA:?HEAD_SHA is required}" "${BASE_SHA:?BASE_SHA is required}" "${REPO:?REPO is required}"

mkdir -p "$OUT" "$WORK"
args=()
warn() { echo "::warning::prv-index: $*"; args+=(--warning "$*"); }
has_lang() { [[ ",$LANGUAGES," == *",$1,"* ]]; }

MERGE_BASE="$(git merge-base "$BASE_SHA" "$HEAD_SHA" 2>/dev/null || true)"
if [[ -z "$MERGE_BASE" ]]; then
  warn "could not compute merge base (shallow clone?), diffing against base"
  MERGE_BASE="$BASE_SHA"
fi
git diff --unified=0 --no-color --no-ext-diff --find-renames "$MERGE_BASE" "$HEAD_SHA" > "$WORK/changes.diff" || warn "git diff failed"

if has_lang go; then
  echo "::group::Install Go tools"
  export GOBIN="$WORK/bin"
  GOTOOLCHAIN="$SCIP_GO_TOOLCHAIN" go install "github.com/scip-code/scip-go/cmd/scip-go@$SCIP_GO_VERSION" || warn "scip-go install failed"
  (cd "$ACTION_DIR/go-analyzer" && GOTOOLCHAIN=auto go build -o "$GOBIN/prv-go-analyzer" .) || warn "go-analyzer build failed"
  echo "::endgroup::"
  IFS=',' read -ra mods <<< "$GO_MODULES"
  n=0
  for mod in "${mods[@]}"; do
    mod="${mod#./}"; mod="${mod%/}"; [[ "$mod" == "." ]] && mod=""
    dir="$ROOT/${mod:-.}"
    echo "::group::Go module ${mod:-.}"
    if [[ -x "$GOBIN/scip-go" ]]; then
      if (cd "$dir" && "$GOBIN/scip-go" --output "$WORK/go-$n.scip"); then
        args+=(--scip "$WORK/go-$n.scip:$mod:utf8")
      else
        warn "scip-go failed for ${mod:-.}"
      fi
    fi
    if [[ -x "$GOBIN/prv-go-analyzer" ]]; then
      if "$GOBIN/prv-go-analyzer" -dir "$dir" -root "$ROOT" -o "$WORK/go-$n.json"; then
        args+=(--analysis "$WORK/go-$n.json")
      else
        warn "go-analyzer failed for ${mod:-.}"
      fi
    fi
    echo "::endgroup::"
    n=$((n + 1))
  done
  args+=(--tool "scip-go=$SCIP_GO_VERSION" --tool "go-analyzer=$(git -C "$ACTION_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)")
fi

if has_lang typescript; then
  # ts-analyzer needs the TypeScript JS compiler API (<= 6.x). It prefers the project's own
  # copy and falls back to this pinned one, installed outside the action directory.
  npm install --prefix "$WORK/ts-api" --no-save --no-audit --no-fund --no-package-lock "typescript@$TS_API_VERSION" >/dev/null \
    || warn "typescript install failed"
  IFS=',' read -ra projs <<< "$TS_PROJECTS"
  n=0
  for proj in "${projs[@]}"; do
    proj="${proj#./}"; proj="${proj%/}"; [[ "$proj" == "." ]] && proj=""
    dir="$ROOT/${proj:-.}"
    echo "::group::TypeScript project ${proj:-.}"
    ws=()
    [[ -f "$dir/pnpm-workspace.yaml" ]] && ws+=(--pnpm-workspaces)
    [[ -f "$dir/package.json" ]] && grep -q '"workspaces"' "$dir/package.json" && [[ -f "$dir/yarn.lock" ]] && ws+=(--yarn-workspaces)
    if (cd "$dir" && NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}" \
        npx --yes "@sourcegraph/scip-typescript@$SCIP_TS_VERSION" index "${ws[@]}" --output "$WORK/ts-$n.scip"); then
      args+=(--scip "$WORK/ts-$n.scip:$proj:utf16")
    else
      warn "scip-typescript failed for ${proj:-.}"
    fi
    if node "$ACTION_DIR/ts-analyzer/dist/index.js" --dir "$dir" --root "$ROOT" \
        --typescript "$WORK/ts-api/node_modules/typescript" -o "$WORK/ts-$n.json"; then
      args+=(--analysis "$WORK/ts-$n.json")
    else
      warn "ts-analyzer failed for ${proj:-.}"
    fi
    echo "::endgroup::"
    n=$((n + 1))
  done
  args+=(--tool "scip-typescript=$SCIP_TS_VERSION")
fi

node "$ACTION_DIR/packer/dist/index.js" build \
  --repo "$REPO" --head "$HEAD_SHA" --base "$BASE_SHA" --merge-base "$MERGE_BASE" \
  --root "$ROOT" --diff "$WORK/changes.diff" "${args[@]}" -o "$OUT/pack.bin"
status=$?
if [[ $status -eq 0 && -n "${PACK_NAME:-}" ]]; then
  # Also provide the file under its artifact name, for upload-artifact's `archive: false`.
  cp "$OUT/pack.bin" "$OUT/$PACK_NAME"
fi
exit $status
