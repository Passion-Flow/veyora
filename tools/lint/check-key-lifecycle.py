#!/usr/bin/env python3
"""Validate the proposed Veyora key/recovery/backup lifecycle authority."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = "contracts/protocol/key-lifecycle-v1.json"
SHA256 = re.compile(r"^[0-9a-f]{64}$")

REQUIREMENTS = {
    *(f"REC-{number:03d}" for number in range(1, 8)),
    *(f"BAK-{number:03d}" for number in range(1, 7)),
    *(f"SEC-KEY-{number:03d}" for number in range(1, 7)),
    "MIG-001",
}
PROJECT_VECTOR_IDS = {
    "recovery-human-form",
    "unlock-wrap-buckets",
    "native-web-bootstrap",
    "root-rotation",
}
BACKUP_FIXTURE_IDS = {"empty", "one-byte", "exact-chunk", "multi-chunk"}


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"top-level JSON object required: {path}")
    return value


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_fixture_digest(fixture: dict[str, Any]) -> str:
    value = copy.deepcopy(fixture)
    value.pop("fixture_sha256", None)
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def nested(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def require_path(root: Path, relative: Any, label: str, errors: list[str]) -> Path | None:
    if not isinstance(relative, str) or not relative:
        errors.append(f"{label} must be a repository-relative path")
        return None
    candidate = root / relative
    try:
        candidate.resolve().relative_to(root.resolve())
    except ValueError:
        errors.append(f"{label} escapes the repository")
        return None
    if not candidate.is_file() or candidate.is_symlink():
        errors.append(f"{label} is missing or not a regular file: {relative}")
        return None
    return candidate


def validate_project_vectors(root: Path, evidence: dict[str, Any], errors: list[str]) -> None:
    corpus_path = require_path(
        root, evidence.get("project_crypto_corpus"), "project crypto corpus", errors
    )
    generator_path = require_path(
        root, evidence.get("project_crypto_generator"), "project crypto generator", errors
    )
    if corpus_path is None or generator_path is None:
        return
    try:
        corpus = load_object(corpus_path)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        errors.append(f"cannot read project crypto corpus: {error}")
        return
    vectors = corpus.get("vectors")
    if not isinstance(vectors, list):
        errors.append("project crypto corpus vectors must be an array")
        return
    by_id = {
        item.get("id"): item
        for item in vectors
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    required = evidence.get("required_project_vector_ids")
    if not isinstance(required, list) or set(required) != PROJECT_VECTOR_IDS:
        errors.append("required project vector IDs differ from the lifecycle policy")
        return
    generator_digest = digest(generator_path)
    for vector_id in sorted(PROJECT_VECTOR_IDS):
        vector = by_id.get(vector_id)
        if not isinstance(vector, dict):
            errors.append(f"missing project crypto vector: {vector_id}")
            continue
        expected_fixture_digest = vector.get("fixture_sha256")
        if expected_fixture_digest != canonical_fixture_digest(vector):
            errors.append(f"project crypto fixture digest differs: {vector_id}")
        if nested(vector, "generator", "source_sha256") != generator_digest:
            errors.append(f"project crypto generator digest differs: {vector_id}")
        if nested(vector, "review", "disposition") not in {
            "ai-non-human-reviewed",
            "qualified-human-reviewed",
        }:
            errors.append(f"project crypto review disposition is invalid: {vector_id}")


def validate_backup_vectors(root: Path, evidence: dict[str, Any], errors: list[str]) -> None:
    corpus_path = require_path(root, evidence.get("backup_corpus"), "backup corpus", errors)
    generator_path = require_path(
        root, evidence.get("backup_generator"), "backup generator", errors
    )
    if corpus_path is None or generator_path is None:
        return
    try:
        corpus = load_object(corpus_path)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        errors.append(f"cannot read backup corpus: {error}")
        return
    fixtures = corpus.get("fixtures")
    if not isinstance(fixtures, dict):
        errors.append("backup corpus fixtures must be an object")
        return
    required = evidence.get("required_backup_fixture_ids")
    if not isinstance(required, list) or set(required) != BACKUP_FIXTURE_IDS:
        errors.append("required backup fixture IDs differ from the lifecycle policy")
        return
    generator_digest = digest(generator_path)
    for fixture_id in sorted(BACKUP_FIXTURE_IDS):
        fixture = fixtures.get(fixture_id)
        if not isinstance(fixture, dict):
            errors.append(f"missing backup fixture: {fixture_id}")
            continue
        if fixture.get("fixture_sha256") != canonical_fixture_digest(fixture):
            errors.append(f"backup fixture digest differs: {fixture_id}")
        if nested(fixture, "generator", "source_sha256") != generator_digest:
            errors.append(f"backup generator digest differs: {fixture_id}")
        if nested(fixture, "review", "disposition") not in {
            "ai-non-human-reviewed",
            "qualified-human-reviewed",
        }:
            errors.append(f"backup review disposition is invalid: {fixture_id}")
        frames = fixture.get("frames")
        if not isinstance(frames, list) or not frames:
            errors.append(f"backup frames are missing: {fixture_id}")
            continue
        for frame in frames:
            if not isinstance(frame, dict):
                errors.append(f"backup frame is invalid: {fixture_id}")
                continue
            sidecar = frame.get("ciphertext_sidecar")
            if not isinstance(sidecar, dict):
                continue
            sidecar_path = require_path(
                root,
                sidecar.get("path"),
                f"backup ciphertext sidecar for {fixture_id}",
                errors,
            )
            if sidecar_path is not None and sidecar.get("sha256") != digest(sidecar_path):
                errors.append(f"backup ciphertext sidecar digest differs: {fixture_id}")


def validate_security_review(root: Path, contract: dict[str, Any], errors: list[str]) -> None:
    review = contract.get("security_review")
    if not isinstance(review, dict):
        errors.append("security_review must be an object")
        return
    require_path(root, review.get("review_schema"), "security review schema", errors)
    registry_path = require_path(
        root, review.get("reviewer_registry"), "security reviewer registry", errors
    )
    if review.get("required_scope") != "key-lifecycle-v1":
        errors.append("security review scope must be key-lifecycle-v1")
    records = review.get("review_records")
    if not isinstance(records, list):
        errors.append("security review records must be an array")
        return
    state = review.get("state")
    if state == "required-not-recorded":
        if records:
            errors.append("unapproved lifecycle contract must not list approval records")
        if contract.get("status") != "proposed-security-review-required":
            errors.append("unapproved lifecycle contract must remain proposed")
        if nested(contract, "implementation_gate", "supported_product_flow") is not False:
            errors.append("unapproved lifecycle contract cannot enable a product flow")
        return
    if state != "qualified-human-approved":
        errors.append("security review state is invalid")
        return
    if contract.get("status") != "accepted" or not records:
        errors.append("accepted lifecycle contract requires qualified review records")
        return
    if nested(contract, "evidence", "current_review_disposition") != (
        "qualified-human-reviewed"
    ):
        errors.append("accepted lifecycle contract requires qualified vector review")
    if registry_path is None:
        return
    try:
        registry = load_object(registry_path)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        errors.append(f"cannot read reviewer registry: {error}")
        return
    reviewers = registry.get("reviewers")
    if not isinstance(reviewers, list):
        errors.append("reviewer registry must contain a reviewers array")
        return
    active = {
        reviewer.get("key_id"): reviewer
        for reviewer in reviewers
        if isinstance(reviewer, dict)
        and reviewer.get("status") == "active"
        and "key-lifecycle-v1" in reviewer.get("scopes", [])
    }
    for relative in records:
        record_path = require_path(root, relative, "security review record", errors)
        if record_path is None:
            continue
        try:
            record = load_object(record_path)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
            errors.append(f"cannot read security review record: {error}")
            continue
        reviewer = active.get(record.get("reviewer_key_id"))
        if not isinstance(reviewer, dict):
            errors.append(f"review record uses an inactive or unscoped reviewer: {relative}")
            continue
        if record.get("reviewer_identity") != reviewer.get("reviewer_identity"):
            errors.append(f"review record identity differs from registry: {relative}")
        subjects = record.get("subjects")
        if not isinstance(subjects, dict):
            errors.append(f"review record subjects are missing: {relative}")
            continue
        for subject in subjects.values():
            if not isinstance(subject, dict):
                errors.append(f"review record subject is invalid: {relative}")
                continue
            subject_path = require_path(root, subject.get("path"), "review subject", errors)
            if subject_path is not None and subject.get("sha256") != digest(subject_path):
                errors.append(f"review subject digest differs: {relative}")
        signature = record.get("approval_signature_hex")
        if not isinstance(signature, str) or not re.fullmatch(r"(?!0{128})[0-9a-f]{128}", signature):
            errors.append(f"review record signature shape is invalid: {relative}")
    errors.append(
        "qualified lifecycle approval cannot be accepted until Ed25519 review-signature verification is implemented"
    )


def validate_contract(root: Path, contract: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if contract.get("schema_version") != 1:
        errors.append("key lifecycle schema_version must be 1")
    if contract.get("contract_id") != "veyora-key-lifecycle-v1":
        errors.append("key lifecycle contract_id is invalid")
    require_path(root, contract.get("design_document"), "key lifecycle ADR", errors)
    cddl_path = require_path(root, contract.get("binary_grammar"), "key lifecycle CDDL", errors)
    require_path(
        root,
        "contracts/protocol/key-lifecycle-v1.schema.json",
        "key lifecycle schema",
        errors,
    )

    requirements = contract.get("requirements")
    if not isinstance(requirements, list) or set(requirements) != REQUIREMENTS:
        errors.append("key lifecycle requirement coverage differs from sequence 4")
    versions = contract.get("versions")
    if not isinstance(versions, dict) or set(versions.values()) != {1} or len(versions) != 6:
        errors.append("all six key lifecycle format versions must be explicitly V1")

    if nested(contract, "primitives", "vault_key", "bytes") != 32:
        errors.append("Vault Key must be 32 bytes")
    if nested(contract, "primitives", "vault_key", "source") != "operating-system-csprng":
        errors.append("Vault Key must come from the operating-system CSPRNG")
    if nested(contract, "primitives", "vault_key", "human_derived") is not False:
        errors.append("Vault Key must not be human-derived")
    expected_password_profile = {
        "algorithm": "Argon2id",
        "version": 19,
        "memory_kib": 65536,
        "iterations": 3,
        "parallelism": 1,
        "salt_bytes": 16,
        "output_bytes": 32,
        "password_encoding": "exact-utf8-no-normalization",
    }
    if nested(contract, "primitives", "password_kdf") != expected_password_profile:
        errors.append("password KDF profile differs from the proposed V1 profile")
    if nested(contract, "primitives", "wrapper_aead", "nonce_source") != (
        "fresh-operating-system-csprng-per-attempt"
    ):
        errors.append("wrapper nonces must be fresh CSPRNG output per attempt")

    wrappers = contract.get("wrappers")
    if not isinstance(wrappers, dict):
        errors.append("wrappers must be an object")
    else:
        for name in ("password", "recovery"):
            wrapper = wrappers.get(name)
            if not isinstance(wrapper, dict):
                errors.append(f"{name} wrapper is missing")
                continue
            if wrapper.get("plaintext") != "vault_key" or wrapper.get("plaintext_bytes") != 32:
                errors.append(f"{name} wrapper must contain the same 32-byte Vault Key")
            context = wrapper.get("kdf_context")
            required_context = {"protocol_version", "suite_id", "source_deployment_id", "vault_id", "key_generation"}
            if not isinstance(context, list) or not required_context <= set(context):
                errors.append(f"{name} wrapper context is missing mandatory bindings")

    if nested(contract, "key_confirmation", "required") is not True:
        errors.append("key confirmation must be required")
    if nested(contract, "key_confirmation", "storage_identity") != [
        "principal_id",
        "vault_id",
        "veyora-key-confirmation-v1",
    ]:
        errors.append("key confirmation storage identity must be principal/Vault scoped")

    password_change = nested(contract, "transactions", "password_change")
    if not isinstance(password_change, dict):
        errors.append("password change transaction is missing")
    else:
        if password_change.get("vault_key") != "unchanged":
            errors.append("password change must keep the Vault Key unchanged")
        if password_change.get("item_ciphertext") != "unchanged":
            errors.append("password change must not re-encrypt items")
        if "atomic-cas-replace-password-wrapper-only" not in password_change.get("steps", []):
            errors.append("password change must atomically replace only its wrapper")
    recovery = nested(contract, "transactions", "recovery")
    if not isinstance(recovery, dict) or recovery.get("requires_prior_local_state") is not False:
        errors.append("recovery must work without prior local application state")
    rotation = nested(contract, "transactions", "vault_key_rotation")
    if not isinstance(rotation, dict) or rotation.get("separate_from_password_change") is not True:
        errors.append("Vault Key rotation must be separate from password change")

    backup = contract.get("portable_backup")
    if not isinstance(backup, dict):
        errors.append("portable backup contract is missing")
    else:
        header_fields = backup.get("required_header_fields")
        required_header_fields = {
            "protocol_version",
            "suite_id",
            "backup_format_version",
            "vault_id",
            "backup_id",
            "key_generation",
            "password_wrapper",
            "recovery_wrapper",
            "key_confirmation",
            "item_count",
            "tombstone_count",
            "minimum_reader_version",
            "maximum_reader_version",
        }
        if not isinstance(header_fields, list) or not required_header_fields <= set(header_fields):
            errors.append("portable backup header omits required identity/wrapper/compatibility fields")
        if "atomic-rename-over-destination" not in backup.get("write_protocol", []):
            errors.append("portable backup write protocol must atomically finalize")
        if "restore-into-empty-staging" not in backup.get("restore_protocol", []):
            errors.append("portable backup restore must use empty staging")

    compatibility = contract.get("compatibility")
    if not isinstance(compatibility, dict):
        errors.append("compatibility policy is missing")
    elif compatibility.get("unsupported_future_versions") != "reject-without-mutation":
        errors.append("unsupported future versions must fail without mutation")

    if cddl_path is not None:
        cddl = cddl_path.read_text(encoding="utf-8")
        for rule in (
            "password-wrapper-v1",
            "recovery-wrapper-v1",
            "key-confirmation-v1",
            "portable-backup-header-v1",
            "portable-backup-final-plaintext-v1",
            "portable-backup-v1",
        ):
            if re.search(rf"(?m)^{re.escape(rule)}\s*=", cddl) is None:
                errors.append(f"key lifecycle CDDL is missing rule: {rule}")

    evidence = contract.get("evidence")
    if not isinstance(evidence, dict):
        errors.append("key lifecycle evidence must be an object")
    else:
        validate_project_vectors(root, evidence, errors)
        validate_backup_vectors(root, evidence, errors)
        dispositions: list[str] = []
        try:
            project = load_object(root / evidence["project_crypto_corpus"])
            project_by_id = {item["id"]: item for item in project["vectors"]}
            dispositions.extend(
                project_by_id[item]["review"]["disposition"]
                for item in PROJECT_VECTOR_IDS
            )
            backup_corpus = load_object(root / evidence["backup_corpus"])
            dispositions.extend(
                backup_corpus["fixtures"][item]["review"]["disposition"]
                for item in BACKUP_FIXTURE_IDS
            )
        except (KeyError, TypeError, OSError, UnicodeError, json.JSONDecodeError, ValueError):
            pass
        current = evidence.get("current_review_disposition")
        if any(value != "qualified-human-reviewed" for value in dispositions):
            if current != "ai-non-human-reviewed-not-security-approval":
                errors.append("vector evidence must not claim qualified review")
        elif current != "qualified-human-reviewed":
            errors.append("qualified vector evidence disposition is stale")

    validate_security_review(root, contract, errors)
    return errors


def validate_repository(root: Path = ROOT) -> list[str]:
    try:
        contract = load_object(root / CONTRACT_PATH)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        return [f"cannot read {CONTRACT_PATH}: {error}"]
    return validate_contract(root, contract)


def main() -> int:
    errors = validate_repository()
    if errors:
        for error in sorted(set(errors)):
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("key lifecycle contract check: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
