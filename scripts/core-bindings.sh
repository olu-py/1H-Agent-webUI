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

core_override="${PROTIUM_CORE_PATH:-}"
core_manifest=""
core_source="metadata"
if [[ -n "$core_override" ]]; then
  if [[ ! -f "$core_override/Cargo.toml" ]]; then
    printf 'PROTIUM_CORE_PATH does not contain Cargo.toml: %s\n' "$core_override"
    exit 1
  fi
  core_manifest="$(cd "$core_override" && pwd)/Cargo.toml"
  core_source="PROTIUM_CORE_PATH"
else
  if ! command -v perl >/dev/null 2>&1; then
    printf 'core-bindings.sh requires perl to read cargo metadata\n' >&2
    exit 1
  fi

  metadata="$(cargo metadata --locked --format-version 1 2>/dev/null || true)"
  core_manifest="$(printf '%s' "$metadata" \
    | perl -ne 'if (/\{"name":"protium-core","version":.*?"source":"git\+.*?"manifest_path":"([^"]+)"/) { print "$1\n"; exit }')"

  if [[ -z "$core_manifest" ]]; then
    printf 'cargo metadata did not resolve the locked protium-core checkout; refusing to guess from %s\n' "\$CARGO_HOME/git/checkouts" >&2
    exit 1
  fi
fi

if [[ -z "$core_manifest" ]]; then
  printf 'could not resolve the locked Git protium-core checkout\n' >&2
  exit 1
fi
if ! grep -q '^name = "protium-core"' "$core_manifest"; then
  printf 'resolved manifest is not protium-core: %s\n' "$core_manifest" >&2
  exit 1
fi

core_dir="$(dirname "$core_manifest")"
core_bindings="$core_dir/bindings"
web_bindings="$repo_root/web/ts"

# The lock file is the single source of truth for which core revision the
# bindings must come from. Resolving to a stale checkout would silently
# rewrite web/ts with an older protocol, so verify it unless an explicit
# local dev override was requested.
locked_rev="$(sed -n 's/.*1H-Agent-core\.git?rev=\([0-9a-fA-F]\{40\}\)#.*/\1/p' Cargo.lock | head -n 1)"
if [[ -z "$locked_rev" ]]; then
  printf 'Cargo.lock does not pin a protium-core Git revision\n' >&2
  exit 1
fi

resolved_rev="$(git -C "$core_dir" rev-parse HEAD 2>/dev/null || true)"
if [[ -z "$resolved_rev" ]]; then
  printf 'could not read the Git revision of %s\n' "$core_dir" >&2
  exit 1
fi

printf 'core source    : %s\n' "$core_source"
printf 'core checkout  : %s\n' "$core_dir"
printf 'locked rev     : %s\n' "$locked_rev"
printf 'resolved rev   : %s\n' "$resolved_rev"

if [[ "$resolved_rev" != "$locked_rev" ]]; then
  if [[ "$core_source" = "PROTIUM_CORE_PATH" ]]; then
    printf 'warning: PROTIUM_CORE_PATH resolves to %s but Cargo.lock pins %s; using the override for local development.\n' "$resolved_rev" "$locked_rev" >&2
  else
    printf 'resolved protium-core checkout (%s) is not the locked revision (%s)\n' "$resolved_rev" "$locked_rev" >&2
    exit 1
  fi
fi

normalize_bindings() {
  local directory="$1"
  while IFS= read -r file; do
    perl -pi -e 's/\r$//; s/[ \t]+$//' "$file"
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
    # Normalize line endings on the comparison side too, so a Windows
    # core.autocrlf=true working tree does not report phantom drift.
    normalized_web="$(mktemp -d)"
    cp "$web_bindings"/*.ts "$normalized_web"/
    normalize_bindings "$normalized_web"
    diff -ru "$normalized_core" "$normalized_web"
    ;;
esac