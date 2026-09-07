#!/usr/bin/env python3
"""Blocking-test policy lint (PRD QA-001).

Critical suites must be blocking. This lint refuses the known success
bypasses in CI workflow definitions and test suites:

- `continue-on-error` anywhere in a workflow (a failed step must fail);
- `|| true`, `|| exit 0`, `|| :`, `|| echo` swallowing a step's exit code
  (an existence probe guarded with `2>/dev/null || true` in a
  *conditional* is allowed only on an approved line, reviewed like the
  wording lint);
- `#[ignore]` in a Rust test file whose owning crate no CI step runs
  with `--ignored` (silent quarantine);
- `it.skip`/`test.skip`/`xit` in the browser suites.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
# Rust test files that own live-database or fuzz suites -> the crate whose
# `cargo test -p <crate>` invocation must carry --ignored in some CI step.
IGNORED_CRATES = {
    ROOT / "services" / "api" / "src" / "lib.rs": "api",
    ROOT / "packages" / "storage" / "postgres" / "src" / "lib.rs": "backend-postgres",
    ROOT / "packages" / "storage" / "sqlite" / "src" / "lib.rs": "backend-sqlite",
    ROOT / "packages" / "security-kernel" / "crates" / "kernel-core"
    / "tests" / "fuzz_boundaries.rs": "kernel-core",
}
BROWSER_SUITES = sorted((ROOT / "tests" / "e2e" / "web").glob("*.mjs"))

# Reviewed swallows: file -> list of distinctive fragments of the guarded
# line (each is a conditional existence probe whose exit code is fed to a
# branch, not a swallowed test result).
APPROVED_SWALLOWS = {
    "publish-images.yml": ("tagged_commit=",),
}

CONTINUE = re.compile(r"continue-on-error", re.I)
SWALLOW = re.compile(r"\|\|\s*(true|exit 0|:|echo)\b", re.I)
IGNORE_ATTR = re.compile(r"#\[(ignore|cfg\(ignore\))", re.I)
SKIP_JS = re.compile(r"\b(it|test|describe)\.(skip|todo)\b|\bxit\b|\bxdescribe\b")


def step_scripts(path: Path) -> list[str]:
    """Every `run:` script in the workflow, one string per step."""
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    scripts: list[str] = []
    for job in (document.get("jobs") or {}).values():
        for step in job.get("steps") or []:
            script = step.get("run")
            if isinstance(script, str):
                scripts.append(script)
    return scripts


def main() -> int:
    problems: list[str] = []
    scripts_by_workflow: dict[str, list[str]] = {}
    for path in WORKFLOWS:
        text = path.read_text(encoding="utf-8")
        scripts_by_workflow[path.name] = step_scripts(path)
        for number, line in enumerate(text.splitlines(), 1):
            if CONTINUE.search(line):
                problems.append(f"{path.name}:{number}: continue-on-error is forbidden")
            if SWALLOW.search(line):
                approved = APPROVED_SWALLOWS.get(path.name, ())
                if not any(fragment in line for fragment in approved):
                    problems.append(
                        f"{path.name}:{number}: swallowed exit code: {line.strip()[:70]!r}")
    for path, crate in IGNORED_CRATES.items():
        if not path.exists() or not IGNORE_ATTR.search(path.read_text(encoding="utf-8")):
            continue
        # Silent quarantine: the crate's ignored tests must be exercised by
        # a CI step whose cargo invocation carries both -p <crate> and
        # --ignored in the same run script.
        wired = any(
            f"-p {crate}" in script and "--ignored" in script
            for scripts in scripts_by_workflow.values()
            for script in scripts
        )
        if not wired:
            problems.append(
                f"{path.relative_to(ROOT)} has #[ignore] tests but no CI step "
                f"runs `cargo test -p {crate} -- --ignored`")
    for path in BROWSER_SUITES:
        text = path.read_text(encoding="utf-8")
        for number, line in enumerate(text.splitlines(), 1):
            if SKIP_JS.search(line):
                problems.append(
                    f"{path.name}:{number}: skipped browser test: {line.strip()[:70]!r}")
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print(f"blocking tests: PASS ({len(WORKFLOWS)} workflows, "
          f"{len(BROWSER_SUITES)} browser suites, ignored-tests wired)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
