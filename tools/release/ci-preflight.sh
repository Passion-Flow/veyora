#!/bin/bash
# CI first-run preflight (PRD sequence 6).
#
# Runs, locally and in CI order, every repository-side check the migrated
# workflows expect, so the first real GitHub-runner execution can only
# fail on runner/environment issues rather than repository issues. Each
# step prints PASS/FAIL; the script exits non-zero on the first failure.
#
# What this preflight deliberately does NOT prove: that GitHub's runners
# execute the jobs (owner push required), that published images match the
# foundation digests on the runner network, or that the desktop toolchain
# caches behave on a cold runner. Those remain sequence-6 scope.
set -uo pipefail
cd "$(dirname "$0")/../.."

status=0
step() {
  printf '\n=== %s ===\n' "$1"
  shift
  if "$@"; then
    printf 'PASS: %s\n' "$1"
  else
    printf 'FAIL: %s (exit %s)\n' "$1" "$?"
    status=1
  fi
}

step "toolchain versions" bash -c 'node --version && python3 --version && cargo --version'
step "make check (repository gates incl. manual-evidence, pairing, key-lifecycle, terminology)" make check
step "make check-codegen" make check-codegen
step "make check-web (client integrity + wasm kernel)" make check-web
step "make check-locales (catalog parity)" make check-locales
step "web unit tests" make test-web-client
step "cargo workspace fmt" cargo fmt --all -- --check
step "cargo workspace clippy" bash -c 'cargo clippy --locked --workspace --all-targets -- -D warnings'
step "security-kernel workspace tests" bash -c 'cd packages/security-kernel && CARGO_TARGET_DIR="$PWD/../.build/kernel" cargo test --locked --workspace'
step "api tests" bash -c 'CARGO_TARGET_DIR=.build/cargo cargo test --locked -p api'
step "desktop shell tests" make check-desktop
step "contracts tests" python3 -B -m unittest discover -s tests/contracts -p 'test_*.py'
step "codegen tooling tests" make check-tooling

printf '\n=== preflight summary ===\n'
if [ "$status" -eq 0 ]; then
  echo "ALL REPOSITORY-SIDE CHECKS PASS."
  echo "Remaining runner-only verification (needs owner push):"
  echo "  - migrated repository/desktop/Rust jobs on github runners"
  echo "  - published-image digest checks on the runner network"
  echo "  - cold-cache desktop toolchain behavior"
else
  echo "FAILURES PRESENT — fix before the owner pushes."
fi
exit "$status"
