#!/usr/bin/env python3
"""Release test-plan drift lint (PRD QA-012).

`release/test-plan.md` is generated from the feature registry and the
ledger's recorded blockers — it must never be hand-edited or go stale.
This check regenerates the plan to a scratch file and fails on any diff
against the committed artifact, mirroring the codegen drift gate.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    with tempfile.NamedTemporaryFile(suffix=".md") as scratch:
        subprocess.run(
            ["python3", str(ROOT / "tools/release/generate-test-plan.py"),
             "--output", scratch.name],
            check=True, capture_output=True)
        committed = (ROOT / "release/test-plan.md").read_text(encoding="utf-8")
        generated = Path(scratch.name).read_text(encoding="utf-8")
    if committed != generated:
        print("ERROR: release/test-plan.md is stale or hand-edited; regenerate with")
        print("  python3 tools/release/generate-test-plan.py --output release/test-plan.md")
        return 1
    print("test plan: PASS (in sync with the registry and ledger)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
