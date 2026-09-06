#!/usr/bin/env sh
# Report toolchain readiness for Veyora development (PRD REPO-012 doctor).
#
# Required tools fail the check; optional integrations are reported as
# warnings so contributors can still work on dependency-free checks.

set -u

status=0

version_line() {
    ("$1" --version 2>/dev/null || "$1" version 2>/dev/null) | head -n 1
}

require() {
    if command -v "$1" >/dev/null 2>&1; then
        printf 'ok       %s: %s\n' "$1" "$(version_line "$1")"
    else
        printf 'MISSING  %s: %s\n' "$1" "$2"
        status=1
    fi
}

optional() {
    if command -v "$1" >/dev/null 2>&1; then
        printf 'ok       %s: %s\n' "$1" "$(version_line "$1")"
    else
        printf 'warn     %s: %s\n' "$1" "$2"
    fi
}

require git "repository operations"
require python3 "repository and codegen checks"
require node "web and desktop tooling"
require npm "workspace installs"
require cargo "Rust workspace builds"

if command -v cargo >/dev/null 2>&1; then
    pinned="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml 2>/dev/null)"
    active="$(rustc --version 2>/dev/null | awk '{print $2}')"
    if [ -n "${pinned:-}" ] && [ -n "${active:-}" ]; then
        printf 'ok       rust toolchain: pinned %s, active %s\n' "$pinned" "$active"
    fi
fi

optional wasm-bindgen "WASM kernel binding generation (make build-wasm)"
optional docker "Compose preview builds and the local deployment stack"
optional shellcheck "optional local shell script linting (CI uses a container)"

printf '\ntransient output directories (all must be git-ignored):\n'
for directory in .build packages/security-kernel/target target apps/desktop/src-tauri/target; do
    if [ -e "$directory" ]; then
        size="$(du -sh "$directory" 2>/dev/null | cut -f1)"
        if git check-ignore --quiet "$directory"; then
            printf 'ignored  %s (%s)\n' "$directory" "$size"
        else
            printf 'NOT IGNORED %s (%s)\n' "$directory" "$size"
            status=1
        fi
    fi
done

if [ "$status" -ne 0 ]; then
    printf '\ndoctor: FAIL\n'
    exit 1
fi
printf '\ndoctor: PASS\n'
