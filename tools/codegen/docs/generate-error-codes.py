#!/usr/bin/env python3
"""Generate docs/reference/error-codes.md — the searchable English error
code reference (PRD DIAG-003, §25.4).

Every stable `PM-*` code the product can emit must be searchable in
English documentation. This generator extracts the live code sets from
their authoritative sources so the page can never drift:

- the API service catalog (services/api/src/error_catalog.rs) plus the
  retry classification (services/api/src/lib.rs `retry_class`),
- the storage layer codes (packages/storage/persistence/src/lib.rs),
- the kernel codes (kernel-core/src/error.rs),
- client-owned codes discovered as `PM-*` literals in apps/web/src that
  no server-side source defines.

A discovered code without a curated meaning/user action fails generation,
and a curated row whose code no longer exists fails too, so the page is
complete in both directions. Output is deterministic (sorted, fixed
template); `--check` compares against the tracked artifact byte for byte.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs" / "reference" / "error-codes.md"

API_CATALOG = ROOT / "services" / "api" / "src" / "error_catalog.rs"
API_LIB = ROOT / "services" / "api" / "src" / "lib.rs"
STORE_LIB = ROOT / "packages" / "storage" / "persistence" / "src" / "lib.rs"
KERNEL_ERROR = ROOT / "packages" / "security-kernel" / "crates" / "kernel-core" / "src" / "error.rs"
WEB_SRC = ROOT / "apps" / "web" / "src"

CODE_RE = re.compile(r"\bPM-[A-Z0-9]+(?:-[A-Z0-9]+)+\b")
CATALOG_PAIR_RE = re.compile(
    r'\(\s*"(PM-[A-Z0-9-]+)",\s*"(?P<message>[^"]+)"\s*,?\s*\)')
RETRY_ARM_RE = re.compile(r'"(PM-[A-Z0-9-]+)"\s*=>\s*RetryClass::(Immediate|Delayed)')
STABLE_ARM_RE = re.compile(r'Self::\w+\s*=>\s*"(PM-[A-Z0-9-]+)"')

# Curated prose per code: what it means and what the user should do. Every
# code discovered in the sources MUST have a row here, and every row MUST
# match a discovered code — the generator fails otherwise (DIAG-003).
CURATED: dict[str, tuple[str, str]] = {
    # API service
    "PM-STORE-NOT-FOUND": (
        "The addressed record does not exist in the vault scope.",
        "Reload the item list and reapply the change to the current state."),
    "PM-STORE-CONFLICT": (
        "Compare-and-set revision mismatch; the record changed elsewhere.",
        "Re-read the item and reapply the edit on the returned "
        "`current_revision`; never blindly overwrite."),
    "PM-STORE-INVALID-RECORD": (
        "The record payload failed validation before storage.",
        "The client seals records — update the client and retry; the "
        "server never stores malformed rows."),
    "PM-STORE-UNAVAILABLE": (
        "The storage backend is unreachable right now.",
        "Retry the identical request; if it persists, check the "
        "database service health."),
    "PM-API-ROUTE-MISMATCH": (
        "The record id in the path differs from the one in the body.",
        "Make both ids identical and retry."),
    "PM-API-BAD-BODY": (
        "The request body could not be parsed.",
        "Send a well-formed JSON body."),
    "PM-API-BAD-QUERY": (
        "The query string could not be parsed.",
        "Fix the query parameters (for example a repeated field) and retry."),
    "PM-API-BODY-TOO-LARGE": (
        "The request body exceeds the configured limit.",
        "Send a smaller payload or split it via the batch endpoint."),
    "PM-API-UNAUTHORIZED": (
        "A required bearer token is missing or invalid.",
        "Configure the deployment token the service was started with."),
    "PM-API-RATE-LIMITED": (
        "Too many requests from this client within the window.",
        "Wait the `retry_after_seconds` window, then retry."),
    # Storage layer (namespaces shared with the API surface)
    # Kernel
    "PM-KERNEL-INVALID-ENCODING": (
        "Kernel input is not in the expected encoding.",
        "The payload must come from the client's own sealing path; retry "
        "from the app, not from a hand-edited payload."),
    "PM-KERNEL-NONCANONICAL-ENCODING": (
        "The encoded payload is valid but not canonical.",
        "Re-seal the record through the client so it is canonically encoded."),
    "PM-KERNEL-LIMIT-EXCEEDED": (
        "A record exceeds the kernel's per-record size limit.",
        "Split the item's content or remove oversized attachments."),
    "PM-KERNEL-INVALID-SECRET-TEXT": (
        "Secret text contains characters the record format cannot encode.",
        "Remove control characters from the secret and save again."),
    "PM-KERNEL-INVALID-IDENTIFIER": (
        "A record or vault identifier failed kernel validation.",
        "Let the app generate identifiers; imported ids must match the "
        "documented format."),
    "PM-KERNEL-INVALID-RECORD": (
        "The record structure failed kernel validation.",
        "Recreate the item in the app; corrupted payloads are rejected, "
        "not stored."),
    "PM-KERNEL-ENTROPY-UNAVAILABLE": (
        "The system entropy source is unavailable.",
        "Retry on a healthy OS; key generation refuses to degrade."),
    "PM-KERNEL-CRYPTOGRAPHIC-FAILURE": (
        "A cryptographic operation failed its self-check.",
        "Retry; if it persists, collect diagnostics and report the issue."),
    "PM-KERNEL-CONFLICT": (
        "The kernel rejected an operation because state changed.",
        "Reload and reapply; the kernel is stateless, the conflict is in "
        "the record stream."),
    "PM-KERNEL-STORAGE-UNAVAILABLE": (
        "Kernel storage (WebAssembly memory or vault file) is unavailable.",
        "Reload the app; check device storage if it persists."),
    "PM-KERNEL-CLIPBOARD-UNAVAILABLE": (
        "The clipboard could not be accessed for a copy action.",
        "Retry the copy; check browser/site clipboard permissions."),
    "PM-KERNEL-DEVICE-CREDENTIAL-UNAVAILABLE": (
        "A device credential (for example platform keychain) is unavailable.",
        "Retry after unlocking the device keychain."),
    "PM-KERNEL-CLOCK-UNAVAILABLE": (
        "A monotonic or wall clock could not be read.",
        "Retry; TOTP and retention refuse to run on an unreadable clock."),
    # Web client (client-owned codes no server source defines)
    "PM-KERNEL-INVALID-RECOVERY-KIT": (
        "The typed recovery material is not a valid kit for this vault.",
        "Re-copy the kit from the creation ceremony; recovery refuses "
        "wrong material."),
    "PM-KERNEL-WRAP-FORMAT": (
        "A vault wrapper payload has an unrecognized format.",
        "The vault may come from a different product version; update the "
        "app and retry."),
    "PM-CLIENT-NO-VAULT": (
        "No vault is known on this device yet.",
        "Create a vault or import/recover one first."),
    "PM-CLIENT-PENDING-WRITES": (
        "Locally queued writes have not synchronized yet.",
        "Reconnect and let the pending queue drain; do not delete local "
        "data while it is non-empty."),
    "PM-NETWORK-UNREACHABLE": (
        "The connected service could not be reached.",
        "Check the connection/URL; the client keeps queued writes safe."),
    "PM-STORE-INVALID-RESPONSE": (
        "A server response failed the client's integrity validation.",
        "Retry after both client and service are on supported versions."),
}


def api_catalog() -> dict[str, str]:
    text = API_CATALOG.read_text(encoding="utf-8")
    block = text.split("static CATALOG", 1)[1].split("];", 1)[0]
    return {m.group(1): m.group("message") for m in CATALOG_PAIR_RE.finditer(block)}


def api_retry_map() -> dict[str, str]:
    text = API_LIB.read_text(encoding="utf-8")
    return dict(RETRY_ARM_RE.findall(text))


def store_codes() -> set[str]:
    text = STORE_LIB.read_text(encoding="utf-8")
    block = text.split("fn stable_code", 1)[1].split("\n    }", 1)[0]
    return set(STABLE_ARM_RE.findall(block))


def kernel_codes() -> set[str]:
    text = KERNEL_ERROR.read_text(encoding="utf-8")
    block = text.split("fn stable_code", 1)[1].split("\n    }", 1)[0]
    return set(STABLE_ARM_RE.findall(block))


def web_client_codes(defined: set[str]) -> list[str]:
    found: set[str] = set()
    for path in sorted(WEB_SRC.rglob("*.js")):
        found.update(CODE_RE.findall(path.read_text(encoding="utf-8")))
    return sorted(code for code in found if code not in defined)


def render() -> str:
    catalog = api_catalog()
    retries = api_retry_map()
    store = store_codes()
    kernel = kernel_codes()
    server_defined = set(catalog) | store | kernel
    client = web_client_codes(server_defined)
    discovered = sorted(server_defined | set(client))

    unknown = [code for code in discovered if code not in CURATED]
    stale = [code for code in CURATED if code not in discovered]
    if unknown or stale:
        for code in unknown:
            print(f"ERROR: code {code} is emitted by the sources but has no "
                  "curated meaning in generate-error-codes.py", file=sys.stderr)
        for code in stale:
            print(f"ERROR: curated code {code} no longer exists in the "
                  "sources", file=sys.stderr)
        raise SystemExit(1)

    def retry_of(code: str) -> str:
        return retries.get(code, "never").lower()

    lines = [
        "# Error codes",
        "",
        "<!-- GENERATED by tools/codegen/docs/generate-error-codes.py from the",
        "     live code sources; do not edit by hand. Regenerate with",
        "     `python3 tools/codegen/docs/generate-error-codes.py --write` and",
        "     never commit hand edits (check_codegen drift-gates this file). -->",
        "",
        "Every operational error the product can emit carries a stable",
        "English ASCII code (PRD DIAG-003, error convention in PRD §25.4).",
        "This page is the searchable English reference for all surfaces:",
        "the API service, the storage layer, the record kernel, and the",
        "web client. Error responses also carry a `request_id` (mirrored in",
        "the `x-request-id` header), safe typed parameters, and a `retry`",
        "classification (`immediate`, `delayed`, or `never`) telling the",
        "client whether repeating the same request can succeed.",
        "",
        "## API service",
        "",
        "| Code | Retry | Meaning | What to do |",
        "|------|-------|---------|------------|",
    ]
    for code in sorted(catalog):
        meaning, action = CURATED[code]
        lines.append(f"| `{code}` | {retry_of(code)} | {meaning} | {action} |")
    lines += [
        "",
        "`PM-STORE-CONFLICT` carries `current_revision` (the server's",
        "committed revision) as a safe parameter; `PM-API-RATE-LIMITED`",
        "carries `retry_after_seconds` and a `Retry-After` header.",
        "",
        "## Storage layer",
        "",
        "The storage adapters surface these codes through the API service",
        "table above; the storage identity of each code is the `stable_code`",
        "mapping in `packages/storage/persistence/src/lib.rs`:",
        "",
        "| Code | Meaning | What to do |",
        "|------|---------|------------|",
    ]
    for code in sorted(store):
        meaning, action = CURATED[code]
        lines.append(f"| `{code}` | {meaning} | {action} |")
    lines += [
        "",
        "## Record kernel",
        "",
        "| Code | Meaning | What to do |",
        "|------|---------|------------|",
    ]
    for code in sorted(kernel):
        meaning, action = CURATED[code]
        lines.append(f"| `{code}` | {meaning} | {action} |")
    lines += [
        "",
        "## Web client",
        "",
        "Client-owned codes no server source emits; the client renders them",
        "from its locale catalogs keyed by the same code:",
        "",
        "| Code | Meaning | What to do |",
        "|------|---------|------------|",
    ]
    for code in client:
        meaning, action = CURATED[code]
        lines.append(f"| `{code}` | {meaning} | {action} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true",
                        help="write the generated page (default: check)")
    parser.add_argument("--check", action="store_true",
                        help="compare against the tracked page (the default)")
    args = parser.parse_args()
    page = render()
    if args.write:
        with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(page)
        print(f"wrote {OUT.relative_to(ROOT)}")
        return 0
    tracked = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
    if tracked != page:
        print(
            "ERROR: docs/reference/error-codes.md is stale; regenerate with "
            "`python3 tools/codegen/docs/generate-error-codes.py --write`",
            file=sys.stderr)
        return 1
    print("error-codes reference: in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
