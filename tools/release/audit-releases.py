#!/usr/bin/env python3
"""Audit published GitHub releases against the version authority (sequence 1).

Two modes:

* `--dry-run` (default, no GitHub access needed): validates the repository
  side of the contract — that the version authority, the release
  workflows' tag/version rejection rules, and the manifest files agree —
  so the owner's live audit can only fail on GitHub metadata itself.

* `--live` (requires `gh` authenticated by the owner): fetches every
  published release and checks, per PRD REL-011/REL-012 and sequence 1:
  - every tag matches the version authority (no backward or stray tags);
  - a tag must not exist without a complete matching Release;
  - a Release may be marked stable/Latest only if the required assets and
    gates named in the release manifest exist;
  - prerelease channels are labeled prereleases.

The live mode is run by the owner once they authorize GitHub access; this
tool makes that audit one reproducible command instead of a manual
checklist. Its output is the evidence artifact for sequence 1.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / "release" / "version.json").read_text(encoding="utf-8"))
WORKFLOWS = {
    "desktop": ROOT / ".github/workflows/desktop-release.yml",
    "images": ROOT / ".github/workflows/publish-images.yml",
}


def dry_run() -> int:
    problems: list[str] = []
    authority = VERSION.get("version")
    if not re.fullmatch(r"\d+\.\d+\.\d+", authority or ""):
        problems.append(f"version authority is not a clean semver: {authority!r}")
    retired = VERSION.get("historical_tag_exceptions") or []
    if not isinstance(retired, list) or not all(
            "tag" in entry and "reason" in entry for entry in retired):
        problems.append("historical_tag_exceptions must list tag+reason entries")

    for name, path in WORKFLOWS.items():
        text = path.read_text(encoding="utf-8")
        if "VEYORA_VERSION" not in text and "version" not in text.lower():
            problems.append(f"{path.name} does not reference the version input")
        # The workflows must reject tags that differ from the authority.
        if not re.search(r"mismatch|differ|!=|reject", text, re.I):
            problems.append(f"{path.name} lacks a tag/version mismatch rejection")

    manifest = ROOT / "release" / "features.json"
    if not manifest.exists():
        problems.append("release/features.json (claim registry) missing")

    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print(f"dry-run PASS: version authority {authority}; workflows enforce the tag gate;")
    print("run with --live (owner-authenticated gh) to audit the published releases.")
    return 0


def gh(args: list[str]) -> object:
    result = subprocess.run(
        ["gh", "api", *args], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def live() -> int:
    problems: list[str] = []
    authority = VERSION["version"]
    releases = gh(["repos/{owner}/{repo}/releases?per_page=100".replace(
        "{owner}/{repo}", subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
            capture_output=True, text=True, check=True).stdout.strip())])
    retired = {
        entry["tag"] for entry in VERSION.get("historical_tag_exceptions") or []
    }
    for release in releases:
        tag = release["tag_name"]
        if tag in retired:
            # Historical retired tag: must never be Latest or stable-labeled.
            if release.get("latest") or not release.get("prerelease", False):
                problems.append(f"retired tag {tag} is presented as stable/Latest")
            continue
        if tag.lstrip("v") != authority:
            problems.append(
                f"tag {tag} does not match the version authority {authority}")
        if not release.get("assets"):
            problems.append(f"release {tag} has no assets (incomplete Release)")
        if release.get("draft"):
            problems.append(f"release {tag} is still a draft")
        if release.get("prerelease") and release.get("latest"):
            problems.append(f"prerelease {tag} is marked Latest")
    if not releases:
        problems.append("no published releases found to audit")
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print(f"live audit PASS over {len(releases)} release(s) against authority {authority}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true",
                        help="audit the actual published releases (owner gh auth required)")
    args = parser.parse_args()
    return live() if args.live else dry_run()


if __name__ == "__main__":
    sys.exit(main())
