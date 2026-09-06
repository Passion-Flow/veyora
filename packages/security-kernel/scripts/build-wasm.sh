#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
kernel_root="$(cd "$script_dir/.." && pwd -P)"
target="wasm32-unknown-unknown"
expected="0.2.127"

exclude() {
  printf '%s: ExcludedUnverified: %s\n' "$target" "$1" >&2
  exit 8
}

target_libdir="$(rustc --print target-libdir --target "$target" 2>/dev/null || true)"
[[ -d "$target_libdir" ]] || exclude 'Rust target std is unavailable'
compgen -G "$target_libdir/libstd-*.rlib" >/dev/null \
  || exclude 'Rust target std is unavailable'
command -v wasm-bindgen >/dev/null 2>&1 || exclude 'wasm-bindgen CLI 0.2.127 is unavailable'
[[ "$(wasm-bindgen --version 2>&1)" == "wasm-bindgen $expected" ]] \
  || exclude 'wasm-bindgen CLI version differs from 0.2.127'

python3 - "$kernel_root" "$expected" <<'PY'
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
expected = sys.argv[2]
metadata = json.loads(subprocess.check_output([
    "cargo", "metadata", "--locked", "--format-version", "1",
    "--manifest-path", str(root / "Cargo.toml"),
], text=True))
package = next(item for item in metadata["packages"] if item["name"] == "wasm-bindgen")
if package["version"] != expected:
    raise SystemExit("wasm-bindgen library/CLI version mismatch")
PY

cargo test --locked --no-run -p kernel-wasm --target "$target" \
  --manifest-path "$kernel_root/Cargo.toml"
cargo build --locked --release -p kernel-wasm --target "$target" \
  --manifest-path "$kernel_root/Cargo.toml"

output_dir="$kernel_root/generated/wasm"
node_output_dir="$(mktemp -d)"
trap 'rm -rf "$node_output_dir"' EXIT
mkdir -p "$output_dir"
wasm-bindgen \
  --target nodejs \
  --out-dir "$node_output_dir" \
  "$kernel_root/target/$target/release/kernel_wasm.wasm"
node - "$node_output_dir/kernel_wasm.js" <<'JS'
const binding = require(process.argv[2]);
const canonical = Uint8Array.from([0x82, 0x01, 0x41, 0xaa]);
const output = binding.validateProtocolCbor(canonical);
if (Buffer.compare(Buffer.from(output), Buffer.from(canonical)) !== 0) {
  throw new Error("WASM canonical parser fixture differs");
}
try {
  binding.validateProtocolCbor(Uint8Array.from([0x81, 0x18, 0x01]));
  throw new Error("WASM noncanonical parser fixture was accepted");
} catch (error) {
  if (!String(error).includes("PM-KERNEL-NONCANONICAL-ENCODING")) {
    throw error;
  }
}
JS
wasm-bindgen \
  --target web \
  --out-dir "$output_dir" \
  "$kernel_root/target/$target/release/kernel_wasm.wasm"

printf '%s: compile/binding/Node parser parity complete; named-browser evidence remains external\n' \
  "$target"
