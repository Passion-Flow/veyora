#!/usr/bin/env python3
"""Regression tests for the key lifecycle contract validator."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CHECKER_PATH = ROOT / "tools/lint/check-key-lifecycle.py"
SPEC = importlib.util.spec_from_file_location("key_lifecycle_checker", CHECKER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load key lifecycle checker")
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


def contract() -> dict:
    return json.loads(
        (ROOT / "contracts/protocol/key-lifecycle-v1.json").read_text(encoding="utf-8")
    )


class KeyLifecycleContractTests(unittest.TestCase):
    def assert_rejected(self, value: dict, message: str) -> None:
        errors = CHECKER.validate_contract(ROOT, value)
        self.assertTrue(any(message in error for error in errors), errors)

    def test_repository_contract_and_bound_vectors_pass(self) -> None:
        self.assertEqual(CHECKER.validate_repository(ROOT), [])

    def test_human_derived_vault_key_is_rejected(self) -> None:
        value = copy.deepcopy(contract())
        value["primitives"]["vault_key"]["human_derived"] = True
        self.assert_rejected(value, "must not be human-derived")

    def test_password_change_cannot_reencrypt_items(self) -> None:
        value = copy.deepcopy(contract())
        value["transactions"]["password_change"]["item_ciphertext"] = "reencrypted"
        self.assert_rejected(value, "must not re-encrypt items")

    def test_portable_backup_cannot_omit_recovery_wrapper(self) -> None:
        value = copy.deepcopy(contract())
        value["portable_backup"]["required_header_fields"].remove("recovery_wrapper")
        self.assert_rejected(value, "omits required identity/wrapper/compatibility fields")

    def test_unapproved_design_cannot_claim_acceptance(self) -> None:
        value = copy.deepcopy(contract())
        value["status"] = "accepted"
        self.assert_rejected(value, "must remain proposed")

    def test_recovery_cannot_require_prior_local_state(self) -> None:
        value = copy.deepcopy(contract())
        value["transactions"]["recovery"]["requires_prior_local_state"] = True
        self.assert_rejected(value, "without prior local application state")

    def test_acceptance_requires_qualified_vector_review(self) -> None:
        value = copy.deepcopy(contract())
        value["status"] = "accepted"
        value["security_review"]["state"] = "qualified-human-approved"
        value["security_review"]["review_records"] = [
            "docs/security/reviews/key-lifecycle-v1/example.review-v1.json"
        ]
        self.assert_rejected(value, "requires qualified vector review")


if __name__ == "__main__":
    unittest.main()
