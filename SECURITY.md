# Security policy

Security is the primary design constraint of Veyora, but this repository is an
early public preview and has not completed an independent human cryptographic
audit or production hardening review.

## Supported versions

There is currently no supported production release. The `main` branch is
available for review and testing with inert data only. It must not be treated as
authorization to store real credentials or expose a deployment to the public
internet.

## Report a vulnerability privately

Do not disclose vulnerabilities, exploit details, private endpoints, personal
data, or credentials in a public issue, discussion, or pull request.

Use GitHub's private vulnerability reporting flow:

<https://github.com/Passion-Flow/veyora/security/advisories/new>

Include only the information required to reproduce and assess the issue:

- the affected commit or component;
- impact and required preconditions;
- a minimal reproduction using inert data;
- any immediate containment recommendation; and
- whether the issue may already have been disclosed elsewhere.

Please do not include real vault data, passwords, keys, tokens, production
addresses, or destructive payloads. No response-time or bounty commitment is
offered at this stage.

## Security boundaries

Veyora aims to keep plaintext vault data, master-password material, root keys,
and record keys inside authorized clients. The server side is designed around
opaque ciphertext and operational metadata. This architecture does not protect
against every class of compromise, including:

- a malicious or compromised browser, extension, endpoint, or operating system;
- a modified build, dependency, WebAssembly module, or delivery path;
- incorrect ingress, TLS, proxy, authentication, or secret configuration;
- exposure through clipboard, screen capture, swap, crash dumps, or local logs;
- weak master passwords or mishandled recovery material; or
- cryptographic or protocol implementation defects.

Read the [threat model](docs/security/threat-model.md) and
[plaintext/metadata inventory](docs/security/plaintext-metadata-inventory.md)
before evaluating the design.

## Disclosure expectations

Please allow reasonable time for triage and remediation before public
disclosure. Coordinated disclosure terms, safe-harbor language, and a formal
support lifecycle may be introduced with a future reviewed release policy.
