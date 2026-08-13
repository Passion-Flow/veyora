#!/usr/bin/env python3
"""Generate and verify Veyora's independent manifest-v1 evidence corpus.

This dependency-free oracle intentionally lives outside product Rust code.  The
fixture inputs freeze a deterministic recipe: derive opaque inert record IDs and
envelope hashes from the recorded seed and ordinal, sort by raw record ID, hash
canonical leaf and chunk CBOR, and reduce chunk hashes with unchanged odd-node
promotion.  The 50,000-relationship fixture distributes five opaque relationship
descriptors into each of 10,000 record-envelope derivations; relationships never
become server-visible manifest fields.

The generator writes only a new path unless ``--replace`` is supplied.  ``check``
reconstructs the full corpus rather than trusting stored expected values.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import sys
from typing import Any, Iterable


DOMAIN_EMPTY = b"pm-v1/manifest-empty\0"
DOMAIN_LEAF = b"pm-v1/manifest-leaf\0"
DOMAIN_CHUNK = b"pm-v1/manifest-chunk\0"
DOMAIN_NODE = b"pm-v1/manifest-node\0"
DOMAIN_MANIFEST = b"pm-v1/manifest\0"
DOMAIN_RECORD_ID = b"pm-v1/manifest-fixture/record-id\0"
DOMAIN_ENVELOPE = b"pm-v1/manifest-fixture/envelope\0"
DOMAIN_LEAF_SET = b"pm-v1/manifest-fixture/leaf-set\0"
DOMAIN_RELATIONSHIP = b"pm-v1/manifest-fixture/relationship\0"
DOMAIN_RELATIONSHIP_SET = b"pm-v1/manifest-fixture/relationship-set\0"
PAGE_SIZE = 500
RECORD_LIMIT = 10_000
RELATIONSHIP_LIMIT = 50_000
SOURCE_DOCUMENT = "docs/adr/0002-synchronization-manifest.md"
SOURCE_SECTION = "Manifest and tree layout"
SOURCE_REF = "security-kernel/oracles/manifest-v1.py"
RFC8032_SEED = bytes.fromhex(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
)
RFC8032_PUBLIC = bytes.fromhex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
)

ED25519_Q = 2**255 - 19
ED25519_L = 2**252 + 27742317777372353535851937790883648493
ED25519_D = (-121665 * pow(121666, ED25519_Q - 2, ED25519_Q)) % ED25519_Q
ED25519_I = pow(2, (ED25519_Q - 1) // 4, ED25519_Q)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * pow(ED25519_D * y * y + 1, ED25519_Q - 2, ED25519_Q)
    xx %= ED25519_Q
    x = pow(xx, (ED25519_Q + 3) // 8, ED25519_Q)
    if (x * x - xx) % ED25519_Q:
        x = x * ED25519_I % ED25519_Q
    if (x * x - xx) % ED25519_Q:
        raise ValueError("invalid Ed25519 point")
    return ED25519_Q - x if x & 1 else x


ED25519_BASE_Y = 4 * pow(5, ED25519_Q - 2, ED25519_Q) % ED25519_Q
ED25519_BASE = (_xrecover(ED25519_BASE_Y), ED25519_BASE_Y)


def _point_add(left: tuple[int, int], right: tuple[int, int]) -> tuple[int, int]:
    x1, y1 = left
    x2, y2 = right
    common = ED25519_D * x1 * x2 * y1 * y2 % ED25519_Q
    return (
        (x1 * y2 + x2 * y1) * pow(1 + common, ED25519_Q - 2, ED25519_Q)
        % ED25519_Q,
        (y1 * y2 + x1 * x2) * pow(1 - common, ED25519_Q - 2, ED25519_Q)
        % ED25519_Q,
    )


def _scalar_multiply(point: tuple[int, int], scalar: int) -> tuple[int, int]:
    result = (0, 1)
    addend = point
    while scalar:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    return result


def _encode_point(point: tuple[int, int]) -> bytes:
    x, y = point
    encoded = y | ((x & 1) << 255)
    return encoded.to_bytes(32, "little")


def _ed25519_public_key(seed: bytes) -> bytes:
    digest = hashlib.sha512(seed).digest()
    scalar_bytes = bytearray(digest[:32])
    scalar_bytes[0] &= 248
    scalar_bytes[31] &= 63
    scalar_bytes[31] |= 64
    return _encode_point(_scalar_multiply(ED25519_BASE, int.from_bytes(scalar_bytes, "little")))


def _ed25519_sign(seed: bytes, message: bytes) -> bytes:
    expanded = hashlib.sha512(seed).digest()
    scalar_bytes = bytearray(expanded[:32])
    scalar_bytes[0] &= 248
    scalar_bytes[31] &= 63
    scalar_bytes[31] |= 64
    scalar = int.from_bytes(scalar_bytes, "little")
    public = _encode_point(_scalar_multiply(ED25519_BASE, scalar))
    nonce = int.from_bytes(hashlib.sha512(expanded[32:] + message).digest(), "little") % ED25519_L
    encoded_r = _encode_point(_scalar_multiply(ED25519_BASE, nonce))
    challenge = int.from_bytes(
        hashlib.sha512(encoded_r + public + message).digest(), "little"
    ) % ED25519_L
    encoded_s = ((nonce + challenge * scalar) % ED25519_L).to_bytes(32, "little")
    return encoded_r + encoded_s


def _decode_point(encoded: bytes) -> tuple[int, int]:
    if len(encoded) != 32:
        raise ValueError("invalid Ed25519 point length")
    integer = int.from_bytes(encoded, "little")
    sign = integer >> 255
    y = integer & ((1 << 255) - 1)
    if y >= ED25519_Q:
        raise ValueError("noncanonical Ed25519 point")
    x = _xrecover(y)
    if (x & 1) != sign:
        x = ED25519_Q - x
    if x == 0 and sign:
        raise ValueError("noncanonical Ed25519 sign bit")
    point = (x, y)
    if _scalar_multiply(point, 8) == (0, 1) or _scalar_multiply(point, ED25519_L) != (0, 1):
        raise ValueError("small-order Ed25519 point")
    return point


def _ed25519_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    scalar = int.from_bytes(signature[32:], "little")
    if scalar >= ED25519_L:
        return False
    try:
        point_a = _decode_point(public)
        point_r = _decode_point(signature[:32])
    except ValueError:
        return False
    challenge = int.from_bytes(
        hashlib.sha512(signature[:32] + public + message).digest(), "little"
    ) % ED25519_L
    return _scalar_multiply(ED25519_BASE, scalar) == _point_add(
        point_r, _scalar_multiply(point_a, challenge)
    )


def _cbor_head(major: int, value: int) -> bytes:
    if not 0 <= value <= 0xFFFFFFFFFFFFFFFF:
        raise ValueError("CBOR integer outside protocol u64")
    if value < 24:
        return bytes([(major << 5) | value])
    if value <= 0xFF:
        return bytes([(major << 5) | 24, value])
    if value <= 0xFFFF:
        return bytes([(major << 5) | 25]) + value.to_bytes(2, "big")
    if value <= 0xFFFFFFFF:
        return bytes([(major << 5) | 26]) + value.to_bytes(4, "big")
    return bytes([(major << 5) | 27]) + value.to_bytes(8, "big")


def encode_cbor(value: Any) -> bytes:
    """Encode the closed manifest evidence subset of deterministic CBOR."""
    if value is False:
        return b"\xf4"
    if value is True:
        return b"\xf5"
    if isinstance(value, int) and not isinstance(value, bool):
        return _cbor_head(0, value)
    if isinstance(value, bytes):
        return _cbor_head(2, len(value)) + value
    if isinstance(value, list):
        return _cbor_head(4, len(value)) + b"".join(encode_cbor(item) for item in value)
    raise TypeError(f"unsupported CBOR evidence value: {type(value).__name__}")


def _decode_length(data: bytes, offset: int, additional: int) -> tuple[int, int]:
    if additional < 24:
        return additional, offset
    widths = {24: 1, 25: 2, 26: 4, 27: 8}
    width = widths.get(additional)
    if width is None or offset + width > len(data):
        raise ValueError("invalid or truncated CBOR length")
    value = int.from_bytes(data[offset : offset + width], "big")
    minimum = {1: 24, 2: 256, 4: 65536, 8: 4294967296}[width]
    if value < minimum or value > 0xFFFFFFFFFFFFFFFF:
        raise ValueError("noncanonical or oversized CBOR length")
    return value, offset + width


def decode_cbor(data: bytes, offset: int = 0) -> tuple[Any, int]:
    """Decode one item in the same closed canonical evidence subset."""
    if offset >= len(data):
        raise ValueError("truncated CBOR item")
    initial = data[offset]
    offset += 1
    if initial == 0xF4:
        return False, offset
    if initial == 0xF5:
        return True, offset
    major = initial >> 5
    if major not in {0, 2, 4}:
        raise ValueError("CBOR major type is outside the evidence profile")
    value, offset = _decode_length(data, offset, initial & 0x1F)
    if major == 0:
        return value, offset
    if major == 2:
        end = offset + value
        if end > len(data):
            raise ValueError("truncated CBOR byte string")
        return data[offset:end], end
    items: list[Any] = []
    for _index in range(value):
        item, offset = decode_cbor(data, offset)
        items.append(item)
    return items, offset


def _u64(value: int) -> bytes:
    return value.to_bytes(8, "big")


def _sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def _deduplicate(values: Iterable[bytes]) -> list[bytes]:
    seen: set[bytes] = set()
    result: list[bytes] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _bitmap(tombstones: list[bool]) -> bytes:
    length = max(1, (len(tombstones) + 7) // 8)
    value = bytearray(length)
    for index, tombstone in enumerate(tombstones):
        if tombstone:
            value[index // 8] |= 1 << (7 - index % 8)
    return bytes(value)


def _fixture_seed(shape: str) -> bytes:
    return _sha256(b"pm-v1/manifest-fixture/seed\0" + shape.encode("ascii"))


def _relationship_commitment(
    seed: bytes,
    *,
    owner_ordinal: int,
    record_count: int,
    relation_start: int,
    relation_count: int,
) -> tuple[bytes, list[bytes]]:
    relationship_hashes = [
        _sha256(
            DOMAIN_RELATIONSHIP
            + seed
            + encode_cbor(
                [
                    relation_ordinal,
                    owner_ordinal,
                    (relation_ordinal + 1) % record_count,
                ]
            )
        )
        for relation_ordinal in range(relation_start, relation_start + relation_count)
    ]
    return (
        _sha256(DOMAIN_RELATIONSHIP_SET + b"".join(relationship_hashes)),
        relationship_hashes,
    )


def _record(
    seed: bytes,
    ordinal: int,
    tombstone: bool,
    record_count: int,
    relation_start: int,
    relation_count: int,
) -> tuple[bytes, list[Any], bytes, bytes]:
    ordinal_bytes = _u64(ordinal)
    record_id = _sha256(DOMAIN_RECORD_ID + seed + ordinal_bytes)[:16]
    relationship_commitment, _relationship_hashes = _relationship_commitment(
        seed,
        owner_ordinal=ordinal,
        record_count=record_count,
        relation_start=relation_start,
        relation_count=relation_count,
    )
    envelope_hash = _sha256(
        DOMAIN_ENVELOPE
        + seed
        + ordinal_bytes
        + _u64(relation_start)
        + _u64(relation_count)
        + relationship_commitment
    )
    leaf = [record_id, ordinal + 1, 1, envelope_hash, tombstone]
    leaf_cbor = encode_cbor(leaf)
    return record_id, leaf, _sha256(DOMAIN_LEAF + leaf_cbor), relationship_commitment


def _tree(
    records: list[tuple[bytes, list[Any], bytes, bytes]], page_size: int
) -> tuple[bytes, list[bytes], list[bytes]]:
    if not records:
        return _sha256(DOMAIN_EMPTY), [], []
    ordered = sorted(records, key=lambda row: row[0])
    leaf_hashes = [row[2] for row in ordered]
    chunks: list[bytes] = []
    for chunk_index, start in enumerate(range(0, len(ordered), page_size)):
        rows = ordered[start : start + page_size]
        chunk_body = [chunk_index, rows[0][0], rows[-1][0], [row[2] for row in rows]]
        chunks.append(_sha256(DOMAIN_CHUNK + encode_cbor(chunk_body)))
    created_nodes: list[bytes] = []
    level = chunks
    while len(level) > 1:
        following: list[bytes] = []
        for index in range(0, len(level), 2):
            if index + 1 == len(level):
                following.append(level[index])
            else:
                node = _sha256(DOMAIN_NODE + level[index] + level[index + 1])
                following.append(node)
                created_nodes.append(node)
        level = following
    return level[0], leaf_hashes, chunks + created_nodes


def _signed_boolean_evidence(tombstone: bool) -> dict[str, str]:
    leaf = [
        bytes(range(0x80, 0x90)),
        1,
        1,
        bytes(range(0x90, 0xB0)),
        tombstone,
    ]
    leaf_cbor = encode_cbor(leaf)
    leaf_hash = _sha256(DOMAIN_LEAF + leaf_cbor)
    body = [
        1,
        1,
        bytes(range(0x00, 0x10)),
        bytes(range(0x10, 0x20)),
        4,
        bytes(range(0x20, 0x30)),
        1,
        1,
        bytes(32),
        leaf_hash,
        1,
        bytes(range(0x30, 0x50)),
        1,
        0 if tombstone else 1,
        1 if tombstone else 0,
        1,
        1,
        1,
        1,
        bytes(range(0x50, 0x70)),
        bytes(range(0x70, 0x80)),
    ]
    body_cbor = encode_cbor(body)
    preimage = DOMAIN_MANIFEST + body_cbor
    signature = _ed25519_sign(RFC8032_SEED, preimage)
    envelope = encode_cbor([body, signature])
    return {
        "body_cbor": body_cbor.hex(),
        "preimage": preimage.hex(),
        "signature": signature.hex(),
        "envelope": envelope.hex(),
        "envelope_sha256": _sha256(envelope).hex(),
        "leaf_cbor": leaf_cbor.hex(),
        "leaf_sha256": leaf_hash.hex(),
    }


FIXTURE_SPECS: tuple[tuple[str, int, int, int, str], ...] = (
    ("empty", 0, 0, PAGE_SIZE, "none"),
    ("one-leaf", 1, 0, PAGE_SIZE, "none"),
    ("two-leaf", 2, 0, 1, "none"),
    ("odd-promotion", 3, 0, 1, "none"),
    ("chunk-boundary", PAGE_SIZE + 1, 0, PAGE_SIZE, "none"),
    ("tombstone-live-order", 4, 0, 2, "alternating"),
    ("10000-live", RECORD_LIMIT, 0, PAGE_SIZE, "none"),
    ("50000-relations", RECORD_LIMIT, RELATIONSHIP_LIMIT, PAGE_SIZE, "none"),
)


def _build_fixture(
    shape: str,
    record_count: int,
    relationship_count: int,
    page_size: int,
    tombstone_rule: str,
    source_sha256: str,
    shape_code: int,
) -> dict[str, Any]:
    if not 0 <= record_count <= RECORD_LIMIT:
        raise ValueError("record count exceeds the frozen evidence limit")
    if not 0 <= relationship_count <= RELATIONSHIP_LIMIT:
        raise ValueError("relationship count exceeds the frozen evidence limit")
    if record_count == 0 and relationship_count:
        raise ValueError("relationships require at least one record")
    seed = _fixture_seed(shape)
    tombstones = [tombstone_rule == "alternating" and index % 2 == 1 for index in range(record_count)]
    ordinals = list(range(record_count))
    if shape == "tombstone-live-order":
        ordinals = [3, 0, 2, 1]
    base_relations, extra_relations = divmod(relationship_count, max(1, record_count))
    relationship_offset = 0
    records: list[tuple[bytes, list[Any], bytes, bytes]] = []
    for ordinal in ordinals:
        relation_count = base_relations + (1 if ordinal < extra_relations else 0)
        relation_start = ordinal * base_relations + min(ordinal, extra_relations)
        relationship_offset += relation_count
        records.append(
            _record(
                seed,
                ordinal,
                tombstones[ordinal],
                max(1, record_count),
                relation_start,
                relation_count,
            )
        )
    if relationship_offset != relationship_count:
        raise AssertionError("relationship distribution differs")
    root, leaf_hashes, tree_hashes = _tree(records, page_size)
    leaf_set_digest = _sha256(DOMAIN_LEAF_SET + b"".join(leaf_hashes))
    relationship_set_digest = _sha256(
        DOMAIN_RELATIONSHIP_SET + b"".join(record[3] for record in records)
    )
    ordered_records = sorted(records, key=lambda row: row[0])
    chunk_hashes: list[bytes] = []
    if ordered_records:
        for chunk_index, start in enumerate(range(0, len(ordered_records), page_size)):
            rows = ordered_records[start : start + page_size]
            chunk_hashes.append(
                _sha256(
                    DOMAIN_CHUNK
                    + encode_cbor(
                        [chunk_index, rows[0][0], rows[-1][0], [row[2] for row in rows]]
                    )
                )
            )
    expected = encode_cbor(
        [
            1,
            shape_code,
            page_size,
            record_count,
            relationship_count,
            relationship_set_digest,
            root,
            leaf_set_digest,
            chunk_hashes,
        ]
    )
    inputs: dict[str, str] = {
        "page_size_u64be": _u64(page_size).hex(),
        "record_count_u64be": _u64(record_count).hex(),
        "relationship_count_u64be": _u64(relationship_count).hex(),
        "seed": seed.hex(),
        "tombstone_bitmap": _bitmap(tombstones).hex(),
    }
    if shape == "tombstone-live-order":
        inputs["generation_order_u64be"] = b"".join(_u64(value) for value in ordinals).hex()
        inputs["signed_verification_key"] = RFC8032_PUBLIC.hex()
        for name, value in (("false", False), ("true", True)):
            for key, encoded in _signed_boolean_evidence(value).items():
                inputs[f"signed_{name}_{key}"] = encoded
    intermediates = _deduplicate(
        [relationship_set_digest, leaf_set_digest, *leaf_hashes, *tree_hashes, root]
    )
    fixture: dict[str, Any] = {
        "shape": shape,
        "source_document": SOURCE_DOCUMENT,
        "source_section": SOURCE_SECTION,
        "provenance_id": "manifest-v1",
        "generator": {
            "owner": "independent-reference-oracle",
            "source_kind": "committed-file",
            "source_ref": SOURCE_REF,
            "source_sha256": source_sha256,
        },
        "inputs": inputs,
        "expected_cbor_hex": expected.hex(),
        "intermediate_hashes": [value.hex() for value in intermediates],
        "expected_root_hex": root.hex(),
        "review": {"disposition": "ai-non-human-reviewed"},
    }
    fixture["fixture_sha256"] = _canonical_fixture_sha256(fixture)
    return fixture


def _canonical_fixture_sha256(fixture: dict[str, Any]) -> str:
    subject = {key: value for key, value in fixture.items() if key != "fixture_sha256"}
    encoded = json.dumps(
        subject,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return _sha256(encoded).hex()


def generate_corpus() -> dict[str, Any]:
    source_sha256 = _sha256(Path(__file__).read_bytes()).hex()
    fixtures = {
        shape: _build_fixture(
            shape,
            record_count,
            relationship_count,
            page_size,
            tombstone_rule,
            source_sha256,
            shape_code,
        )
        for shape_code, (
            shape,
            record_count,
            relationship_count,
            page_size,
            tombstone_rule,
        ) in enumerate(FIXTURE_SPECS, start=1)
    }
    return {
        "schema_version": 1,
        "corpus_id": "manifest-v1",
        "provenance_contract": "contracts/protocol/vector-provenance-v1.json",
        "canonical_hash_rule": "veyora-vector-json-v1",
        "fixtures": fixtures,
    }


def _canonical_json(corpus: dict[str, Any]) -> bytes:
    return (
        json.dumps(
            corpus,
            allow_nan=False,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _assert_internal_invariants(corpus: dict[str, Any]) -> None:
    if _ed25519_public_key(RFC8032_SEED) != RFC8032_PUBLIC:
        raise AssertionError("RFC 8032 public-key derivation differs")
    empty_signature = bytes.fromhex(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    )
    if _ed25519_sign(RFC8032_SEED, b"") != empty_signature or not _ed25519_verify(
        RFC8032_PUBLIC, b"", empty_signature
    ):
        raise AssertionError("RFC 8032 empty-message signature differs")
    if _sha256(DOMAIN_EMPTY).hex() != "e4115741b843d9acbf403baee350ad9d8268ae04b1dfdd88c6d55b5739b62b3a":
        raise AssertionError("empty-manifest domain root differs")
    fixtures = corpus.get("fixtures")
    expected_shapes = {shape for shape, *_rest in FIXTURE_SPECS}
    if not isinstance(fixtures, dict) or set(fixtures) != expected_shapes:
        raise AssertionError("manifest fixture shape coverage differs")
    for shape, fixture in fixtures.items():
        if fixture.get("fixture_sha256") != _canonical_fixture_sha256(fixture):
            raise AssertionError(f"{shape}: canonical fixture hash differs")
        if len(set(fixture.get("intermediate_hashes", []))) != len(
            fixture.get("intermediate_hashes", [])
        ):
            raise AssertionError(f"{shape}: intermediate hashes are not unique")
    signed_inputs = fixtures["tombstone-live-order"]["inputs"]
    for name, expected_tombstone in (("false", False), ("true", True)):
        body_bytes = bytes.fromhex(signed_inputs[f"signed_{name}_body_cbor"])
        leaf_bytes = bytes.fromhex(signed_inputs[f"signed_{name}_leaf_cbor"])
        envelope_bytes = bytes.fromhex(signed_inputs[f"signed_{name}_envelope"])
        signature = bytes.fromhex(signed_inputs[f"signed_{name}_signature"])
        preimage = bytes.fromhex(signed_inputs[f"signed_{name}_preimage"])
        body, body_end = decode_cbor(body_bytes)
        leaf, leaf_end = decode_cbor(leaf_bytes)
        envelope, envelope_end = decode_cbor(envelope_bytes)
        leaf_hash = _sha256(DOMAIN_LEAF + leaf_bytes)
        if (
            body_end != len(body_bytes)
            or leaf_end != len(leaf_bytes)
            or envelope_end != len(envelope_bytes)
            or encode_cbor(body) != body_bytes
            or encode_cbor(leaf) != leaf_bytes
            or encode_cbor(envelope) != envelope_bytes
            or not isinstance(body, list)
            or len(body) != 21
            or not isinstance(leaf, list)
            or len(leaf) != 5
            or leaf[4] is not expected_tombstone
            or body[9] != leaf_hash
            or body[13] != (0 if expected_tombstone else 1)
            or body[14] != (1 if expected_tombstone else 0)
            or envelope != [body, signature]
            or preimage != DOMAIN_MANIFEST + body_bytes
            or not _ed25519_verify(RFC8032_PUBLIC, preimage, signature)
            or signed_inputs[f"signed_{name}_leaf_sha256"] != leaf_hash.hex()
            or signed_inputs[f"signed_{name}_envelope_sha256"]
            != _sha256(envelope_bytes).hex()
        ):
            raise AssertionError(f"signed manifest {name} evidence differs")


def _write(output: Path, replace: bool) -> None:
    if os.path.lexists(output) and not replace:
        raise FileExistsError(f"output already exists: {output}")
    if os.path.lexists(output):
        output_mode = output.lstat().st_mode
        if stat.S_ISLNK(output_mode) or not stat.S_ISREG(output_mode):
            raise ValueError(f"refusing nonregular output: {output}")
    corpus = generate_corpus()
    _assert_internal_invariants(corpus)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.parent.is_symlink() or not stat.S_ISDIR(output.parent.lstat().st_mode):
        raise ValueError(f"refusing nonregular output directory: {output.parent}")
    temporary: Path | None = None
    descriptor: int | None = None
    identity: tuple[int, int] | None = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        for _attempt in range(32):
            candidate = output.with_name(
                f".{output.name}.{secrets.token_hex(16)}.tmp"
            )
            try:
                descriptor = os.open(candidate, flags, 0o600)
            except FileExistsError:
                continue
            temporary = candidate
            break
        if descriptor is None or temporary is None:
            raise OSError("unable to allocate exclusive manifest temporary file")
        descriptor_stat = os.fstat(descriptor)
        path_stat = temporary.lstat()
        identity = (descriptor_stat.st_dev, descriptor_stat.st_ino)
        if (
            not stat.S_ISREG(descriptor_stat.st_mode)
            or not stat.S_ISREG(path_stat.st_mode)
            or identity != (path_stat.st_dev, path_stat.st_ino)
        ):
            raise OSError("manifest temporary file identity is unsafe")
        remaining = memoryview(_canonical_json(corpus))
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise OSError("manifest temporary write made no progress")
            remaining = remaining[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        final_stat = temporary.lstat()
        if (
            not stat.S_ISREG(final_stat.st_mode)
            or identity != (final_stat.st_dev, final_stat.st_ino)
        ):
            raise OSError("manifest temporary file changed before publication")
        if replace:
            os.replace(temporary, output)
            temporary = None
        else:
            os.link(temporary, output, follow_symlinks=False)
            published_stat = output.lstat()
            if (
                not stat.S_ISREG(published_stat.st_mode)
                or identity != (published_stat.st_dev, published_stat.st_ino)
            ):
                raise OSError("manifest publication inode differs from verified temporary")
            temporary.unlink()
            temporary = None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _check(path: Path) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"input is not a regular file: {path}")
    actual = json.loads(path.read_text(encoding="utf-8"))
    expected = generate_corpus()
    _assert_internal_invariants(expected)
    if actual != expected:
        actual_fixtures = actual.get("fixtures", {}) if isinstance(actual, dict) else {}
        expected_fixtures = expected["fixtures"]
        differing = [
            shape
            for shape in expected_fixtures
            if actual_fixtures.get(shape) != expected_fixtures[shape]
        ]
        suffix = ", ".join(differing) if differing else "corpus envelope"
        raise ValueError(f"manifest corpus differs: {suffix}")
    if path.read_bytes() != _canonical_json(expected):
        raise ValueError("manifest corpus JSON encoding is not canonical")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    generate = subparsers.add_parser("generate", help="write a deterministic corpus")
    generate.add_argument("--output", type=Path, required=True)
    generate.add_argument("--replace", action="store_true")
    check = subparsers.add_parser("check", help="reconstruct and verify a corpus")
    check.add_argument("--input", type=Path, required=True)
    subparsers.add_parser("self-test", help="exercise closed internal invariants")
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "generate":
            _write(arguments.output, arguments.replace)
            print(f"manifest-v1 generated: {arguments.output}")
        elif arguments.command == "check":
            _check(arguments.input)
            print("manifest-v1 oracle check: PASS")
        else:
            corpus = generate_corpus()
            _assert_internal_invariants(corpus)
            print("manifest-v1 oracle self-test: PASS")
    except (AssertionError, FileExistsError, json.JSONDecodeError, OSError, TypeError, ValueError) as error:
        print(f"manifest-v1 oracle: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
