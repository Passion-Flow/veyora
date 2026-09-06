# Base images are parameterized so builds can target a registry mirror
# (e.g. --build-arg RUST_IMAGE=…/rust:1.93.1-slim) without editing files.
ARG RUST_IMAGE=rust:1.93.1-slim-bookworm
ARG DEBIAN_IMAGE=debian:bookworm-slim
FROM ${RUST_IMAGE} AS builder
ENV RUSTFLAGS="-D warnings"
WORKDIR /veyora
COPY Cargo.toml Cargo.lock ./
COPY rust-toolchain.toml ./
COPY services/ ./services/
COPY packages/ ./packages/
COPY apps/desktop/src-tauri/Cargo.toml ./apps/desktop/src-tauri/Cargo.toml
COPY apps/desktop/src-tauri/src/ ./apps/desktop/src-tauri/src/
COPY apps/desktop/src-tauri/build.rs ./apps/desktop/src-tauri/build.rs
COPY contracts/ ./contracts/
COPY tests/architecture/ ./tests/architecture/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/veyora/target,sharing=locked \
    cargo build --release -p api && \
    cp target/release/api /veyora-api

FROM ${DEBIAN_IMAGE}
# The image tag and package index are resolved together; pinning Debian package
# revisions independently would make routine base-image refreshes fail.
# hadolint ignore=DL3008
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /veyora-api /usr/local/bin/veyora-api
EXPOSE 8080
# No baked configuration: every VEYORA_* variable is provided explicitly by
# the deployment environment (.env.example documents the full set) and
# the binary refuses to start when any required one is missing.
# DEP-006: run as an unprivileged fixed-uid service user; these
# services write no filesystem state outside mounted volumes.
RUN useradd --system --uid 10001 --no-create-home veyora
USER 10001
ENTRYPOINT ["veyora-api"]
