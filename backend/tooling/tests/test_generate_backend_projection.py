import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[3]
TOOL = PROJECT_ROOT / "backend" / "tooling" / "generate_backend_projection.py"
REGISTRY = PROJECT_ROOT / "backend" / "config" / "registry.generated.json"
CAPABILITIES = (
    PROJECT_ROOT / "contracts" / "authorization" / "service-capabilities-v1.json"
)


class GenerateBackendProjectionTests(unittest.TestCase):
    def run_tool(self, registry, capabilities, output, mode):
        return subprocess.run(
            [
                sys.executable,
                str(TOOL),
                "--registry",
                str(registry),
                "--capabilities",
                str(capabilities),
                "--output",
                str(output),
                mode,
            ],
            cwd=PROJECT_ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=2,
        )

    def write_json(self, path, value):
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def assert_rejected(self, result, reason=None):
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("/tmp/", result.stderr)
        self.assertLessEqual(len(result.stderr), 320)
        if reason is not None:
            self.assertIn(reason, result.stderr)

    def test_write_is_deterministic_and_preserves_all_canonical_data(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory).resolve() / "generated.rs"
            first = self.run_tool(REGISTRY, CAPABILITIES, output, "--write")
            self.assertEqual(first.returncode, 0, first.stderr)
            expected = output.read_bytes()

            second = self.run_tool(REGISTRY, CAPABILITIES, output, "--write")
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(output.read_bytes(), expected)

            rendered = expected.decode("utf-8")
            self.assertEqual(rendered.count("GeneratedSettingSpec {"), 34)
            for kind in [
                "Integer",
                "DurationSeconds",
                "Bytes",
                "String",
                "Path",
                "StringList",
                "SecretReference",
            ]:
                self.assertIn(f"SettingKind::{kind}", rendered)
            for exact_contract_value in [
                "backend.snapshot.page-max-bytes",
                "^[a-z][a-z0-9_]*$",
                "^/run/config/",
                "verify-full",
                "bounded-ciphertext",
                "provisional-postgresql",
            ]:
                self.assertIn(exact_contract_value, rendered)
            self.assertIn("REGISTRY_FILE_SHA256", rendered)
            self.assertIn("CAPABILITIES_FILE_SHA256", rendered)
            self.assertIn("REGISTRY_SOURCE_INTEGRITY", rendered)

            registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
            for setting in registry["settings"]:
                marker = f'id: "{setting["id"]}"'
                self.assertIn(marker, rendered)
                row = rendered.split(marker, 1)[1].split("\n    GeneratedSettingSpec {", 1)[0]
                kind = setting["value"]["kind"]
                self.assertIn(f"SettingKind::{self.rust_kind(kind)}", row)
                for key, value in setting["bounds"]["operational"].items():
                    if isinstance(value, list):
                        for item in value:
                            self.assertIn(f'"{item}"', row)
                    elif isinstance(value, str):
                        self.assertIn(f'"{value}"', row)
                    else:
                        self.assertIn(f"{key}: Some({value})", row)
                policy = setting["value_policy"]
                self.assertIn(f"GeneratedValueMode::{policy['mode'].title()}", row)
                if "default" in policy:
                    self.assertIn(str(policy["default"]).lower(), row.lower())

    def test_check_accepts_exact_output_and_never_rewrites_it(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory).resolve() / "generated.rs"
            written = self.run_tool(REGISTRY, CAPABILITIES, output, "--write")
            self.assertEqual(written.returncode, 0, written.stderr)
            before = output.read_bytes()
            checked = self.run_tool(REGISTRY, CAPABILITIES, output, "--check")
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertEqual(output.read_bytes(), before)

    def test_rejects_altered_catalog_and_capability_schema_versions(self):
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        capabilities = json.loads(CAPABILITIES.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_path = root / "registry.json"
            capabilities_path = root / "capabilities.json"
            output = root / "generated.rs"

            altered_registry = copy.deepcopy(registry)
            altered_registry["_generated"]["catalog_version"] = 2
            self.write_json(registry_path, altered_registry)
            self.write_json(capabilities_path, capabilities)
            result = self.run_tool(registry_path, capabilities_path, output, "--write")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("catalog_version", result.stderr)

            self.write_json(registry_path, registry)
            altered_capabilities = copy.deepcopy(capabilities)
            altered_capabilities["schema_version"] = 2
            self.write_json(capabilities_path, altered_capabilities)
            result = self.run_tool(registry_path, capabilities_path, output, "--write")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("schema_version", result.stderr)

    def test_check_rejects_altered_source_or_emitted_digest(self):
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        capabilities = json.loads(CAPABILITIES.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_path = root / "registry.json"
            capabilities_path = root / "capabilities.json"
            output = root / "generated.rs"
            self.write_json(registry_path, registry)
            self.write_json(capabilities_path, capabilities)
            result = self.run_tool(registry_path, capabilities_path, output, "--write")
            self.assertEqual(result.returncode, 0, result.stderr)

            altered_registry = copy.deepcopy(registry)
            altered_registry["_generated"]["source_integrity"] = "sha256:" + "0" * 64
            self.write_json(registry_path, altered_registry)
            result = self.run_tool(registry_path, capabilities_path, output, "--check")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("integrity", result.stderr)

            self.write_json(registry_path, registry)
            rendered = output.read_text(encoding="utf-8")
            output.write_text(
                re.sub(r"sha256:[0-9a-f]{64}", "sha256:" + "0" * 64, rendered, count=1),
                encoding="utf-8",
            )
            result = self.run_tool(registry_path, capabilities_path, output, "--check")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stale", result.stderr)

    def test_rejects_unknown_setting_kind_instead_of_weakening_it(self):
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        registry["settings"][0]["value"]["kind"] = "number"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_path = root / "registry.json"
            capabilities_path = root / "capabilities.json"
            output = root / "generated.rs"
            self.write_json(registry_path, registry)
            capabilities_path.write_bytes(CAPABILITIES.read_bytes())
            result = self.run_tool(registry_path, capabilities_path, output, "--write")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("setting kind", result.stderr)

    def test_rejects_nonfinite_constants_and_duplicate_keys(self):
        capabilities = json.loads(CAPABILITIES.read_text(encoding="utf-8"))
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_path = root / "registry.json"
            capabilities_path = root / "capabilities.json"
            output = root / "generated.rs"
            self.write_json(capabilities_path, capabilities)

            registry["settings"][0]["description"] = float("nan")
            self.write_json(registry_path, registry)
            result = self.run_tool(registry_path, capabilities_path, output, "--write")
            self.assert_rejected(result, "non-finite")

            registry_path.write_text(
                '{"_generated": {}, "_generated": {}, "settings": []}\n',
                encoding="utf-8",
            )
            result = self.run_tool(registry_path, capabilities_path, output, "--write")
            self.assert_rejected(result, "duplicate JSON key")

    def test_rejects_wrong_types_in_every_registry_and_capability_section(self):
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        capabilities = json.loads(CAPABILITIES.read_text(encoding="utf-8"))
        mutations = [
            ("metadata banner", lambda r, c: r["_generated"].__setitem__("banner", 1)),
            ("metadata source", lambda r, c: r["_generated"].__setitem__("source", False)),
            ("classification", lambda r, c: r["settings"][0].__setitem__("classification", 1)),
            ("description", lambda r, c: r["settings"][0].__setitem__("description", [])),
            ("deprecation", lambda r, c: r["settings"][0].__setitem__("deprecation", [])),
            ("log policy", lambda r, c: r["settings"][0]["log_policy"].__setitem__("reason", 1)),
            ("precedence", lambda r, c: r["settings"][0].__setitem__("precedence", [1])),
            ("reload", lambda r, c: r["settings"][0].__setitem__("reload", 1)),
            ("safety bounds", lambda r, c: r["settings"][0]["bounds"].__setitem__("safety", [])),
            ("capability schema", lambda r, c: c.__setitem__("$schema", 1)),
            ("capability version bool", lambda r, c: c.__setitem__("schema_version", True)),
            ("capability item", lambda r, c: c["services"]["api"].__setitem__("routes", [1])),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_path = root / "registry.json"
            capabilities_path = root / "capabilities.json"
            output = root / "generated.rs"
            for label, mutate in mutations:
                with self.subTest(label=label):
                    altered_registry = copy.deepcopy(registry)
                    altered_capabilities = copy.deepcopy(capabilities)
                    mutate(altered_registry, altered_capabilities)
                    self.write_json(registry_path, altered_registry)
                    self.write_json(capabilities_path, altered_capabilities)
                    result = self.run_tool(
                        registry_path, capabilities_path, output, "--write"
                    )
                    self.assert_rejected(result)

    def test_rejects_inverted_bounds_unsupported_patterns_and_invalid_defaults(self):
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        capabilities = json.loads(CAPABILITIES.read_text(encoding="utf-8"))
        mutations = [
            lambda r: r["settings"][0]["bounds"]["operational"].update(
                minimum=17, maximum=16
            ),
            lambda r: r["settings"][8]["bounds"]["operational"].update(
                minimum_length=64, maximum_length=63
            ),
            lambda r: r["settings"][8]["bounds"]["operational"].__setitem__(
                "pattern", ".*"
            ),
            lambda r: r["settings"][0]["value_policy"].__setitem__("default", 99),
            lambda r: self.setting(r, "backend.log.level")["value_policy"].__setitem__(
                "default", "verbose"
            ),
            lambda r: self.setting(r, "backend.database.schema")["value_policy"].__setitem__(
                "default", "Bad-Name"
            ),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_path = root / "registry.json"
            capabilities_path = root / "capabilities.json"
            output = root / "generated.rs"
            self.write_json(capabilities_path, capabilities)
            for index, mutate in enumerate(mutations):
                with self.subTest(index=index):
                    altered = copy.deepcopy(registry)
                    mutate(altered)
                    self.write_json(registry_path, altered)
                    result = self.run_tool(
                        registry_path, capabilities_path, output, "--write"
                    )
                    self.assert_rejected(result)

    def test_rejects_recomputed_integrity_cross_policy_safety_violations(self):
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        mutations = [
            (
                "numeric maximum removed while safety retains it",
                lambda r: self.setting(
                    r, "backend.database.connect-timeout-seconds"
                )["bounds"]["operational"].pop("maximum"),
            ),
            (
                "numeric minimum removed while safety retains it",
                lambda r: self.setting(
                    r, "backend.database.connect-timeout-seconds"
                )["bounds"]["operational"].pop("minimum"),
            ),
            (
                "numeric maximum above safety ceiling",
                lambda r: self.setting(
                    r, "backend.database.connect-timeout-seconds"
                )["bounds"]["operational"].__setitem__("maximum", 31),
            ),
            (
                "numeric minimum below safety floor",
                lambda r: self.setting(r, "backend.database.connect-timeout-seconds")[
                    "bounds"
                ]["operational"].__setitem__("minimum", 0),
            ),
            (
                "item maximum removed while safety retains it",
                lambda r: self.setting(r, "backend.database.hosts")["bounds"][
                    "operational"
                ].pop("maximum_items"),
            ),
            (
                "item minimum removed while safety retains it",
                lambda r: self.setting(r, "backend.database.hosts")["bounds"][
                    "operational"
                ].pop("minimum_items"),
            ),
            (
                "item maximum above safety ceiling",
                lambda r: self.setting(r, "backend.database.hosts")["bounds"][
                    "operational"
                ].__setitem__("maximum_items", 17),
            ),
            (
                "item minimum below safety floor",
                lambda r: self.setting(r, "backend.database.hosts")["bounds"][
                    "operational"
                ].__setitem__("minimum_items", 0),
            ),
            (
                "length minimum removed while safety retains it",
                lambda r: self.remove_operational_constraint(
                    r, "backend.database.name", "minimum_length", 1
                ),
            ),
            (
                "length maximum removed while safety retains it",
                lambda r: self.setting(r, "backend.database.name")["bounds"][
                    "operational"
                ].pop("maximum_length"),
            ),
            (
                "length maximum above safety ceiling",
                lambda r: self.setting(r, "backend.database.name")["bounds"][
                    "operational"
                ].__setitem__("maximum_length", 64),
            ),
            ("length minimum below safety floor", self.lower_operational_length_floor),
            (
                "allowed set removed while safety retains it",
                lambda r: self.remove_operational_constraint(
                    r, "backend.database.name", "allowed", ["veyora"]
                ),
            ),
            (
                "operational allowed set exceeds safety set",
                lambda r: self.setting(r, "backend.log.level")["bounds"][
                    "operational"
                ]["allowed"].append("trace"),
            ),
            (
                "operational pattern removed while safety retains it",
                lambda r: self.setting(r, "backend.database.name")["bounds"][
                    "operational"
                ].pop("pattern"),
            ),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_path = root / "registry.json"
            capabilities_path = root / "capabilities.json"
            output = root / "generated.rs"
            capabilities_path.write_bytes(CAPABILITIES.read_bytes())
            for label, mutate in mutations:
                with self.subTest(label=label):
                    altered = copy.deepcopy(registry)
                    mutate(altered)
                    self.refresh_projection_integrity(altered)
                    self.write_json(registry_path, altered)
                    output.write_bytes(b"existing checked output\n")
                    before = (
                        registry_path.read_bytes(),
                        capabilities_path.read_bytes(),
                        output.read_bytes(),
                    )
                    result = self.run_tool(
                        registry_path, capabilities_path, output, "--write"
                    )
                    after = (
                        registry_path.read_bytes(),
                        capabilities_path.read_bytes(),
                        output.read_bytes(),
                    )
                    self.assertTrue(
                        result.returncode != 0 and after == before,
                        f"returncode={result.returncode}; files_unchanged={after == before}",
                    )
                    self.assert_rejected(result)
                    if "removed while" not in label:
                        self.assertIn("safety", result.stderr)

    def test_rejects_symlinked_and_nonregular_paths_in_both_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_link = root / "registry-link.json"
            capabilities_link = root / "capabilities-link.json"
            output = root / "generated.rs"
            registry_link.symlink_to(REGISTRY)
            capabilities_link.symlink_to(CAPABILITIES)
            for mode in ("--check", "--write"):
                with self.subTest(path="registry symlink", mode=mode):
                    result = self.run_tool(
                        registry_link, CAPABILITIES, root / f"registry-{mode}.rs", mode
                    )
                    self.assert_rejected(result, "regular file")
                with self.subTest(path="capabilities symlink", mode=mode):
                    result = self.run_tool(
                        REGISTRY, capabilities_link, root / f"capabilities-{mode}.rs", mode
                    )
                    self.assert_rejected(result, "regular file")

            output.symlink_to(REGISTRY)
            before = REGISTRY.read_bytes()
            for mode in ("--check", "--write"):
                with self.subTest(path="output symlink", mode=mode):
                    result = self.run_tool(REGISTRY, CAPABILITIES, output, mode)
                    self.assert_rejected(result, "regular file")
                    self.assertEqual(REGISTRY.read_bytes(), before)

            output.unlink()
            output.mkdir()
            for mode in ("--check", "--write"):
                with self.subTest(path="output directory", mode=mode):
                    result = self.run_tool(REGISTRY, CAPABILITIES, output, mode)
                    self.assert_rejected(result, "regular file")

            for label, registry_path, capabilities_path in (
                ("registry directory", root, CAPABILITIES),
                ("capabilities directory", REGISTRY, root),
            ):
                for mode in ("--check", "--write"):
                    with self.subTest(path=label, mode=mode):
                        result = self.run_tool(
                            registry_path,
                            capabilities_path,
                            root / f"nonregular-{label}-{mode}.rs",
                            mode,
                        )
                        self.assert_rejected(result, "regular file")

            fifo = root / "registry.fifo"
            os.mkfifo(fifo)
            for mode in ("--check", "--write"):
                try:
                    result = self.run_tool(
                        fifo, CAPABILITIES, root / f"fifo-{mode}.rs", mode
                    )
                except subprocess.TimeoutExpired:
                    self.fail("generator opened a non-regular FIFO")
                self.assert_rejected(result, "regular file")

    def test_rejects_source_output_aliases_without_changing_any_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for output_name in ("registry.json", "capabilities.json"):
                with self.subTest(alias="same path", output=output_name):
                    case = root / output_name.replace(".json", "")
                    case.mkdir()
                    registry_path = case / "registry.json"
                    capabilities_path = case / "capabilities.json"
                    registry_path.write_bytes(REGISTRY.read_bytes())
                    capabilities_path.write_bytes(CAPABILITIES.read_bytes())
                    original_registry = registry_path.read_bytes()
                    original_capabilities = capabilities_path.read_bytes()
                    output = case / output_name
                    result = self.run_tool(
                        registry_path, capabilities_path, output, "--write"
                    )
                    self.assert_rejected(result, "alias")
                    self.assertEqual(registry_path.read_bytes(), original_registry)
                    self.assertEqual(capabilities_path.read_bytes(), original_capabilities)

            hardlink_case = root / "hardlink"
            hardlink_case.mkdir()
            registry_path = hardlink_case / "registry.json"
            capabilities_path = hardlink_case / "capabilities.json"
            registry_path.write_bytes(REGISTRY.read_bytes())
            capabilities_path.write_bytes(CAPABILITIES.read_bytes())
            original_registry = registry_path.read_bytes()
            hardlink = hardlink_case / "hardlink.rs"
            os.link(registry_path, hardlink)
            result = self.run_tool(
                registry_path, capabilities_path, hardlink, "--write"
            )
            self.assert_rejected(result, "alias")
            self.assertEqual(registry_path.read_bytes(), original_registry)
            self.assertEqual(hardlink.read_bytes(), original_registry)

    def test_rejection_never_partially_replaces_an_existing_output(self):
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        registry["settings"][0]["value_policy"]["default"] = 99
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            registry_path = root / "registry.json"
            capabilities_path = root / "capabilities.json"
            output = root / "generated.rs"
            self.write_json(registry_path, registry)
            capabilities_path.write_bytes(CAPABILITIES.read_bytes())
            output.write_bytes(b"existing checked output\n")
            before = (
                registry_path.read_bytes(),
                capabilities_path.read_bytes(),
                output.read_bytes(),
            )
            result = self.run_tool(registry_path, capabilities_path, output, "--write")
            self.assert_rejected(result)
            self.assertEqual(
                (
                    registry_path.read_bytes(),
                    capabilities_path.read_bytes(),
                    output.read_bytes(),
                ),
                before,
            )

    @staticmethod
    def rust_kind(kind):
        return {
            "integer": "Integer",
            "duration-seconds": "DurationSeconds",
            "bytes": "Bytes",
            "string": "String",
            "path": "Path",
            "string-list": "StringList",
            "secret-reference": "SecretReference",
        }[kind]

    @staticmethod
    def setting(registry, setting_id):
        return next(item for item in registry["settings"] if item["id"] == setting_id)

    @classmethod
    def lower_operational_length_floor(cls, registry):
        bounds = cls.setting(registry, "backend.database.name")["bounds"]
        bounds["operational"]["minimum_length"] = 0
        bounds["safety"]["minimum_length"] = 1

    @classmethod
    def remove_operational_constraint(cls, registry, setting_id, key, safety_value):
        bounds = cls.setting(registry, setting_id)["bounds"]
        bounds["operational"][key] = safety_value
        bounds["safety"][key] = safety_value
        bounds["operational"].pop(key)

    @staticmethod
    def refresh_projection_integrity(registry):
        generated = {
            key: value
            for key, value in registry["_generated"].items()
            if key != "projection_integrity"
        }
        encoded = json.dumps(
            {"generated": generated, "settings": registry["settings"]},
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        registry["_generated"]["projection_integrity"] = (
            "sha256:" + hashlib.sha256(encoded).hexdigest()
        )


if __name__ == "__main__":
    unittest.main()
