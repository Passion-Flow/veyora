# Veyora roadmap

Audience: users and evaluators. Owner: repository maintainers.
Derived from the PRD maturity gates; every status below must match the
feature/evidence registry (`release/features.json`) and the progress
ledger (`release/prd-progress.json`). This page is a view, not a second
source of truth.

## Where the project is now

Preview: source-available, local desktop-first vault with an experimental
connected mode. No supported production deployment, no signed installers,
and no stable release channel yet.

## Gate progression (PRD §G)

| Gate | Meaning | Status |
| --- | --- | --- |
| G0 Foundations | Crypto kernel, storage, API contracts | Done for the preview scope; independent cryptographic review pending (ADR gate) |
| G1 Local MVP | Create/unlock, items, search, Trash, lock | Implemented; browser-verified continuously |
| G2–G3 Hardening | Atomicity, fault injection, retention, reset | Implemented in the experimental lane (rekey, batch, retention purge, reset matrix); ADR acceptance pending |
| G4–G5 Connected | Pairing, sessions, production TLS | Design accepted as Proposed; implementation blocked on the independent review (ADR 0005) |
| G6 Documentation/community | OSI license, community readiness | Community documents in place; **OSI license decision pending owner/legal approval** |
| G7 Stable | External assessment, soak, Beta remediation | Not started; requires G4–G6 |

## Near-term work (already implemented locally, awaiting external gates)

- Independent cryptography review of the key/recovery/backup lifecycle so
  the experimental lane can be accepted (ADR 0004/0005).
- Owner verification of published release metadata and first CI runs on
  GitHub runners.
- Signing/notarization credentials for the four native packages, then
  E2E-009 on real hardware.
- A real HTTPS hostname for the connected production-shaped path
  (E2E-008).

## Not on the roadmap

- Backdoors, escrow, or any server-side ability to read vault contents.
- Calling the project "open source" before an OSI-approved license is
  adopted (OSS-001/OSS-002).
- Marketing claims ahead of evidence: every capability claim on public
  surfaces must trace to the feature/evidence registry.
