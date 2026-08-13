# Veyora contracts

This directory contains the versioned declarative contracts shared by Veyora's
clients, backend, security kernel, and deployment sources.

## Contents

| Directory | Scope |
| --- | --- |
| `authorization/` | Per-service capabilities and deny-by-default boundaries |
| `backup/` | Logical snapshot formats, digests, and vector metadata |
| `branding/` | Public claim and release identity rules |
| `budgets/` | Runtime limits and bounded-resource policies |
| `cddl/` | Canonical CBOR wire grammars |
| `errors/` | Stable error and recovery-action catalogs |
| `generator/` | Password-generation policy |
| `i18n/` | Message catalog and parameter contracts |
| `interchange/` | CSV and portable text interchange definitions |
| `observability/` | Privacy constraints for logs and metrics |
| `openapi/` | HTTP gateway contract |
| `operator/` | Operator command, output, help, and exit shapes |
| `protocol/` | Cryptographic profiles, invariants, vectors, and provenance |
| `registry/` | Canonical configuration schema and settings catalog |
| `release/` | Reviewed dependency and toolchain lock |
| `vault/` | Encrypted record and template definitions |
| `web/` | Browser security-header policy |

JSON documents use a deliberately strict numeric profile so values remain
interoperable across Rust, Python, JavaScript, and schema consumers. Example and
vector data is inert and must never be replaced with live credentials.

Generated Rust and TypeScript projections are checked into their consuming
workspaces. Contract changes must update every affected projection and include
compatibility, security, and migration analysis.
