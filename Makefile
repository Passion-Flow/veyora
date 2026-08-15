# Veyora common operations
.PHONY: help check check-web check-desktop check-tooling build build-wasm test test-kernel test-backend test-wasm-runtime test-browser run run-web run-db migrate worker backup restore sandbox docker-build docker-up docker-down clean

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

check: ## Validate the public repository structure and documentation links
	python3 scripts/check-repository.py

check-web: ## Validate the static web client, JavaScript, and WASM assets
	node scripts/check-web.mjs

check-desktop: ## Validate the desktop capability spike TypeScript
	cd frontend/spikes/m0-desktop && npm run check

check-tooling: ## Run backend projection generator tests
	python3 -B -m unittest discover -s backend/tooling/tests -p 'test_*.py' -v

build: ## Build all backend services
	cd backend && cargo build --locked --workspace

build-wasm: ## Build the WebAssembly kernel for the web client
	cd security-kernel && cargo build --locked --target wasm32-unknown-unknown --lib -p kernel-wasm --release
	wasm-bindgen --target web --out-dir deployment/web/wasm \
		--out-name veyora_kernel \
		security-kernel/target/wasm32-unknown-unknown/release/kernel_wasm.wasm

test-kernel: ## Run security-kernel tests
	cd security-kernel && cargo fmt --all -- --check
	cd security-kernel && cargo clippy --locked --workspace --all-targets -- -D warnings
	cd security-kernel && RUSTFLAGS="-D warnings" cargo test --locked --workspace --all-targets

test-backend: ## Run backend tests
	cd backend && cargo fmt --all -- --check
	cd backend && cargo clippy --locked --workspace --all-targets -- -D warnings
	cd backend && RUSTFLAGS="-D warnings" cargo test --locked --workspace --all-targets

test-wasm-runtime: ## Execute a freshly generated WASM binding in Node.js
	cd security-kernel && RUSTFLAGS="-D warnings" cargo build --locked --target wasm32-unknown-unknown --lib -p kernel-wasm --release
	cd security-kernel && wasm-bindgen --target nodejs --out-dir tests/wasm-out \
		--out-name veyora_kernel target/wasm32-unknown-unknown/release/kernel_wasm.wasm
	node security-kernel/tests/wasm_runtime_test.js

test-browser: ## Exercise the running web client with Playwright
	node scripts/test-browser.mjs

test: check check-web check-desktop check-tooling test-kernel test-backend ## Run all dependency-free source checks

run: ## Start the in-memory API on 127.0.0.1:8080
	cd backend && cargo build --locked -p api
	cd backend && VEYORA_STORE=in-memory VEYORA_API_BIND=127.0.0.1:8080 VEYORA_API_AUTH=disabled VEYORA_API_MAX_BODY_BYTES=262144 ./target/debug/api

run-web: ## Serve the web client on 127.0.0.1:3000
	printf 'window.VEYORA_API_BASE_URL = "http://127.0.0.1:8080";\n' > frontend/web/veyora-config.js
	cd frontend/web && python3 -m http.server 3000 --bind 127.0.0.1

run-db: ## Start PostgreSQL for source development
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up postgres

migrate: ## Apply database migrations using DATABASE_URL
	cd backend && cargo build --locked -p migrator
	cd backend && DATABASE_URL=$(DATABASE_URL) VEYORA_MIGRATIONS_DIR=crates/postgres/migrations ./target/debug/migrator

worker: ## Run the worker using DATABASE_URL
	cd backend && cargo build --locked -p worker
	cd backend && DATABASE_URL=$(DATABASE_URL) VEYORA_WORKER_POLL_SECONDS=60 ./target/debug/worker

backup: ## Export an opaque database snapshot to snapshot.json
	cd backend && cargo build --locked -p backup
	cd backend && DATABASE_URL=$(DATABASE_URL) ./target/debug/backup > ../snapshot.json

restore: ## Restore snapshot.json into the database at DATABASE_URL
	cd backend && cargo build --locked -p restore
	cd backend && DATABASE_URL=$(DATABASE_URL) ./target/debug/restore < ../snapshot.json

sandbox: ## Validate an inert record supplied through RECORD
	echo '$(RECORD)' | backend/target/debug/sandbox

docker-build: ## Build the local Compose images
	docker compose -f docker-compose.yml -f docker-compose.build.yml build

docker-up: ## Start the local preview in the background
	docker compose up -d

docker-down: ## Stop the local preview without deleting its data volume
	docker compose down

clean: ## Remove Rust build artifacts
	cd security-kernel && cargo clean
	cd backend && cargo clean
