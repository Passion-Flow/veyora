# Veyora common operations

# Transient build output lives under the ignored .build tree (REPO-012) so
# the checkout stays bounded; override either variable to relocate it.
CARGO_TARGET_DIR ?= .build/cargo
KERNEL_TARGET_DIR ?= $(CURDIR)/.build/kernel
export CARGO_TARGET_DIR

.PHONY: help check check-web check-locales check-codegen test-web-client check-desktop check-tooling codegen build build-wasm test test-kernel test-backend test-wasm-runtime test-browser test-browser-e2e test-browser-faults test-backup-restore desktop-dev desktop-build desktop-check run run-web run-db migrate worker backup restore validator docker-build docker-up docker-down purge-data doctor clean clean-all

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

check: ## Validate the public repository structure and documentation links
	python3 tools/lint/check-repository.py
	python3 tools/lint/check-manual-evidence.py
	python3 tools/lint/check-pairing-session.py
	python3 tools/lint/check-foundation-pins.py
	python3 tools/lint/check-compose-topology.py
	python3 tools/lint/check-recovery-terminology.py
	python3 tools/lint/check-doc-commands.py
	python3 tools/lint/check-doc-ownership.py
	python3 tools/lint/check-test-plan.py
	python3 tools/lint/check-source-available-wording.py
	python3 tools/lint/check-progress-consistency.py
	python3 tools/lint/check-browser-selectors.py
	python3 tools/lint/check-actions-pinned.py
	python3 tools/lint/check-artifact-hygiene.py
	python3 -B -m unittest discover -s tests/contracts -p 'test_*.py'

check-web: ## Validate the static web client, JavaScript, and WASM assets
	node tools/lint/check-web.mjs

check-locales: ## Validate frontend locale catalog integrity
	cd apps/web && node tools/check-locales.mjs

test-web-client: ## Run the web client unit tests (i18n, kernel, sync)
	cd apps/web && node --test "test/*.test.mjs"

check-desktop: desktop-check ## Lint and test the shipping desktop application
	cargo test --locked -p veyora-desktop --all-targets

check-tooling: ## Run backend projection generator tests
	python3 -B -m unittest discover -s tools/codegen/backend/tests -p 'test_*.py' -v

codegen: ## Regenerate every tracked generated artifact (see tools/codegen/manifest.json)
	python3 tools/codegen/backend/generate_registry_projection.py --write
	python3 tools/codegen/backend/generate_backend_projection.py --write \
		--registry packages/config/registry.generated.json \
		--capabilities contracts/authorization/service-capabilities-v1.json \
		--output packages/config/src/generated.rs
	cargo fmt -p backend-config
	python3 tools/codegen/contracts/generate_bindings.py --write
	python3 tools/codegen/check_codegen.py --refresh-digests

check-codegen: ## Fail when any tracked generated artifact is stale (REPO-006/007/008)
	python3 tools/codegen/check_codegen.py

build: ## Build all workspace services and packages
	cargo build --locked --workspace

build-wasm: ## Build the WebAssembly kernel for the web client
	cd packages/security-kernel && CARGO_TARGET_DIR=$(KERNEL_TARGET_DIR) cargo build --locked --target wasm32-unknown-unknown --lib -p kernel-wasm --release
	wasm-bindgen --target web --out-dir apps/web/src/wasm \
		--out-name veyora_kernel \
		$(KERNEL_TARGET_DIR)/wasm32-unknown-unknown/release/kernel_wasm.wasm

test-kernel: ## Run security-kernel tests
	cd packages/security-kernel && CARGO_TARGET_DIR=$(KERNEL_TARGET_DIR) cargo fmt --all -- --check
	cd packages/security-kernel && CARGO_TARGET_DIR=$(KERNEL_TARGET_DIR) cargo clippy --locked --workspace --all-targets -- -D warnings
	cd packages/security-kernel && CARGO_TARGET_DIR=$(KERNEL_TARGET_DIR) RUSTFLAGS="-D warnings" cargo test --locked --workspace --all-targets

test-backend: ## Run the root Rust workspace tests
	cargo fmt --all -- --check
	cargo clippy --locked --workspace --all-targets -- -D warnings
	RUSTFLAGS="-D warnings" cargo test --locked --workspace --all-targets

test-wasm-runtime: ## Execute a freshly generated WASM binding in Node.js
	cd packages/security-kernel && CARGO_TARGET_DIR=$(KERNEL_TARGET_DIR) RUSTFLAGS="-D warnings" cargo build --locked --target wasm32-unknown-unknown --lib -p kernel-wasm --release
	cd packages/security-kernel && CARGO_TARGET_DIR=$(KERNEL_TARGET_DIR) wasm-bindgen --target nodejs --out-dir tests/wasm-out \
		--out-name veyora_kernel $(KERNEL_TARGET_DIR)/wasm32-unknown-unknown/release/kernel_wasm.wasm
	node packages/security-kernel/tests/wasm_runtime_test.js

test-browser: ## Exercise the running web client with Playwright
	node tests/e2e/web/test-browser.mjs

test-browser-e2e: ## PRD acceptance journeys E2E-002/005/006/007 (running stack)
	node tests/e2e/web/test-browser-e2e.mjs

# Fault suite: its own rate-limited stack so a burst of real requests trips
# the live 429 limiter, a stopped postgres drives a real 503 store answer,
# and the gateway injects real latency on record writes for single-flight.
VEYORA_FAULT_ENV = VEYORA_DB_PASSWORD=e2e-local-dbpw VEYORA_API_AUTH=disabled VEYORA_WEB_PORT=3311 VEYORA_BUILD_COMMIT=e2e-local-check VEYORA_API_RATE_LIMIT=120 VEYORA_GATEWAY_DELAY_MS=2500

test-backup-restore: ## Backup/wipe/restore drill against the running stack's PostgreSQL
	cargo build --locked -p backup -p restore
	export DATABASE_URL="${DATABASE_URL:?set DATABASE_URL to the stack PostgreSQL}"
	export VEYORA_API_URL="${VEYORA_API_URL:-http://127.0.0.1:8080/api}"
	export VEYORA_POSTGRES_CONTAINER="${VEYORA_POSTGRES_CONTAINER:-veyora-postgres-1}"
	export BACKUP_BIN="$(CURDIR)/$(CARGO_TARGET_DIR)/debug/backup"
	export RESTORE_BIN="$(CURDIR)/$(CARGO_TARGET_DIR)/debug/restore"
	tests/integration/backup-restore.sh

test-browser-faults: ## 429/5xx fault-injection suite on its own disposable stack
	cd deploy/compose && $(VEYORA_FAULT_ENV) docker compose down --volumes >/dev/null 2>&1 || true
	cd deploy/compose && $(VEYORA_FAULT_ENV) docker compose up -d >/dev/null
	@for i in $$(seq 1 90); do \
		H=$$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3311/api/healthz 2>/dev/null); \
		W=$$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3311/ 2>/dev/null); \
		[ "$$H" = "200" ] && [ "$$W" = "200" ] && break; sleep 2; \
	done; \
	[ "$$H" = "200" ] && [ "$$W" = "200" ] || { echo "fault stack never became ready"; \
		cd deploy/compose && $(VEYORA_FAULT_ENV) docker compose down --volumes >/dev/null 2>&1; exit 1; }
	status=0; VEYORA_WEB_URL=http://127.0.0.1:3311 node tests/e2e/web/test-browser-faults.mjs || status=$$?; \
	cd deploy/compose && $(VEYORA_FAULT_ENV) docker compose down --volumes >/dev/null 2>&1; \
	exit $$status

desktop-dev: ## Run the Tauri desktop client against a live server
	npm ci --no-audit --no-fund && npm run -w @veyora/desktop dev

desktop-build: ## Build unsigned desktop preview bundles for the current host
	npm ci --no-audit --no-fund && npm run -w @veyora/desktop build

desktop-check: ## Lint the desktop client Rust shell
	cargo fmt --all -- --check
	cargo clippy --locked --all-targets -p veyora-desktop -- -D warnings

test: check check-web check-locales test-web-client check-desktop check-tooling test-kernel test-backend ## Run all dependency-free source checks

run: ## Start the in-memory API on 127.0.0.1:8080
	cargo build --locked -p api
	VEYORA_STORE=in-memory VEYORA_API_BIND=127.0.0.1:8080 VEYORA_API_AUTH=disabled VEYORA_API_MAX_BODY_BYTES=262144 $(CARGO_TARGET_DIR)/debug/api

run-web: ## Serve the web client on 127.0.0.1:3000
	printf 'window.VEYORA_API_BASE_URL = "http://127.0.0.1:8080";\nwindow.VEYORA_BUILD_COMMIT = "%s";\n' 		"$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" > apps/web/veyora-config.js
	cd apps/web && python3 -m http.server 3000 --bind 127.0.0.1

run-db: ## Start PostgreSQL for source development
	cd deploy/compose && docker compose up postgres

migrate: ## Apply database migrations using DATABASE_URL
	cargo build --locked -p migrator
	DATABASE_URL=$(DATABASE_URL) VEYORA_MIGRATIONS_DIR=packages/storage/postgres/migrations $(CARGO_TARGET_DIR)/debug/migrator

worker: ## Run the worker using DATABASE_URL
	cargo build --locked -p worker
	DATABASE_URL=$(DATABASE_URL) VEYORA_WORKER_POLL_SECONDS=60 $(CARGO_TARGET_DIR)/debug/worker

backup: ## Export an opaque database snapshot to .local/backups/snapshot.json
	mkdir -p .local/backups
	cargo build --locked -p backup
	DATABASE_URL=$(DATABASE_URL) $(CARGO_TARGET_DIR)/debug/backup > .local/backups/snapshot.json

restore: ## Restore .local/backups/snapshot.json into the database at DATABASE_URL
	cargo build --locked -p restore
	DATABASE_URL=$(DATABASE_URL) $(CARGO_TARGET_DIR)/debug/restore < .local/backups/snapshot.json

validator: ## Validate an inert record supplied through RECORD
	echo '$(RECORD)' | $(CARGO_TARGET_DIR)/debug/validator

docker-build: ## Build the local Compose images
	cd deploy/compose && docker compose build

docker-up: ## Start the local preview in the background
	cd deploy/compose && docker compose up -d

docker-down: ## Stop the local preview without deleting its data volume
	cd deploy/compose && docker compose down

purge-data: ## DESTRUCTIVE: stop the preview and DELETE the veyora-pg data
## volume (every encrypted record). Requires CONFIRM=destroy-veyora-data.
ifndef CONFIRM
	$(error Set CONFIRM=destroy-veyora-data to delete the veyora-pg volume and every stored record)
endif
ifeq ($(CONFIRM),destroy-veyora-data)
	cd deploy/compose && docker compose down --volumes
else
	$(error CONFIRM must be exactly destroy-veyora-data)
endif

doctor: ## Report required and optional toolchain readiness
	sh tools/lint/doctor.sh

clean: ## Remove transient build output under the ignored .build tree
	rm -rf .build
	cd packages/security-kernel && CARGO_TARGET_DIR=$(KERNEL_TARGET_DIR) cargo clean

clean-all: clean ## Additionally remove dependency trees and every target dir
	rm -rf node_modules
	rm -rf packages/security-kernel/target target apps/desktop/src-tauri/target
	cargo clean
