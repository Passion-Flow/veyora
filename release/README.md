# Release truth sources

Audience: release engineering, product, QA, security, and documentation owners.

`version.json` is the single product-version and release-channel authority.
Product manifests and release workflows must match it. Tooling and archived
experiments use `0.0.0` because they are not product releases.

`features.json` is the public capability and evidence registry required by
`DOC-001`. Public documentation may make only the bounded claims recorded
there. A status describes evidence, not implementation intent:

- `Stable`: every required stable gate is complete.
- `Beta`: feature-complete for its stated scope, with remaining validation
  recorded as limitations.
- `Experimental`: usable only with inert test data and no support promise.
- `Protocol-only`: a format or primitive exists without a complete user flow.
- `Planned`: not implemented as a supported capability.
- `Unsupported`: no supported path exists.

The repository integrity check validates these authorities and rejects version,
channel, status, path, and evidence drift.

`kernel-assets.json` pins the reviewed browser binding and WebAssembly bytes.
The runtime verifies those digests before initialization; repository checks
reject source or generated-output drift. A future signed release manifest must
carry the same identities plus artifact URLs, signatures, and provenance.

`prd-progress.json` is the execution handoff record for the PRD backlog. It does
not replace the PRD or relax its completion signals. Every change that advances
or completes a backlog work package must update this record in the same change.
`Complete` is allowed only when the PRD completion signal is satisfied;
containment or a subset of implementation work must remain `Partial`.
