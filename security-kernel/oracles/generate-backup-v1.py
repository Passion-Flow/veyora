#!/usr/bin/env python3
"""Reproduce the native-backup-v1 corpus from the signed source archive.

The transcriber verifies the official Minisign signature with a committed,
offline-built verifier, safely extracts and network-isolated-builds the exact
archive in a fresh directory, rejects ambient/system sodium inputs, compiles the
two standalone C processes, independently checks every stream, and emits a
compact JSON index plus full hash-bound MESSAGE ciphertext sidecars.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
from typing import Callable


ARCHIVE_SHA256 = "0dead67e534e4e14302d9f285fb68688f18ee93fb35350ac05214dd7772ab534"
SIDECAR_SHA256 = "9ed6444f7bb2a0b052d872062d398417262d544f65ee42be1df2a956469c07fe"
LINKED_LIBRARY_SHA256 = "2b082ef330e43ccbb7db83fe0bbf8d3ee5b038bbc088b7dd8d09609dcf67c859"
CATALOG_INVARIANT_ID = "protocol.backup.ciphertext-digest-catalog-sha256"
MINISIGN_PUBLIC_KEY = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
CHUNK_BYTES = 4_194_304
OVERHEAD_BYTES = 17
CASES = ("empty", "one-byte", "exact-chunk", "multi-chunk")
CASE_SHAPES = {
    "empty": (0, 1),
    "one-byte": (1, 1),
    "exact-chunk": (CHUNK_BYTES, 1),
    "multi-chunk": (CHUNK_BYTES + 1, 2),
}
FORBIDDEN_ENVIRONMENT = (
    "SODIUM_LIB_DIR",
    "SODIUM_USE_PKG_CONFIG",
    "SODIUM_SHARED",
    "VCPKGRS_DYNAMIC",
    "SODIUM_DISABLE_PIE",
    "SODIUM_BUILD_PREFIX",
)
SOURCE_BUILD_COMMAND = (
    "unshare -n sh -c 'cd \"$SOURCE_DIR\" && ./configure "
    "--prefix=\"$INSTALL_DIR\" --disable-shared --enable-static --with-pic "
    ">configure.log 2>&1 && make -j2 >make.log 2>&1 && "
    "make install >install.log 2>&1'"
)
ORACLE_COMPILE_FLAGS = "-std=c11 -O2 -Wall -Wextra -Werror"
GENERATOR_LINK_COMMAND = (
    '"$CC" -std=c11 -O2 -Wall -Wextra -Werror -I"$INSTALL_DIR/include" '
    'security-kernel/oracles/secretstream-v1.c "$INSTALL_DIR/lib/libsodium.a" '
    '-pthread -o "$WORK_DIR/secretstream-v1"'
)
CHECKER_LINK_COMMAND = (
    '"$CC" -std=c11 -O2 -Wall -Wextra -Werror -I"$INSTALL_DIR/include" '
    'security-kernel/oracles/check-secretstream-v1.c "$INSTALL_DIR/lib/libsodium.a" '
    '-pthread -o "$WORK_DIR/check-secretstream-v1"'
)
GENERATION_COMMAND = (
    'SODIUM_DIST_DIR="$SODIUM_DIST_DIR" '
    "python3 security-kernel/oracles/generate-backup-v1.py "
    "--output security-kernel/vectors/backup-v1.json"
)
UPSTREAM_GENERATOR = {
    "owner": "upstream-secretstream-captured-vector-generator",
    "source_kind": "upstream-url",
    "source_ref": "https://raw.githubusercontent.com/pyca/pynacl/ecf41f55a3d8f1e10ce89c61c4b4d67f3f4467cf/docs/vectors/c-source/secretstream_test_vector.c",
    "source_sha256": "911a361c92996c35f73e85e2258d848b4b43a3aba7030e4f070a0f148617e1b3",
    "capture_semantics": "random-output-capture-not-deterministic-kat",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def require_regular(path: Path) -> None:
    status = path.lstat()
    if not stat.S_ISREG(status.st_mode):
        raise RuntimeError(f"required regular non-symlink file is unavailable: {path}")


def require_hash(path: Path, expected: str) -> None:
    require_regular(path)
    actual = sha256(path)
    if actual != expected:
        raise RuntimeError(f"SHA-256 mismatch for {path}: {actual}")


def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(command, check=True, **kwargs)


def command_output(command: list[str]) -> bytes:
    return run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout


def canonical_sha256(value: dict[str, object], omitted: str) -> str:
    payload = {key: item for key, item in value.items() if key != omitted}
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_bytes(encoded)


def canonical_fixture_sha256(fixture: dict[str, object]) -> str:
    return canonical_sha256(fixture, "fixture_sha256")


def load_ciphertext_catalog(repository: Path) -> tuple[dict[str, object], str]:
    catalog_path = repository / "contracts/backup/backup-ciphertext-digests-v1.json"
    invariants_path = repository / "contracts/protocol/invariants-v1.json"
    require_regular(catalog_path)
    require_regular(invariants_path)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    invariants = json.loads(invariants_path.read_text(encoding="utf-8"))
    raw_sha256 = sha256(catalog_path)
    seals = [
        item
        for item in invariants.get("invariants", [])
        if isinstance(item, dict) and item.get("id") == CATALOG_INVARIANT_ID
    ]
    if (
        len(seals) != 1
        or seals[0].get("value") != raw_sha256
        or canonical_sha256(catalog, "canonical_catalog_sha256")
        != catalog.get("canonical_catalog_sha256")
    ):
        raise RuntimeError("backup ciphertext digest catalog is unsealed")
    return catalog, raw_sha256


def safe_extract(archive_path: Path, destination: Path) -> Path:
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            name = PurePosixPath(member.name)
            if (
                name.is_absolute()
                or ".." in name.parts
                or not (member.isdir() or member.isfile())
            ):
                raise RuntimeError(f"unsafe archive member: {member.name}")
        archive.extractall(destination, members=members, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != "libsodium-stable":
        raise RuntimeError("unexpected libsodium archive root")
    return roots[0]


def clean_build_environment() -> dict[str, str]:
    present = [name for name in FORBIDDEN_ENVIRONMENT if name in os.environ]
    if present:
        raise RuntimeError("forbidden ambient sodium variables: " + ", ".join(present))
    environment = os.environ.copy()
    environment.update({"LC_ALL": "C", "LANG": "C", "TZ": "UTC"})
    for name in FORBIDDEN_ENVIRONMENT:
        environment.pop(name, None)
    return environment


def build_minisign_verifier(
    oracle_directory: Path, work_directory: Path, environment: dict[str, str]
) -> tuple[Path, dict[str, str]]:
    source = oracle_directory / "minisign-verifier"
    verifier_project = work_directory / "minisign-verifier"
    shutil.copytree(source, verifier_project)
    target = work_directory / "minisign-target"
    command = [
        "unshare",
        "-n",
        "cargo",
        "build",
        "--release",
        "--offline",
        "--locked",
        "--manifest-path",
        str(verifier_project / "Cargo.toml"),
        "--target-dir",
        str(target),
    ]
    run(command, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    binary = target / "release/veyora-minisign-verifier"
    require_regular(binary)
    return binary, {
        "minisign_verifier_source_ref": "security-kernel/oracles/minisign-verifier/src/main.rs",
        "minisign_verifier_source_sha256": sha256(source / "src/main.rs"),
        "minisign_verifier_manifest_sha256": sha256(source / "Cargo.toml"),
        "minisign_verifier_lock_sha256": sha256(source / "Cargo.lock"),
        "minisign_verifier_binary_sha256": sha256(binary),
        "minisign_verifier_build_command": (
            "unshare -n cargo build --release --offline --locked "
            "--manifest-path $WORK_DIR/minisign-verifier/Cargo.toml "
            "--target-dir $WORK_DIR/minisign-target"
        ),
    }


def verify_source(
    verifier: Path, archive: Path, signature: Path, environment: dict[str, str]
) -> None:
    result = run(
        [str(verifier), str(archive), str(signature)],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.stdout != b"minisign-verification: PASS\n":
        raise RuntimeError("unexpected Minisign verification output")


def build_libsodium(
    archive: Path, work_directory: Path, environment: dict[str, str]
) -> tuple[Path, Path]:
    extract_directory = work_directory / "source"
    extract_directory.mkdir()
    source = safe_extract(archive, extract_directory)
    install = work_directory / "install"
    script = (
        'cd "$1" && ./configure --prefix="$2" --disable-shared --enable-static '
        '--with-pic >configure.log 2>&1 && make -j2 >make.log 2>&1 && '
        'make install >install.log 2>&1'
    )
    run(["unshare", "-n", "sh", "-c", script, "sh", str(source), str(install)], env=environment)
    library = install / "lib/libsodium.a"
    require_hash(library, LINKED_LIBRARY_SHA256)
    require_regular(install / "include/sodium.h")
    return install, library


def compile_oracles(
    compiler: str,
    install: Path,
    library: Path,
    oracle_directory: Path,
    work_directory: Path,
    environment: dict[str, str],
) -> tuple[Path, Path]:
    generator = work_directory / "secretstream-v1"
    checker = work_directory / "check-secretstream-v1"
    common = [
        compiler,
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        f"-I{install / 'include'}",
    ]
    run(
        common
        + [str(oracle_directory / "secretstream-v1.c"), str(library), "-pthread", "-o", str(generator)],
        env=environment,
    )
    run(
        common
        + [str(oracle_directory / "check-secretstream-v1.c"), str(library), "-pthread", "-o", str(checker)],
        env=environment,
    )
    return generator, checker


def metadata(directory: Path) -> dict[str, str]:
    pairs: dict[str, str] = {}
    for line in (directory / "metadata.txt").read_text(encoding="ascii").splitlines():
        key, separator, value = line.partition("=")
        if not separator or key in pairs:
            raise RuntimeError(f"invalid fixture metadata in {directory}")
        pairs[key] = value
    return pairs


def frame_path(directory: Path, index: int, suffix: str) -> Path:
    return directory / f"frame-{index:03d}.{suffix}"


def flip_first_byte(path: Path) -> None:
    value = bytearray(path.read_bytes())
    if not value:
        raise RuntimeError(f"cannot mutate empty oracle file: {path}")
    value[0] ^= 1
    path.write_bytes(value)


def run_checker_hostile_matrix(
    checker: Path, fixture_directory: Path, work_directory: Path
) -> int:
    """Prove the independent checker fails closed for stream/file mutations."""

    hostile_root = work_directory / "checker-hostile"
    hostile_root.mkdir()
    final_index = 2

    def hostile(name: str, mutate: Callable[[Path], object]) -> None:
        target = hostile_root / name
        shutil.copytree(fixture_directory, target)
        mutate(target)
        result = subprocess.run(
            [str(checker), str(target)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if result.returncode == 0:
            raise RuntimeError(f"checker accepted hostile fixture: {name}")

    def write_tag(index: int, value: bytes):
        return lambda target: frame_path(target, index, "tag").write_bytes(value)

    def append_byte(path: Path) -> None:
        path.write_bytes(path.read_bytes() + b"\x00")

    def truncate_byte(path: Path) -> None:
        value = path.read_bytes()
        if not value:
            raise RuntimeError(f"cannot truncate empty oracle file: {path}")
        path.write_bytes(value[:-1])

    def swap_ciphertexts(target: Path) -> None:
        first = frame_path(target, 0, "ciphertext.bin")
        second = frame_path(target, 1, "ciphertext.bin")
        first_bytes = first.read_bytes()
        first.write_bytes(second.read_bytes())
        second.write_bytes(first_bytes)

    def duplicate_ciphertext(target: Path) -> None:
        frame_path(target, 1, "ciphertext.bin").write_bytes(
            frame_path(target, 0, "ciphertext.bin").read_bytes()
        )

    def duplicate_final_files(target: Path) -> None:
        for suffix in ("aad.bin", "plaintext.bin", "ciphertext.bin", "tag"):
            shutil.copyfile(
                frame_path(target, final_index, suffix),
                frame_path(target, final_index + 1, suffix),
            )

    def symlink_frame(target: Path) -> None:
        path = frame_path(target, 0, "aad.bin")
        path.unlink()
        path.symlink_to("frame-001.aad.bin")

    mutations = (
        ("early-final-tag", write_tag(0, b"FINAL\n")),
        ("missing-final-tag", write_tag(final_index, b"MESSAGE\n")),
        ("duplicate-final-files", duplicate_final_files),
        ("appended-ciphertext", lambda target: append_byte(frame_path(target, 0, "ciphertext.bin"))),
        ("reordered-ciphertexts", swap_ciphertexts),
        ("duplicated-ciphertext", duplicate_ciphertext),
        ("truncated-ciphertext", lambda target: truncate_byte(frame_path(target, 0, "ciphertext.bin"))),
        ("mutated-aad", lambda target: flip_first_byte(frame_path(target, 0, "aad.bin"))),
        ("mutated-index", lambda target: frame_path(target, 0, "aad.bin").rename(frame_path(target, 9, "aad.bin"))),
        ("mutated-key", lambda target: flip_first_byte(target / "key.bin")),
        ("mutated-header", lambda target: flip_first_byte(target / "header.bin")),
        ("mutated-backup-header", lambda target: flip_first_byte(target / "backup-header.bin")),
        ("mutated-ciphertext", lambda target: flip_first_byte(frame_path(target, 0, "ciphertext.bin"))),
        ("missing-frame-file", lambda target: frame_path(target, final_index, "ciphertext.bin").unlink()),
        ("extra-frame-file", lambda target: (target / "frame-999.tag").write_bytes(b"FINAL\n")),
        ("symlinked-frame-file", symlink_frame),
    )
    for name, mutate in mutations:
        hostile(name, mutate)
    return len(mutations)


def build_fixture(
    repository: Path,
    case_name: str,
    generator: Path,
    checker: Path,
    work_directory: Path,
    project_generator: dict[str, str],
    oracle_evidence_sha256: str,
    expected_ciphertext: dict[str, object],
) -> tuple[dict[str, object], list[tuple[Path, str]]]:
    fixture_directory = work_directory / case_name
    repeat_directory = work_directory / f"{case_name}-repeat"
    fixture_directory.mkdir()
    repeat_directory.mkdir()
    run([str(generator), case_name, str(fixture_directory)])
    run([str(generator), case_name, str(repeat_directory)])
    first_files = sorted(path.name for path in fixture_directory.iterdir())
    second_files = sorted(path.name for path in repeat_directory.iterdir())
    if first_files != second_files or any(
        (fixture_directory / name).read_bytes() != (repeat_directory / name).read_bytes()
        for name in first_files
    ):
        raise RuntimeError(f"oracle output is not deterministic for {case_name}")
    run([str(checker), str(fixture_directory)], stdout=subprocess.DEVNULL)

    logical_size, message_count = CASE_SHAPES[case_name]
    details = metadata(fixture_directory)
    if details != {
        "format": "veyora-secretstream-oracle-v1",
        "case": case_name,
        "logical_size": str(logical_size),
        "message_count": str(message_count),
        "frame_count": str(message_count + 1),
        "chunk_plaintext_bytes": str(CHUNK_BYTES),
        "secretstream_overhead": str(OVERHEAD_BYTES),
        "backup_header_bytes": str(len((fixture_directory / "backup-header.bin").read_bytes())),
        "library_version": "1.0.22",
    }:
        raise RuntimeError(f"oracle metadata differs for {case_name}")

    golden_path = repository / "contracts/backup/goldens" / f"{case_name}.json"
    golden = json.loads(golden_path.read_text(encoding="utf-8"))
    logical_hash = (fixture_directory / "logical-snapshot-sha256.bin").read_bytes().hex()
    backup_header = (fixture_directory / "backup-header.bin").read_bytes()
    backup_header_hash = (fixture_directory / "backup-header-sha256.bin").read_bytes().hex()
    stream_header = (fixture_directory / "header.bin").read_bytes()
    key = (fixture_directory / "key.bin").read_bytes()
    if (
        golden["logical_size"] != logical_size
        or golden["data_chunk_count"] != message_count
        or golden["protocol_chunk_bytes"] != CHUNK_BYTES
        or golden["logical_snapshot_fixture"] != "zero-bytes-of-logical-size"
        or golden["logical_snapshot_sha256"] != logical_hash
        or len(key) != 32
        or len(stream_header) != 24
        or backup_header[-24:] != stream_header
        or sha256_bytes(backup_header) != backup_header_hash
    ):
        raise RuntimeError(f"ADR backup inputs differ for {case_name}")

    frames: list[dict[str, object]] = []
    sidecars: list[tuple[Path, str]] = []
    for index in range(message_count):
        aad = frame_path(fixture_directory, index, "aad.bin").read_bytes()
        plaintext = frame_path(fixture_directory, index, "plaintext.bin").read_bytes()
        ciphertext_path = frame_path(fixture_directory, index, "ciphertext.bin")
        ciphertext_length = ciphertext_path.stat().st_size
        seed = frame_path(fixture_directory, index, "padding-seed.bin").read_bytes()
        logical_offset = index * CHUNK_BYTES
        logical_bytes = max(0, min(CHUNK_BYTES, logical_size - logical_offset))
        relative_sidecar = f"security-kernel/vectors/backup-v1/{case_name}/frame-{index:03d}.ciphertext.bin"
        if (
            len(aad) == 0
            or len(plaintext) != CHUNK_BYTES
            or ciphertext_length != CHUNK_BYTES + OVERHEAD_BYTES
            or len(seed) != 32
            or sha256(ciphertext_path)
            != expected_ciphertext["message_ciphertext_sha256"][index]
        ):
            raise RuntimeError(f"MESSAGE frame differs for {case_name}/{index}")
        frames.append(
            {
                "index": index,
                "tag": "MESSAGE",
                "aad_hex": aad.hex(),
                "plaintext_recipe": {
                    "id": "zero-logical-then-libsodium-deterministic-padding-v1",
                    "logical_offset": logical_offset,
                    "logical_bytes": logical_bytes,
                    "padding_bytes": CHUNK_BYTES - logical_bytes,
                    "padding_generator": "libsodium-randombytes-buf-deterministic-1.0.22",
                    "padding_seed_hex": seed.hex(),
                },
                "plaintext_length": len(plaintext),
                "plaintext_sha256": sha256_bytes(plaintext),
                "ciphertext_sidecar": {
                    "representation": "contained-regular-file",
                    "path": relative_sidecar,
                    "length": ciphertext_length,
                    "sha256": sha256(ciphertext_path),
                },
            }
        )
        sidecars.append((ciphertext_path, relative_sidecar))

    final_index = message_count
    final_aad = frame_path(fixture_directory, final_index, "aad.bin").read_bytes()
    final_plaintext = frame_path(fixture_directory, final_index, "plaintext.bin").read_bytes()
    final_ciphertext = frame_path(fixture_directory, final_index, "ciphertext.bin").read_bytes()
    if (
        not final_aad
        or final_plaintext[0:1] != b"\x85"
        or len(final_ciphertext) != len(final_plaintext) + OVERHEAD_BYTES
        or sha256_bytes(final_ciphertext)
        != expected_ciphertext["final_ciphertext_sha256"]
    ):
        raise RuntimeError(f"FINAL frame differs for {case_name}")
    frames.append(
        {
            "index": final_index,
            "tag": "FINAL",
            "aad_hex": final_aad.hex(),
            "plaintext_hex": final_plaintext.hex(),
            "ciphertext_hex": final_ciphertext.hex(),
        }
    )

    fixture: dict[str, object] = {
        "case": case_name,
        "source_document": "docs/adr/0001-cryptographic-protocol.md",
        "source_section": "encrypted-backup-v1, checkpoint, and artifact receipt",
        "provenance_id": "native-backup-v1",
        "oracle_kind": "project-independent-c",
        "generator": project_generator,
        "generation_command": GENERATION_COMMAND,
        "library_archive_sha256": ARCHIVE_SHA256,
        "linked_library_sha256": LINKED_LIBRARY_SHA256,
        "oracle_evidence_sha256": oracle_evidence_sha256,
        "golden_source_path": f"contracts/backup/goldens/{case_name}.json",
        "golden_source_sha256": sha256(golden_path),
        "logical_size": logical_size,
        "data_chunk_count": message_count,
        "chunk_plaintext_bytes": CHUNK_BYTES,
        "logical_snapshot_recipe": "zero-bytes-of-logical-size",
        "logical_snapshot_sha256": logical_hash,
        "key_hex": key.hex(),
        "stream_header_hex": stream_header.hex(),
        "backup_header_cbor_hex": backup_header.hex(),
        "backup_header_sha256": backup_header_hash,
        "frames": frames,
        "review": {"disposition": "ai-non-human-reviewed"},
    }
    fixture["fixture_sha256"] = canonical_fixture_sha256(fixture)
    return fixture, sidecars


def build_corpus(
    repository: Path, work_directory: Path
) -> tuple[dict[str, object], list[tuple[Path, str]], int]:
    oracle_directory = repository / "security-kernel/oracles"
    ciphertext_catalog, ciphertext_catalog_sha256 = load_ciphertext_catalog(repository)
    environment = clean_build_environment()
    dist_value = os.environ.get("SODIUM_DIST_DIR")
    if not dist_value:
        raise RuntimeError("SODIUM_DIST_DIR is required")
    dist_directory = Path(dist_value).resolve(strict=True)
    archive = dist_directory / "LATEST.tar.gz"
    signature = dist_directory / "LATEST.tar.gz.minisig"
    require_hash(archive, ARCHIVE_SHA256)
    require_hash(signature, SIDECAR_SHA256)

    verifier, verifier_evidence = build_minisign_verifier(
        oracle_directory, work_directory, environment
    )
    verify_source(verifier, archive, signature, environment)
    install, library = build_libsodium(archive, work_directory, environment)
    compiler = os.environ.get("CC", "cc")
    compiler_output = command_output([compiler, "--version"])
    archiver_output = command_output(["ar", "--version"])
    generator, checker = compile_oracles(
        compiler, install, library, oracle_directory, work_directory, environment
    )

    oracle_evidence: dict[str, object] = {
        "archive_sha256": ARCHIVE_SHA256,
        "sidecar_sha256": SIDECAR_SHA256,
        "minisign_public_key": MINISIGN_PUBLIC_KEY,
        **verifier_evidence,
        "minisign_verification_command": (
            "$WORK_DIR/veyora-minisign-verifier "
            "$SODIUM_DIST_DIR/LATEST.tar.gz $SODIUM_DIST_DIR/LATEST.tar.gz.minisig"
        ),
        "generator_source_ref": "security-kernel/oracles/secretstream-v1.c",
        "generator_source_sha256": sha256(oracle_directory / "secretstream-v1.c"),
        "generator_binary_sha256": sha256(generator),
        "checker_source_ref": "security-kernel/oracles/check-secretstream-v1.c",
        "checker_source_sha256": sha256(oracle_directory / "check-secretstream-v1.c"),
        "checker_binary_sha256": sha256(checker),
        "transcriber_source_ref": "security-kernel/oracles/generate-backup-v1.py",
        "transcriber_source_sha256": sha256(Path(__file__)),
        "compiler_command": compiler,
        "compiler_version": compiler_output.decode("utf-8").splitlines()[0],
        "compiler_version_sha256": sha256_bytes(compiler_output),
        "archiver_command": "ar",
        "archiver_version": archiver_output.decode("utf-8").splitlines()[0],
        "archiver_version_sha256": sha256_bytes(archiver_output),
        "source_build_command": SOURCE_BUILD_COMMAND,
        "generator_link_command": GENERATOR_LINK_COMMAND,
        "checker_link_command": CHECKER_LINK_COMMAND,
        "network_isolation": "linux-unshare-network-namespace",
        "source_build_mode": "fresh-controlled-directory",
        "linked_library_sha256": LINKED_LIBRARY_SHA256,
        "ciphertext_digest_catalog_sha256": ciphertext_catalog_sha256,
    }
    expected_build = ciphertext_catalog.get("build_fingerprints")
    if (
        ciphertext_catalog.get("library_archive_sha256") != ARCHIVE_SHA256
        or ciphertext_catalog.get("linked_library_sha256") != LINKED_LIBRARY_SHA256
        or ciphertext_catalog.get("oracle_source_sha256")
        != oracle_evidence["generator_source_sha256"]
        or ciphertext_catalog.get("checker_source_sha256")
        != oracle_evidence["checker_source_sha256"]
        or not isinstance(expected_build, dict)
        or any(
            oracle_evidence.get(field) != expected_build.get(field)
            for field in (
                "compiler_command", "compiler_version", "compiler_version_sha256",
                "archiver_command", "archiver_version", "archiver_version_sha256",
                "minisign_verifier_binary_sha256", "generator_binary_sha256",
                "checker_binary_sha256",
            )
        )
        or ciphertext_catalog.get("upstream_captured_transcript", {}).get("status")
        != "blocked-pending-independent-pull-verified-capture"
    ):
        raise RuntimeError("backup ciphertext/build catalog differs from reproduced evidence")
    oracle_evidence["oracle_evidence_sha256"] = canonical_sha256(
        oracle_evidence, "oracle_evidence_sha256"
    )
    project_generator = {
        "owner": "standalone-c-libsodium-oracle",
        "source_kind": "committed-file",
        "source_ref": "security-kernel/oracles/secretstream-v1.c",
        "source_sha256": oracle_evidence["generator_source_sha256"],
    }

    fixtures: dict[str, object] = {
        "upstream-fixed-decrypt": {
            "case": "upstream-fixed-decrypt",
            "evidence_status": "blocked-pending-captured-output-and-qualified-review",
            "source_document": "PyNaCl 1.6.2 secretstream reference vectors",
            "source_section": "Vector generation",
            "provenance_id": "native-backup-v1",
            "oracle_kind": "upstream-captured-random-decrypt",
            "generator": UPSTREAM_GENERATOR,
            "blocker": "libsodium-1.0.22-publishes-no-fixed-secretstream-reference-data",
        }
    }
    sidecars: list[tuple[Path, str]] = []
    for case_name in CASES:
        fixture, fixture_sidecars = build_fixture(
            repository,
            case_name,
            generator,
            checker,
            work_directory,
            project_generator,
            str(oracle_evidence["oracle_evidence_sha256"]),
            ciphertext_catalog["project_fixtures"][case_name],
        )
        fixtures[case_name] = fixture
        sidecars.extend(fixture_sidecars)
    hostile_check_count = run_checker_hostile_matrix(
        checker, work_directory / "multi-chunk", work_directory
    )
    return (
        {
            "schema_version": 1,
            "corpus_id": "native-backup-v1",
            "provenance_contract": "contracts/protocol/vector-provenance-v1.json",
            "canonical_hash_rule": "veyora-vector-json-v1",
            "libsodium_version": "1.0.22",
            "oracle_evidence": oracle_evidence,
            "fixtures": fixtures,
        },
        sidecars,
        hostile_check_count,
    )


def output_bytes(corpus: dict[str, object]) -> bytes:
    return (json.dumps(corpus, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("security-kernel/vectors/backup-v1.json"),
    )
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    repository = Path(__file__).resolve().parents[2]
    output = arguments.output if arguments.output.is_absolute() else repository / arguments.output
    if not output.is_relative_to(repository / "security-kernel/vectors"):
        raise RuntimeError("output must remain under security-kernel/vectors")

    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="veyora-backup-corpus-") as temporary:
        corpus, sidecars, hostile_check_count = build_corpus(repository, Path(temporary))
        encoded = output_bytes(corpus)
        if arguments.check:
            if output.read_bytes() != encoded:
                raise RuntimeError(f"generated backup corpus differs: {output}")
            for source, relative in sidecars:
                target = repository / relative
                require_regular(target)
                if target.stat().st_size != source.stat().st_size or sha256(target) != sha256(source):
                    raise RuntimeError(f"generated backup sidecar differs: {target}")
            elapsed = time.monotonic() - started
            print(
                f"backup corpus check: PASS sha256:{sha256_bytes(encoded)} "
                f"sidecar_bytes:{sum(source.stat().st_size for source, _ in sidecars)} "
                f"hostile_checks:{hostile_check_count} "
                f"elapsed_seconds:{elapsed:.3f}"
            )
            return 0
        if os.path.lexists(output):
            raise RuntimeError(f"refusing to overwrite existing corpus: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        for source, relative in sidecars:
            target = repository / relative
            if os.path.lexists(target):
                raise RuntimeError(f"refusing to overwrite existing sidecar: {target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        output.write_bytes(encoded)
        elapsed = time.monotonic() - started
        print(
            f"backup corpus generated: {output} sha256:{sha256_bytes(encoded)} "
            f"sidecar_bytes:{sum(source.stat().st_size for source, _ in sidecars)} "
            f"hostile_checks:{hostile_check_count} "
            f"elapsed_seconds:{elapsed:.3f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
