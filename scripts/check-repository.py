#!/usr/bin/env python3
"""Validate the public source tree without external dependencies."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
MAX_FILE_BYTES = 5 * 1024 * 1024

FORBIDDEN_PATH_PARTS = {
    "." + "planning",
    "." + "superpowers",
    "__pycache__",
    "node_modules",
    "target",
}

FORBIDDEN_TEXT = {
    "co" + "dex": "assistant-specific attribution",
    "clau" + "de": "assistant-specific attribution",
    "/us" + "ers/": "developer-specific absolute path",
    "/ho" + "me/": "developer-specific absolute path",
    "/ro" + "ot/": "developer-specific absolute path",
    "." + "planning/": "private planning path",
    "." + "superpowers/": "private planning path",
}

TEXT_SUFFIXES = {
    ".c",
    ".css",
    ".html",
    ".java",
    ".js",
    ".json",
    ".kts",
    ".md",
    ".py",
    ".rs",
    ".sh",
    ".sql",
    ".svg",
    ".toml",
    ".ts",
    ".yaml",
    ".yml",
}

MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")


def iter_files() -> list[Path]:
    """Yield tracked files only, so local build output and dependency trees
    (node_modules, target/, .env, untracked notes) never trip the checks."""
    listing = subprocess.run(
        ["git", "ls-files"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
        timeout=60,
    )
    return sorted(ROOT / line for line in listing.stdout.splitlines() if line)


def check_paths(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        relative = path.relative_to(ROOT)
        if path.is_symlink():
            errors.append(f"symlink is not allowed: {relative}")
        if FORBIDDEN_PATH_PARTS.intersection(relative.parts):
            errors.append(f"private or generated path is present: {relative}")
        if path.stat().st_size > MAX_FILE_BYTES:
            errors.append(f"file exceeds 5 MiB: {relative}")
    return errors


def read_text(path: Path) -> str | None:
    if path.suffix.lower() not in TEXT_SUFFIXES and path.name not in {
        ".dockerignore",
        ".env.example",
        ".gitignore",
        "LICENSE",
        "Makefile",
        "NOTICE",
    }:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return None


def check_text(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        text = read_text(path)
        if text is None:
            continue
        lowered = text.lower()
        relative = path.relative_to(ROOT)
        for marker, description in FORBIDDEN_TEXT.items():
            if marker in lowered:
                errors.append(f"{description} in {relative}")
    return errors


def check_json(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        if path.suffix.lower() != ".json":
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            errors.append(f"invalid JSON in {path.relative_to(ROOT)}: {error}")
    return errors


def check_markdown_links(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        if path.suffix.lower() != ".md":
            continue
        text = path.read_text(encoding="utf-8")
        for raw_target in MARKDOWN_LINK.findall(text):
            target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target_path = unquote(target.split("#", 1)[0])
            if not target_path:
                continue
            resolved = (path.parent / target_path).resolve()
            try:
                resolved.relative_to(ROOT)
            except ValueError:
                errors.append(
                    f"relative link escapes the repository in {path.relative_to(ROOT)}: {target}"
                )
                continue
            if not resolved.exists():
                errors.append(
                    f"broken relative link in {path.relative_to(ROOT)}: {target}"
                )
    return errors


def main() -> int:
    paths = iter_files()
    errors = [
        *check_paths(paths),
        *check_text(paths),
        *check_json(paths),
        *check_markdown_links(paths),
    ]
    if errors:
        for error in sorted(set(errors)):
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"repository check: PASS ({len(paths)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
