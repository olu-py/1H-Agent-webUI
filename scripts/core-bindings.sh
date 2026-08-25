#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

usage() {
  printf 'Usage: %s {sync|check}\n' "$0" >&2
  exit 2
}

mode="${1:-}"
case "$mode" in
  sync|check) ;;
  *) usage ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if ! command -v perl >/dev/null 2>&1; then
  printf 'core-bindings.sh requires perl to read cargo metadata\n' >&2
  exit 1
fi

metadata="$(cargo metadata --locked --format-version 1 2>/dev/null || true)"
core_manifest="$(printf '%s' "$metadata" \
  | perl -ne 'if (/\{"name":"protium-core","version":.*?"source":"git\\+.*?"manifest_path":"([^"]+)"/) { print "$1\n"; exit }')"

if [[ -z "$core_manifest" ]]; then
  cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  while IFS= read -r manifest; do
    if grep -q '^name = "protium-core"' "$manifest"; then
      core_manifest="$manifest"
      break
    fi
  done < <(find "$cargo_home/git/checkouts" -type f -name Cargo.toml 2>/dev/null)
fi

if [[ -z "$core_manifest" ]]; then
  printf 'could not resolve the locked Git protium-core checkout\n' >&2
  exit 1
fi

core_bindings="$(dirname "$core_manifest")/bindings"
web_bindings="$repo_root/web/ts"

normalize_bindings() {
  local directory="$1"
  while IFS= read -r file; do
    perl -pi -e 's/[ \t]+$//' "$file"
  done < <(find "$directory" -maxdepth 1 -type f -name '*.ts')
}

if [[ ! -d "$core_bindings" ]]; then
  printf 'core bindings directory does not exist: %s\n' "$core_bindings" >&2
  exit 1
fi

case "$mode" in
  sync)
    mkdir -p "$web_bindings"
    find "$web_bindings" -maxdepth 1 -type f -name '*.ts' -delete
    cp "$core_bindings"/*.ts "$web_bindings"/
    normalize_bindings "$web_bindings"
    ;;
  check)
    normalized_core="$(mktemp -d)"
    trap 'rm -rf "$normalized_core"' EXIT
    cp "$core_bindings"/*.ts "$normalized_core"/
    normalize_bindings "$normalized_core"
    diff -ru "$normalized_core" "$web_bindings"
    ;;
esac
