import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[4]
TOOL = (
    PROJECT_ROOT
    / "tools"
    / "codegen"
    / "backend"
    / "generate_registry_projection.py"
)
CANONICAL = PROJECT_ROOT / "contracts" / "registry" / "settings.json"


class RegistryProjectionTests(unittest.TestCase):
    """The generator must be a deterministic function of the canonical registry."""

    def run_tool(self, mode):
        return subprocess.run(
            [sys.executable, str(TOOL), mode],
            cwd=PROJECT_ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )

    def build_from_bytes(self, raw):
        source = sys.path
        sys.path.insert(0, str(TOOL.parent))
        try:
            import generate_registry_projection as generator

            return generator.build(raw)
        finally:
            sys.path[:] = source

    def test_check_passes_on_the_tracked_output(self):
        completed = self.run_tool("--check")
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_projection_filters_backend_settings_and_binds_source_bytes(self):
        canonical = json.loads(CANONICAL.read_text(encoding="utf-8"))
        raw = CANONICAL.read_bytes()
        projected = json.loads(self.build_from_bytes(raw))
        backend_ids = sorted(
            setting["id"]
            for setting in canonical["settings"]
            if setting.get("owner") == "backend"
        )
        self.assertEqual(
            [setting["id"] for setting in projected["settings"]], backend_ids
        )
        metadata = projected["_generated"]
        self.assertEqual(
            metadata["source_integrity"],
            "sha256:" + hashlib.sha256(raw).hexdigest(),
        )
        self.assertTrue(metadata["read_only"])

    def test_changed_source_bytes_change_the_source_integrity(self):
        canonical = json.loads(CANONICAL.read_text(encoding="utf-8"))
        raw_a = json.dumps(canonical, sort_keys=True).encode("utf-8")
        altered = json.loads(json.dumps(canonical))
        altered["settings"][0]["description"] += " changed"
        raw_b = json.dumps(altered, sort_keys=True).encode("utf-8")
        digest_a = json.loads(self.build_from_bytes(raw_a))["_generated"][
            "source_integrity"
        ]
        digest_b = json.loads(self.build_from_bytes(raw_b))["_generated"][
            "source_integrity"
        ]
        self.assertNotEqual(digest_a, digest_b)

    def test_invalid_registry_is_rejected(self):
        with self.assertRaises(Exception):
            self.build_from_bytes(b'{"settings": "not-a-list"}')

    def test_tampered_output_differs_from_the_generated_bytes(self):
        expected = self.build_from_bytes(CANONICAL.read_bytes())
        tracked = (
            PROJECT_ROOT / "packages" / "config" / "registry.generated.json"
        ).read_text(encoding="utf-8")
        self.assertEqual(tracked, expected)
        tampered = tracked.replace('"read_only": true', '"read_only": false')
        self.assertNotEqual(tampered, expected)


if __name__ == "__main__":
    unittest.main()
