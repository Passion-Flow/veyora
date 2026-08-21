# Contributing to Veyora

Thank you for taking the time to review Veyora.

The repository is in an early public-preview phase. Issue reports and design
feedback are welcome. Before investing in a substantial pull request, open an
issue to confirm that the proposed change fits the current direction. Security
reports must follow [SECURITY.md](SECURITY.md) and must never be posted publicly.

## Development setup

Install the Rust toolchain declared by each workspace. Docker is optional for
Rust-only work and required for the full local topology.

```bash
git clone https://github.com/Passion-Flow/veyora.git
cd veyora
make check
make test
```

For container work:

```bash
cp docker/.env.example docker/.env
# Set a unique VEYORA_DB_PASSWORD in docker/.env.
cd docker
docker compose config --quiet
docker compose up --build -d
```

## Change guidelines

- Keep changes focused and explain the user or operator impact.
- Add or update tests for executable behavior.
- Preserve the client/server trust boundary: server-side code must not receive
  plaintext vault fields, master-password material, or client root keys.
- Use inert fixtures only. Never commit credentials, tokens, non-public endpoints,
  production data, or personal information.
- Keep configuration explicit and fail closed when a required value is absent.
- Document new dependencies, generated assets, copied code, and license notices.
- Update user-facing documentation when behavior or configuration changes.
- Run `make check`, the affected Rust workspace tests, and `git diff --check`.

## Commit and pull-request style

Use concise English commit messages in the imperative mood. A pull request
should explain:

1. what changed and why;
2. the security and privacy impact;
3. compatibility or migration considerations;
4. the verification performed; and
5. known limitations or follow-up work.

## Licensing and brand

The project is source-available under the terms in [LICENSE](LICENSE). By
submitting a contribution, you must have the right to provide it and understand
that acceptance is not guaranteed. No contributor license agreement or
Developer Certificate of Origin process has been adopted.

The [trademark policy](TRADEMARK.md) and
[brand guidelines](BRAND_GUIDELINES.md) govern representations of official
Veyora work independently of the software license.
