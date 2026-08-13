#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
kernel_root="$(cd "$script_dir/.." && pwd -P)"
mode="${1:-host}"

exclude() {
  printf 'FFI %s: ExcludedUnverified: %s\n' "$mode" "$1" >&2
  exit 8
}

if [[ "$mode" == '--android' ]]; then
  command -v java >/dev/null 2>&1 || exclude 'JDK 17 is unavailable'
  java_version="$(java -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p')"
  [[ "$java_version" == '17' ]] || exclude 'JDK version differs from 17'
  command -v gradle >/dev/null 2>&1 || exclude 'Gradle 9.5.0 is unavailable'
  gradle --version 2>&1 | rg --quiet '^Gradle 9\.5\.0$' \
    || exclude 'Gradle version differs from 9.5.0'
  command -v cargo-ndk >/dev/null 2>&1 || exclude 'cargo-ndk 4.1.2 is unavailable'
  [[ "$(cargo-ndk --version 2>&1)" == *'4.1.2'* ]] \
    || exclude 'cargo-ndk version differs from 4.1.2'
  [[ -n "${ANDROID_SDK_ROOT:-}" && -d "${ANDROID_SDK_ROOT:-}" ]] \
    || exclude 'Android SDK 36 is unavailable'
  [[ -d "$ANDROID_SDK_ROOT/platforms/android-36" ]] \
    || exclude 'Android SDK platform 36 is unavailable'
  [[ -d "$ANDROID_SDK_ROOT/build-tools/36.0.0" ]] \
    || exclude 'Android SDK Build Tools 36.0.0 are unavailable'
  [[ -f "$ANDROID_SDK_ROOT/ndk/28.2.13676358/source.properties" ]] \
    || exclude 'Android SDK NDK package 28.2.13676358 is unavailable'
  [[ -n "${ANDROID_NDK_HOME:-}" && -f "${ANDROID_NDK_HOME:-}/source.properties" ]] \
    || exclude 'Android NDK 28.2.13676358 is unavailable'
  rg --quiet '^Pkg\.Revision = 28\.2\.13676358$' "$ANDROID_NDK_HOME/source.properties" \
    || exclude 'Android NDK version differs from 28.2.13676358'
  target_libdir="$(rustc --print target-libdir --target aarch64-linux-android 2>/dev/null || true)"
  [[ -d "$target_libdir" ]] || exclude 'aarch64-linux-android Rust target is unavailable'
  command -v adb >/dev/null 2>&1 || exclude 'ADB is unavailable'
  mapfile -t android_devices < <(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
  [[ "${#android_devices[@]}" -eq 1 ]] \
    || exclude 'exactly one authorized Android device is required'
  android_serial="${android_devices[0]}"
  android_abi="$(adb -s "$android_serial" shell getprop ro.product.cpu.abi | tr -d '\r')"
  [[ "$android_abi" == 'arm64-v8a' ]] \
    || exclude 'connected Android device is not arm64-v8a'

  jni_lib_root="$(mktemp -d)"
  trap 'rm -rf -- "$jni_lib_root"' EXIT
  cargo ndk -t arm64-v8a -o "$jni_lib_root" build --locked --release -p kernel-ffi \
    --manifest-path "$kernel_root/Cargo.toml"
  [[ -f "$jni_lib_root/arm64-v8a/libkernel_ffi.so" ]] \
    || exclude 'Android JNI library was not produced for arm64-v8a'
  android_spike="$kernel_root/../frontend/spikes/m0-android"
  ANDROID_SERIAL="$android_serial" gradle --no-daemon -p "$android_spike" \
    -PveyoraJniLibDir="$jni_lib_root" \
    verifyVeyoraAndroidPins connectedDebugAndroidTest
  printf 'Android arm64 JNI status-only instrumentation smoke complete\n'
  exit 0
fi

[[ "$mode" == 'host' ]] || exclude 'unknown mode'
command -v cbindgen >/dev/null 2>&1 || exclude 'cbindgen 0.29.4 is unavailable'
[[ "$(cbindgen --version 2>&1)" == 'cbindgen 0.29.4' ]] \
  || exclude 'cbindgen version differs from 0.29.4'

cargo build --locked --release -p kernel-ffi --manifest-path "$kernel_root/Cargo.toml"
output_dir="$kernel_root/generated/ffi"
mkdir -p "$output_dir"
first="$(mktemp)"
second="$(mktemp)"
trap 'rm -f "$first" "$second"' EXIT
cbindgen --crate kernel-ffi --output "$first" "$kernel_root"
cbindgen --crate kernel-ffi --output "$second" "$kernel_root"
cmp -s "$first" "$second" || {
  printf 'FFI host: FAIL: cbindgen output is nondeterministic\n' >&2
  exit 1
}
header="$output_dir/veyora_kernel.h"
if [[ -f "$header" ]] && ! cmp -s "$first" "$header"; then
  printf 'FFI host: FAIL: generated header drift; regenerate in a reviewed change\n' >&2
  exit 1
fi
if [[ ! -f "$header" ]]; then
  cp "$first" "$header"
fi
printf 'FFI host: native library and deterministic generated header complete\n'
