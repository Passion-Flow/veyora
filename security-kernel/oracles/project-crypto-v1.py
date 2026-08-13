#!/usr/bin/env python3
"""Generate Veyora's inert project-cryptography evidence corpus.

This oracle is intentionally outside the Rust product implementation and uses
only the Python standard library.  It recomputes the protocol encodings,
digests, KDF output, recovery form, Ed25519 signatures, and P-256 signature in
this corpus.  Published Argon2id, XChaCha20-Poly1305, and HPKE primitive rows
are transcribed from their exact cited standards because the standard library
does not implement those primitives; they remain separate from Veyora's
project-protocol recomputations.

All bytes are inert public test material.  This program does not assert that a
qualified human reviewed any row.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
from typing import Any


ORACLE_REF = "security-kernel/oracles/project-crypto-v1.py"
CORPUS_ID = "project-crypto-v1"
ADR = "docs/adr/0001-cryptographic-protocol.md"
ARGON_ORACLE_SHA256 = "0f2b3b30fc6876d8418455c8da3f03905a72e49d2061d569970ff829ac2bff58"
ARGON_ORACLE_VERSION = "OpenSSL 3.5.5 27 Jan 2026 (Library: OpenSSL 3.5.5 27 Jan 2026)"

ED_Q = 2**255 - 19
ED_L = 2**252 + 27742317777372353535851937790883648493
ED_D = (-121665 * pow(121666, ED_Q - 2, ED_Q)) % ED_Q
ED_I = pow(2, (ED_Q - 1) // 4, ED_Q)

P256_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
P256_A = P256_P - 3
P256_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
P256_G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)


def sha256(value: bytes) -> bytes:
    return hashlib.sha256(value).digest()


def cbor_head(major: int, value: int) -> bytes:
    if value < 0:
        raise ValueError("negative CBOR length")
    if value < 24:
        return bytes([(major << 5) | value])
    if value <= 0xFF:
        return bytes([(major << 5) | 24, value])
    if value <= 0xFFFF:
        return bytes([(major << 5) | 25]) + value.to_bytes(2, "big")
    if value <= 0xFFFFFFFF:
        return bytes([(major << 5) | 26]) + value.to_bytes(4, "big")
    if value <= 0x7FFFFFFFFFFFFFFF:
        return bytes([(major << 5) | 27]) + value.to_bytes(8, "big")
    raise ValueError("integer outside the Veyora profile")


def cbor(value: Any) -> bytes:
    if type(value) is bool:
        return b"\xf5" if value else b"\xf4"
    if isinstance(value, int):
        return cbor_head(0, value) if value >= 0 else cbor_head(1, -1 - value)
    if isinstance(value, bytes):
        return cbor_head(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return cbor_head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return cbor_head(4, len(value)) + b"".join(cbor(item) for item in value)
    if isinstance(value, dict):
        pairs = sorted(((cbor(key), cbor(item)) for key, item in value.items()), key=lambda pair: (len(pair[0]), pair[0]))
        return cbor_head(5, len(pairs)) + b"".join(key + item for key, item in pairs)
    raise TypeError(f"unsupported CBOR value: {type(value).__name__}")


def preimage(domain: str, body: Any) -> bytes:
    return domain.encode("ascii") + b"\0" + cbor(body)


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> tuple[bytes, bytes]:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    output = bytearray()
    previous = b""
    counter = 1
    while len(output) < length:
        previous = hmac.new(prk, previous + info + bytes([counter]), hashlib.sha256).digest()
        output.extend(previous)
        counter += 1
    return prk, bytes(output[:length])


def ed_xrecover(y: int) -> int:
    xx = (y * y - 1) * pow(ED_D * y * y + 1, ED_Q - 2, ED_Q) % ED_Q
    x = pow(xx, (ED_Q + 3) // 8, ED_Q)
    if (x * x - xx) % ED_Q:
        x = x * ED_I % ED_Q
    if (x * x - xx) % ED_Q:
        raise ValueError("invalid Ed25519 point")
    return ED_Q - x if x & 1 else x


ED_B_Y = 4 * pow(5, ED_Q - 2, ED_Q) % ED_Q
ED_B = (ed_xrecover(ED_B_Y), ED_B_Y)


def ed_add(left: tuple[int, int], right: tuple[int, int]) -> tuple[int, int]:
    x1, y1 = left
    x2, y2 = right
    common = ED_D * x1 * x2 * y1 * y2 % ED_Q
    return (
        (x1 * y2 + x2 * y1) * pow(1 + common, ED_Q - 2, ED_Q) % ED_Q,
        (y1 * y2 + x1 * x2) * pow(1 - common, ED_Q - 2, ED_Q) % ED_Q,
    )


def ed_mul(point: tuple[int, int], scalar: int) -> tuple[int, int]:
    result = (0, 1)
    addend = point
    while scalar:
        if scalar & 1:
            result = ed_add(result, addend)
        addend = ed_add(addend, addend)
        scalar >>= 1
    return result


def ed_encode(point: tuple[int, int]) -> bytes:
    x, y = point
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def ed25519_key(seed: bytes) -> tuple[int, bytes, bytes]:
    digest = hashlib.sha512(seed).digest()
    scalar_bytes = bytearray(digest[:32])
    scalar_bytes[0] &= 248
    scalar_bytes[31] &= 63
    scalar_bytes[31] |= 64
    scalar = int.from_bytes(scalar_bytes, "little")
    return scalar, digest[32:], ed_encode(ed_mul(ED_B, scalar))


def ed25519_sign(seed: bytes, message: bytes) -> tuple[bytes, bytes]:
    scalar, prefix, public = ed25519_key(seed)
    nonce = int.from_bytes(hashlib.sha512(prefix + message).digest(), "little") % ED_L
    encoded_r = ed_encode(ed_mul(ED_B, nonce))
    challenge = int.from_bytes(hashlib.sha512(encoded_r + public + message).digest(), "little") % ED_L
    signature = encoded_r + ((nonce + challenge * scalar) % ED_L).to_bytes(32, "little")
    return public, signature


def p256_add(left: tuple[int, int] | None, right: tuple[int, int] | None) -> tuple[int, int] | None:
    if left is None:
        return right
    if right is None:
        return left
    x1, y1 = left
    x2, y2 = right
    if x1 == x2 and (y1 + y2) % P256_P == 0:
        return None
    if left == right:
        slope = (3 * x1 * x1 + P256_A) * pow(2 * y1, P256_P - 2, P256_P) % P256_P
    else:
        slope = (y2 - y1) * pow((x2 - x1) % P256_P, P256_P - 2, P256_P) % P256_P
    x3 = (slope * slope - x1 - x2) % P256_P
    return x3, (slope * (x1 - x3) - y1) % P256_P


def p256_mul(point: tuple[int, int], scalar: int) -> tuple[int, int] | None:
    result = None
    addend: tuple[int, int] | None = point
    while scalar:
        if scalar & 1:
            result = p256_add(result, addend)
        addend = p256_add(addend, addend)
        scalar >>= 1
    return result


def der_integer(value: int) -> bytes:
    encoded = value.to_bytes((value.bit_length() + 7) // 8 or 1, "big")
    if encoded[0] & 0x80:
        encoded = b"\0" + encoded
    return b"\x02" + bytes([len(encoded)]) + encoded


def p256_sign(private: int, nonce: int, message: bytes) -> tuple[bytes, tuple[int, int]]:
    public = p256_mul(P256_G, private)
    nonce_point = p256_mul(P256_G, nonce)
    if public is None or nonce_point is None:
        raise ValueError("invalid P-256 scalar")
    r = nonce_point[0] % P256_N
    z = int.from_bytes(sha256(message), "big")
    s = pow(nonce, -1, P256_N) * (z + r * private) % P256_N
    s = min(s, P256_N - s)
    encoded_r = der_integer(r)
    encoded_s = der_integer(s)
    return b"\x30" + bytes([len(encoded_r) + len(encoded_s)]) + encoded_r + encoded_s, public


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def openssl_argon2id(
    password: bytes,
    salt: bytes,
    *,
    memory_kib: int = 65536,
    iterations: int = 3,
    lanes: int = 1,
    tag_bytes: int = 32,
    secret: bytes = b"",
    associated_data: bytes = b"",
) -> tuple[bytes, dict[str, str | int]]:
    """Derive Argon2id through a hash-bound OpenSSL 3.5 external oracle."""
    executable_name = shutil.which("openssl")
    if executable_name is None:
        raise RuntimeError("the hash-bound OpenSSL Argon2id oracle is unavailable")
    executable = Path(executable_name).resolve(strict=True)
    version = subprocess.run(
        [str(executable), "version"], check=True, capture_output=True, text=True,
    ).stdout.strip()
    executable_hash = sha256(executable.read_bytes()).hex()
    if executable_hash != ARGON_ORACLE_SHA256 or version != ARGON_ORACLE_VERSION:
        raise RuntimeError("OpenSSL Argon2id oracle identity differs from the frozen evidence tool")
    command = [
        str(executable), "kdf", "-keylen", str(tag_bytes),
        "-kdfopt", f"hexpass:{password.hex()}",
        "-kdfopt", f"hexsalt:{salt.hex()}",
        "-kdfopt", f"iter:{iterations}",
        "-kdfopt", f"lanes:{lanes}",
        "-kdfopt", "threads:1",
        "-kdfopt", f"memcost:{memory_kib}",
        "-kdfopt", "version:19",
    ]
    if secret:
        command.extend(["-kdfopt", f"hexsecret:{secret.hex()}"])
    if associated_data:
        command.extend(["-kdfopt", f"hexad:{associated_data.hex()}"])
    command.append("ARGON2ID")
    completed = subprocess.run(command, check=True, capture_output=True, text=True)
    result = bytes.fromhex(completed.stdout.replace(":", "").strip())
    provenance: dict[str, str | int] = {
        "program": "openssl",
        "resolved_path": str(executable),
        "executable_sha256": executable_hash,
        "version_stdout": version,
        "algorithm": "ARGON2ID",
        "provider_profile": "version=19,threads=1",
    }
    return result, provenance


def rotate_left32(value: int, amount: int) -> int:
    return ((value << amount) & 0xFFFFFFFF) | (value >> (32 - amount))


def quarter_round(state: list[int], a: int, b: int, c: int, d: int) -> None:
    state[a] = (state[a] + state[b]) & 0xFFFFFFFF
    state[d] = rotate_left32(state[d] ^ state[a], 16)
    state[c] = (state[c] + state[d]) & 0xFFFFFFFF
    state[b] = rotate_left32(state[b] ^ state[c], 12)
    state[a] = (state[a] + state[b]) & 0xFFFFFFFF
    state[d] = rotate_left32(state[d] ^ state[a], 8)
    state[c] = (state[c] + state[d]) & 0xFFFFFFFF
    state[b] = rotate_left32(state[b] ^ state[c], 7)


def chacha_rounds(state: list[int]) -> list[int]:
    working = state.copy()
    for _round in range(10):
        quarter_round(working, 0, 4, 8, 12)
        quarter_round(working, 1, 5, 9, 13)
        quarter_round(working, 2, 6, 10, 14)
        quarter_round(working, 3, 7, 11, 15)
        quarter_round(working, 0, 5, 10, 15)
        quarter_round(working, 1, 6, 11, 12)
        quarter_round(working, 2, 7, 8, 13)
        quarter_round(working, 3, 4, 9, 14)
    return working


def chacha_block(key: bytes, counter: int, nonce: bytes) -> bytes:
    if len(key) != 32 or len(nonce) != 12:
        raise ValueError("ChaCha20 key or nonce length differs")
    state = list(struct.unpack("<4I", b"expand 32-byte k"))
    state += list(struct.unpack("<8I", key))
    state += [counter]
    state += list(struct.unpack("<3I", nonce))
    working = chacha_rounds(state)
    return struct.pack("<16I", *((working[index] + state[index]) & 0xFFFFFFFF for index in range(16)))


def hchacha20(key: bytes, nonce16: bytes) -> bytes:
    if len(key) != 32 or len(nonce16) != 16:
        raise ValueError("HChaCha20 key or nonce length differs")
    state = list(struct.unpack("<4I", b"expand 32-byte k"))
    state += list(struct.unpack("<8I", key))
    state += list(struct.unpack("<4I", nonce16))
    working = chacha_rounds(state)
    return struct.pack("<8I", *(working[index] for index in (0, 1, 2, 3, 12, 13, 14, 15)))


def chacha_xor(key: bytes, nonce: bytes, counter: int, value: bytes) -> bytes:
    output = bytearray()
    for offset in range(0, len(value), 64):
        block = chacha_block(key, counter, nonce)
        part = value[offset:offset + 64]
        output.extend(left ^ right for left, right in zip(part, block))
        counter = (counter + 1) & 0xFFFFFFFF
    return bytes(output)


def pad16(value: bytes) -> bytes:
    return b"" if len(value) % 16 == 0 else bytes(16 - len(value) % 16)


def poly1305(key: bytes, message: bytes) -> bytes:
    if len(key) != 32:
        raise ValueError("Poly1305 key length differs")
    r = int.from_bytes(key[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(key[16:], "little")
    accumulator = 0
    modulus = (1 << 130) - 5
    for offset in range(0, len(message), 16):
        block = message[offset:offset + 16]
        accumulator = (accumulator + int.from_bytes(block + b"\x01", "little")) * r % modulus
    return ((accumulator + s) % (1 << 128)).to_bytes(16, "little")


def chacha20poly1305_seal(key: bytes, nonce: bytes, aad: bytes, plaintext: bytes) -> bytes:
    one_time_key = chacha_block(key, 0, nonce)[:32]
    ciphertext = chacha_xor(key, nonce, 1, plaintext)
    mac_input = aad + pad16(aad) + ciphertext + pad16(ciphertext)
    mac_input += len(aad).to_bytes(8, "little") + len(ciphertext).to_bytes(8, "little")
    return ciphertext + poly1305(one_time_key, mac_input)


def xchacha20poly1305_seal(key: bytes, nonce: bytes, aad: bytes, plaintext: bytes) -> bytes:
    if len(nonce) != 24:
        raise ValueError("XChaCha20 nonce length differs")
    subkey = hchacha20(key, nonce[:16])
    return chacha20poly1305_seal(subkey, b"\0\0\0\0" + nonce[16:], aad, plaintext)


def x25519(private: bytes, public: bytes) -> bytes:
    if len(private) != 32 or len(public) != 32:
        raise ValueError("X25519 key length differs")
    scalar = bytearray(private)
    scalar[0] &= 248
    scalar[31] &= 127
    scalar[31] |= 64
    k = int.from_bytes(scalar, "little")
    x1 = int.from_bytes(public, "little") & ((1 << 255) - 1)
    prime = 2**255 - 19
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for bit_index in range(254, -1, -1):
        bit = (k >> bit_index) & 1
        swap ^= bit
        if swap:
            x2, x3 = x3, x2
            z2, z3 = z3, z2
        swap = bit
        a = (x2 + z2) % prime
        aa = a * a % prime
        b = (x2 - z2) % prime
        bb = b * b % prime
        e = (aa - bb) % prime
        c = (x3 + z3) % prime
        d = (x3 - z3) % prime
        da = d * a % prime
        cb = c * b % prime
        x3 = (da + cb) ** 2 % prime
        z3 = x1 * (da - cb) ** 2 % prime
        x2 = aa * bb % prime
        z2 = e * (aa + 121665 * e) % prime
    if swap:
        x2, x3 = x3, x2
        z2, z3 = z3, z2
    return (x2 * pow(z2, prime - 2, prime) % prime).to_bytes(32, "little")


def x25519_public(private: bytes) -> bytes:
    return x25519(private, bytes([9]) + bytes(31))


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    return _hkdf_expand(prk, info, length)


def _hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    output = bytearray()
    previous = b""
    for counter in range(1, (length + 31) // 32 + 1):
        previous = hmac.new(prk, previous + info + bytes([counter]), hashlib.sha256).digest()
        output.extend(previous)
    return bytes(output[:length])


def labeled_extract(suite_id: bytes, salt: bytes, label: str, ikm: bytes) -> bytes:
    return hkdf_extract(salt, b"HPKE-v1" + suite_id + label.encode("ascii") + ikm)


def labeled_expand(suite_id: bytes, prk: bytes, label: str, info: bytes, length: int) -> bytes:
    labeled_info = length.to_bytes(2, "big") + b"HPKE-v1" + suite_id + label.encode("ascii") + info
    return _hkdf_expand(prk, labeled_info, length)


def hpke_base_seal(recipient_public: bytes, sender_private: bytes, info: bytes, aad: bytes, plaintext: bytes) -> tuple[bytes, bytes, dict[str, bytes]]:
    enc = x25519_public(sender_private)
    dh = x25519(sender_private, recipient_public)
    kem_suite = b"KEM" + bytes.fromhex("0020")
    kem_context = enc + recipient_public
    eae_prk = labeled_extract(kem_suite, b"", "eae_prk", dh)
    shared_secret = labeled_expand(kem_suite, eae_prk, "shared_secret", kem_context, 32)
    suite = b"HPKE" + bytes.fromhex("002000010003")
    psk_id_hash = labeled_extract(suite, b"", "psk_id_hash", b"")
    info_hash = labeled_extract(suite, b"", "info_hash", info)
    context = b"\0" + psk_id_hash + info_hash
    secret = labeled_extract(suite, shared_secret, "secret", b"")
    key = labeled_expand(suite, secret, "key", context, 32)
    base_nonce = labeled_expand(suite, secret, "base_nonce", context, 12)
    ciphertext = chacha20poly1305_seal(key, base_nonce, aad, plaintext)
    return enc, ciphertext, {"shared_secret": shared_secret, "key": key, "base_nonce": base_nonce}


def veyora_kdf(label: str, ikm: bytes, context: Any) -> bytes:
    prk = hkdf_extract(bytes(32), ikm)
    return _hkdf_expand(prk, label.encode("ascii") + b"\0" + cbor(context), 32)


def signed_envelope(domain: str, body: Any, seed: bytes) -> bytes:
    _public, signature = ed25519_sign(seed, preimage(domain, body))
    return cbor([body, signature])


def mac_envelope(domain: str, body: Any, key: bytes) -> bytes:
    tag = hmac.new(key, preimage(domain, body), hashlib.sha256).digest()
    return cbor([body, tag])


def hpke_envelope(
    deployment: bytes,
    vault: bytes,
    purpose: int,
    descriptor_hash: bytes,
    authority_kind: int,
    authority_id: bytes,
    revision: int,
    epoch: int,
    operation_id: bytes,
    recipient_public: bytes,
    sender_private: bytes,
    plaintext: bytes,
) -> tuple[bytes, dict[str, bytes]]:
    context = [1, 1, deployment, vault, purpose, descriptor_hash, authority_kind, authority_id, revision, epoch, operation_id]
    info = preimage("pm-v1/hpke-key-envelope", context)
    enc = x25519_public(sender_private)
    aad = preimage("pm-v1/hpke-key-envelope/aad", context + [enc])
    actual_enc, ciphertext, details = hpke_base_seal(recipient_public, sender_private, info, aad, plaintext)
    if actual_enc != enc:
        raise AssertionError("HPKE encapsulated key differs")
    return cbor(context + [enc, ciphertext]), details


def least_record_bucket(length: int) -> int | None:
    if length < 0 or length > 16 * 1024 * 1024:
        return None
    if length <= 1024:
        return 1024
    if length <= 4096:
        return ((length + 1023) // 1024) * 1024
    if length <= 65536:
        return ((length + 4095) // 4096) * 4096
    return 1 << (length - 1).bit_length()


def hostile_matrix(names: list[str]) -> bytes:
    return json_bytes({"expected": "reject", "cases": names})


def build_authentication_context_evidence() -> tuple[dict[str, bytes], dict[str, bytes], dict[str, bytes]]:
    deployment = bytes(range(0x00, 0x10))
    vault = bytes(range(0x10, 0x20))
    server_key_id = bytes(range(0x20, 0x30))
    authority_id = bytes(range(0x30, 0x40))
    native_raw_id = bytes(range(0x40, 0x50))
    web_raw_id = bytes(range(0x40, 0x60))
    transaction_id = bytes(range(0x60, 0x70))
    operation_id = bytes(range(0x70, 0x80))
    prior_root = bytes(range(0x80, 0xA0))
    prior_manifest_hash = bytes(range(0xA0, 0xC0))
    random_challenge = bytes(range(0xC0, 0xE0))
    proposed_hash = bytes([0xD0]) * 32
    specific_hash = bytes([0xD1]) * 32
    server_seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    native_seed = bytes.fromhex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    server_public, _unused = ed25519_sign(server_seed, b"")
    server_hash = sha256(server_public)
    purposes = {
        1: (0, [0], "login"),
        2: (12, [2, 12, proposed_hash, specific_hash], "recovery"),
        3: (2, [2, 2, proposed_hash, specific_hash], "enrollment"),
        4: (10, [2, 10, proposed_hash, specific_hash], "rp-migration"),
        5: (12, [2, 12, proposed_hash, specific_hash], "step-up"),
    }
    inputs = {
        "common_ids": cbor([deployment, vault, server_key_id, authority_id, transaction_id, operation_id]),
        "prior_roots": cbor([7, prior_root, 8, prior_manifest_hash]),
        "proposed_and_specific_hashes": cbor([proposed_hash, specific_hash]),
        "raw_credential_ids": cbor([native_raw_id, web_raw_id]),
        "server_seed": server_seed,
        "native_seed": native_seed,
        "challenge_and_times": cbor([random_challenge, 1700000000, 1700000300]),
        "cross_purpose_negative_matrix": hostile_matrix([
            "method-swap", "purpose-swap", "authority-swap", "deployment-swap",
            "vault-swap", "server-pin-swap", "request-swap", "proposed-state-swap",
            "expired-context", "transaction-replay", "unknown-method-3",
            "native-proof-as-webauthn-challenge", "device-wrap-signing-key",
        ]),
    }
    expected: dict[str, bytes] = {}
    intermediates: dict[str, bytes] = {"server_public_key": server_public, "server_identity_hash": server_hash}
    for method_name, method, authority_kind, raw_id in (
        ("native", 1, 1, native_raw_id),
        ("webauthn", 2, 2, web_raw_id),
    ):
        credential_hash = sha256(preimage("pm-v1/auth-credential-id", [method, authority_kind, authority_id, raw_id]))
        intermediates[f"{method_name}_credential_id_hash"] = credential_hash
        for purpose, (operation_type, payload, suffix) in purposes.items():
            payload_hash = sha256(preimage("pm-v1/authorization-payload", payload))
            request = [
                1, 1, deployment, vault, purpose, operation_type, 7, prior_root,
                8, prior_manifest_hash, operation_id, payload_hash,
            ]
            request_hash = sha256(preimage("pm-v1/authorization-request", request))
            body = [
                1, 1, deployment, vault, 5, server_key_id, method,
                authority_kind, authority_id, credential_hash, purpose,
                request_hash, transaction_id, server_hash, random_challenge,
                1700000000, 1700000300,
            ]
            domain = f"pm-v1/auth/{suffix}"
            envelope = signed_envelope(domain, body, server_seed)
            context_hash = sha256(envelope)
            prefix = f"{method_name}_{purpose}"
            intermediates[f"{prefix}_payload_body"] = cbor(payload)
            intermediates[f"{prefix}_authorization_request"] = cbor(request)
            intermediates[f"{prefix}_request_hash"] = request_hash
            intermediates[f"{prefix}_context_body"] = cbor(body)
            intermediates[f"{prefix}_context_envelope"] = envelope
            intermediates[f"{prefix}_context_hash"] = context_hash
            if method_name == "native":
                proof_domain = f"pm-v1/auth/{suffix}/native-proof"
                _public, proof = ed25519_sign(native_seed, preimage(proof_domain, [context_hash]))
                expected[f"{prefix}_proof_signature"] = proof
            else:
                expected[f"{prefix}_challenge"] = context_hash
    return inputs, expected, intermediates


def build_unlock_evidence() -> tuple[dict[str, bytes], dict[str, bytes], dict[str, bytes]]:
    deployment = bytes(range(0x00, 0x10))
    vault = bytes(range(0x10, 0x20))
    root = bytes([0x22]) * 32
    rows = (
        (1, bytes.fromhex("696e6572742d70617373776f72642d7631"), bytes(range(0x20, 0x30)), bytes(range(0x40, 0x58))),
        (2, bytes.fromhex("65cc812070617373"), bytes(range(0x30, 0x40)), bytes(range(0x58, 0x70))),
        (3, bytes.fromhex("c3a92070617373"), bytes(range(0x70, 0x80)), bytes(range(0x80, 0x98))),
    )
    inputs: dict[str, bytes] = {
        "deployment_id": deployment,
        "vault_id": vault,
        "root": root,
        "portable_profile": cbor([0x13, 32, 16, 65536, 3, 1]),
        "bucket_boundary_schedule": json_bytes([
            [length, least_record_bucket(length)]
            for length in (0, 1, 1023, 1024, 1025, 2047, 2048, 2049, 4095, 4096, 4097, 65535, 65536, 65537, 131071, 131072, 131073, 16777215, 16777216, 16777217)
        ]),
        "negative_matrix": hostile_matrix([
            "wrong-password", "wrong-tag", "decomposed-to-composed-normalization",
            "generation-substitution", "aad-substitution", "old-wrap-replay",
            "interrupted-wrap-state-cas", "idempotent-byte-difference",
            "declared-bucket-mismatch", "ciphertext-length-mismatch",
            "true-length-over-bucket", "embedded-or-duplicated-nonce",
            "wrong-tag-length", "malformed-id-length", "over-16-mib-preallocation",
        ]),
    }
    expected: dict[str, bytes] = {}
    intermediates: dict[str, bytes] = {}
    for generation, password, salt, nonce in rows:
        argon_output, _provenance = openssl_argon2id(password, salt)
        wrap_key = veyora_kdf("pm-v1/unlock-wrap-key", argon_output, [deployment, vault, generation])
        aad_body = [1, 1, deployment, vault, generation, salt, 65536, 3, 1, nonce]
        ciphertext = xchacha20poly1305_seal(wrap_key, nonce, preimage("pm-v1/unlock-wrap", aad_body), root)
        wrap = cbor(aad_body + [ciphertext])
        inputs[f"generation_{generation}_password"] = password
        inputs[f"generation_{generation}_salt_nonce"] = cbor([salt, nonce])
        intermediates[f"generation_{generation}_argon2id_output"] = argon_output
        intermediates[f"generation_{generation}_wrap_key"] = wrap_key
        intermediates[f"generation_{generation}_aad"] = preimage("pm-v1/unlock-wrap", aad_body)
        intermediates[f"generation_{generation}_wrapped_root"] = ciphertext
        expected[f"generation_{generation}_wrap"] = wrap
        expected[f"generation_{generation}_wrap_hash"] = sha256(wrap)
    return inputs, expected, intermediates


def build_bootstrap_evidence() -> tuple[dict[str, bytes], dict[str, bytes], dict[str, bytes]]:
    deployment = bytes(range(0x00, 0x10))
    vault = bytes(range(0x10, 0x20))
    registration_id = bytes(range(0x20, 0x30))
    transaction_id = bytes(range(0x30, 0x40))
    server_key_id = bytes(range(0x40, 0x50))
    receipt_key_id = bytes(range(0x50, 0x60))
    recovery_id = bytes(range(0x60, 0x70))
    device_id = bytes(range(0x70, 0x80))
    enrollment_id = bytes(range(0x80, 0x90))
    operation_id = bytes(range(0x90, 0xA0))
    manifest_key_id = bytes(range(0xA0, 0xB0))
    native_credential_id = bytes(range(0xB0, 0xC0))
    web_credential_id = bytes(range(0xB0, 0xD0))
    web_user_handle = bytes(range(0xD0, 0xF0))
    bootstrap_secret = bytes(range(0xE0, 0x100))
    root = bytes([0x22]) * 32
    recovery_material = bytes([0x33]) * 32
    device_wrap_private = bytes(range(0xA0, 0xC0))
    device_wrap_public = x25519_public(device_wrap_private)
    root_sender_private = bytes(range(0xC0, 0xE0))
    challenge_sender_private = bytes(range(0x00, 0x20))
    wrap_challenge = bytes(range(0xC0, 0xE0))
    recovery_nonce = bytes(range(0xE0, 0xF8))
    password = b"inert-password-v1"
    password_salt = bytes(range(0x20, 0x30))
    password_nonce = bytes(range(0x40, 0x58))
    argon_output, _argon_provenance = openssl_argon2id(password, password_salt)
    server_seed = sha256(b"server-seed")
    receipt_seed = sha256(b"receipt-seed")
    native_seed = bytes.fromhex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    server_public, _unused = ed25519_sign(server_seed, b"")
    receipt_public, _unused = ed25519_sign(receipt_seed, b"")
    native_public, _unused = ed25519_sign(native_seed, b"")
    server_hash = sha256(server_public)
    manifest_seed = veyora_kdf("pm-v1/manifest-signing-seed", root, [deployment, vault, 1, manifest_key_id])
    manifest_public, _unused = ed25519_sign(manifest_seed, b"")
    recovery_seed = veyora_kdf("pm-v1/recovery-auth-seed", recovery_material, [deployment, vault, 1, recovery_id])
    recovery_public, _unused = ed25519_sign(recovery_seed, b"")
    recovery_wrap_key = veyora_kdf("pm-v1/recovery-wrap-key", recovery_material, [deployment, vault, 1, recovery_id])
    bootstrap_key = veyora_kdf("pm-v1/bootstrap-key", bootstrap_secret, [deployment, server_hash])
    descriptor = [1, 0x0020, 0x0001, 0x0003, device_id, device_wrap_public]
    descriptor_hash = sha256(preimage("pm-v1/hpke-recipient", descriptor))
    root_envelope, root_hpke = hpke_envelope(
        deployment, vault, 1, descriptor_hash, 7, registration_id, 0, 1,
        operation_id, device_wrap_public, root_sender_private, root,
    )
    challenge_envelope, challenge_hpke = hpke_envelope(
        deployment, vault, 3, descriptor_hash, 7, registration_id, 0, 1,
        operation_id, device_wrap_public, challenge_sender_private, wrap_challenge,
    )
    root_envelope_hash = sha256(root_envelope)
    challenge_envelope_hash = sha256(challenge_envelope)
    device_wrap_set_root = sha256(preimage("pm-v1/device-wrap-set", [[device_id, 1, root_envelope_hash]]))
    origin = b"https://vault.example.com"
    rp_id = b"example.com"
    psl_hash = bytes.fromhex("343cb40628bfd83d695c84a89fca169d41f531d1ea410dad28e76847dc738d68")
    recovery_aad_body = [
        1, 1, deployment, vault, 1, recovery_id, manifest_key_id,
        manifest_public, 1, 1, 1, server_key_id, server_hash, origin, rp_id,
        psl_hash, receipt_key_id, receipt_public, recovery_nonce,
    ]
    recovery_ciphertext = xchacha20poly1305_seal(
        recovery_wrap_key, recovery_nonce,
        preimage("pm-v1/recovery-wrap", recovery_aad_body), root,
    )
    recovery_core_body = recovery_aad_body + [recovery_ciphertext]
    recovery_core_hash = sha256(preimage("pm-v1/recovery-kit-core", recovery_core_body))
    unlock_key = veyora_kdf("pm-v1/unlock-wrap-key", argon_output, [deployment, vault, 1])
    unlock_aad_body = [1, 1, deployment, vault, 1, password_salt, 65536, 3, 1, password_nonce]
    unlock_ciphertext = xchacha20poly1305_seal(
        unlock_key, password_nonce, preimage("pm-v1/unlock-wrap", unlock_aad_body), root,
    )
    unlock_wrap = cbor(unlock_aad_body + [unlock_ciphertext])
    unlock_wrap_hash = sha256(unlock_wrap)
    record_root = bytes.fromhex("53099280a140e59a2e5f2969d0c7b1949cb0aceda7e3c78982c785b4f5e766a5")
    issued_at, expires_at = 1700000000, 1700000600
    web_server_nonce = bytes(range(0x48, 0x68))

    inputs = {
        "deployment_id": deployment,
        "vault_id": vault,
        "bootstrap_secret": bootstrap_secret,
        "bootstrap_ids": cbor([
            registration_id, transaction_id, server_key_id, receipt_key_id,
            recovery_id, device_id, enrollment_id, operation_id, manifest_key_id,
        ]),
        "public_configuration": cbor([origin, rp_id, psl_hash, record_root, issued_at, expires_at, web_server_nonce]),
        "credential_material": cbor([
            native_credential_id, web_credential_id, web_user_handle,
            P256_G[0].to_bytes(32, "big"), P256_G[1].to_bytes(32, "big"),
        ]),
        "locally_generated_secret_material": cbor([root, recovery_material, device_wrap_private]),
        "local_randomness": cbor([root_sender_private, challenge_sender_private, wrap_challenge, recovery_nonce, password_salt, password_nonce]),
        "direct_password_utf8": password,
        "server_receipt_native_seeds": cbor([server_seed, receipt_seed, native_seed]),
        "bootstrap_state_machine_matrix": json_bytes([
            ["concurrent-first-clients", "one-winner-cas"],
            ["replay-same", "idempotent"], ["replay-different", "reject"],
            ["crash-before-commit", "uninitialized"], ["crash-after-commit", "retirement-required"],
            ["substituted-authority", "reject"], ["unknown-method", "reject-before-allocation"],
            ["recovery-confirmation-failure", "atomic-abort"], ["sixth-failure", "bootstrap-locked"],
            ["mounted-file-after-init", "readiness-fail"],
        ]),
        "hostile_substitution_matrix": hostile_matrix([
            "password", "root", "recovery-material", "recovery-id",
            "manifest-context", "hpke-sender", "hpke-recipient", "hpke-authority",
            "recovery-aad", "web-credential", "web-key", "creation-context-reference",
            "account-final-scalar", "receipt-back-edge", "account-root-in-recovery-aad",
        ]),
    }
    expected: dict[str, bytes] = {}
    intermediates: dict[str, bytes] = {
        "bootstrap_key": bootstrap_key,
        "manifest_seed": manifest_seed,
        "manifest_public_key": manifest_public,
        "recovery_auth_seed": recovery_seed,
        "recovery_public_key": recovery_public,
        "recovery_wrap_key": recovery_wrap_key,
        "device_wrap_public_key": device_wrap_public,
        "recipient_descriptor": cbor(descriptor),
        "recipient_descriptor_hash": descriptor_hash,
        "root_hpke_envelope": root_envelope,
        "root_hpke_shared_secret": root_hpke["shared_secret"],
        "challenge_hpke_envelope": challenge_envelope,
        "challenge_hpke_shared_secret": challenge_hpke["shared_secret"],
        "device_wrap_set_root": device_wrap_set_root,
        "recovery_aad": preimage("pm-v1/recovery-wrap", recovery_aad_body),
        "recovery_ciphertext": recovery_ciphertext,
        "recovery_core_body": cbor(recovery_core_body),
        "recovery_core_hash": recovery_core_hash,
        "unlock_aad": preimage("pm-v1/unlock-wrap", unlock_aad_body),
        "argon2id_output": argon_output,
        "unlock_key": unlock_key,
        "unlock_wrap": unlock_wrap,
        "unlock_wrap_hash": unlock_wrap_hash,
    }

    for branch in ("native", "web"):
        if branch == "native":
            credential = [1, native_credential_id, native_public]
            creation_user_reference = [0]
            context_reference = [0]
        else:
            credential = [
                2, web_credential_id, web_user_handle,
                P256_G[0].to_bytes(32, "big"), P256_G[1].to_bytes(32, "big"),
                0, True, False,
            ]
            creation_user_reference = [1, web_user_handle]
            context_reference = None
        intent_body = [
            1, 1, deployment, vault, 7, registration_id, 0, enrollment_id,
            device_id, creation_user_reference, descriptor_hash,
            root_envelope_hash, challenge_envelope_hash, sha256(wrap_challenge),
            transaction_id, expires_at, operation_id,
        ]
        intent_hash = sha256(preimage("pm-v1/webauthn-creation-intent", intent_body))
        if branch == "native":
            evidence_body = [1, 1, deployment, vault, intent_hash, credential, operation_id]
            evidence = signed_envelope("pm-v1/device-key-possession", evidence_body, native_seed)
        else:
            context_body = [
                1, 1, deployment, vault, 5, server_key_id, server_hash,
                intent_hash, web_server_nonce, issued_at, expires_at,
            ]
            creation_context = signed_envelope("pm-v1/auth/webauthn-create", context_body, server_seed)
            creation_challenge = sha256(creation_context)
            challenge_b64 = base64.urlsafe_b64encode(creation_challenge).rstrip(b"=")
            client_data = (
                b'{"type":"webauthn.create","challenge":"' + challenge_b64
                + b'","origin":"https://vault.example.com","crossOrigin":false}'
            )
            cose_key = {1: 2, 3: -7, -1: 1, -2: P256_G[0].to_bytes(32, "big"), -3: P256_G[1].to_bytes(32, "big")}
            auth_data = sha256(rp_id) + bytes([0x4D]) + bytes(4) + bytes(16)
            auth_data += len(web_credential_id).to_bytes(2, "big") + web_credential_id + cbor(cose_key)
            attestation = cbor({"fmt": "none", "attStmt": {}, "authData": auth_data})
            evidence = cbor([2, web_credential_id, client_data, attestation])
            context_reference = [1, creation_challenge]
            intermediates["web_creation_context_body"] = cbor(context_body)
            intermediates["web_creation_context"] = creation_context
            intermediates["web_creation_challenge"] = creation_challenge
            intermediates["web_client_data_json"] = client_data
            intermediates["web_attestation_object"] = attestation
        entry = [device_id, 1, credential, device_wrap_public, 0x1F, 0, 1]
        entry_hash = sha256(preimage("pm-v1/device-entry-core", entry))
        evidence_hash = sha256(evidence)
        result_body = [
            1, 1, deployment, vault, enrollment_id, intent_hash,
            context_reference, entry_hash, root_envelope_hash,
            challenge_envelope_hash, sha256(wrap_challenge), evidence_hash,
            0, transaction_id, expires_at, operation_id,
        ]
        result_hash = sha256(preimage("pm-v1/device-creation-result", result_body))
        state_core_body = [
            1, 1, deployment, vault, 1, bytes(32), 1, manifest_key_id,
            manifest_public, 1, recovery_id, recovery_public, 1,
            unlock_wrap_hash, 1, [[1, 1], [2, 1], [3, 0]],
            1, 1, 1, 1, 0, server_key_id, server_hash, origin, rp_id,
            psl_hash, receipt_key_id, receipt_public, [entry],
            device_wrap_set_root,
        ]
        state_core_hash = sha256(preimage("pm-v1/account-state-core", state_core_body))
        recovery_confirmation_body = [
            1, 1, deployment, vault, 1, recovery_id, recovery_core_hash,
            state_core_hash, registration_id, transaction_id, expires_at, operation_id,
        ]
        recovery_confirmation = signed_envelope(
            "pm-v1/recovery-confirmation", recovery_confirmation_body, recovery_seed,
        )
        authorization_body = [
            1, 1, deployment, vault, registration_id, transaction_id,
            server_key_id, server_hash, receipt_key_id, receipt_public,
            state_core_hash, recovery_core_hash, sha256(recovery_confirmation),
            intent_hash, result_hash, entry_hash, root_envelope_hash,
            challenge_envelope_hash, evidence_hash, expires_at, operation_id,
        ]
        authorization = mac_envelope(
            "pm-v1/bootstrap-authorization", authorization_body, bootstrap_key,
        )
        authorization_hash = sha256(authorization)
        account_body = state_core_body + [authorization_hash]
        account_envelope = signed_envelope("pm-v1/account-state", account_body, manifest_seed)
        account_root = sha256(account_envelope)
        recovery_body = recovery_core_body[:8] + [1, account_root] + recovery_core_body[8:]
        recovery_envelope = signed_envelope("pm-v1/recovery-kit", recovery_body, recovery_seed)
        manifest_body = [
            1, 1, deployment, vault, 4, manifest_key_id, 1, 1, bytes(32),
            record_root, 1, account_root, 1, 0, 0, 1, 1, 1, 1,
            authorization_hash, operation_id,
        ]
        manifest_envelope = signed_envelope("pm-v1/manifest", manifest_body, manifest_seed)
        receipt_body = [
            1, 1, deployment, vault, registration_id, transaction_id,
            authorization_hash, sha256(account_envelope), account_root,
            sha256(manifest_envelope), sha256(recovery_envelope),
            root_envelope_hash, operation_id, 1,
        ]
        receipt = mac_envelope("pm-v1/bootstrap-receipt", receipt_body, bootstrap_key)
        intermediates.update({
            f"{branch}_creation_intent_body": cbor(intent_body),
            f"{branch}_creation_intent_hash": intent_hash,
            f"{branch}_creation_evidence": evidence,
            f"{branch}_device_entry": cbor(entry),
            f"{branch}_device_entry_core_hash": entry_hash,
            f"{branch}_creation_result_body": cbor(result_body),
            f"{branch}_creation_result_hash": result_hash,
            f"{branch}_account_state_core_body": cbor(state_core_body),
            f"{branch}_account_state_core_hash": state_core_hash,
            f"{branch}_recovery_confirmation_body": cbor(recovery_confirmation_body),
            f"{branch}_recovery_confirmation": recovery_confirmation,
            f"{branch}_bootstrap_authorization_body": cbor(authorization_body),
            f"{branch}_bootstrap_authorization": authorization,
            f"{branch}_account_state_envelope": account_envelope,
            f"{branch}_recovery_kit_envelope": recovery_envelope,
            f"{branch}_manifest_envelope": manifest_envelope,
            f"{branch}_bootstrap_receipt_body": cbor(receipt_body),
            f"{branch}_bootstrap_receipt": receipt,
        })
        expected.update({
            f"{branch}_creation_intent_hash": intent_hash,
            f"{branch}_creation_evidence_hash": evidence_hash,
            f"{branch}_creation_result_hash": result_hash,
            f"{branch}_account_state_core_hash": state_core_hash,
            f"{branch}_recovery_confirmation_hash": sha256(recovery_confirmation),
            f"{branch}_bootstrap_authorization_hash": authorization_hash,
            f"{branch}_account_state_root": account_root,
            f"{branch}_recovery_kit_hash": sha256(recovery_envelope),
            f"{branch}_manifest_hash": sha256(manifest_envelope),
            f"{branch}_bootstrap_receipt_hash": sha256(receipt),
        })
    return inputs, expected, intermediates


def build_later_enrollment_evidence() -> tuple[dict[str, bytes], dict[str, bytes], dict[str, bytes]]:
    deployment = bytes(range(0x00, 0x10))
    vault = bytes(range(0x10, 0x20))
    enrollment_id = bytes([0x12]) * 16
    new_device_id = bytes([0x23]) * 16
    transaction_id = bytes([0x34]) * 16
    operation_id = bytes([0x45]) * 16
    credential_id = bytes(range(0x56, 0x76))
    user_handle = bytes(range(0x76, 0x96))
    server_nonce = bytes(range(0x96, 0xB6))
    signed_context_challenge = bytes(range(0xB6, 0xD6))
    wrap_challenge = bytes(range(0xD6, 0xF6))
    new_wrap_private = bytes(range(0x01, 0x21))
    new_wrap_public = x25519_public(new_wrap_private)
    root_sender_private = bytes(range(0x21, 0x41))
    challenge_sender_private = bytes(range(0x41, 0x61))
    root = bytes([0x22]) * 32
    anchor_id = bytes(range(0x80, 0x90))
    anchor_credential_id = bytes(range(0x90, 0xA0))
    anchor_seed = bytes.fromhex("1c086cc46e9a006d35edd371853a393960ac059c92ccbf18c7d290af5d6e8a17")
    anchor_public, _unused = ed25519_sign(anchor_seed, b"")
    anchor_wrap_public = bytes.fromhex("605a725d2a4adfeeb1a29e17edd621c1b7593ee8cdbc44ac6c4ab6e2f805d23c")
    manifest_key_id = bytes(range(0x70, 0x80))
    manifest_seed = bytes.fromhex("bd12edc46d58fa501fff3601550aebb7c8e98dc30bc4272e86f88d41fe9ca607")
    manifest_public, _unused = ed25519_sign(manifest_seed, b"")
    server_key_id = bytes(range(0xB0, 0xC0))
    server_seed = bytes.fromhex("c95c2369e9cb071a8771a333ae0bf63ccc4f6455dcdbf6a7ebc5400f51b48ea0")
    server_public, _unused = ed25519_sign(server_seed, b"")
    server_hash = sha256(server_public)
    descriptor = [1, 0x0020, 0x0001, 0x0003, new_device_id, new_wrap_public]
    descriptor_hash = sha256(preimage("pm-v1/hpke-recipient", descriptor))
    root_envelope, root_hpke = hpke_envelope(
        deployment, vault, 1, descriptor_hash, 1, anchor_id, 8, 2,
        operation_id, new_wrap_public, root_sender_private, root,
    )
    challenge_envelope, challenge_hpke = hpke_envelope(
        deployment, vault, 3, descriptor_hash, 1, anchor_id, 8, 2,
        operation_id, new_wrap_public, challenge_sender_private, wrap_challenge,
    )
    root_envelope_hash = sha256(root_envelope)
    challenge_envelope_hash = sha256(challenge_envelope)
    creation_user_reference = [1, user_handle]
    intent_body = [
        1, 1, deployment, vault, 1, anchor_id, 8, enrollment_id,
        new_device_id, creation_user_reference, descriptor_hash,
        root_envelope_hash, challenge_envelope_hash, sha256(wrap_challenge),
        transaction_id, 1700000900, operation_id,
    ]
    intent_hash = sha256(preimage("pm-v1/webauthn-creation-intent", intent_body))
    creation_context_body = [
        1, 1, deployment, vault, 5, server_key_id, server_hash, intent_hash,
        server_nonce, 1700000600, 1700000900,
    ]
    creation_context = signed_envelope("pm-v1/auth/webauthn-create", creation_context_body, server_seed)
    creation_challenge = sha256(creation_context)
    challenge_b64 = base64.urlsafe_b64encode(creation_challenge).rstrip(b"=")
    client_data = (
        b'{"type":"webauthn.create","challenge":"' + challenge_b64
        + b'","origin":"https://vault.example.com","crossOrigin":false}'
    )
    cose_key = {1: 2, 3: -7, -1: 1, -2: P256_G[0].to_bytes(32, "big"), -3: P256_G[1].to_bytes(32, "big")}
    auth_data = sha256(b"example.com") + bytes([0x4D]) + bytes(4) + bytes(16)
    auth_data += len(credential_id).to_bytes(2, "big") + credential_id + cbor(cose_key)
    attestation = cbor({"fmt": "none", "attStmt": {}, "authData": auth_data})
    evidence = cbor([2, credential_id, client_data, attestation])
    evidence_hash = sha256(evidence)
    credential = [
        2, credential_id, user_handle, P256_G[0].to_bytes(32, "big"),
        P256_G[1].to_bytes(32, "big"), 0, True, False,
    ]
    new_entry = [new_device_id, 1, credential, new_wrap_public, 0x01, 0, 9]
    entry_hash = sha256(preimage("pm-v1/device-entry-core", new_entry))
    creation_result_body = [
        1, 1, deployment, vault, enrollment_id, intent_hash,
        [1, creation_challenge], entry_hash, root_envelope_hash,
        challenge_envelope_hash, sha256(wrap_challenge), evidence_hash,
        8, transaction_id, 1700000900, operation_id,
    ]
    creation_result_hash = sha256(preimage("pm-v1/device-creation-result", creation_result_body))

    prior_root = bytes.fromhex("ae94b9121bb6f23e4dc206c3622193410ad167c7095371838ad32563dfa2392d")
    recovery_id = bytes([0x03]) * 16
    recovery_public = bytes.fromhex("32deb3f8521909a7f78cc6d600437e36794695a9334d1cb375083047f8782bc0")
    unlock_hash = bytes.fromhex("8912ee8f24d0a7225405d270e542bc3c96c2fe316084e68354579004e5924a1f")
    psl_hash = bytes.fromhex("2b6f5a9231a44949f78cb4e3a6f60ef28207f229907cff2580d1e7ec58eb4299")
    receipt_id = bytes(range(0xF0, 0x100))
    receipt_public = bytes.fromhex("338b89545199bf5b517f6e06576e53489a826e1629bc8b3d38f9f7927ac67cc6")
    anchor_entry = [
        anchor_id, 1, [1, anchor_credential_id, anchor_public], anchor_wrap_public,
        0x1F, 0, 8,
    ]
    prior_device_wrap_root = bytes.fromhex("6f30fba3bc0b598a85eb77bc177bb37f5cf36e56757825d733b85aeccab71b61")
    prepare_authorization_hash = bytes.fromhex("7427163595ebb0c9e6d6991bfc32280c79fda41e20ef32e83d703a16b1c474cc")
    prior_account_body = [
        1, 1, deployment, vault, 8, prior_root, 2, manifest_key_id,
        manifest_public, 2, recovery_id, recovery_public, 2, unlock_hash, 1,
        [[1, 1], [2, 1], [3, 0]], 1, 1, 1, 1, 0, server_key_id,
        server_hash, b"https://vault.example.com", b"example.com", psl_hash,
        receipt_id, receipt_public, [anchor_entry], prior_device_wrap_root,
        prepare_authorization_hash,
    ]
    prior_account = signed_envelope("pm-v1/account-state", prior_account_body, manifest_seed)
    prior_account_root = sha256(prior_account)
    prior_manifest_body = [
        1, 1, deployment, vault, 4, manifest_key_id, 8, 12,
        bytes.fromhex("a0248ddb4332112064de68a3ceb8ddd1caae3eaa09fa00defd785dc93d497b58"),
        bytes.fromhex("794ee8f91a85c6c837eb9fd459adc470783adb405d3f79513d800f6681d0d4f8"),
        8, prior_account_root, 2, 1, 0, 1, 1, 1, 1,
        prepare_authorization_hash, bytes(range(0x30, 0x40)),
    ]
    prior_manifest = signed_envelope("pm-v1/manifest", prior_manifest_body, manifest_seed)
    prior_manifest_hash = sha256(prior_manifest)
    device_wrap_set_root = sha256(preimage("pm-v1/device-wrap-set", [
        [new_device_id, 2, root_envelope_hash],
        [anchor_id, 2, bytes.fromhex("9921ed43c8eb8b13508d7974908cc1ba274f4073189ce04e439277d289b86a76")],
    ]))
    proposed_core = prior_account_body[:-3] + [[new_entry, anchor_entry], device_wrap_set_root]
    proposed_core[4] = 9
    proposed_core[5] = prior_account_root
    proposed_core_hash = sha256(preimage("pm-v1/account-state-core", proposed_core))
    enrollment_body = [
        1, 1, deployment, vault, 8, enrollment_id, intent_hash,
        creation_result_hash, entry_hash, root_envelope_hash,
        challenge_envelope_hash, evidence_hash, 1700000900,
        proposed_core_hash, operation_id,
    ]
    enrollment_body_hash = sha256(preimage("pm-v1/device-enrollment", enrollment_body))
    authorization_payload = [2, 2, proposed_core_hash, enrollment_body_hash]
    payload_hash = sha256(preimage("pm-v1/authorization-payload", authorization_payload))
    authorization_request = [
        1, 1, deployment, vault, 3, 2, 8, prior_account_root, 12,
        prior_manifest_hash, operation_id, payload_hash,
    ]
    request_hash = sha256(preimage("pm-v1/authorization-request", authorization_request))
    credential_hash = sha256(preimage("pm-v1/auth-credential-id", [1, 1, anchor_id, anchor_credential_id]))
    signed_context_body = [
        1, 1, deployment, vault, 5, server_key_id, 1, 1, anchor_id,
        credential_hash, 3, request_hash, transaction_id, server_hash,
        signed_context_challenge, 1700000600, 1700000900,
    ]
    signed_context = signed_envelope("pm-v1/auth/enrollment", signed_context_body, server_seed)
    signed_context_hash = sha256(signed_context)
    _public, native_proof = ed25519_sign(
        anchor_seed,
        preimage("pm-v1/auth/enrollment/native-proof", [signed_context_hash]),
    )
    operation_authorization_body = [
        1, 1, deployment, vault, 1, anchor_id, 8, request_hash,
        signed_context_hash, operation_id,
    ]
    operation_authorization = signed_envelope(
        "pm-v1/operation-authorization", operation_authorization_body, anchor_seed,
    )
    tagged_authorization = cbor([1, operation_authorization])
    tagged_authorization_hash = sha256(tagged_authorization)
    next_account_body = proposed_core + [tagged_authorization_hash]
    next_account = signed_envelope("pm-v1/account-state", next_account_body, manifest_seed)
    next_account_root = sha256(next_account)
    next_manifest_body = [
        1, 1, deployment, vault, 4, manifest_key_id, 8, 13,
        prior_manifest_hash,
        bytes.fromhex("794ee8f91a85c6c837eb9fd459adc470783adb405d3f79513d800f6681d0d4f8"),
        9, next_account_root, 2, 1, 0, 1, 1, 1, 1,
        tagged_authorization_hash, operation_id,
    ]
    next_manifest = signed_envelope("pm-v1/manifest", next_manifest_body, manifest_seed)

    inputs = {
        "prior_a8_account_envelope": prior_account,
        "prior_m12_manifest_envelope": prior_manifest,
        "enrollment_ids": cbor([enrollment_id, new_device_id, transaction_id, operation_id]),
        "returned_credential": cbor([credential_id, user_handle, P256_G[0].to_bytes(32, "big"), P256_G[1].to_bytes(32, "big")]),
        "new_wrap_private_key": new_wrap_private,
        "locally_generated_root": root,
        "hpke_sender_private_keys": cbor([root_sender_private, challenge_sender_private]),
        "creation_and_wrap_challenges": cbor([server_nonce, signed_context_challenge, wrap_challenge]),
        "creation_times": cbor([1700000600, 1700000900]),
        "prior_anchor_root_envelope_hash": bytes.fromhex("9921ed43c8eb8b13508d7974908cc1ba274f4073189ce04e439277d289b86a76"),
        "prior_anchor_seed": anchor_seed,
        "manifest_and_server_seeds": cbor([manifest_seed, server_seed]),
        "hostile_negative_matrix": hostile_matrix([
            "signer-wrapper-split", "credential-id", "credential-key", "attestation",
            "device-entry", "root-envelope", "challenge-envelope", "wrap-challenge",
            "transaction", "context", "result", "enrollment-body", "stale-authority",
            "proposed-core", "wrap-root", "wrong-prior-device-key",
            "new-web-credential-self-authorization",
        ]),
    }
    expected = {
        "creation_evidence_hash": evidence_hash,
        "next_account_root": next_account_root,
        "next_manifest_hash": sha256(next_manifest),
        "tagged_native_authorization_hash": tagged_authorization_hash,
    }
    intermediates = {
        "recipient_descriptor": cbor(descriptor),
        "recipient_descriptor_hash": descriptor_hash,
        "root_hpke_envelope": root_envelope,
        "root_hpke_shared_secret": root_hpke["shared_secret"],
        "challenge_hpke_envelope": challenge_envelope,
        "challenge_hpke_shared_secret": challenge_hpke["shared_secret"],
        "creation_intent_body": cbor(intent_body),
        "creation_intent_hash": intent_hash,
        "creation_context_body": cbor(creation_context_body),
        "creation_context": creation_context,
        "creation_challenge": creation_challenge,
        "client_data_json": client_data,
        "attestation_object": attestation,
        "creation_evidence": evidence,
        "new_device_entry": cbor(new_entry),
        "new_device_entry_core_hash": entry_hash,
        "creation_result_body": cbor(creation_result_body),
        "creation_result_hash": creation_result_hash,
        "device_wrap_set_root": device_wrap_set_root,
        "proposed_account_core": cbor(proposed_core),
        "proposed_account_core_hash": proposed_core_hash,
        "enrollment_body": cbor(enrollment_body),
        "enrollment_body_hash": enrollment_body_hash,
        "authorization_payload": cbor(authorization_payload),
        "authorization_request": cbor(authorization_request),
        "authorization_request_hash": request_hash,
        "signed_enrollment_context_body": cbor(signed_context_body),
        "signed_enrollment_context": signed_context,
        "native_enrollment_proof": native_proof,
        "operation_authorization_body": cbor(operation_authorization_body),
        "operation_authorization": operation_authorization,
        "tagged_native_authorization": tagged_authorization,
        "next_account_envelope": next_account,
        "next_manifest_envelope": next_manifest,
    }
    return inputs, expected, intermediates


def build_root_rotation_evidence() -> tuple[dict[str, bytes], dict[str, bytes], dict[str, bytes]]:
    deployment = bytes(range(0x00, 0x10))
    vault = bytes(range(0x10, 0x20))
    rotation_id = bytes(range(0x20, 0x30))
    prepare_id = bytes(range(0x30, 0x40))
    finalize_id = bytes(range(0x40, 0x50))
    commit_id = bytes(range(0x50, 0x60))
    old_manifest_id = bytes(range(0x60, 0x70))
    new_manifest_id = bytes(range(0x70, 0x80))
    anchor_id = bytes(range(0x80, 0x90))
    credential_id = bytes(range(0x90, 0xA0))
    checkpoint_id = bytes(range(0xA0, 0xB0))
    server_id = bytes(range(0xB0, 0xC0))
    prepare_transaction = bytes(range(0xC0, 0xD0))
    commit_transaction = bytes(range(0xD0, 0xE0))
    prior_recovery_id = bytes(range(0xE0, 0xF0))
    receipt_id = bytes(range(0xF0, 0x100))
    old_manifest_seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    anchor_seed = bytes.fromhex("1c086cc46e9a006d35edd371853a393960ac059c92ccbf18c7d290af5d6e8a17")
    prior_recovery_seed = bytes.fromhex("6fc3b48c1cb24f82c082430c6ab339fc501433877b74af8b4efed9e0545fbc28")
    server_seed = bytes.fromhex("c95c2369e9cb071a8771a333ae0bf63ccc4f6455dcdbf6a7ebc5400f51b48ea0")
    old_manifest_public, _unused = ed25519_sign(old_manifest_seed, b"")
    anchor_public, _unused = ed25519_sign(anchor_seed, b"")
    prior_recovery_public, _unused = ed25519_sign(prior_recovery_seed, b"")
    server_public, _unused = ed25519_sign(server_seed, b"")
    server_hash = sha256(server_public)
    origin = b"https://vault.example.com"
    rp_id = b"example.com"
    psl_hash = bytes.fromhex("2b6f5a9231a44949f78cb4e3a6f60ef28207f229907cff2580d1e7ec58eb4299")
    receipt_public = bytes.fromhex("338b89545199bf5b517f6e06576e53489a826e1629bc8b3d38f9f7927ac67cc6")
    prior_wrap_public = bytes.fromhex("6bb51d5ba7e18a25c8395b5bd889b299265d2f777e1d1ae1b8d96154a1d6861c")
    prior_device_wrap_root = bytes.fromhex("65443a40c6cb52d66db9b5bf676106a9709d677c1faa6dcf1ca49067e371b4c4")
    prior_transition = bytes.fromhex("0c3afc60d67c75073d1b3f4464e0de699526667dd95195266ef5ad103a259dd9")
    prior_account_body = [
        1, 1, deployment, vault, 7,
        bytes.fromhex("aca4dd9f2e75078ca231a0262b042e0935c5d4e75d3c902de5cbe00fda2589fb"),
        1, old_manifest_id, old_manifest_public, 1, prior_recovery_id,
        prior_recovery_public, 1,
        bytes.fromhex("b2233e77a668d93cbd75ff73403af73dc500f764616e5af4f44a9b89370af129"),
        1, [[1, 1], [2, 1], [3, 0]], 1, 1, 1, 1, 0, server_id,
        server_hash, origin, rp_id, psl_hash, receipt_id, receipt_public,
        [[anchor_id, 1, [1, credential_id, anchor_public], prior_wrap_public, 0x1F, 0, 1]],
        prior_device_wrap_root, prior_transition,
    ]
    prior_account = signed_envelope("pm-v1/account-state", prior_account_body, old_manifest_seed)
    prior_account_root = sha256(prior_account)
    prior_record_root = bytes.fromhex("355dadc10b9a4b1b37f1472d48e74322cb08fa047d30d34510ec56faa6f47e10")
    prior_manifest_body = [
        1, 1, deployment, vault, 4, old_manifest_id, 7, 11,
        bytes.fromhex("741280b8b32ad4c2d6f3f5af4d0649ef5170d8d0792e61ef777d5112e6084884"),
        prior_record_root, 7, prior_account_root, 1, 1, 0, 1, 1, 1, 1,
        prior_transition, bytes(range(0x01, 0x11)),
    ]
    prior_manifest = signed_envelope("pm-v1/manifest", prior_manifest_body, old_manifest_seed)
    prior_manifest_hash = sha256(prior_manifest)
    checkpoint_body = [
        1, 1, deployment, vault, 4, old_manifest_id, 7, checkpoint_id, 11,
        prior_manifest_hash, 7, prior_account_root, 1, 1, 1, 0, 1700000000,
    ]
    checkpoint = signed_envelope("pm-v1/trusted-checkpoint", checkpoint_body, old_manifest_seed)
    checkpoint_hash = sha256(checkpoint)

    new_root = bytes([0x22]) * 32
    new_manifest_seed = veyora_kdf("pm-v1/manifest-signing-seed", new_root, [deployment, vault, 2, new_manifest_id])
    new_manifest_public, _unused = ed25519_sign(new_manifest_seed, b"")
    recovery_material = bytes([0x33]) * 32
    recovery_id = bytes([0x03]) * 16
    recovery_seed = veyora_kdf("pm-v1/recovery-auth-seed", recovery_material, [deployment, vault, 2, recovery_id])
    recovery_public, _unused = ed25519_sign(recovery_seed, b"")
    recovery_wrap_key = veyora_kdf("pm-v1/recovery-wrap-key", recovery_material, [deployment, vault, 2, recovery_id])
    recovery_nonce = bytes(range(0x20, 0x38))
    recovery_aad_body = [
        1, 1, deployment, vault, 2, recovery_id, new_manifest_id,
        new_manifest_public, 2, 1, 1, server_id, server_hash, origin, rp_id,
        psl_hash, receipt_id, receipt_public, recovery_nonce,
    ]
    recovery_ciphertext = xchacha20poly1305_seal(
        recovery_wrap_key, recovery_nonce,
        preimage("pm-v1/recovery-wrap", recovery_aad_body), new_root,
    )
    recovery_core_body = recovery_aad_body + [recovery_ciphertext]
    recovery_core_hash = sha256(preimage("pm-v1/recovery-kit-core", recovery_core_body))
    replacement_password = b"round-four-new-password"
    password_salt = bytes(range(0x40, 0x50))
    password_nonce = bytes(range(0x50, 0x68))
    argon_output, _argon_provenance = openssl_argon2id(replacement_password, password_salt)
    unlock_key = veyora_kdf("pm-v1/unlock-wrap-key", argon_output, [deployment, vault, 2])
    unlock_aad_body = [1, 1, deployment, vault, 2, password_salt, 65536, 3, 1, password_nonce]
    unlock_ciphertext = xchacha20poly1305_seal(
        unlock_key, password_nonce, preimage("pm-v1/unlock-wrap", unlock_aad_body), new_root,
    )
    unlock_wrap = cbor(unlock_aad_body + [unlock_ciphertext])
    unlock_hash = sha256(unlock_wrap)
    successor_wrap_private = bytes(range(0xA0, 0xC0))
    successor_wrap_public = x25519_public(successor_wrap_private)
    descriptor = [1, 0x0020, 0x0001, 0x0003, anchor_id, successor_wrap_public]
    descriptor_hash = sha256(preimage("pm-v1/hpke-recipient", descriptor))
    root_sender_private = bytes(range(0xC0, 0xE0))
    challenge_sender_private = bytes(range(0xE0, 0x100))
    wrap_challenge = bytes(range(0x68, 0x88))
    root_envelope, root_hpke = hpke_envelope(
        deployment, vault, 1, descriptor_hash, 1, anchor_id, 7, 2,
        prepare_id, successor_wrap_public, root_sender_private, new_root,
    )
    challenge_envelope, challenge_hpke = hpke_envelope(
        deployment, vault, 3, descriptor_hash, 1, anchor_id, 7, 2,
        prepare_id, successor_wrap_public, challenge_sender_private, wrap_challenge,
    )
    root_envelope_hash = sha256(root_envelope)
    challenge_envelope_hash = sha256(challenge_envelope)
    root_commitment = sha256(preimage("pm-v1/root-commitment", [deployment, vault, 2, new_root]))
    device_wrap_set_root = sha256(preimage("pm-v1/device-wrap-set", [[anchor_id, 2, root_envelope_hash]]))
    backup_rows = [[bytes([0x01]) * 16, bytes([0x02]) * 16, bytes.fromhex("a6d70c6026a547f939e37aa5ec26d9873f191c7a6dfe5ebdce9536c9df064315")]]
    backup_root = sha256(preimage("pm-v1/backup-dependencies", backup_rows))
    final_entry = [anchor_id, 1, [1, credential_id, anchor_public], successor_wrap_public, 0x1F, 0, 8]
    final_account_core = [
        1, 1, deployment, vault, 8, prior_account_root, 2, new_manifest_id,
        new_manifest_public, 2, recovery_id, recovery_public, 2, unlock_hash, 1,
        [[1, 1], [2, 1], [3, 0]], 1, 1, 1, 1, 0, server_id, server_hash,
        origin, rp_id, psl_hash, receipt_id, receipt_public, [final_entry],
        device_wrap_set_root,
    ]
    final_account_core_hash = sha256(preimage("pm-v1/account-state-core", final_account_core))
    provenance_body = [
        1, 1, deployment, vault, 1, rotation_id, checkpoint_hash, 7,
        anchor_id, 2, root_commitment, new_manifest_id, new_manifest_public,
        recovery_core_hash, unlock_hash, device_wrap_set_root, prepare_id,
    ]
    provenance = signed_envelope(
        "pm-v1/root-rotation/clean-anchor-generated-root", provenance_body, anchor_seed,
    )
    provenance_hash = sha256(provenance)
    possession_body = [
        1, 1, deployment, vault, rotation_id, checkpoint_hash, 7, anchor_id,
        2, root_commitment, device_wrap_set_root, provenance_hash,
        sha256(wrap_challenge), challenge_envelope_hash, root_envelope_hash,
        prepare_id,
    ]
    possession = signed_envelope(
        "pm-v1/root-rotation/device-possession", possession_body, anchor_seed,
    )
    possession_root = sha256(preimage("pm-v1/root-rotation/possession-set", [[
        anchor_id, 2, root_envelope_hash, challenge_envelope_hash, sha256(possession),
    ]]))
    prepare_body = [
        1, 1, deployment, vault, rotation_id, prepare_id, finalize_id, commit_id,
        old_manifest_id, 7, prior_account_root, 1, 2, 11, prior_manifest_hash,
        root_commitment, new_manifest_id, new_manifest_public, checkpoint_hash,
        anchor_id, device_wrap_set_root, provenance_hash, possession_root,
        recovery_core_hash, backup_root, final_account_core_hash,
    ]
    signed_prepare = signed_envelope("pm-v1/root-rotation/prepare", prepare_body, old_manifest_seed)

    def authorize(operation_id: bytes, transaction_id: bytes, challenge: bytes, specific_hash: bytes) -> tuple[bytes, dict[str, bytes]]:
        payload = [2, 12, final_account_core_hash, specific_hash]
        payload_hash = sha256(preimage("pm-v1/authorization-payload", payload))
        request = [
            1, 1, deployment, vault, 5, 12, 7, prior_account_root, 11,
            prior_manifest_hash, operation_id, payload_hash,
        ]
        request_hash = sha256(preimage("pm-v1/authorization-request", request))
        credential_hash = sha256(preimage("pm-v1/auth-credential-id", [1, 1, anchor_id, credential_id]))
        context_body = [
            1, 1, deployment, vault, 5, server_id, 1, 1, anchor_id,
            credential_hash, 5, request_hash, transaction_id, server_hash,
            challenge, 1700000000, 1700000300,
        ]
        context = signed_envelope("pm-v1/auth/step-up", context_body, server_seed)
        context_hash = sha256(context)
        _public, proof = ed25519_sign(
            anchor_seed, preimage("pm-v1/auth/step-up/native-proof", [context_hash]),
        )
        authorization_body = [
            1, 1, deployment, vault, 1, anchor_id, 7, request_hash,
            context_hash, operation_id,
        ]
        authorization = signed_envelope(
            "pm-v1/operation-authorization", authorization_body, anchor_seed,
        )
        tagged = cbor([1, authorization])
        return tagged, {
            "payload": cbor(payload), "payload_hash": payload_hash,
            "request": cbor(request), "request_hash": request_hash,
            "context_body": cbor(context_body), "context": context,
            "context_hash": context_hash, "native_proof": proof,
            "authorization_body": cbor(authorization_body),
            "authorization": authorization,
        }

    prepare_tagged, prepare_auth = authorize(
        prepare_id, prepare_transaction, bytes(range(0x58, 0x78)), sha256(signed_prepare),
    )
    prepare_authorization_hash = sha256(prepare_tagged)
    final_account_body = final_account_core + [prepare_authorization_hash]
    final_account = signed_envelope("pm-v1/account-state", final_account_body, new_manifest_seed)
    final_account_root = sha256(final_account)
    final_recovery_body = recovery_core_body[:8] + [8, final_account_root] + recovery_core_body[8:]
    final_recovery = signed_envelope("pm-v1/recovery-kit", final_recovery_body, recovery_seed)
    final_record_root = bytes.fromhex("794ee8f91a85c6c837eb9fd459adc470783adb405d3f79513d800f6681d0d4f8")
    final_manifest_body = [
        1, 1, deployment, vault, 4, new_manifest_id, 8, 12,
        prior_manifest_hash, final_record_root, 8, final_account_root, 2, 1, 0,
        1, 1, 1, 1, prepare_authorization_hash, prepare_id,
    ]
    final_manifest = signed_envelope("pm-v1/manifest", final_manifest_body, new_manifest_seed)
    finalize_body = [
        1, 1, deployment, vault, rotation_id, prepare_id, finalize_id, commit_id,
        sha256(signed_prepare), prepare_authorization_hash,
        final_account_core_hash, sha256(final_account), final_account_root,
        sha256(final_recovery), sha256(final_manifest), final_record_root,
        device_wrap_set_root, provenance_hash, possession_root, backup_root,
    ]
    signed_finalize = signed_envelope("pm-v1/root-rotation/finalize", finalize_body, new_manifest_seed)
    commit_body = [
        1, 1, deployment, vault, rotation_id, prepare_id, finalize_id, commit_id,
        old_manifest_id, new_manifest_id, 7, prior_account_root, 11,
        prior_manifest_hash, sha256(signed_prepare), prepare_authorization_hash,
        sha256(signed_finalize), sha256(final_account), final_account_root,
        sha256(final_recovery), sha256(final_manifest), final_record_root,
        device_wrap_set_root, provenance_hash, possession_root, backup_root,
        checkpoint_hash, anchor_id,
    ]
    old_signed_commit = signed_envelope("pm-v1/root-rotation/commit", commit_body, old_manifest_seed)
    new_commit_body = [
        1, 1, deployment, vault, rotation_id, new_manifest_id,
        sha256(old_signed_commit), commit_id,
    ]
    new_cross_signature = signed_envelope(
        "pm-v1/root-rotation/new-commit", new_commit_body, new_manifest_seed,
    )
    commit_core_hash = sha256(preimage("pm-v1/root-rotation/commit-core", commit_body))
    commit_tagged, commit_auth = authorize(
        commit_id, commit_transaction, bytes(range(0x78, 0x98)), commit_core_hash,
    )
    commit_authorization_hash = sha256(commit_tagged)
    commit_bundle = cbor([provenance, [possession], old_signed_commit, new_cross_signature, commit_tagged])
    commit_bundle_hash = sha256(commit_bundle)

    inputs = {
        "prior_account_envelope": prior_account,
        "prior_manifest_envelope": prior_manifest,
        "anchor_checkpoint_envelope": checkpoint,
        "phase_ids": cbor([rotation_id, prepare_id, finalize_id, commit_id]),
        "successor_manifest_key_id": new_manifest_id,
        "final_record_root": final_record_root,
        "authorization_randomness": cbor([
            prepare_transaction, commit_transaction,
            bytes(range(0x58, 0x78)), bytes(range(0x78, 0x98)),
        ]),
        "authority_seeds": cbor([old_manifest_seed, anchor_seed, prior_recovery_seed, server_seed]),
        "locally_generated_material": cbor([new_root, recovery_material, recovery_id, successor_wrap_private]),
        "direct_password_utf8": replacement_password,
        "local_randomness": cbor([recovery_nonce, password_salt, password_nonce, root_sender_private, challenge_sender_private, wrap_challenge]),
        "retained_backup_rows": cbor(backup_rows),
        "phase_state_machine": json_bytes([
            ["frozen-preparing", "resume-exact-or-cancel-before-durable-prepare"],
            ["staging", "resume-finalize-or-abort-staging"],
            ["ready-to-commit", "resume-exact-commit-only"],
            ["committed-verifying", "no-old-generation-rollback"],
            ["retired", "best-effort-old-key-deletion"],
        ]),
        "hostile_negative_matrix": hostile_matrix([
            "external-root", "external-recovery-material", "external-unlock-wrap",
            "independent-manifest-seed", "missing-provenance", "missing-possession",
            "extra-recipient", "root-envelope", "challenge-envelope", "wrap-substitution",
            "anchor-absent-at-commit", "phase-id-reuse", "phase-link-substitution",
            "final-object-substitution", "competing-successor", "no-clean-anchor",
        ]),
    }
    expected = {
        "prepare_authorization_hash": prepare_authorization_hash,
        "final_account_root": final_account_root,
        "final_recovery_hash": sha256(final_recovery),
        "final_manifest_hash": sha256(final_manifest),
        "commit_authorization_hash": commit_authorization_hash,
        "rotation_commit_bundle_hash": commit_bundle_hash,
    }
    intermediates = {
        "new_manifest_seed": new_manifest_seed,
        "new_manifest_public_key": new_manifest_public,
        "recovery_auth_seed": recovery_seed,
        "recovery_public_key": recovery_public,
        "recovery_wrap_key": recovery_wrap_key,
        "recovery_ciphertext": recovery_ciphertext,
        "recovery_core_body": cbor(recovery_core_body),
        "recovery_core_hash": recovery_core_hash,
        "argon2id_output": argon_output,
        "unlock_key": unlock_key,
        "unlock_wrap": unlock_wrap,
        "unlock_wrap_hash": unlock_hash,
        "recipient_descriptor": cbor(descriptor),
        "recipient_descriptor_hash": descriptor_hash,
        "root_hpke_envelope": root_envelope,
        "root_hpke_shared_secret": root_hpke["shared_secret"],
        "challenge_hpke_envelope": challenge_envelope,
        "challenge_hpke_shared_secret": challenge_hpke["shared_secret"],
        "new_root_commitment": root_commitment,
        "device_wrap_set_root": device_wrap_set_root,
        "retained_backup_dependency_root": backup_root,
        "final_account_core_body": cbor(final_account_core),
        "final_account_core_hash": final_account_core_hash,
        "root_provenance_body": cbor(provenance_body),
        "root_provenance_envelope": provenance,
        "root_provenance_hash": provenance_hash,
        "possession_body": cbor(possession_body),
        "possession_envelope": possession,
        "rotation_possession_root": possession_root,
        "prepare_body": cbor(prepare_body),
        "signed_prepare": signed_prepare,
        "prepare_payload": prepare_auth["payload"],
        "prepare_request": prepare_auth["request"],
        "prepare_context": prepare_auth["context"],
        "prepare_native_proof": prepare_auth["native_proof"],
        "prepare_operation_authorization": prepare_auth["authorization"],
        "prepare_tagged_authorization": prepare_tagged,
        "final_account_envelope": final_account,
        "final_recovery_envelope": final_recovery,
        "final_manifest_envelope": final_manifest,
        "finalize_body": cbor(finalize_body),
        "signed_finalize": signed_finalize,
        "commit_body": cbor(commit_body),
        "old_signed_commit": old_signed_commit,
        "new_commit_body": cbor(new_commit_body),
        "new_cross_signature": new_cross_signature,
        "commit_core_hash": commit_core_hash,
        "commit_payload": commit_auth["payload"],
        "commit_request": commit_auth["request"],
        "commit_context": commit_auth["context"],
        "commit_native_proof": commit_auth["native_proof"],
        "commit_operation_authorization": commit_auth["authorization"],
        "commit_tagged_authorization": commit_tagged,
        "rotation_commit_bundle": commit_bundle,
    }
    return inputs, expected, intermediates


def canonical_fixture_sha256(fixture: dict[str, Any]) -> str:
    payload = {key: value for key, value in fixture.items() if key != "fixture_sha256"}
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def source_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def vector(
    family: str,
    section: str,
    inputs: dict[str, bytes],
    expected: dict[str, bytes],
    intermediates: dict[str, bytes],
    generator_hash: str,
    *,
    source_document: str = ADR,
    boolean_subfixtures: dict[str, Any] | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": family,
        "family": family,
        "source_document": source_document,
        "source_section": section,
        "provenance_id": CORPUS_ID,
        "generator": {
            "owner": "independent-reference-oracle",
            "source_kind": "committed-file",
            "source_ref": ORACLE_REF,
            "source_sha256": generator_hash,
        },
        "inputs": {key: value.hex() for key, value in inputs.items()},
        "expected_bytes": {key: value.hex() for key, value in expected.items()},
        "intermediates": {key: value.hex() for key, value in intermediates.items()},
        "protocol_boolean_coverage": [False, True] if boolean_subfixtures else [],
        "fixture_sha256": "pending",
        "review": {"disposition": "ai-non-human-reviewed"},
    }
    if boolean_subfixtures is not None:
        item["boolean_subfixtures"] = boolean_subfixtures
    item["fixture_sha256"] = canonical_fixture_sha256(item)
    return item


def signed_subfixture(family: str, value: bool, seed: bytes) -> dict[str, Any]:
    public, _unused = ed25519_sign(seed, b"")
    deployment = bytes(range(16))
    vault = bytes(range(16, 32))
    if family == "signed-account-state-false-true":
        domain = "pm-v1/account-state"
        location = "account-state.devices[0].credential.backup-state"
        credential = [
            2,
            b"credential-id",
            bytes(range(32, 64)),
            P256_G[0].to_bytes(32, "big"),
            P256_G[1].to_bytes(32, "big"),
            7,
            True,
            value,
        ]
        body = [
            1, 1, deployment, vault, 2, bytes([1]) * 32, 1,
            bytes([2]) * 16, public, 1, bytes([3]) * 16,
            bytes([4]) * 32, 1, bytes([5]) * 32, 1,
            [[1, 1], [2, 1], [3, 0]], 1, 1, 1, 1, 0,
            bytes([6]) * 16, bytes([7]) * 32,
            b"https://vault.example.invalid", b"vault.example.invalid",
            bytes([8]) * 32, bytes([9]) * 16, bytes([10]) * 32,
            [[bytes([11]) * 16, 1, credential, bytes([12]) * 32, 0x1F, 0, 1]],
            bytes([13]) * 32, bytes([14]) * 32,
        ]
        extra: dict[str, str] = {}
    else:
        domain = "pm-v1/manifest"
        location = "manifest-leaf.tombstone"
        leaf = [bytes([15]) * 16, 3, 9, bytes([16]) * 32, value]
        leaf_bytes = cbor(leaf)
        leaf_hash = sha256(b"pm-v1/manifest-leaf\0" + leaf_bytes)
        body = [
            1, 1, deployment, vault, 4, bytes([17]) * 16, 2, 4,
            bytes([18]) * 32, leaf_hash, 2, bytes([19]) * 32, 1,
            0 if value else 1, 1 if value else 0, 1, 1, 1, 1,
            bytes([20]) * 32, bytes([21]) * 16,
        ]
        extra = {
            "manifest_leaf_cbor_hex": leaf_bytes.hex(),
            "manifest_leaf_sha256": leaf_hash.hex(),
        }
    body_bytes = cbor(body)
    message = domain.encode("ascii") + b"\0" + body_bytes
    verification_key, signature = ed25519_sign(seed, message)
    envelope = cbor([body, signature])
    return {
        "boolean_value": value,
        "boolean_location": location,
        "domain": domain,
        "verification_key_hex": verification_key.hex(),
        "body_cbor_hex": body_bytes.hex(),
        "preimage_hex": message.hex(),
        "signature_hex": signature.hex(),
        "signed_envelope_hex": envelope.hex(),
        "envelope_sha256": sha256(envelope).hex(),
        **extra,
    }


def build_corpus() -> dict[str, Any]:
    generator_hash = source_sha256()
    vectors: list[dict[str, Any]] = []

    argon_tag, argon_provenance = openssl_argon2id(
        b"\x01" * 32, b"\x02" * 16, memory_kib=32, lanes=4,
        secret=b"\x03" * 8, associated_data=b"\x04" * 12,
    )
    vectors.append(vector(
        "argon2id", "RFC 9106 primitive plus the strict Veyora password profile",
        {
            "password": b"\x01" * 32,
            "salt": b"\x02" * 16,
            "secret": b"\x03" * 8,
            "associated_data": b"\x04" * 12,
            "external_oracle_provenance": json_bytes(argon_provenance),
            "rfc_profile": cbor([0x13, 32, 16, 32, 3, 4, 8, 12]),
            "veyora_portable_profile": cbor([0x13, 32, 16, 65536, 3, 1, 0, 0]),
            "strict_password_profile": json_bytes({
                "encoding": "direct-utf8-no-normalization",
                "minimum_bytes": 1,
                "maximum_bytes": 1024,
                "salt_bytes": 16,
                "memory_kib": 65536,
                "iterations": 3,
                "lanes": 1,
                "tag_bytes": 32,
                "version": 19,
                "secret_bytes": 0,
                "associated_data_bytes": 0,
            }),
            "hostile_parameter_matrix": hostile_matrix([
                "version-0x10", "version-unknown", "memory-65535-kib",
                "iterations-2", "lanes-2", "tag-31", "tag-33",
                "secret-present", "associated-data-present", "salt-15",
                "salt-17", "password-empty", "password-1025-bytes",
                "invalid-utf8", "utf8-surrogate", "c-string-truncation-interface",
                "decomposed-composed-normalization", "parser-memory-over-ceiling",
                "arithmetic-overflow-before-allocation", "parallelism-memory-mismatch",
            ]),
            "hostile_parameter_vectors": json_bytes([
                {"case": "version-0x10", "profile": [0x10, 32, 16, 65536, 3, 1, 0, 0], "accept": False},
                {"case": "version-unknown", "profile": [0x14, 32, 16, 65536, 3, 1, 0, 0], "accept": False},
                {"case": "memory-65535-kib", "profile": [0x13, 32, 16, 65535, 3, 1, 0, 0], "accept": False},
                {"case": "iterations-2", "profile": [0x13, 32, 16, 65536, 2, 1, 0, 0], "accept": False},
                {"case": "lanes-2", "profile": [0x13, 32, 16, 65536, 3, 2, 0, 0], "accept": False},
                {"case": "tag-31", "profile": [0x13, 31, 16, 65536, 3, 1, 0, 0], "accept": False},
                {"case": "tag-33", "profile": [0x13, 33, 16, 65536, 3, 1, 0, 0], "accept": False},
                {"case": "secret-present", "profile": [0x13, 32, 16, 65536, 3, 1, 1, 0], "accept": False},
                {"case": "associated-data-present", "profile": [0x13, 32, 16, 65536, 3, 1, 0, 1], "accept": False},
                {"case": "salt-15", "profile": [0x13, 32, 15, 65536, 3, 1, 0, 0], "accept": False},
                {"case": "salt-17", "profile": [0x13, 32, 17, 65536, 3, 1, 0, 0], "accept": False},
                {"case": "password-empty", "password_hex": "", "accept": False},
                {"case": "password-1025-bytes", "password_hex": (b"a" * 1025).hex(), "accept": False},
                {"case": "invalid-utf8", "password_hex": "ff", "accept": False},
                {"case": "utf8-surrogate", "password_hex": "eda080", "accept": False},
                {"case": "c-string-truncation-interface", "password_hex": "610062", "truncated_password_hex": "61", "interface": "c-string", "accept": False},
                {"case": "decomposed-composed-normalization", "left_hex": "c3a9", "right_hex": "65cc81", "equal": False, "accept": False},
                {"case": "parser-memory-over-ceiling", "profile": [0x13, 32, 16, 1048577, 3, 1, 0, 0], "accept": False},
                {"case": "arithmetic-overflow-before-allocation", "profile": [0x13, 32, 16, 4294967295, 3, 1, 0, 0], "accept": False},
                {"case": "parallelism-memory-mismatch", "profile": [0x13, 32, 16, 65536, 3, 255, 0, 0], "accept": False},
            ]),
            "u0000_password": b"\0",
            "u0000_salt": bytes(range(0xA0, 0xB0)),
            "u0000_acceptance": json_bytes({
                "accept": True,
                "encoded_length": 1,
                "interface": "length-aware-utf8",
                "scalar": "U+0000",
            }),
        },
        {
            "tag": argon_tag,
            "u0000_tag": openssl_argon2id(b"\0", bytes(range(0xA0, 0xB0)))[0],
        },
        {"prehash_digest": bytes.fromhex("2889de487eb42ae500c0007ed9252f1069eadec40d5765b485de6dc2437a67b8546a2f0acc1a0882db8fcf74714b472e94df421a5da1112ffa11434370a1e997")},
        generator_hash, source_document="RFC 9106",
    ))

    ikm, salt, info = b"\x0b" * 22, bytes(range(13)), bytes(range(0xF0, 0xFA))
    prk, okm = hkdf_sha256(ikm, salt, info, 42)
    vectors.append(vector(
        "hkdf-sha256", "RFC 5869 Appendix A.1",
        {"ikm": ikm, "salt": salt, "info": info, "length_u16_be": (42).to_bytes(2, "big")},
        {"okm": okm}, {"prk": prk}, generator_hash, source_document="RFC 5869",
    ))

    x_plain = bytes.fromhex("4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73637265656e20776f756c642062652069742e")
    x_ct = bytes.fromhex("bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e")
    vectors.append(vector(
        "xchacha20poly1305", "draft-irtf-cfrg-xchacha-03 Appendix A.3.1",
        {"key": bytes(range(0x80, 0xA0)), "nonce": bytes(range(0x40, 0x58)), "aad": bytes.fromhex("50515253c0c1c2c3c4c5c6c7"), "plaintext": x_plain},
        {"ciphertext_and_tag": x_ct + bytes.fromhex("c0875924c1c7987947deafd8780acf49")},
        {"poly1305_key": bytes.fromhex("7b191f80f361f099094f6f4b8fb97df847cc6873a8f2b190dd73807183f907d5")},
        generator_hash, source_document="draft-irtf-cfrg-xchacha-03",
    ))

    vectors.append(vector(
        "hpke-base-x25519", "RFC 9180 Appendix A.2.1 sequence zero (suite 0020-0001-0003)",
        {"recipient_private_key": bytes.fromhex("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb"), "ephemeral_private_key": bytes.fromhex("f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600"), "info": bytes.fromhex("4f6465206f6e2061204772656369616e2055726e"), "plaintext": bytes.fromhex("4265617574792069732074727574682c20747275746820626561757479"), "aad": bytes.fromhex("436f756e742d30")},
        {"enc": bytes.fromhex("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a"), "ciphertext": bytes.fromhex("1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28")},
        {"shared_secret": bytes.fromhex("0bbe78490412b4bbea4812666f7916932b828bba79942424abb65244930d69a7"), "key": bytes.fromhex("ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91"), "base_nonce": bytes.fromhex("5c4d98150661b848853b547f")},
        generator_hash, source_document="RFC 9180",
    ))

    rfc_seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    rfc_public, rfc_signature = ed25519_sign(rfc_seed, b"")
    vectors.append(vector(
        "ed25519-strict", "RFC 8032 test 1 plus strict verification rejection cases",
        {
            "seed": rfc_seed,
            "message_length_u8": b"\0",
            "verification_profile": json_bytes({
                "public_key_bytes": 32,
                "signature_bytes": 64,
                "require_canonical_R": True,
                "require_canonical_A": True,
                "require_S_less_than_L": True,
                "reject_small_order": True,
            }),
            "hostile_verification_matrix": hostile_matrix([
                "signature-63-bytes", "signature-65-bytes", "public-key-31-bytes",
                "public-key-33-bytes", "S-equal-L", "S-greater-than-L",
                "noncanonical-R", "noncanonical-public-key", "small-order-R",
                "small-order-public-key", "identity-public-key", "wrong-public-key",
                "altered-message", "altered-signature", "trailing-envelope-bytes",
                "prehash-instead-of-pure", "context-injection",
            ]),
            "hostile_verification_vectors": json_bytes([
                {"case": "signature-63-bytes", "public_hex": rfc_public.hex(), "signature_hex": rfc_signature[:-1].hex(), "accept": False},
                {"case": "signature-65-bytes", "public_hex": rfc_public.hex(), "signature_hex": (rfc_signature + b"\0").hex(), "accept": False},
                {"case": "public-key-31-bytes", "public_hex": rfc_public[:-1].hex(), "signature_hex": rfc_signature.hex(), "accept": False},
                {"case": "public-key-33-bytes", "public_hex": (rfc_public + b"\0").hex(), "signature_hex": rfc_signature.hex(), "accept": False},
                {"case": "S-equal-L", "public_hex": rfc_public.hex(), "signature_hex": (rfc_signature[:32] + ED_L.to_bytes(32, "little")).hex(), "accept": False},
                {"case": "S-greater-than-L", "public_hex": rfc_public.hex(), "signature_hex": (rfc_signature[:32] + (ED_L + 1).to_bytes(32, "little")).hex(), "accept": False},
                {"case": "noncanonical-R", "public_hex": rfc_public.hex(), "signature_hex": (ED_Q.to_bytes(32, "little") + rfc_signature[32:]).hex(), "accept": False},
                {"case": "noncanonical-public-key", "public_hex": ED_Q.to_bytes(32, "little").hex(), "signature_hex": rfc_signature.hex(), "accept": False},
                {"case": "small-order-R", "public_hex": rfc_public.hex(), "signature_hex": (b"\x01" + bytes(31) + rfc_signature[32:]).hex(), "accept": False},
                {"case": "small-order-public-key", "public_hex": (b"\x01" + bytes(31)).hex(), "signature_hex": rfc_signature.hex(), "accept": False},
                {"case": "identity-public-key", "public_hex": (b"\x01" + bytes(31)).hex(), "signature_hex": rfc_signature.hex(), "accept": False},
                {"case": "wrong-public-key", "public_hex": ed25519_sign(bytes([1]) * 32, b"")[0].hex(), "signature_hex": rfc_signature.hex(), "accept": False},
                {"case": "altered-message", "public_hex": rfc_public.hex(), "signature_hex": rfc_signature.hex(), "message_hex": "00", "accept": False},
                {"case": "altered-signature", "public_hex": rfc_public.hex(), "signature_hex": (bytes([rfc_signature[0] ^ 1]) + rfc_signature[1:]).hex(), "accept": False},
                {"case": "trailing-envelope-bytes", "public_hex": rfc_public.hex(), "signature_hex": (rfc_signature + b"\0").hex(), "accept": False},
                {"case": "prehash-instead-of-pure", "public_hex": rfc_public.hex(), "signature_hex": rfc_signature.hex(), "message_hex": sha256(b"").hex(), "accept": False},
                {"case": "context-injection", "public_hex": rfc_public.hex(), "signature_hex": rfc_signature.hex(), "message_hex": b"context".hex(), "accept": False},
            ]),
        }, {"signature": rfc_signature}, {"public_key": rfc_public},
        generator_hash, source_document="RFC 8032",
    ))

    p_message = b"Veyora ES256 inert evidence"
    p_signature, p_public = p256_sign(1, 2, p_message)
    vectors.append(vector(
        "p256-es256", "RFC 9052 and RFC 9053 ES256 encoding policy",
        {"private_scalar": (1).to_bytes(32, "big"), "nonce_scalar": (2).to_bytes(32, "big"), "message": p_message},
        {"low_s_der_signature": p_signature},
        {"public_x": p_public[0].to_bytes(32, "big"), "public_y": p_public[1].to_bytes(32, "big"), "message_sha256": sha256(p_message)},
        generator_hash, source_document="RFC 9052 and RFC 9053",
    ))

    protocol_body = [1, False, True, bytes(range(16)), 24, bytes(range(32))]
    protocol_cbor = cbor(protocol_body)
    vectors.append(vector(
        "protocol-cbor", "Deterministic protocol CBOR plus hostile grammar matrix",
        {
            "body_semantics": b"[u64,false,true,bstr16,u64,bstr32]",
            "accepted_boolean_encodings": b"\xf4\xf5",
            "hostile_cbor_matrix": json_bytes({
                "null": "f6", "undefined": "f7", "negative": "33",
                "non_shortest_uint": "1817", "indefinite_array": "9f01ff",
                "indefinite_bstr": "5f4101ff", "map": "a0", "tag": "c001",
                "float": "fa3f800000", "text": "6161", "break": "ff",
                "trailing_byte": protocol_cbor.hex() + "00",
                "second_top_level_item": protocol_cbor.hex() + "01",
                "array_length_mismatch": "8201", "over_u64": "1bffffffffffffffff",
            }),
        },
        {"deterministic_cbor": protocol_cbor}, {"sha256": sha256(protocol_cbor)}, generator_hash,
    ))

    cose_key = {1: 2, 3: -7, -1: 1, -2: P256_G[0].to_bytes(32, "big"), -3: P256_G[1].to_bytes(32, "big")}
    cose_bytes = cbor(cose_key)
    assertion_challenge = sha256(b"veyora-webauthn-assertion-challenge")
    assertion_client_json = (
        b'{"type":"webauthn.get","challenge":"'
        + base64.urlsafe_b64encode(assertion_challenge).rstrip(b"=")
        + b'","origin":"https://vault.example.invalid","crossOrigin":false}'
    )
    assertion_auth_data = sha256(b"example.invalid") + bytes([0x05]) + (7).to_bytes(4, "big")
    assertion_signature, _assertion_public = p256_sign(
        1, 2, assertion_auth_data + sha256(assertion_client_json),
    )
    assertion_r = p256_mul(P256_G, 2)[0] % P256_N  # type: ignore[index]
    assertion_z = int.from_bytes(sha256(assertion_auth_data + sha256(assertion_client_json)), "big")
    assertion_s = pow(2, -1, P256_N) * (assertion_z + assertion_r) % P256_N
    assertion_low_s = min(assertion_s, P256_N - assertion_s)
    high_s_body = der_integer(assertion_r) + der_integer(P256_N - assertion_low_s)
    assertion_high_s = b"\x30" + bytes([len(high_s_body)]) + high_s_body
    vectors.append(vector(
        "webauthn-cbor", "Strict WebAuthn ES256 credential and assertion validation",
        {
            "cose_labels": cbor([1, 3, -1, -2, -3]),
            "assertion_client_data_json": assertion_client_json,
            "assertion_challenge": assertion_challenge,
            "assertion_authenticator_data": assertion_auth_data,
            "assertion_profile": json_bytes({
                "credential_type": 2, "alg": -7, "curve": 1,
                "require_up": True, "require_uv": True, "rp_id": "example.invalid",
                "origin": "https://vault.example.invalid", "counter_policy": "monotonic",
            }),
            "hostile_cose_assertion_matrix": hostile_matrix([
                "wrong-kty", "wrong-alg", "wrong-curve", "x-31-bytes", "y-33-bytes",
                "off-curve-point", "duplicate-cose-label", "noncanonical-cose-order",
                "missing-up", "missing-uv", "wrong-rp-id-hash", "wrong-origin",
                "wrong-client-type", "wrong-challenge", "challenge-not-32-bytes",
                "malformed-client-json", "duplicate-client-json-key", "invalid-base64url",
                "der-trailing-bytes", "der-negative-r", "der-zero-r", "der-zero-s",
                "high-s-signature", "counter-regression", "be-bs-invalid",
                "unexpected-extension", "attestation-used-as-assertion",
            ]),
            "hostile_cose_assertion_vectors": json_bytes([
                {"case": "wrong-kty", "cose_hex": cbor({1: 1, 3: -7, -1: 1, -2: P256_G[0].to_bytes(32, "big"), -3: P256_G[1].to_bytes(32, "big")}).hex(), "accept": False},
                {"case": "wrong-alg", "cose_hex": cbor({1: 2, 3: -8, -1: 1, -2: P256_G[0].to_bytes(32, "big"), -3: P256_G[1].to_bytes(32, "big")}).hex(), "accept": False},
                {"case": "wrong-curve", "cose_hex": cbor({1: 2, 3: -7, -1: 2, -2: P256_G[0].to_bytes(32, "big"), -3: P256_G[1].to_bytes(32, "big")}).hex(), "accept": False},
                {"case": "x-31-bytes", "cose_hex": cbor({1: 2, 3: -7, -1: 1, -2: P256_G[0].to_bytes(32, "big")[1:], -3: P256_G[1].to_bytes(32, "big")}).hex(), "accept": False},
                {"case": "y-33-bytes", "cose_hex": cbor({1: 2, 3: -7, -1: 1, -2: P256_G[0].to_bytes(32, "big"), -3: b"\0" + P256_G[1].to_bytes(32, "big")}).hex(), "accept": False},
                {"case": "off-curve-point", "cose_hex": cbor({1: 2, 3: -7, -1: 1, -2: bytes(32), -3: bytes(32)}).hex(), "accept": False},
                {"case": "duplicate-cose-label", "cose_hex": (b"\xa6" + cose_bytes[1:] + b"\x01\x02").hex(), "accept": False},
                {"case": "noncanonical-cose-order", "cose_hex": (b"\xa5\x03\x26\x01\x02\x20\x01\x21\x58\x20" + P256_G[0].to_bytes(32, "big") + b"\x22\x58\x20" + P256_G[1].to_bytes(32, "big")).hex(), "accept": False},
                {"case": "missing-up", "authenticator_data_hex": (sha256(b"example.invalid") + b"\x04" + (7).to_bytes(4, "big")).hex(), "accept": False},
                {"case": "missing-uv", "authenticator_data_hex": (sha256(b"example.invalid") + b"\x01" + (7).to_bytes(4, "big")).hex(), "accept": False},
                {"case": "wrong-rp-id-hash", "authenticator_data_hex": (bytes(32) + b"\x05" + (7).to_bytes(4, "big")).hex(), "accept": False},
                {"case": "wrong-origin", "client_data_hex": assertion_client_json.replace(b"https://vault.example.invalid", b"https://other.example.invalid").hex(), "accept": False},
                {"case": "wrong-client-type", "client_data_hex": assertion_client_json.replace(b"webauthn.get", b"webauthn.create").hex(), "accept": False},
                {"case": "wrong-challenge", "client_data_hex": assertion_client_json.replace(base64.urlsafe_b64encode(assertion_challenge).rstrip(b"="), base64.urlsafe_b64encode(bytes(32)).rstrip(b"=")).hex(), "accept": False},
                {"case": "challenge-not-32-bytes", "challenge_hex": assertion_challenge[:-1].hex(), "accept": False},
                {"case": "malformed-client-json", "client_data_hex": assertion_client_json[:-1].hex(), "accept": False},
                {"case": "duplicate-client-json-key", "client_data_hex": assertion_client_json.replace(b'{"type":', b'{"type":"webauthn.get","type":', 1).hex(), "accept": False},
                {"case": "invalid-base64url", "client_data_hex": assertion_client_json.replace(base64.urlsafe_b64encode(assertion_challenge).rstrip(b"="), b"*").hex(), "accept": False},
                {"case": "der-trailing-bytes", "signature_hex": (assertion_signature + b"\0").hex(), "accept": False},
                {"case": "der-negative-r", "signature_hex": (b"\x30\x06\x02\x01\x80\x02\x01\x01").hex(), "accept": False},
                {"case": "der-zero-r", "signature_hex": (b"\x30\x06\x02\x01\x00\x02\x01\x01").hex(), "accept": False},
                {"case": "der-zero-s", "signature_hex": (b"\x30\x06\x02\x01\x01\x02\x01\x00").hex(), "accept": False},
                {"case": "high-s-signature", "signature_hex": assertion_high_s.hex(), "accept": False},
                {"case": "counter-regression", "previous_counter": 8, "authenticator_data_hex": assertion_auth_data.hex(), "accept": False},
                {"case": "be-bs-invalid", "authenticator_data_hex": (sha256(b"example.invalid") + b"\x15" + (7).to_bytes(4, "big")).hex(), "accept": False},
                {"case": "unexpected-extension", "authenticator_data_hex": (sha256(b"example.invalid") + b"\x85" + (7).to_bytes(4, "big") + b"\xa0").hex(), "accept": False},
                {"case": "attestation-used-as-assertion", "assertion_hex": cbor({"fmt": "none", "attStmt": {}, "authData": assertion_auth_data}).hex(), "accept": False},
            ]),
        },
        {"canonical_cose_key": cose_bytes, "assertion_der_signature": assertion_signature},
        {
            "cose_key_sha256": sha256(cose_bytes),
            "assertion_client_data_sha256": sha256(assertion_client_json),
            "assertion_signed_bytes": assertion_auth_data + sha256(assertion_client_json),
        }, generator_hash,
    ))

    client_challenge = sha256(b"veyora-client-json-challenge")
    client_json = (
        b'{"type":"webauthn.get","challenge":"'
        + base64.urlsafe_b64encode(client_challenge).rstrip(b"=")
        + b'","origin":"https://vault.example.invalid","crossOrigin":false}'
    )
    vectors.append(vector(
        "webauthn-client-json", "WebAuthn assertion original-byte verification",
        {
            "client_data_json": client_json,
            "strict_json_profile": json_bytes({
                "challenge_decoded_bytes": 32, "base64url_padding": False,
                "duplicate_members": "reject", "compare_origin_exactly": True,
                "hash_original_bytes": True,
            }),
            "hostile_json_matrix": hostile_matrix([
                "duplicate-type", "duplicate-challenge", "duplicate-origin",
                "padded-base64url", "standard-base64", "challenge-31-bytes",
                "challenge-33-bytes", "wrong-type", "wrong-origin", "cross-origin-true",
                "utf8-bom", "trailing-json", "reencoded-before-hash",
            ]),
            "hostile_json_vectors": json_bytes([
                {"case": "duplicate-type", "raw_hex": client_json.replace(b'{"type":', b'{"type":"webauthn.get","type":', 1).hex()},
                {"case": "duplicate-challenge", "raw_hex": client_json.replace(b'"challenge":', b'"challenge":"AAAA","challenge":', 1).hex()},
                {"case": "duplicate-origin", "raw_hex": client_json.replace(b'"origin":', b'"origin":"https://other.invalid","origin":', 1).hex()},
                {"case": "padded-base64url", "raw_hex": client_json.replace(base64.urlsafe_b64encode(client_challenge).rstrip(b"="), base64.urlsafe_b64encode(client_challenge)).hex()},
                {"case": "standard-base64", "raw_hex": client_json.replace(base64.urlsafe_b64encode(client_challenge).rstrip(b"="), base64.b64encode(client_challenge).rstrip(b"=")).hex()},
                {"case": "challenge-31-bytes", "raw_hex": client_json.replace(base64.urlsafe_b64encode(client_challenge).rstrip(b"="), base64.urlsafe_b64encode(client_challenge[:-1]).rstrip(b"=")).hex()},
                {"case": "challenge-33-bytes", "raw_hex": client_json.replace(base64.urlsafe_b64encode(client_challenge).rstrip(b"="), base64.urlsafe_b64encode(client_challenge + b"\0").rstrip(b"=")).hex()},
                {"case": "wrong-type", "raw_hex": client_json.replace(b"webauthn.get", b"webauthn.create").hex()},
                {"case": "wrong-origin", "raw_hex": client_json.replace(b"https://vault.example.invalid", b"https://other.example.invalid").hex()},
                {"case": "cross-origin-true", "raw_hex": client_json.replace(b"false", b"true").hex()},
                {"case": "utf8-bom", "raw_hex": (b"\xef\xbb\xbf" + client_json).hex()},
                {"case": "trailing-json", "raw_hex": (client_json + b"{}").hex()},
                {"case": "reencoded-before-hash", "raw_hex": client_json.replace(b'","origin"', b'", "origin"').hex()},
            ]),
        }, {"client_data_sha256": sha256(client_json)}, {"challenge": client_challenge}, generator_hash,
        source_document="WebAuthn Level 3 Candidate Recommendation 2026-05-26",
    ))

    recovery_entropy = bytes(range(32))
    recovery_checksum = sha256(b"pm-v1/recovery-checksum\0" + recovery_entropy)[:5]
    recovery_text = base64.b32encode(recovery_entropy + recovery_checksum).decode("ascii").rstrip("=").lower()
    recovery_human = "-".join(recovery_text[index:index + 5] for index in range(0, 60, 5)).encode("ascii")
    vectors.append(vector(
        "recovery-human-form", "Canonical password and recovery material",
        {"entropy": recovery_entropy}, {"human_form": recovery_human}, {"checksum": recovery_checksum, "ungrouped_base32": recovery_text.encode("ascii")}, generator_hash,
    ))

    session_body = [1, 1, 86400, 900, 5]
    session_cbor = cbor(session_body)
    session_hash = sha256(preimage("pm-v1/session-policy", session_body))
    result_body = [1, session_hash, 1, 86400, 900, 5, 1700000000, 1700086400, 1700000900]
    vectors.append(vector(
        "session-policy", "WebAuthn result-template and composite operations",
        {"policy_body": session_cbor, "issued_at": (1700000000).to_bytes(8, "big")},
        {"policy_hash": session_hash, "result_hash": sha256(preimage("pm-v1/session-policy-result", result_body))},
        {"result_body": cbor(result_body)}, generator_hash,
    ))

    enrollment_inputs, enrollment_expected, enrollment_intermediates = build_later_enrollment_evidence()
    vectors.append(vector(
        "webauthn-composite-enrollment", "Complete later-WebAuthn-enrollment known-answer vector",
        enrollment_inputs, enrollment_expected, enrollment_intermediates, generator_hash,
    ))

    unlock_inputs, unlock_expected, unlock_intermediates = build_unlock_evidence()
    vectors.append(vector(
        "unlock-wrap-buckets", "Successive unlock generations and record-bucket boundaries",
        unlock_inputs, unlock_expected, unlock_intermediates, generator_hash,
    ))

    bootstrap_inputs, bootstrap_expected, bootstrap_intermediates = build_bootstrap_evidence()
    vectors.append(vector(
        "native-web-bootstrap", "Complete acyclic bootstrap known-answer vectors",
        bootstrap_inputs, bootstrap_expected, bootstrap_intermediates, generator_hash,
    ))

    auth_inputs, auth_expected, auth_intermediates = build_authentication_context_evidence()
    vectors.append(vector(
        "authentication-contexts", "All native and WebAuthn authorization purposes",
        auth_inputs, auth_expected, auth_intermediates, generator_hash,
    ))

    rotation_inputs, rotation_expected, rotation_intermediates = build_root_rotation_evidence()
    vectors.append(vector(
        "root-rotation", "Complete prepare/finalize/commit root-rotation transcript",
        rotation_inputs, rotation_expected, rotation_intermediates, generator_hash,
    ))

    checkpoint_body = [1, 1, bytes(range(16)), bytes(range(16, 32)), 4, bytes(range(32, 48)), 1, bytes(range(48, 64)), 7, bytes(range(64, 96)), 1, bytes(range(96, 128)), 2, 1, 1, 0, 1700000000]
    checkpoint_message = preimage("pm-v1/trusted-checkpoint", checkpoint_body)
    checkpoint_public, checkpoint_signature = ed25519_sign(rfc_seed, checkpoint_message)
    checkpoint_envelope = cbor([checkpoint_body, checkpoint_signature])
    vectors.append(vector(
        "signed-checkpoint", "Signed-envelope known-answer vector",
        {"seed": rfc_seed, "body_cbor": cbor(checkpoint_body)},
        {"signed_envelope": checkpoint_envelope},
        {"public_key": checkpoint_public, "preimage": checkpoint_message, "signature": checkpoint_signature, "envelope_sha256": sha256(checkpoint_envelope)}, generator_hash,
    ))

    boolean_seed = rfc_seed
    for family in ("signed-account-state-false-true", "signed-manifest-false-true"):
        pair = {
            "false": signed_subfixture(family, False, boolean_seed),
            "true": signed_subfixture(family, True, boolean_seed),
        }
        vectors.append(vector(
            family, "Adversarial state and vector gates",
            {"signing_seed": boolean_seed},
            {"false_envelope_sha256": bytes.fromhex(pair["false"]["envelope_sha256"]), "true_envelope_sha256": bytes.fromhex(pair["true"]["envelope_sha256"])},
            {"verification_key": bytes.fromhex(pair["false"]["verification_key_hex"]), "typed_boolean_pair": b"\xf4\xf5"},
            generator_hash, boolean_subfixtures=pair,
        ))

    corpus = {
        "schema_version": 1,
        "corpus_id": CORPUS_ID,
        "provenance_contract": "contracts/protocol/vector-provenance-v1.json",
        "canonical_hash_rule": "veyora-vector-json-v1",
        "vectors": vectors,
    }
    self_check(corpus)
    return corpus


def self_check(corpus: dict[str, Any]) -> None:
    vectors = corpus["vectors"]
    required = {
        "argon2id", "hkdf-sha256", "xchacha20poly1305", "hpke-base-x25519",
        "ed25519-strict", "p256-es256", "protocol-cbor", "webauthn-cbor",
        "webauthn-client-json", "recovery-human-form", "session-policy",
        "webauthn-composite-enrollment", "unlock-wrap-buckets", "native-web-bootstrap",
        "authentication-contexts", "root-rotation", "signed-checkpoint",
        "signed-account-state-false-true", "signed-manifest-false-true",
    }
    if len(vectors) != 19 or {item["family"] for item in vectors} != required:
        raise AssertionError("project crypto family coverage differs")
    for item in vectors:
        if item["fixture_sha256"] != canonical_fixture_sha256(item):
            raise AssertionError(f"fixture hash differs: {item['id']}")
        if item["generator"]["source_sha256"] != source_sha256():
            raise AssertionError(f"generator hash differs: {item['id']}")
    by_family = {item["family"]: item for item in vectors}
    if by_family["hkdf-sha256"]["expected_bytes"]["okm"] != "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865":
        raise AssertionError("RFC 5869 vector differs")
    if by_family["ed25519-strict"]["expected_bytes"]["signature"] != "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b":
        raise AssertionError("RFC 8032 vector differs")
    if by_family["recovery-human-form"]["expected_bytes"]["human_form"] != b"aaaqe-ayeau-daoca-jbifq-ydiob-4ibce-qtcqk-rmfyy-denbw-ha5dy-pruwf-twqea".hex():
        raise AssertionError("recovery human-form vector differs")
    if by_family["session-policy"]["expected_bytes"] != {
        "policy_hash": "7b550b26e237e998b630252d8cd4bbf224f15986ce594cd922966f4f06e8ac33",
        "result_hash": "ea607cba6680057cf60654270867abc3f81b540a3c9071794a15979555211a4c",
    }:
        raise AssertionError("session-policy vector differs")
    if len(by_family["authentication-contexts"]["expected_bytes"]) != 10:
        raise AssertionError("authentication context purpose coverage differs")
    if len(by_family["unlock-wrap-buckets"]["expected_bytes"]) != 6:
        raise AssertionError("unlock-wrap generation coverage differs")
    if len(by_family["native-web-bootstrap"]["expected_bytes"]) != 20:
        raise AssertionError("bootstrap branch coverage differs")
    if len(by_family["root-rotation"]["expected_bytes"]) != 6:
        raise AssertionError("root-rotation phase coverage differs")
    if by_family["signed-checkpoint"]["intermediates"]["envelope_sha256"] != "b943099ab9bdd2a0ce93009b1301af196a6520e886f970ce5a76e163ddb919e9":
        raise AssertionError("signed-checkpoint vector differs")
    for family in ("signed-account-state-false-true", "signed-manifest-false-true"):
        subfixtures = by_family[family]["boolean_subfixtures"]
        if subfixtures["false"]["boolean_value"] is not False or subfixtures["true"]["boolean_value"] is not True:
            raise AssertionError(f"typed boolean pair differs: {family}")


def render(corpus: dict[str, Any]) -> str:
    return json.dumps(corpus, ensure_ascii=False, allow_nan=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", type=Path, help="verify that PATH exactly matches generated output")
    parser.add_argument("--output", type=Path, help="write the canonical generated corpus to PATH")
    parser.add_argument("--self-check", action="store_true", help="recompute the corpus without emitting JSON")
    parser.add_argument("--source-sha256", action="store_true", help="print the exact oracle source SHA-256")
    args = parser.parse_args()
    if args.source_sha256:
        print(source_sha256())
        return 0
    output = render(build_corpus())
    if args.check:
        if not args.check.is_file() or args.check.read_text(encoding="utf-8") != output:
            print(f"project crypto corpus differs: {args.check}", file=sys.stderr)
            return 1
        print(f"project crypto corpus verified: {args.check}")
        return 0
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8", newline="\n")
        print(f"project crypto corpus written: {args.output}")
        return 0
    if not args.self_check:
        sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
