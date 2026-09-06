#!/usr/bin/env python3
"""Validate the proposed Veyora scoped pairing/session contract authority.

Checks the machine-readable invariants of ADR 0005 (DEC-002): credential
entropy and non-derivability, forbidden client storage, bounded lifecycle
parameters, server-side scope enforcement, the closed error-code surface,
and the proposed-only status until a qualified review is recorded.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = "contracts/protocol/pairing-session-v1.json"

REQUIREMENTS = {"UX-AUTH-007", "UX-AUTH-008", "API-001", "API-002", "API-003", "DEP-004", "DEP-005"}
ERROR_CODES = {
    "PM-AUTH-PAIRING-INVALID",
    "PM-AUTH-PAIRING-EXPIRED",
    "PM-AUTH-CREDENTIAL-REVOKED",
    "PM-AUTH-SESSION-EXPIRED",
    "PM-AUTH-RATE-LIMITED",
}


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"top-level JSON object required: {path}")
    return value


def nested(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def require_exact(
    value: dict[str, Any], keys: tuple[str, ...], expected: Any, errors: list[str]
) -> None:
    label = ".".join(keys)
    actual = nested(value, *keys)
    if actual != expected:
        errors.append(f"{label} must be {expected!r} (got {actual!r})")


def require_positive_int(
    value: dict[str, Any], keys: tuple[str, ...], errors: list[str], maximum: int
) -> None:
    label = ".".join(keys)
    actual = nested(value, *keys)
    if not isinstance(actual, int) or isinstance(actual, bool) or not 0 < actual <= maximum:
        errors.append(f"{label} must be a bounded positive integer <= {maximum} (got {actual!r})")


def validate_contract(root: Path, value: dict[str, Any]) -> list[str]:
    """Validate a pairing/session contract document against the ADR rules."""
    errors: list[str] = []

    if value.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    if value.get("contract_id") != "veyora-pairing-session-v1":
        errors.append("contract_id must be veyora-pairing-session-v1")

    design = value.get("design_document")
    if not isinstance(design, str) or not (root / design).exists():
        errors.append(f"design_document must exist in the repository (got {design!r})")

    requirements = value.get("requirements")
    if not isinstance(requirements, list):
        errors.append("requirements must be an array")
    else:
        if set(requirements) != REQUIREMENTS:
            errors.append(
                "requirements must be exactly "
                f"{sorted(REQUIREMENTS)} (got {sorted(set(requirements))})"
            )

    # Credential shape: high-entropy, CSPRNG, never password-derived, hashed
    # server-side, authenticated context includes the full scope.
    require_exact(value, ("connection_credential", "source"), "operating-system-csprng", errors)
    require_exact(value, ("connection_credential", "human_derived"), False, errors)
    require_exact(value, ("connection_credential", "derived_from_master_password"), False, errors)
    require_exact(value, ("connection_credential", "plaintext_server_storage"), False, errors)
    require_positive_int(value, ("connection_credential", "entropy_bytes"), errors, 4096)
    context = nested(value, "connection_credential", "authenticated_context")
    if not isinstance(context, list) or not {
        "protocol_version",
        "principal_id",
        "device_id",
        "credential_generation",
        "credential_purpose",
    } <= set(context):
        errors.append("authenticated_context must bind principal, device, generation, and purpose")

    # Client storage boundaries (UX-AUTH-008).
    require_exact(value, ("client_storage", "desktop"), "operating-system-credential-store", errors)
    forbidden = nested(value, "client_storage", "forbidden")
    if not isinstance(forbidden, list) or not {
        "localStorage-bearer-token",
        "plaintext-file-beside-vault",
        "query-parameter",
    } <= set(forbidden):
        errors.append("client_storage.forbidden must list localStorage, plaintext file, and query parameter")
    require_exact(value, ("web_session_cookie", "http_only"), True, errors)
    require_exact(value, ("web_session_cookie", "secure"), True, errors)
    require_exact(value, ("web_session_cookie", "same_site"), "Strict", errors)
    require_exact(value, ("web_session_cookie", "in_memory_mirror_only"), True, errors)

    # Deployment token is bootstrap-only.
    require_exact(value, ("deployment_token", "authorizes_record_access"), False, errors)
    require_exact(value, ("deployment_token", "reaches_client"), False, errors)

    # Bounded lifecycle parameters.
    require_exact(value, ("lifecycle", "pairing", "code_single_use"), True, errors)
    require_positive_int(value, ("lifecycle", "pairing", "code_entropy_bytes"), errors, 512)
    require_positive_int(value, ("lifecycle", "pairing", "code_ttl_minutes"), errors, 24 * 60)
    require_positive_int(value, ("lifecycle", "rotation", "overlap_minutes"), errors, 24 * 60)
    require_exact(value, ("lifecycle", "rotation", "old_generation_dead_after_overlap"), True, errors)
    require_exact(value, ("lifecycle", "revocation", "immediate"), True, errors)
    require_exact(value, ("lifecycle", "revocation", "idempotent"), True, errors)
    require_positive_int(value, ("lifecycle", "expiry", "absolute_days"), errors, 366 * 5)
    require_positive_int(value, ("lifecycle", "expiry", "idle_days"), errors, 366 * 5)

    # Server-side authorization is the isolation boundary (API-001, DATA-002).
    require_exact(value, ("authorization", "scope_source"), "authenticated-session-context-only", errors)
    require_exact(value, ("authorization", "client_side_filtering_as_isolation"), False, errors)
    require_exact(value, ("authorization", "cross_scope_access"), "forbidden", errors)

    # Closed, stable error-code surface (DIAG-003 family).
    codes = value.get("error_codes")
    if not isinstance(codes, list) or set(codes) != ERROR_CODES:
        errors.append(f"error_codes must be exactly {sorted(ERROR_CODES)} (got {codes!r})")

    # Status gate: nothing is Accepted without a recorded qualified review.
    status = value.get("status")
    if status == "accepted":
        errors.append(
            "status must remain proposed-security-review-required until a qualified "
            "independent review is recorded through the reviewer registry"
        )
    elif status != "proposed-security-review-required":
        errors.append(f"unknown status {status!r}")

    review = value.get("security_review")
    if not isinstance(review, dict):
        errors.append("security_review must be an object")
    else:
        if review.get("state") != "not-reviewed":
            errors.append("security_review.state must remain not-reviewed while the ADR is Proposed")
        if review.get("review_records"):
            errors.append("security_review.review_records must stay empty while the ADR is Proposed")
        registry = review.get("reviewer_registry")
        if not isinstance(registry, str) or not (root / registry).exists():
            errors.append(f"security_review.reviewer_registry must exist (got {registry!r})")

    return errors


def validate_repository(root: Path = ROOT) -> list[str]:
    """Validate the repository's pairing/session contract in place."""
    contract_path = root / CONTRACT_PATH
    if not contract_path.exists():
        return [f"missing contract: {CONTRACT_PATH}"]
    return validate_contract(root, load_object(contract_path))


def main() -> int:
    errors = validate_repository()
    for error in errors:
        print(f"pairing-session contract check: {error}", file=sys.stderr)
    if errors:
        return 1
    print("pairing-session contract check: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
