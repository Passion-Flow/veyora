#!/usr/bin/env python3
"""Regression tests for the pairing/session contract validator."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CHECKER_PATH = ROOT / "tools/lint/check-pairing-session.py"
SPEC = importlib.util.spec_from_file_location("pairing_session_checker", CHECKER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load pairing session checker")
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


def contract() -> dict:
    return json.loads(
        (ROOT / "contracts/protocol/pairing-session-v1.json").read_text(encoding="utf-8")
    )


class PairingSessionContractTests(unittest.TestCase):
    def assert_rejected(self, value: dict, message: str) -> None:
        errors = CHECKER.validate_contract(ROOT, value)
        self.assertTrue(any(message in error for error in errors), errors)

    def test_repository_contract_passes(self) -> None:
        self.assertEqual(CHECKER.validate_repository(ROOT), [])

    def test_password_derived_credential_is_rejected(self) -> None:
        value = copy.deepcopy(contract())
        value["connection_credential"]["derived_from_master_password"] = True
        self.assert_rejected(value, "derived_from_master_password")

    def test_plaintext_server_storage_is_rejected(self) -> None:
        value = copy.deepcopy(contract())
        value["connection_credential"]["plaintext_server_storage"] = True
        self.assert_rejected(value, "plaintext_server_storage")

    def test_localstorage_bearer_is_rejected_as_forbidden_storage(self) -> None:
        value = copy.deepcopy(contract())
        value["client_storage"]["forbidden"].remove("localStorage-bearer-token")
        self.assert_rejected(value, "client_storage.forbidden")

    def test_unscoped_authorization_is_rejected(self) -> None:
        value = copy.deepcopy(contract())
        value["authorization"]["scope_source"] = "query-parameters"
        self.assert_rejected(value, "scope_source")

    def test_client_side_filtering_as_isolation_is_rejected(self) -> None:
        value = copy.deepcopy(contract())
        value["authorization"]["client_side_filtering_as_isolation"] = True
        self.assert_rejected(value, "client_side_filtering_as_isolation")

    def test_deployment_token_cannot_authorize_records(self) -> None:
        value = copy.deepcopy(contract())
        value["deployment_token"]["authorizes_record_access"] = True
        self.assert_rejected(value, "authorizes_record_access")

    def test_unbounded_rotation_overlap_is_rejected(self) -> None:
        value = copy.deepcopy(contract())
        value["lifecycle"]["rotation"]["overlap_minutes"] = 10_000_000
        self.assert_rejected(value, "overlap_minutes")

    def test_open_error_surface_is_rejected(self) -> None:
        value = copy.deepcopy(contract())
        value["error_codes"].append("PM-AUTH-SOMETHING-ELSE")
        self.assert_rejected(value, "error_codes")

    def test_unapproved_design_cannot_claim_acceptance(self) -> None:
        value = copy.deepcopy(contract())
        value["status"] = "accepted"
        self.assert_rejected(value, "must remain proposed-security-review-required")

    def test_review_records_cannot_appear_while_proposed(self) -> None:
        value = copy.deepcopy(contract())
        value["security_review"]["state"] = "qualified-human-approved"
        self.assert_rejected(value, "security_review.state")


if __name__ == "__main__":
    unittest.main()
