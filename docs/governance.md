# Veyora governance and maintainer expectations

Audience: contributors and maintainers.
Owner: repository maintainers.
Status: effective for the current preview phase; revisited before external
contribution intake opens.

## Decision model

| Decision class | Who decides | Recorded where |
| --- | --- | --- |
| Requirements, acceptance criteria, sequencing | Maintainers, from the PRD | `PRD.md`, `release/prd-progress.json` |
| Architecture and protocol changes | Maintainer review of an ADR | `docs/adr/` |
| Cryptographic or key-lifecycle changes | Independent cryptography review (required before Accepted status) | ADR review records |
| Public claims (capabilities, readiness) | Feature/evidence registry + CODEOWNERS approval | `release/features.json`, `SECURITY.md` |
| License changes | Copyright owner (currently the sole decision holder) | `docs/legal/licensing.md` |

The PRD is the single source of requirements. The progress ledger records
what is actually complete with evidence; a claim is only as strong as its
most recent machine-verified run.

## Maintainer expectations

Maintainers:

- keep public claims truthful — an unproven capability is described as
  unsupported, not "coming soon";
- do not merge changes that weaken tests, gates, or acceptance criteria to
  obtain a green result;
- keep browser, unit, and repository gates green on `main`, re-running
  them after any behavioral change;
- record blockers precisely (what is missing, who can unblock, what
  evidence will close them) instead of leaving work silently unfinished;
- route security reports only through the private channel in
  `SECURITY.md`, never through public issues.

## Contribution state

External contribution intake is closed pending a reviewed inbound policy
(see `docs/legal/licensing.md`). Until it opens:

- issues and pull requests from non-maintainers are not the input channel;
- security reports follow `SECURITY.md`;
- discussions of the design are welcome in the repository's public review
  artifacts once a discussion venue is authorized and announced here.

Before intake opens, the maintainers must publish the contribution
mechanics (fork policy, DCO/CLA decision, review latency expectations,
and the conduct-reporting route required by `CODE_OF_CONDUCT.md`).
