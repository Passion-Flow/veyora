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
    cargo build --release -p restore && \
    cp target/release/restore /veyora-restore

FROM ${DEBIAN_IMAGE}
COPY --from=builder /veyora-restore /usr/local/bin/veyora-restore
# DEP-006: run as an unprivileged fixed-uid service user; these
# services write no filesystem state outside mounted volumes.
RUN useradd --system --uid 10001 --no-create-home veyora
USER 10001
ENTRYPOINT ["veyora-restore"]
