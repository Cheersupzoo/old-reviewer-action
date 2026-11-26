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
# Prebuilt binaries, checked against these sums. If a download or check fails, or the
# runner isn't Linux amd64/arm64, the tool is built from source as a fallback.
# PREBUILT=0 always builds from source.
PREBUILT="${PREBUILT:-1}"
SCIP_GO_SHA256_amd64=880cc963e16bdf0e38fe624b8ed278eeddce32efd81056375a00dc1b6a0cfc93
SCIP_GO_SHA256_arm64=ad2d37f19062441ba73ed5192e74d3410b0ee870cfcb5650e92e338f2aef1327
# Built by .github/workflows/release-go-analyzer.yml in Cheersupzoo/old-reviewer-action.
# Bump the tag and sums whenever go-analyzer/ changes.
GO_ANALYZER_RELEASE="${GO_ANALYZER_RELEASE:-go-analyzer-v1}"
GO_ANALYZER_SHA256_amd64=f8c58c5bfa25fedbbdd1a9014a4eefb4388ef4127b7ef818732d148e6460133b
GO_ANALYZER_SHA256_arm64=6ba3126c5aff520d5b45a902cc041175e6cc9a06caaf309445914f5fb3649093
GO_ANALYZER_URL="https://github.com/Cheersupzoo/old-reviewer-action/releases/download"
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
# fetch <url> <sha256> <dest>: download and verify; leaves nothing behind on failure.
fetch() {
  [[ -n "$2" ]] || return 1
  curl -fsSL --retry 3 --connect-timeout 10 -o "$3.part" "$1" \
    && echo "$2  $3.part" | sha256sum -c --status 2>/dev/null \
    && mv "$3.part" "$3" && return 0
  rm -f "$3.part"
  return 1
}
# go_minor go1.26.3 -> 1026, for comparing Go releases.
go_minor() {
  local v="${1#go}" major minor
  IFS=. read -r major minor _ <<< "$v"
  minor="${minor%%[!0-9]*}"
  echo $(( ${major:-0} * 1000 + ${minor:-0} ))
}
# why <exit code> <stderr file>: a short reason for a failed step, for the warning text.
why() {
  local rc=$1 last
  last="$(grep -v '^[[:space:]]*$' "$2" 2>/dev/null | tail -n 1 | cut -c1-300)"
  if [[ $rc -eq 137 || $rc -eq 9 ]]; then echo "killed (exit $rc, likely out of memory)${last:+: $last}"
  else echo "exit $rc${last:+: $last}"; fi
}
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
  mkdir -p "$GOBIN"
  arch=""
  if [[ "$PREBUILT" == 1 && "$(uname -s)" == Linux ]]; then
    case "$(uname -m)" in
      x86_64 | amd64) arch=amd64 ;;
      aarch64 | arm64) arch=arm64 ;;
    esac
  fi
  scip_sha="" analyzer_sha=""
  if [[ -n "$arch" ]]; then
    scip_sha_var="SCIP_GO_SHA256_$arch" analyzer_sha_var="GO_ANALYZER_SHA256_$arch"
    scip_sha="${!scip_sha_var}" analyzer_sha="${!analyzer_sha_var}"
  fi

  if fetch "https://github.com/scip-code/scip-go/releases/download/$SCIP_GO_VERSION/scip-go-linux-$arch.tar.gz" \
      "$scip_sha" "$WORK/scip-go.tar.gz" && tar -xzf "$WORK/scip-go.tar.gz" -C "$GOBIN" scip-go; then
    echo "scip-go $SCIP_GO_VERSION: prebuilt linux-$arch"
    scip_pid=""
  else
    [[ -n "$arch" ]] && echo "scip-go: prebuilt download failed, building from source"
    GOTOOLCHAIN="$SCIP_GO_TOOLCHAIN" go install "github.com/scip-code/scip-go/cmd/scip-go@$SCIP_GO_VERSION" &
    scip_pid=$!
  fi

  if fetch "$GO_ANALYZER_URL/$GO_ANALYZER_RELEASE/prv-go-analyzer-linux-$arch" "$analyzer_sha" "$GOBIN/prv-go-analyzer"; then
    chmod +x "$GOBIN/prv-go-analyzer"
    # Its go/types can only check code up to the Go it was built with.
    built="$(go version "$GOBIN/prv-go-analyzer" 2>/dev/null | awk '{print $2}')"
    local_go="$(cd "$ROOT" && go env GOVERSION)"
    if [[ -n "$built" && $(go_minor "$local_go") -le $(go_minor "$built") ]]; then
      echo "go-analyzer: prebuilt $GO_ANALYZER_RELEASE linux-$arch ($built)"
    else
      echo "go-analyzer: prebuilt was built with ${built:-unknown Go}, repo uses $local_go; building from source"
      rm -f "$GOBIN/prv-go-analyzer"
    fi
  elif [[ -n "$arch" ]]; then
    echo "go-analyzer: prebuilt download failed, building from source"
  fi
  if [[ ! -x "$GOBIN/prv-go-analyzer" ]]; then
    (cd "$ACTION_DIR/go-analyzer" && GOTOOLCHAIN=auto go build -o "$GOBIN/prv-go-analyzer" .) || warn "go-analyzer build failed"
  fi
  if [[ -n "$scip_pid" ]]; then
    wait "$scip_pid" || warn "scip-go install failed"
  fi
  echo "::endgroup::"
  IFS=',' read -ra mods <<< "$GO_MODULES"
  n=0
  for mod in "${mods[@]}"; do
    mod="${mod#./}"; mod="${mod%/}"; [[ "$mod" == "." ]] && mod=""
    dir="$ROOT/${mod:-.}"
    echo "::group::Go module ${mod:-.}"
    # scip-go and go-analyzer each load the module on their own; run them side by side.
    # stderr still goes to the log, and a copy is kept for the warning text.
    scip_pid=""
    if [[ -x "$GOBIN/scip-go" ]]; then
      (cd "$dir" && "$GOBIN/scip-go" --output "$WORK/go-$n.scip") 2> >(tee "$WORK/go-$n.scip.err" >&2) &
      scip_pid=$!
    fi
    if [[ -x "$GOBIN/prv-go-analyzer" ]]; then
      "$GOBIN/prv-go-analyzer" -dir "$dir" -root "$ROOT" -o "$WORK/go-$n.json" 2> >(tee "$WORK/go-$n.json.err" >&2)
      rc=$?
      if [[ $rc -eq 0 ]]; then
        args+=(--analysis "$WORK/go-$n.json")
      else
        warn "go-analyzer failed for ${mod:-.}: $(why $rc "$WORK/go-$n.json.err")"
      fi
    fi
    if [[ -n "$scip_pid" ]]; then
      wait "$scip_pid"
      rc=$?
      if [[ $rc -eq 0 ]]; then
        args+=(--scip "$WORK/go-$n.scip:$mod:utf8")
      else
        warn "scip-go failed for ${mod:-.}: $(why $rc "$WORK/go-$n.scip.err")"
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
