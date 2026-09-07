# Veyora support and discussion routing

Audience: users and evaluators.
Owner: repository maintainers.

Veyora is a preview. There is no paid support, no SLA, and no operated
service. Route each need to the correct place so safety reports are never
handled in public.

| Need | Route | Notes |
| --- | --- | --- |
| Security vulnerability (any severity) | Private vulnerability reporting: `SECURITY.md` | Never a public issue; do not include live credentials or real vault data |
| Product/requirements question | Repository issues (once external intake opens; see `docs/governance.md`) | Until then, the PRD and `docs/USER-GUIDE.md` are the reference |
| Deployment/operations question (self-hosted preview) | `docs/OPERATOR-GUIDE.md`, `docs/runbook.md` | Check the runbook's symptom index first |
| Bug report | Issue templates in `.github/ISSUE_TEMPLATE/` when intake opens | Use inert data only in reproductions |
| Feature discussion | Roadmap and PRD first (`docs/roadmap.md`) | Changes land through PRD requirement updates, not ad-hoc issues |
| Conduct concern | Private route published with the conduct policy (`docs/CODE_OF_CONDUCT.md`) | Do not discuss conduct reports in public threads |

## Response expectations

Maintainers review security reports first. Other routes have no response
time commitment while external intake is closed; this page will state
expectations when channels open.

## What support will never ask for

No maintainer or support route will ever ask for your master password,
Recovery Key, vault contents, or a decrypted export. Any such request is a
reportable security incident.
