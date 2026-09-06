#!/usr/bin/env python3
"""Detect drift between the pinned container foundation digests (DEP-007).

The release workflow (.github/workflows/publish-images.yml) and the local
publish script (tools/release/publish-containers.sh) must mirror exactly the
same digest-pinned upstream foundations, and every Dockerfile default base
tag must be the tag side of one of those pins. A change in either place
without the other is silent supply-chain drift; this check makes it fail.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/publish-images.yml"
SCRIPT = ROOT / "tools/release/publish-containers.sh"
DOCKERFILES = {
    "deploy/containers/api/Dockerfile",
    "deploy/containers/backup/Dockerfile",
    "deploy/containers/migrator/Dockerfile",
    "deploy/containers/restore/Dockerfile",
    "deploy/containers/validator/Dockerfile",
    "deploy/containers/worker/Dockerfile",
    "deploy/gateway/Dockerfile",
    "deploy/web/Dockerfile",
}
PIN = re.compile(r"([a-z0-9./_-]+:[a-z0-9][a-z0-9._-]*)@sha256:([0-9a-f]{64})")
BASE_ARG = re.compile(r"^ARG\s+(RUST_IMAGE|DEBIAN_IMAGE|NGINX_IMAGE|ENVOY_IMAGE|BASE_IMAGE)=(\S+)$", re.MULTILINE)


def pins_in(text: str) -> dict[str, str]:
    return {repo: digest for repo, digest in PIN.findall(text)}


def validate(root: Path = ROOT) -> list[str]:
    errors: list[str] = []

    workflow_pins = pins_in(WORKFLOW.read_text(encoding="utf-8"))
    script_pins = pins_in(SCRIPT.read_text(encoding="utf-8"))

    if not workflow_pins:
        errors.append("no digest pins found in the publish workflow")
    if not script_pins:
        errors.append("no digest pins found in tools/release/publish-containers.sh")
    if workflow_pins != script_pins:
        only_workflow = sorted(set(workflow_pins) - set(script_pins))
        only_script = sorted(set(script_pins) - set(workflow_pins))
        changed = sorted(
            repo
            for repo in set(workflow_pins) & set(script_pins)
            if workflow_pins[repo] != script_pins[repo]
        )
        if only_workflow:
            errors.append(f"pins only in the workflow: {only_workflow}")
        if only_script:
            errors.append(f"pins only in the publish script: {only_script}")
        if changed:
            errors.append(f"pins with different digests: {changed}")

    pinned_repos = {pin.split("@")[0] for pin in workflow_pins}

    for relative in sorted(DOCKERFILES):
        path = root / relative
        if not path.exists():
            errors.append(f"missing Dockerfile: {relative}")
            continue
        for _arg_name, default in BASE_ARG.findall(path.read_text(encoding="utf-8")):
            # The Dockerfile defaults are the upstream tags only; registry
            # mirrors are injected as build args by the publish paths and
            # never appear as defaults.
            if default not in pinned_repos:
                errors.append(
                    f"{relative}: base default {default!r} is not one of the "
                    f"digest-pinned foundations {sorted(pinned_repos)}"
                )

    return errors


def main() -> int:
    errors = validate()
    for error in errors:
        print(f"foundation pin check: {error}", file=sys.stderr)
    if errors:
        return 1
    print("foundation pin check: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
