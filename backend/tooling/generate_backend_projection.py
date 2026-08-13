#!/usr/bin/env python3
"""Generate the backend-local Rust projection from canonical JSON inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import Any


SETTING_KINDS = {
    "integer": "Integer",
    "duration-seconds": "DurationSeconds",
    "bytes": "Bytes",
    "string": "String",
    "path": "Path",
    "string-list": "StringList",
    "secret-reference": "SecretReference",
}
SERVICES = ("gateway", "api", "worker", "web", "sandbox", "migrator", "backup", "restore")
CAPABILITY_FIELDS = (
    "routes",
    "database_operations",
    "secret_files",
    "network_targets",
    "volumes",
    "jobs",
    "observability",
)
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
SETTING_ID = re.compile(r"^backend\.[a-z][a-z0-9.-]*$")
SUPPORTED_PATTERNS = {"^/run/config/", "^[a-z][a-z0-9_]*$"}
POLICY_LEVELS = {"allowed", "redacted", "denied"}
PRECEDENCE_LEVELS = {
    "command",
    "owner-file",
    "deployment-adapter",
    "secure-default",
    "secret-reference-file",
}
MAX_DIAGNOSTIC_LENGTH = 280


class ProjectionError(ValueError):
    pass


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProjectionError("duplicate JSON key")
        result[key] = value
    return result


def reject_nonfinite(_constant: str) -> None:
    raise ProjectionError("non-finite JSON constant")


def reject_float(_value: str) -> None:
    raise ProjectionError("floating-point JSON number")


def load_json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(
            raw,
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_nonfinite,
            parse_float=reject_float,
        )
    except json.JSONDecodeError as error:
        raise ProjectionError(
            f"invalid JSON in {label}: line {error.lineno} column {error.colno}"
        ) from None
    except UnicodeDecodeError:
        raise ProjectionError(f"invalid UTF-8 JSON in {label}") from None
    if not isinstance(value, dict):
        raise ProjectionError(f"top-level JSON object required for {label}")
    return value


def require_string(value: Any, context: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value):
        raise ProjectionError(f"{context} must be a string")
    return value


def require_integer(value: Any, context: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ProjectionError(f"{context} must be an integer")
    if not -(2**63) <= value < 2**63:
        raise ProjectionError(f"{context} is outside the supported integer range")
    return value


def absolute_path(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def inspect_regular_file(
    path: Path,
    label: str,
    *,
    allow_missing: bool = False,
) -> tuple[Path, os.stat_result | None]:
    normalized = absolute_path(path)
    try:
        details = os.lstat(normalized)
    except FileNotFoundError:
        if not allow_missing:
            raise ProjectionError(f"{label} must be a non-symlink regular file") from None
        inspect_output_parent(normalized.parent)
        return normalized, None
    except OSError:
        raise ProjectionError(f"unable to inspect {label}") from None
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
        raise ProjectionError(f"{label} must be a non-symlink regular file")
    try:
        resolved = normalized.resolve(strict=True)
    except OSError:
        raise ProjectionError(f"unable to resolve {label}") from None
    if resolved != normalized:
        raise ProjectionError(f"{label} must not traverse symlinks")
    return normalized, details


def inspect_output_parent(parent: Path) -> None:
    try:
        details = os.lstat(parent)
        resolved = parent.resolve(strict=True)
    except OSError:
        raise ProjectionError("output parent must be an existing directory") from None
    if not stat.S_ISDIR(details.st_mode) or resolved != parent:
        raise ProjectionError("output parent must be a non-symlink directory")


def same_file(
    first_path: Path,
    first_details: os.stat_result | None,
    second_path: Path,
    second_details: os.stat_result | None,
) -> bool:
    if first_path == second_path:
        return True
    if first_details is None or second_details is None:
        return False
    return (first_details.st_dev, first_details.st_ino) == (
        second_details.st_dev,
        second_details.st_ino,
    )


def read_regular_file(
    path: Path,
    expected: os.stat_result,
    label: str,
) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            actual = os.fstat(stream.fileno())
            if not stat.S_ISREG(actual.st_mode) or (
                actual.st_dev,
                actual.st_ino,
            ) != (expected.st_dev, expected.st_ino):
                raise ProjectionError(f"{label} changed during inspection")
            return stream.read()
    except ProjectionError:
        raise
    except OSError:
        raise ProjectionError(f"unable to read {label}") from None


def validate_paths(
    registry: Path,
    capabilities: Path,
    output: Path,
    *,
    write: bool,
) -> tuple[Path, bytes, Path, bytes, Path, os.stat_result | None]:
    registry_path, registry_details = inspect_regular_file(registry, "registry")
    capabilities_path, capabilities_details = inspect_regular_file(
        capabilities, "capabilities"
    )
    output_path, output_details = inspect_regular_file(
        output,
        "output",
        allow_missing=write,
    )
    if registry_details is None or capabilities_details is None:
        raise ProjectionError("generator sources must exist")
    if same_file(registry_path, registry_details, capabilities_path, capabilities_details):
        raise ProjectionError("registry and capabilities paths alias")
    if same_file(registry_path, registry_details, output_path, output_details):
        raise ProjectionError("registry and output paths alias")
    if same_file(capabilities_path, capabilities_details, output_path, output_details):
        raise ProjectionError("capabilities and output paths alias")
    registry_raw = read_regular_file(registry_path, registry_details, "registry")
    capabilities_raw = read_regular_file(
        capabilities_path, capabilities_details, "capabilities"
    )
    return (
        registry_path,
        registry_raw,
        capabilities_path,
        capabilities_raw,
        output_path,
        output_details,
    )


def require_keys(
    value: dict[str, Any],
    required: set[str],
    allowed: set[str],
    context: str,
) -> None:
    missing = required - value.keys()
    extra = value.keys() - allowed
    if missing:
        raise ProjectionError(f"{context} missing keys: {sorted(missing)}")
    if extra:
        raise ProjectionError(f"{context} unknown keys: {sorted(extra)}")


def require_string_list(value: Any, context: str) -> list[str]:
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise ProjectionError(f"{context} must be a string array")
    if len(value) != len(set(value)):
        raise ProjectionError(f"{context} contains duplicates")
    return value


def structured_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def validate_registry(registry: dict[str, Any]) -> list[dict[str, Any]]:
    require_keys(registry, {"_generated", "settings"}, {"_generated", "settings"}, "registry")
    generated = registry["_generated"]
    if not isinstance(generated, dict):
        raise ProjectionError("registry _generated must be an object")
    required_metadata = {
        "banner",
        "catalog_version",
        "owner",
        "projection_integrity",
        "read_only",
        "source",
        "source_integrity",
    }
    require_keys(generated, required_metadata, required_metadata, "registry _generated")
    if require_string(generated["banner"], "registry banner") != (
        "GENERATED: read-only owner projection; edit contracts/registry/settings.json"
    ):
        raise ProjectionError("registry banner is invalid")
    if require_integer(generated["catalog_version"], "registry catalog_version") != 1:
        raise ProjectionError("registry catalog_version must be 1")
    if require_string(generated["owner"], "registry owner") != "backend":
        raise ProjectionError("registry owner must be backend")
    if generated["read_only"] is not True:
        raise ProjectionError("registry must be a read-only backend projection")
    if require_string(generated["source"], "registry source") != (
        "contracts/registry/settings.json"
    ):
        raise ProjectionError("registry source is invalid")
    for key in ("projection_integrity", "source_integrity"):
        if not isinstance(generated[key], str) or not SHA256.fullmatch(generated[key]):
            raise ProjectionError(f"registry {key} must be a sha256 digest")

    settings = registry["settings"]
    if not isinstance(settings, list) or len(settings) != 34:
        raise ProjectionError("registry must contain exactly 34 backend settings")
    seen: set[str] = set()
    for index, setting in enumerate(settings):
        validate_setting(setting, index, seen)
    digest_metadata = {
        key: value for key, value in generated.items() if key != "projection_integrity"
    }
    expected_projection_integrity = structured_digest(
        {"generated": digest_metadata, "settings": settings}
    )
    if generated["projection_integrity"] != expected_projection_integrity:
        raise ProjectionError("registry projection integrity mismatch")
    return settings


def validate_setting(setting: Any, index: int, seen: set[str]) -> None:
    context = f"setting[{index}]"
    if not isinstance(setting, dict):
        raise ProjectionError(f"{context} must be an object")
    required = {
        "bounds",
        "classification",
        "deprecation",
        "description",
        "id",
        "log_policy",
        "owner",
        "precedence",
        "reload",
        "value",
        "value_policy",
    }
    require_keys(setting, required, required, context)
    setting_id = setting["id"]
    if (
        not isinstance(setting_id, str)
        or len(setting_id) > 128
        or not SETTING_ID.fullmatch(setting_id)
    ):
        raise ProjectionError(f"{context} id must be backend-owned")
    if setting_id in seen:
        raise ProjectionError(f"duplicate setting id: {setting_id}")
    seen.add(setting_id)
    if setting["owner"] != "backend":
        raise ProjectionError(f"{setting_id} owner must be backend")
    classification = require_string(
        setting["classification"], f"{setting_id} classification"
    )
    if classification not in {
        "runtime-nonsensitive",
        "runtime-secret-file-reference",
    }:
        raise ProjectionError(f"{setting_id} classification is invalid")
    require_string(setting["description"], f"{setting_id} description")
    validate_deprecation(setting["deprecation"], setting_id)
    validate_log_policy(setting["log_policy"], setting_id)
    precedence = require_string_list(setting["precedence"], f"{setting_id} precedence")
    if not precedence or not set(precedence) <= PRECEDENCE_LEVELS:
        raise ProjectionError(f"{setting_id} precedence is invalid")
    reload_mode = require_string(setting["reload"], f"{setting_id} reload")
    if reload_mode not in {"immediate", "new-session", "restart"}:
        raise ProjectionError(f"{setting_id} reload is invalid")

    value = setting["value"]
    if not isinstance(value, dict) or not isinstance(value.get("kind"), str):
        raise ProjectionError(f"{setting_id} value.kind is required")
    kind = value["kind"]
    if kind not in SETTING_KINDS:
        raise ProjectionError(f"unknown setting kind for {setting_id}: {kind}")
    allowed_value_keys = {"kind"}
    if kind == "secret-reference":
        allowed_value_keys.add("reference_type")
        if value.get("reference_type") != "mounted-file":
            raise ProjectionError(f"{setting_id} secret reference_type must be mounted-file")
    require_keys(value, allowed_value_keys, allowed_value_keys, f"{setting_id} value")

    bounds = setting["bounds"]
    if not isinstance(bounds, dict) or set(bounds) != {"operational", "safety"}:
        raise ProjectionError(f"{setting_id} bounds require operational and safety")
    operational = bounds["operational"]
    safety = bounds["safety"]
    if not isinstance(operational, dict) or not isinstance(safety, dict):
        raise ProjectionError(f"{setting_id} bounds must be objects")
    validate_operational(kind, operational, setting_id)
    validate_operational(kind, safety, f"{setting_id} safety")
    validate_safety_ceiling(operational, safety, setting_id)

    policy = setting["value_policy"]
    if not isinstance(policy, dict):
        raise ProjectionError(f"{setting_id} value_policy mode is invalid")
    mode = require_string(policy.get("mode"), f"{setting_id} value_policy mode")
    if mode not in {"default", "required"}:
        raise ProjectionError(f"{setting_id} value_policy mode is invalid")
    if mode == "required":
        require_keys(policy, {"mode"}, {"mode"}, f"{setting_id} value_policy")
    else:
        require_keys(policy, {"mode", "default"}, {"mode", "default"}, f"{setting_id} value_policy")
        validate_default(kind, policy["default"], operational, setting_id)


def validate_deprecation(value: Any, setting_id: str) -> None:
    if not isinstance(value, dict):
        raise ProjectionError(f"{setting_id} deprecation must be an object")
    require_keys(value, {"status"}, {"status"}, f"{setting_id} deprecation")
    if value["status"] != "active":
        raise ProjectionError(f"{setting_id} deprecation status is invalid")


def validate_log_policy(value: Any, setting_id: str) -> None:
    if not isinstance(value, dict):
        raise ProjectionError(f"{setting_id} log_policy must be an object")
    fields = {"diagnostics", "logs", "reason", "support_bundles"}
    require_keys(value, fields, fields, f"{setting_id} log_policy")
    require_string(value["reason"], f"{setting_id} log_policy reason")
    for key in ("diagnostics", "logs", "support_bundles"):
        policy = require_string(value[key], f"{setting_id} log_policy {key}")
        if policy not in POLICY_LEVELS:
            raise ProjectionError(f"{setting_id} log_policy {key} is invalid")


def validate_safety_ceiling(
    operational: dict[str, Any],
    safety: dict[str, Any],
    setting_id: str,
) -> None:
    for key in (
        "minimum",
        "maximum",
        "minimum_items",
        "maximum_items",
        "minimum_length",
        "maximum_length",
        "allowed",
        "pattern",
    ):
        if key in safety and key not in operational:
            raise ProjectionError(f"{setting_id} {key} required by safety")
    for key in ("minimum", "minimum_items", "minimum_length"):
        if key in operational and key in safety and operational[key] < safety[key]:
            raise ProjectionError(f"{setting_id} {key} violates safety floor")
    for key in ("maximum", "maximum_items", "maximum_length"):
        if key in operational and key in safety and operational[key] > safety[key]:
            raise ProjectionError(f"{setting_id} {key} violates safety ceiling")
    if "allowed" in operational and "allowed" in safety:
        if not all(item in safety["allowed"] for item in operational["allowed"]):
            raise ProjectionError(f"{setting_id} allowed set violates safety ceiling")
    if operational.get("pattern") != safety.get("pattern"):
        raise ProjectionError(f"{setting_id} pattern violates safety ceiling")


def validate_operational(kind: str, operational: dict[str, Any], setting_id: str) -> None:
    if kind in {"integer", "duration-seconds", "bytes"}:
        require_keys(
            operational,
            {"minimum", "maximum"},
            {"minimum", "maximum"},
            setting_id,
        )
        minimum = require_integer(operational["minimum"], f"{setting_id} minimum")
        maximum = require_integer(operational["maximum"], f"{setting_id} maximum")
        if minimum > maximum:
            raise ProjectionError(f"{setting_id} numeric operational bounds are invalid")
    elif kind in {"string", "path"}:
        allowed = {"minimum_length", "maximum_length", "pattern", "allowed"}
        if not set(operational) <= allowed or not operational:
            raise ProjectionError(f"{setting_id} string operational constraints are invalid")
        if "allowed" in operational:
            allowed_values = require_string_list(
                operational["allowed"], f"{setting_id} allowed"
            )
            if not allowed_values:
                raise ProjectionError(f"{setting_id} allowed must not be empty")
        if "pattern" in operational:
            pattern = require_string(operational["pattern"], f"{setting_id} pattern")
            if pattern not in SUPPORTED_PATTERNS:
                raise ProjectionError(f"{setting_id} pattern is unsupported")
        for key in ("minimum_length", "maximum_length"):
            if key not in operational:
                continue
            value = require_integer(operational[key], f"{setting_id} {key}")
            if value < 0:
                raise ProjectionError(f"{setting_id} {key} must be a nonnegative integer")
        minimum_length = operational.get("minimum_length")
        maximum_length = operational.get("maximum_length")
        if (
            minimum_length is not None
            and maximum_length is not None
            and minimum_length > maximum_length
        ):
            raise ProjectionError(f"{setting_id} length bounds are invalid")
    elif kind == "string-list":
        require_keys(
            operational,
            {"minimum_items", "maximum_items"},
            {"minimum_items", "maximum_items"},
            setting_id,
        )
        minimum = require_integer(operational["minimum_items"], f"{setting_id} minimum_items")
        maximum = require_integer(operational["maximum_items"], f"{setting_id} maximum_items")
        if minimum < 0 or minimum > maximum:
            raise ProjectionError(f"{setting_id} item bounds are invalid")
    elif kind == "secret-reference":
        require_keys(operational, {"allowed"}, {"allowed"}, setting_id)
        if require_string_list(operational["allowed"], f"{setting_id} allowed") != ["mounted-file"]:
            raise ProjectionError(f"{setting_id} only mounted-file is allowed")


def validate_default(
    kind: str,
    value: Any,
    operational: dict[str, Any],
    setting_id: str,
) -> None:
    if kind in {"integer", "duration-seconds", "bytes"}:
        number = require_integer(value, f"{setting_id} default")
        if not operational["minimum"] <= number <= operational["maximum"]:
            raise ProjectionError(f"{setting_id} default is outside operational bounds")
    elif kind in {"string", "path"}:
        text = require_string(value, f"{setting_id} default", nonempty=False)
        validate_text_value(text, operational, setting_id)
    elif kind == "string-list":
        values = require_string_list(value, f"{setting_id} default")
        if not operational["minimum_items"] <= len(values) <= operational["maximum_items"]:
            raise ProjectionError(f"{setting_id} default item count is outside bounds")
    else:
        raise ProjectionError(f"{setting_id} secret references cannot have defaults")


def validate_text_value(value: str, operational: dict[str, Any], setting_id: str) -> None:
    byte_length = len(value.encode("utf-8"))
    if byte_length < operational.get("minimum_length", 0):
        raise ProjectionError(f"{setting_id} default is shorter than its minimum")
    if byte_length > operational.get("maximum_length", byte_length):
        raise ProjectionError(f"{setting_id} default is longer than its maximum")
    if operational.get("allowed") and value not in operational["allowed"]:
        raise ProjectionError(f"{setting_id} default is not allowed")
    pattern = operational.get("pattern")
    if pattern == "^[a-z][a-z0-9_]*$" and re.fullmatch(r"[a-z][a-z0-9_]*", value) is None:
        raise ProjectionError(f"{setting_id} default does not match its pattern")
    if pattern == "^/run/config/" and not valid_mounted_path(value, "/run/config/"):
        raise ProjectionError(f"{setting_id} default does not match its pattern")


def valid_mounted_path(value: str, prefix: str) -> bool:
    if not value.startswith(prefix):
        return False
    relative = value[len(prefix) :]
    return bool(relative) and all(
        part not in {"", ".", ".."}
        and all(
            character.isascii() and (character.isalnum() or character in "._-")
            for character in part
        )
        for part in relative.split("/")
    )


def validate_capabilities(capabilities: dict[str, Any]) -> dict[str, Any]:
    required = {"$schema", "schema_version", "default", "services"}
    require_keys(capabilities, required, required, "capabilities")
    if require_string(capabilities["$schema"], "capabilities $schema") != (
        "service-capabilities-v1.schema.json"
    ):
        raise ProjectionError("capabilities $schema is invalid")
    if require_integer(capabilities["schema_version"], "capabilities schema_version") != 1:
        raise ProjectionError("capabilities schema_version must be 1")
    if require_string(capabilities["default"], "capabilities default") != "deny":
        raise ProjectionError("capabilities default must be deny")
    services = capabilities["services"]
    if not isinstance(services, dict) or set(services) != set(SERVICES):
        raise ProjectionError("capabilities must define the closed eight-service set")
    for service in SERVICES:
        value = services[service]
        if not isinstance(value, dict):
            raise ProjectionError(f"capability {service} must be an object")
        allowed = set(CAPABILITY_FIELDS) | {"stdin"}
        require_keys(value, set(CAPABILITY_FIELDS), allowed, f"capability {service}")
        for field in CAPABILITY_FIELDS:
            values = require_string_list(value[field], f"capability {service}.{field}")
            for item in values:
                if len(item) > 128 or not item.isascii():
                    raise ProjectionError(f"capability {service}.{field} item is invalid")
        if "stdin" in value:
            stdin = require_string_list(value["stdin"], f"capability {service}.stdin")
            if any(len(item) > 128 or not item.isascii() for item in stdin):
                raise ProjectionError(f"capability {service}.stdin item is invalid")
        if service != "sandbox" and "stdin" in value:
            raise ProjectionError(f"only sandbox may define stdin")
    return services


def rust_string(value: str) -> str:
    try:
        value.encode("ascii")
    except UnicodeEncodeError as error:
        raise ProjectionError("generated Rust strings must be ASCII") from error
    return json.dumps(value)


def option_number(value: Any) -> str:
    return "None" if value is None else f"Some({value})"


def option_string(value: Any) -> str:
    return "None" if value is None else f"Some({rust_string(value)})"


def string_slice(values: list[str]) -> str:
    return "&[" + ", ".join(rust_string(value) for value in values) + "]"


def digest_bytes(raw: bytes) -> str:
    return ", ".join(f"0x{byte:02x}" for byte in hashlib.sha256(raw).digest())


def render_default(kind: str, policy: dict[str, Any]) -> str:
    if policy["mode"] == "required":
        return "None"
    value = policy["default"]
    if kind in {"integer", "duration-seconds", "bytes"}:
        return f"Some(GeneratedDefault::Number({value}))"
    if kind in {"string", "path"}:
        return f"Some(GeneratedDefault::Text({rust_string(value)}))"
    if kind == "string-list":
        raise ProjectionError(
            "string-list defaults are not present in the canonical backend registry"
        )
    raise ProjectionError("secret-reference default is not representable")


def render_setting(setting: dict[str, Any]) -> str:
    kind = setting["value"]["kind"]
    bounds = setting["bounds"]["operational"]
    allowed = bounds.get("allowed", [])
    return "\n".join(
        [
            "    GeneratedSettingSpec {",
            f"        id: {rust_string(setting['id'])},",
            f"        owner: {rust_string(setting['owner'])},",
            f"        kind: SettingKind::{SETTING_KINDS[kind]},",
            "        constraints: GeneratedConstraints {",
            f"            minimum: {option_number(bounds.get('minimum'))},",
            f"            maximum: {option_number(bounds.get('maximum'))},",
            f"            minimum_length: {option_number(bounds.get('minimum_length'))},",
            f"            maximum_length: {option_number(bounds.get('maximum_length'))},",
            f"            minimum_items: {option_number(bounds.get('minimum_items'))},",
            f"            maximum_items: {option_number(bounds.get('maximum_items'))},",
            f"            pattern: {option_string(bounds.get('pattern'))},",
            f"            allowed: {string_slice(allowed)},",
            f"            reference_type: {option_string(setting['value'].get('reference_type'))},",
            "        },",
            f"        mode: GeneratedValueMode::{setting['value_policy']['mode'].title()},",
            f"        default: {render_default(kind, setting['value_policy'])},",
            "    },",
        ]
    )


def render_capability(service: str, value: dict[str, Any]) -> str:
    lines = [f"    {service}: GeneratedServiceCapability {{"]
    for field in CAPABILITY_FIELDS:
        lines.append(f"        {field}: {string_slice(value[field])},")
    stdin = value.get("stdin")
    rendered_stdin = "None" if stdin is None else f"Some({string_slice(stdin)})"
    lines.append(f"        stdin: {rendered_stdin},")
    lines.append("    },")
    return "\n".join(lines)


def render(
    registry: dict[str, Any],
    registry_raw: bytes,
    capabilities: dict[str, Any],
    capabilities_raw: bytes,
) -> str:
    settings = validate_registry(registry)
    services = validate_capabilities(capabilities)
    metadata = registry["_generated"]
    registry_sha = hashlib.sha256(registry_raw).hexdigest()
    capabilities_sha = hashlib.sha256(capabilities_raw).hexdigest()
    setting_rows = "\n".join(render_setting(setting) for setting in settings)
    capability_rows = "\n".join(
        render_capability(service, services[service]) for service in SERVICES
    )
    return f"""// @generated by backend/tooling/generate_backend_projection.py.
// Verified backend projection. Edit canonical JSON inputs, then regenerate.

use crate::{{
    GeneratedConstraints, GeneratedDefault, GeneratedServiceCapability,
    GeneratedServiceCapabilityMap, GeneratedSettingSpec, GeneratedValueMode, SettingKind,
}};

pub const REGISTRY_FILE_SHA256: &str = "sha256:{registry_sha}";
pub const CAPABILITIES_FILE_SHA256: &str = "sha256:{capabilities_sha}";
pub const REGISTRY_SOURCE_INTEGRITY: &str = {rust_string(metadata['source_integrity'])};
pub const REGISTRY_PROJECTION_INTEGRITY: &str = {rust_string(metadata['projection_integrity'])};
pub(crate) const CAPABILITIES_FILE_DIGEST: [u8; 32] = [{digest_bytes(capabilities_raw)}];

pub(crate) const GENERATED_CATALOG_VERSION: u16 = {metadata['catalog_version']};
pub(crate) const GENERATED_OWNER: &str = {rust_string(metadata['owner'])};
pub(crate) const GENERATED_SETTINGS: &[GeneratedSettingSpec] = &[
{setting_rows}
];

pub(crate) const GENERATED_CAPABILITY_SCHEMA_VERSION: u16 = {capabilities['schema_version']};
pub(crate) const GENERATED_CAPABILITY_DEFAULT: &str = {rust_string(capabilities['default'])};
pub(crate) const GENERATED_SERVICE_CAPABILITIES: GeneratedServiceCapabilityMap =
    GeneratedServiceCapabilityMap {{
{capability_rows}
}};
"""


def write_generated(output: Path, contents: str) -> None:
    staged_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as staged:
            staged.write(contents)
            staged_path = Path(staged.name)
        staged_path.replace(output)
    finally:
        if staged_path is not None and staged_path.exists():
            staged_path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--capabilities", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    try:
        (
            _registry_path,
            registry_raw,
            _capabilities_path,
            capabilities_raw,
            output_path,
            output_details,
        ) = validate_paths(
            arguments.registry,
            arguments.capabilities,
            arguments.output,
            write=arguments.write,
        )
        registry = load_json(registry_raw, "registry")
        capabilities = load_json(capabilities_raw, "capabilities")
        expected = render(registry, registry_raw, capabilities, capabilities_raw)
        if arguments.check:
            if output_details is None:
                raise ProjectionError("output must exist in check mode")
            actual = read_regular_file(output_path, output_details, "output")
            if actual != expected.encode("utf-8"):
                raise ProjectionError("generated output is stale")
            print(f"backend generated projection: PASS ({len(registry['settings'])} settings)")
            return 0
        write_generated(output_path, expected)
        print(f"backend generated projection: WROTE ({len(registry['settings'])} settings)")
        return 0
    except ProjectionError as error:
        diagnostic = " ".join(str(error).split())[:MAX_DIAGNOSTIC_LENGTH]
        print(f"backend generated projection: FAIL: {diagnostic}", file=sys.stderr)
        return 1
    except Exception:
        print("backend generated projection: FAIL: unexpected generator failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
