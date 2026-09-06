#!/usr/bin/env python3
"""Validate the public source tree without external dependencies."""

from __future__ import annotations

import json
import hashlib
import re
import subprocess
import sys
from datetime import datetime
from fnmatch import fnmatch
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[2]
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
SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

FEATURE_STATUSES = {
    "Stable",
    "Beta",
    "Experimental",
    "Protocol-only",
    "Planned",
    "Unsupported",
}
FEATURE_MODES = {"Desktop Local", "Desktop Connected", "Web Connected"}
FEATURE_REQUIRED_FIELDS = {
    "feature_id",
    "name",
    "status",
    "modes",
    "platforms",
    "implementation_paths",
    "security_claims",
    "requirement_ids",
    "automated_evidence",
    "manual_evidence",
    "owner",
    "security_approver",
    "last_verified_version",
    "last_verified_at",
    "known_limitations",
}

PRD_PROGRESS_STATUSES = {"Complete", "Partial", "Not started", "Blocked"}
PRD_PROGRESS_FIELDS = {
    "sequence",
    "work_package",
    "primary_ids",
    "status",
    "completed_scope",
    "remaining_scope",
    "evidence",
}


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


# Han, Hiragana, Katakana, Hangul, and compatibility ideographs. English is
# the repository language; these scripts may appear only in the intentional
# localization surfaces listed below.
CJK_SCRIPT = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]")

# Locale catalogs and the i18n documentation and registries are the only
# permitted CJK locations. All former source exceptions were removed: the
# generic browser E2E suite, the root README, and the API error catalog
# (LANG-003 moved API localization to the client locale catalogs) are
# English-only.
CJK_ALLOWED_PARTS = {
    ("apps", "web", "locales"),
    ("apps", "web", "src", "i18n"),
    ("docs", "i18n"),
}


def check_cjk(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        text = read_text(path)
        if text is None:
            continue
        relative = path.relative_to(ROOT)
        parts = relative.parts
        if any(
            len(parts) > len(prefix) and parts[: len(prefix)] == prefix
            for prefix in CJK_ALLOWED_PARTS
        ):
            continue
        if CJK_SCRIPT.search(text):
            errors.append(f"CJK text outside the i18n allowlist in {relative}")
    return errors


def parse_layout_manifest(errors: list[str]) -> dict | None:
    """Parse the restricted repository-layout.toml subset without a parser
    dependency: [entry."name"] and [root] tables whose values are strings,
    booleans, integers, or arrays of strings (possibly spanning lines)."""
    relative = "repository-layout.toml"
    try:
        text = (ROOT / relative).read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        errors.append(f"cannot read {relative}: {error}")
        return None

    def split_value(raw: str, line_no: int):
        raw = raw.strip()
        if raw.startswith('"'):
            match = re.match(r'"([^"]*)"', raw)
            if match is None:
                errors.append(f"{relative}:{line_no} has an unterminated string")
                return None
            return match.group(1)
        if raw in {"true", "false"}:
            return raw == "true"
        if re.fullmatch(r"[0-9]+", raw):
            return int(raw)
        errors.append(f"{relative}:{line_no} has an unsupported value")
        return None

    # Pass one: join array continuations into logical lines.
    logical: list[tuple[int, str]] = []
    buffer: list[str] = []
    start_no = 0

    def open_brackets(fragment: str) -> int:
        without_strings = re.sub(r'"[^"]*"', "", fragment)
        return without_strings.count("[") - without_strings.count("]")

    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        stripped = raw_line.strip()
        if buffer:
            buffer.append(stripped)
            if open_brackets(" ".join(buffer)) <= 0:
                logical.append((start_no, " ".join(buffer)))
                buffer = []
            continue
        if not stripped or stripped.startswith("#"):
            continue
        if open_brackets(stripped) > 0:
            buffer = [stripped]
            start_no = line_no
            continue
        logical.append((line_no, stripped))
    if buffer:
        errors.append(f"{relative}:{start_no} has an unterminated array")

    # Pass two: interpret each logical line.
    manifest: dict = {"schema_version": None, "entries": {}, "root": {}}
    current: dict | None = manifest
    for line_no, line in logical:
        header = re.fullmatch(r'\[entry\."([^"]+)"\]', line)
        if header is not None:
            current = manifest["entries"][header.group(1)] = {}
            continue
        if re.fullmatch(r"\[root\]", line):
            current = manifest["root"]
            continue
        match = re.match(r"([A-Za-z0-9_]+)\s*=\s*(.+)", line)
        if match is None or current is None:
            errors.append(f"{relative}:{line_no} is not a supported layout line")
            continue
        key, raw = match.group(1), match.group(2).strip()
        if raw.startswith("["):
            body = raw[raw.index("[") + 1 : raw.rindex("]")]
            items: list[str] = []
            for token in body.split(","):
                token = token.strip()
                if not token:
                    continue
                value = split_value(token, line_no)
                if not isinstance(value, str):
                    errors.append(f"{relative}:{line_no} array values must be strings")
                    value = ""
                items.append(value)
            current[key] = items
        else:
            current[key] = split_value(raw, line_no)

    if manifest.get("schema_version") != 1:
        errors.append("repository-layout.toml schema_version must be 1")
    for required in ("category", "owner", "generated", "runtime_state", "file_types"):
        for name, entry in manifest["entries"].items():
            if required not in entry:
                errors.append(f"repository-layout.toml entry {name} lacks {required}")
    return manifest


# LANG-002: ordinary path components are lowercase kebab-case (digits, dots,
# dashes, underscores, and the @ sigil allowed). Uppercase is permitted only
# for established naming conventions: governance documents, cargo/make/docker
# toolchain files, the IBM Plex font families, archived Java experiment
# sources, and BCP-47-style locale catalog names such as zh-TW.json.
UPPERCASE_COMPONENT_CONVENTIONS = (
    "README*",
    "LICENSE*",
    "NOTICE",
    "CONTRIBUTING*",
    "SECURITY*",
    "CODE_OF_CONDUCT*",
    "CODEOWNERS",
    "COPYRIGHT*",
    "TRADEMARKS*",
    "TRADEMARK*",
    "PRD.md",
    "CHANGELOG*",
    "ARCHITECTURE*",
    "BRAND_GUIDELINES*",
    "DEPLOYMENT*",
    "DESKTOP*",
    "OPERATOR-GUIDE*",
    "USER-GUIDE*",
    "Cargo.*",
    "Makefile",
    "Dockerfile*",
    "AndroidManifest.xml",
    "IBMPlex*",
    "KernelSmoke*",
    "androidTest",
    ".github*",
    "ISSUE_TEMPLATE*",
)
LOCALE_COMPONENT = re.compile(r"^[a-z]{2}(-[A-Za-z0-9]{2,8})?(\.inert)?\.json$")


def path_component_allowed(component: str) -> bool:
    if any(fnmatch(component, pattern) for pattern in UPPERCASE_COMPONENT_CONVENTIONS):
        return True
    return LOCALE_COMPONENT.fullmatch(component) is not None


def check_path_case(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        relative = path.relative_to(ROOT)
        for component in relative.parts:
            if component == component.lower():
                continue
            if not path_component_allowed(component):
                errors.append(
                    f"path component is not lowercase or an approved convention"
                    f" (LANG-002): {relative}"
                )
    return errors


def check_layout(paths: list[Path], manifest: dict | None) -> list[str]:
    """Enforce REPO-001/002/003/016/017 from the layout manifest."""
    if manifest is None:
        return ["repository layout manifest is unavailable"]
    errors: list[str] = []
    entries: dict = manifest["entries"]
    root_files: set[str] = set(manifest["root"].get("approved_files", []))

    # Nested entries such as packages/security-kernel override their parent
    # directory for the files they cover, so match the longest declared prefix.
    prefix_entries: list[tuple[tuple[str, ...], str]] = sorted(
        ((tuple(name.split("/")), name) for name in entries),
        key=lambda item: len(item[0]),
        reverse=True,
    )

    def match_entry(parts: tuple[str, ...]) -> str | None:
        for prefix, name in prefix_entries:
            if parts[: len(prefix)] == prefix:
                return name
        return None

    lower_seen: dict[str, str] = {}
    for path in paths:
        relative = path.relative_to(ROOT)
        posix = relative.as_posix()
        if any(ord(char) > 127 for char in posix):
            errors.append(f"non-ASCII path is not allowed (LANG-002/REPO-016): {relative}")
        if " " in posix:
            errors.append(f"path contains spaces (LANG-002/REPO-016): {relative}")
        folded = posix.casefold()
        if folded in lower_seen:
            errors.append(
                f"case-insensitive path collision (REPO-016): {relative} vs {lower_seen[folded]}"
            )
        else:
            lower_seen[folded] = posix

        parts = relative.parts
        if len(parts) == 1:
            if posix not in root_files:
                errors.append(f"unapproved root file (REPO-002): {relative}")
            continue
        entry_name = match_entry(parts)
        entry = entries.get(entry_name) if entry_name is not None else None
        if entry is None:
            errors.append(f"unapproved root directory (REPO-002): {parts[0]}")
            continue
        if entry.get("runtime_state"):
            errors.append(f"runtime location must stay untracked (REPO-014): {relative}")
            continue
        patterns = entry.get("file_types", [])
        if not any(fnmatch(relative.name, pattern) for pattern in patterns):
            errors.append(
                f"{entry_name} does not allow file type '{relative.name}' (REPO-001): {relative}"
            )

    # Working-tree root entries must be declared, approved, or ignored so
    # unowned runtime data (for example password/) is rejected (REPO-002/017).
    declared = set(entries) | root_files | {".git"}
    for working_entry in ROOT.iterdir():
        name = working_entry.name
        if name in declared or name.startswith(".git"):
            continue
        ignored = subprocess.run(
            ["git", "check-ignore", "--quiet", name],
            cwd=ROOT,
            capture_output=True,
            check=False,
            timeout=30,
        )
        if ignored.returncode != 0:
            errors.append(f"unapproved working-tree root entry (REPO-002): {name}")

    # Experiments must never satisfy shipping CI or Makefile targets (REPO-003).
    shipping_surfaces = [ROOT / "Makefile"]
    shipping_surfaces.extend((ROOT / ".github" / "workflows").glob("*.yml"))
    for surface in shipping_surfaces:
        try:
            text = surface.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        if "experiments/" in text:
            errors.append(
                f"experiments must not gate shipping work (REPO-003): {surface.relative_to(ROOT)}"
            )
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


def read_json(relative: str, errors: list[str]) -> dict | None:
    path = ROOT / relative
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        errors.append(f"cannot read {relative}: {error}")
        return None
    if not isinstance(value, dict):
        errors.append(f"expected a JSON object in {relative}")
        return None
    return value


def read_toml_string(
    relative: str, table: str, key: str, errors: list[str]
) -> str | None:
    """Read one quoted TOML string without adding a Python package dependency."""
    path = ROOT / relative
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        errors.append(f"cannot read {relative}: {error}")
        return None
    table_match = re.search(
        rf"(?ms)^\[{re.escape(table)}\]\s*$\n(.*?)(?=^\[|\Z)", text
    )
    if table_match is None:
        errors.append(f"cannot find [{table}] in {relative}")
        return None
    value_match = re.search(
        rf'(?m)^{re.escape(key)}\s*=\s*"([^"]+)"\s*$', table_match.group(1)
    )
    if value_match is None:
        errors.append(f"cannot find {key} in [{table}] in {relative}")
        return None
    return value_match.group(1)


def nested_value(value: dict, keys: tuple[str, ...]) -> object | None:
    current: object = value
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def check_prd_progress(
    progress_record: dict, product_version: str, errors: list[str]
) -> None:
    """Keep the human PRD marker and machine-readable handoff in sync."""
    relative = "release/prd-progress.json"
    if progress_record.get("schema_version") != 1:
        errors.append(f"{relative} schema_version must be 1")
    if progress_record.get("prd") != "PRD.md":
        errors.append(f"{relative} must reference PRD.md")
    if progress_record.get("product_version") != product_version:
        errors.append(f"{relative} product_version does not match version.json")
    if set(progress_record.get("status_values", [])) != PRD_PROGRESS_STATUSES:
        errors.append(f"{relative} status_values are incomplete or invalid")
    if not isinstance(progress_record.get("completion_rule"), str) or not progress_record[
        "completion_rule"
    ].strip():
        errors.append(f"{relative} must define a completion_rule")
    if not isinstance(progress_record.get("continuation_note"), str) or not progress_record[
        "continuation_note"
    ].strip():
        errors.append(f"{relative} must define a continuation_note")
    try:
        datetime.fromisoformat(progress_record["updated_at"].replace("Z", "+00:00"))
    except (AttributeError, KeyError, ValueError):
        errors.append(f"{relative} updated_at must be an ISO-8601 timestamp")

    try:
        prd_text = (ROOT / "PRD.md").read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        errors.append(f"cannot read PRD.md: {error}")
        return

    backlog = progress_record.get("backlog")
    if not isinstance(backlog, list) or len(backlog) != 11:
        errors.append(f"{relative} must contain exactly 11 backlog entries")
        return

    seen_sequences: set[int] = set()
    sequence_statuses: dict[int, str] = {}
    for index, entry in enumerate(backlog):
        label = f"{relative} backlog entry #{index + 1}"
        if not isinstance(entry, dict):
            errors.append(f"{label} must be an object")
            continue
        missing = PRD_PROGRESS_FIELDS.difference(entry)
        extra = set(entry).difference(PRD_PROGRESS_FIELDS)
        if missing:
            errors.append(f"{label} is missing fields: {', '.join(sorted(missing))}")
        if extra:
            errors.append(f"{label} has unknown fields: {', '.join(sorted(extra))}")

        sequence = entry.get("sequence")
        if not isinstance(sequence, int) or sequence not in range(1, 12):
            errors.append(f"{label} has an invalid sequence")
            continue
        if sequence in seen_sequences:
            errors.append(f"duplicate PRD backlog sequence: {sequence}")
        seen_sequences.add(sequence)

        work_package = entry.get("work_package")
        if not isinstance(work_package, str) or not work_package.strip():
            errors.append(f"{label} must define a work_package")
        elif work_package not in prd_text:
            errors.append(f"{label} work_package does not match PRD.md")

        status = entry.get("status")
        if status not in PRD_PROGRESS_STATUSES:
            errors.append(f"{label} has an invalid status")
            continue
        sequence_statuses[sequence] = status
        marker = re.compile(
            rf"(?m)^\|\s*{sequence}\s*\|[^\n]*`{re.escape(status)}`[^\n]*\|$"
        )
        if marker.search(prd_text) is None:
            errors.append(
                f"PRD.md progress marker for sequence {sequence} must be {status}"
            )

        for field in ("primary_ids", "completed_scope", "remaining_scope", "evidence"):
            values = entry.get(field)
            if not isinstance(values, list) or any(
                not isinstance(item, str) or not item.strip() for item in values
            ):
                errors.append(f"{label} field {field} must be an array of strings")
        completed_scope = entry.get("completed_scope", [])
        remaining_scope = entry.get("remaining_scope", [])
        evidence = entry.get("evidence", [])
        if status == "Complete" and (
            not completed_scope or remaining_scope or not evidence
        ):
            errors.append(
                f"{label} Complete requires completed_scope/evidence and no remaining_scope"
            )
        if status == "Partial" and (
            not completed_scope or not remaining_scope or not evidence
        ):
            errors.append(
                f"{label} Partial requires completed_scope, remaining_scope, and evidence"
            )
        if status == "Not started" and (completed_scope or not remaining_scope):
            errors.append(
                f"{label} Not started requires empty completed_scope and remaining_scope"
            )
        if status == "Blocked" and not remaining_scope:
            errors.append(f"{label} Blocked requires remaining_scope")
        for evidence_path in evidence:
            if not (ROOT / evidence_path).exists():
                errors.append(f"{label} references missing evidence: {evidence_path}")

    if seen_sequences != set(range(1, 12)):
        errors.append(f"{relative} backlog sequences must be exactly 1 through 11")
    next_sequence = progress_record.get("next_recommended_sequence")
    if not isinstance(next_sequence, int) or next_sequence not in seen_sequences:
        errors.append(f"{relative} has an invalid next_recommended_sequence")
    elif sequence_statuses.get(next_sequence) == "Complete":
        errors.append(f"{relative} next_recommended_sequence is already Complete")


def check_release_truth() -> list[str]:
    """Validate the M0 product version, channel, and evidence authorities."""
    errors: list[str] = []
    version_record = read_json("release/version.json", errors)
    feature_record = read_json("release/features.json", errors)
    kernel_assets = read_json("release/kernel-assets.json", errors)
    progress_record = read_json("release/prd-progress.json", errors)
    if (
        version_record is None
        or feature_record is None
        or kernel_assets is None
        or progress_record is None
    ):
        return errors

    if version_record.get("schema_version") != 1:
        errors.append("release/version.json schema_version must be 1")
    product_version = version_record.get("version")
    if not isinstance(product_version, str) or not SEMVER.fullmatch(product_version):
        errors.append("release/version.json version must be canonical SemVer")
        return errors
    expected_tag = f"v{product_version}"
    if version_record.get("tag") != expected_tag:
        errors.append(f"release/version.json tag must be {expected_tag}")
    if version_record.get("channel") not in {"preview", "beta", "stable"}:
        errors.append("release/version.json channel must be preview, beta, or stable")
    stable = version_record.get("channel") == "stable"
    if version_record.get("github_prerelease") is not (not stable):
        errors.append("non-stable channels must set github_prerelease to true")
    if version_record.get("latest_allowed") is not stable:
        errors.append("latest_allowed must be true only for the stable channel")
    if version_record.get("license_classification") not in {
        "source-available",
        "open-source",
    }:
        errors.append("release/version.json has an invalid license classification")

    check_prd_progress(progress_record, product_version, errors)

    json_consumers = {
        "apps/desktop/package.json": (("version",), product_version),
        "apps/desktop/src-tauri/tauri.conf.json": (("version",), product_version),
        "package-lock.json": (("packages", "", "version"), "0.0.0"),
        "contracts/protocol/invariants-v1.json": (("release_version",), expected_tag),
        "contracts/compatibility/v1.json": (("release",), expected_tag),
        "contracts/release/toolchain-lock-v1.json": (("release",), expected_tag),
        "contracts/branding/release-identity-v1.json": (("release_version",), expected_tag),
    }
    for relative, (keys, expected) in json_consumers.items():
        record = read_json(relative, errors)
        if record is not None and nested_value(record, keys) != expected:
            errors.append(f"version drift in {relative}: expected {expected}")
    brand = read_json("contracts/branding/release-identity-v1.json", errors)
    if brand is not None and brand.get("component_version") != product_version:
        errors.append(
            "version drift in contracts/branding/release-identity-v1.json: "
            f"expected component_version {product_version}"
        )

    toml_consumers = {
        "Cargo.toml": "workspace.package",
        "packages/security-kernel/Cargo.toml": "workspace.package",
    }
    for relative, table in toml_consumers.items():
        version = read_toml_string(relative, table, "version", errors)
        if version is not None and version != product_version:
            errors.append(f"version drift in {relative}: expected {product_version}")
    desktop_version = read_toml_string(
        "apps/desktop/src-tauri/Cargo.toml", "package", "version", errors
    )
    if desktop_version is not None and desktop_version != product_version:
        errors.append(
            "version drift in apps/desktop/src-tauri/Cargo.toml: "
            f"expected {product_version}"
        )

    text_consumers = {
        "apps/web/src/config.js": f"version: '{product_version}'",
        "packages/contracts-rust/src/lib.rs": (
            f'RELEASE_VERSION: &str = "{expected_tag}"'
        ),
        "packages/security-kernel/crates/kernel-core/src/contracts_generated/mod.rs": (
            f'RELEASE_VERSION: &str = "{expected_tag}"'
        ),
        "contracts/protocol/invariants-v1.schema.json": (
            f'"release_version": {{"const": "{expected_tag}"}}'
        ),
        "contracts/release/toolchain-lock-v1.schema.json": (
            f'"release": {{"const": "{expected_tag}"}}'
        ),
    }
    for relative, marker in text_consumers.items():
        try:
            text = (ROOT / relative).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            errors.append(f"cannot read {relative}: {error}")
            continue
        if marker not in text:
            errors.append(f"version drift in {relative}: missing {marker}")

    for relative in (
        "package.json",
        "tests/e2e/web/package.json",
        "experiments/archive/m0-desktop/package.json",
    ):
        record = read_json(relative, errors)
        if record is not None and record.get("version") != "0.0.0":
            errors.append(f"non-product package {relative} must use version 0.0.0")

    if kernel_assets.get("schema_version") != 1:
        errors.append("release/kernel-assets.json schema_version must be 1")
    if kernel_assets.get("product_version") != product_version:
        errors.append("release/kernel-assets.json product_version does not match version.json")
    asset_records = kernel_assets.get("assets")
    if not isinstance(asset_records, list) or len(asset_records) != 2:
        errors.append("release/kernel-assets.json must contain exactly two assets")
    else:
        config_text = (ROOT / "apps/web/src/config.js").read_text(encoding="utf-8")
        seen_asset_roles: set[str] = set()
        for asset in asset_records:
            if not isinstance(asset, dict):
                errors.append("release/kernel-assets.json assets must be objects")
                continue
            role = asset.get("role")
            relative = asset.get("path")
            expected_sha256 = asset.get("sha256")
            if role not in {"browser-binding", "browser-wasm"} or role in seen_asset_roles:
                errors.append("release/kernel-assets.json has invalid or duplicate asset roles")
            else:
                seen_asset_roles.add(role)
            if not isinstance(relative, str) or not relative.startswith(
                "apps/web/src/wasm/"
            ):
                errors.append("release/kernel-assets.json has an invalid asset path")
                continue
            if not isinstance(expected_sha256, str) or not re.fullmatch(
                r"[0-9a-f]{64}", expected_sha256
            ):
                errors.append(f"invalid SHA-256 for kernel asset {relative}")
                continue
            try:
                actual_sha256 = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
            except OSError as error:
                errors.append(f"cannot read kernel asset {relative}: {error}")
                continue
            if actual_sha256 != expected_sha256:
                errors.append(f"kernel asset digest drift: {relative}")
            if expected_sha256 not in config_text:
                errors.append(f"runtime kernel digest missing from config.js: {relative}")

    if feature_record.get("schema_version") != 1:
        errors.append("release/features.json schema_version must be 1")
    if feature_record.get("product_version") != product_version:
        errors.append("release/features.json product_version does not match version.json")
    features = feature_record.get("features")
    if not isinstance(features, list) or not features:
        errors.append("release/features.json must contain a non-empty features array")
        return errors
    seen_ids: set[str] = set()
    prd_text = (ROOT / "PRD.md").read_text(encoding="utf-8")
    for index, feature in enumerate(features):
        label = f"release/features.json feature #{index + 1}"
        if not isinstance(feature, dict):
            errors.append(f"{label} must be an object")
            continue
        missing = FEATURE_REQUIRED_FIELDS.difference(feature)
        extra = set(feature).difference(FEATURE_REQUIRED_FIELDS)
        if missing:
            errors.append(f"{label} is missing fields: {', '.join(sorted(missing))}")
        if extra:
            errors.append(f"{label} has unknown fields: {', '.join(sorted(extra))}")
        feature_id = feature.get("feature_id")
        if not isinstance(feature_id, str) or not re.fullmatch(
            r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", feature_id
        ):
            errors.append(f"{label} has an invalid feature_id")
        elif feature_id in seen_ids:
            errors.append(f"duplicate feature_id in release/features.json: {feature_id}")
        else:
            seen_ids.add(feature_id)
            label = f"feature {feature_id}"
        if feature.get("status") not in FEATURE_STATUSES:
            errors.append(f"{label} has an invalid status")
        modes = feature.get("modes")
        if not isinstance(modes, list) or not modes or not set(modes) <= FEATURE_MODES:
            errors.append(f"{label} has invalid modes")
        for field in (
            "platforms",
            "implementation_paths",
            "security_claims",
            "requirement_ids",
            "automated_evidence",
            "manual_evidence",
            "known_limitations",
        ):
            values = feature.get(field)
            if not isinstance(values, list) or any(
                not isinstance(item, str) or not item for item in values
            ):
                errors.append(f"{label} field {field} must be an array of strings")
        for relative in feature.get("implementation_paths", []):
            if not (ROOT / relative).exists():
                errors.append(f"{label} references missing implementation path: {relative}")
        for relative in feature.get("automated_evidence", []):
            if not (ROOT / relative).exists():
                errors.append(f"{label} references missing automated evidence: {relative}")
        for requirement_id in feature.get("requirement_ids", []):
            if f"`{requirement_id}`" not in prd_text:
                errors.append(f"{label} references unknown requirement: {requirement_id}")
        if feature.get("last_verified_version") != product_version:
            errors.append(f"{label} last_verified_version does not match version.json")
        verified_at = feature.get("last_verified_at")
        try:
            datetime.fromisoformat(verified_at.replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            errors.append(f"{label} last_verified_at must be an ISO-8601 timestamp")
    return errors


def check_key_lifecycle_contract() -> list[str]:
    """Run the dependency-free sequence-4 lifecycle and vector validator."""
    checker = ROOT / "tools/lint/check-key-lifecycle.py"
    try:
        completed = subprocess.run(
            [sys.executable, str(checker)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return [f"cannot run key lifecycle contract check: {error}"]
    if completed.returncode == 0:
        return []
    output = completed.stderr.strip() or completed.stdout.strip()
    if not output:
        return ["key lifecycle contract check failed without diagnostics"]
    return [
        line.removeprefix("ERROR: ")
        for line in output.splitlines()
        if line.strip()
    ]


def main() -> int:
    paths = iter_files()
    layout_errors: list[str] = []
    manifest = parse_layout_manifest(layout_errors)
    errors = [
        *check_paths(paths),
        *check_text(paths),
        *check_json(paths),
        *check_markdown_links(paths),
        *check_cjk(paths),
        *check_path_case(paths),
        *layout_errors,
        *check_layout(paths, manifest),
        *check_release_truth(),
        *check_key_lifecycle_contract(),
    ]
    if errors:
        for error in sorted(set(errors)):
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"repository check: PASS ({len(paths)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
