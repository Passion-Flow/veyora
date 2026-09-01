//! Veyora API functional surface.
//!
//! A ciphertext-only HTTP boundary: it stores and retrieves opaque per-record
//! ciphertext through the [`backend_persistence::OpaqueStore`] port. It never
//! decrypts, never accepts cleartext, and never handles authentication material
//! or keys. Record bodies are already client-encrypted before they arrive.

#![forbid(unsafe_code)]

pub mod error_catalog;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use backend_persistence::{GenericEncryptedRecordV1, OpaqueStore, RecordSummary, StoreError};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// API authentication mode. Explicitly configured, never inferred: when
/// [`Config::from_env`] is used, a missing or malformed `VEYORA_API_AUTH`
/// aborts startup instead of silently deciding.
#[derive(Clone, Debug)]
pub enum AuthMode {
    Disabled,
    BearerToken(String),
}

/// Explicit runtime configuration. There are no hidden defaults: production
/// entry points must construct this via [`Config::from_env`], which fails fast
/// listing every missing or invalid variable. The only hand-built instances
/// are in tests, where the values are written out at the construction site.
#[derive(Clone, Debug)]
pub struct Config {
    /// Socket to bind, e.g. `0.0.0.0:8080` (`VEYORA_API_BIND`).
    pub bind: String,
    /// Authentication policy (`VEYORA_API_AUTH`: `disabled` | `token`).
    pub auth_mode: AuthMode,
    /// Request body ceiling in bytes (`VEYORA_API_MAX_BODY_BYTES`).
    pub max_body_bytes: usize,
    /// CORS allowlist (`VEYORA_API_CORS_ORIGINS`, comma-separated; empty
    /// keeps the permissive `*` for development). Setting any origin
    /// removes the wildcard, which is required in authenticated
    /// deployments (OWASP API6:2023).
    pub cors_origins: Vec<String>,
    /// Maximum requests per minute per client IP (`VEYORA_API_RATE_LIMIT`).
    /// Zero disables rate limiting (development default).
    pub rate_limit_per_minute: usize,
}

impl Config {
    /// Resolve the configuration from the environment or return a list of
    /// every problem found (missing, invalid, or inconsistent variables).
    pub fn from_env_problems() -> Result<Self, Vec<String>> {
        let mut problems: Vec<String> = Vec::new();
        let bind = std::env::var("VEYORA_API_BIND").unwrap_or_else(|_| {
            problems.push("VEYORA_API_BIND is required (e.g. 0.0.0.0:8080)".into());
            String::new()
        });
        let auth_mode = match std::env::var("VEYORA_API_AUTH").as_deref() {
            Ok("disabled") => AuthMode::Disabled,
            Ok("token") => match std::env::var("VEYORA_API_TOKEN") {
                Ok(token) if !token.is_empty() => AuthMode::BearerToken(token),
                _ => {
                    problems
                        .push("VEYORA_API_AUTH=token requires a non-empty VEYORA_API_TOKEN".into());
                    AuthMode::Disabled
                }
            },
            Ok(other) => {
                problems.push(format!(
                    "VEYORA_API_AUTH must be 'disabled' or 'token' (got {other:?})"
                ));
                AuthMode::Disabled
            }
            Err(_) => {
                problems.push("VEYORA_API_AUTH is required ('disabled' or 'token')".into());
                AuthMode::Disabled
            }
        };
        let cors_origins = std::env::var("VEYORA_API_CORS_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(str::to_string)
            .collect();
        let rate_limit_per_minute = match std::env::var("VEYORA_API_RATE_LIMIT") {
            // Empty and unset behave the same: deployment templates pass
            // the variable through as an empty string when it is unset.
            Ok(raw) if raw.trim().is_empty() => 0,
            Ok(raw) => match raw.parse::<usize>() {
                Ok(n) => n,
                Err(_) => {
                    problems.push(format!(
                        "VEYORA_API_RATE_LIMIT must be a non-negative integer (got {raw:?})"
                    ));
                    0
                }
            },
            Err(_) => 0, // Optional: zero disables rate limiting
        };
        let max_body_bytes = match std::env::var("VEYORA_API_MAX_BODY_BYTES") {
            Ok(raw) => match raw.parse::<usize>() {
                Ok(n) if n > 0 => n,
                _ => {
                    problems.push(format!(
                        "VEYORA_API_MAX_BODY_BYTES must be a positive integer (got {raw:?})"
                    ));
                    0
                }
            },
            Err(_) => {
                problems.push("VEYORA_API_MAX_BODY_BYTES is required (e.g. 262144)".into());
                0
            }
        };
        if problems.is_empty() {
            Ok(Self {
                bind,
                auth_mode,
                max_body_bytes,
                cors_origins,
                rate_limit_per_minute,
            })
        } else {
            Err(problems)
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    store: Arc<dyn OpaqueStore>,
    metrics: Arc<RequestMetrics>,
    rate_limiter: Arc<RateLimiter>,
    config: Config,
}

pub struct RequestMetrics {
    total_requests: AtomicU64,
    put_count: AtomicU64,
    get_count: AtomicU64,
    delete_count: AtomicU64,
    started: std::time::Instant,
}

impl RequestMetrics {
    fn new() -> Self {
        Self {
            total_requests: AtomicU64::new(0),
            put_count: AtomicU64::new(0),
            get_count: AtomicU64::new(0),
            delete_count: AtomicU64::new(0),
            started: std::time::Instant::now(),
        }
    }
    fn record(&self, method: &str) {
        self.total_requests.fetch_add(1, Ordering::Relaxed);
        match method {
            "PUT" => {
                self.put_count.fetch_add(1, Ordering::Relaxed);
            }
            "GET" => {
                self.get_count.fetch_add(1, Ordering::Relaxed);
            }
            "DELETE" => {
                self.delete_count.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }
    fn uptime_seconds(&self) -> u64 {
        self.started.elapsed().as_secs()
    }
}

impl AppState {
    #[must_use]
    pub fn new(store: Arc<dyn OpaqueStore>, config: Config) -> Self {
        Self {
            store,
            metrics: Arc::new(RequestMetrics::new()),
            rate_limiter: Arc::new(RateLimiter::new(config.rate_limit_per_minute)),
            config,
        }
    }

    /// Run a blocking store operation off the async runtime. Store
    /// implementations (notably the synchronous managed-PostgreSQL client)
    /// cannot be driven from within a tokio worker thread, so every store call
    /// is dispatched to a blocking thread and awaited.
    async fn run<F, R>(&self, f: F) -> Result<R, StoreError>
    where
        F: FnOnce(&dyn OpaqueStore) -> Result<R, StoreError> + Send + 'static,
        R: Send + 'static,
    {
        let store = self.store.clone();
        match tokio::task::spawn_blocking(move || f(&*store)).await {
            Ok(inner) => inner,
            Err(_) => Err(StoreError::StoreUnavailable),
        }
    }
}

/// Build the API router over a shared opaque store and explicit configuration.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(ready_check))
        .route("/version", get(version))
        .route("/metrics", get(metrics))
        .route("/records", get(list_records).options(cors_ok))
        .route("/records/batch", post(batch_put_records).options(cors_ok))
        .route(
            "/records/{id}",
            get(get_record)
                .put(put_record)
                .delete(tombstone_record)
                .options(cors_ok),
        )
        .route("/vault/purge", post(purge_tombstoned).options(cors_ok))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            body_limit_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            request_log_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            cors_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        // Outermost: rate limiting, then error localization.
        .layer(axum::middleware::from_fn(localize_error_middleware))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rate_limit_middleware,
        ))
        .with_state(state)
}

/// Reject request bodies larger than the configured ceiling before they reach
/// handlers (`VEYORA_API_MAX_BODY_BYTES` via [`Config`]).
async fn body_limit_middleware(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if let Some(len) = req.headers().get(axum::http::header::CONTENT_LENGTH)
        && let Ok(s) = len.to_str()
        && let Ok(n) = s.parse::<usize>()
        && n > state.config.max_body_bytes
    {
        return error_response(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            "PM-API-BODY-TOO-LARGE",
            error_catalog::FALLBACK_LOCALE,
        );
    }
    next.run(req).await
}

async fn cors_ok() -> StatusCode {
    StatusCode::NO_CONTENT
}

/// Monotonic per-process request-ID source for [`request_log_middleware`].
static REQUEST_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Simple request logger with per-request ID: prints method, path, status,
/// duration, and a short hex request ID to stderr. The ID is also returned
/// in the X-Request-Id response header for client-side correlation.
async fn request_log_middleware(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    state.metrics.record(method.as_str());
    // Short unique request ID: a monotonic per-process counter. Uniqueness (not
    // unpredictability) is the requirement, and a counter works on every
    // platform — unlike a /dev/urandom read, which silently failed on Windows.
    let req_id: String = format!(
        "{:016x}",
        REQUEST_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let start = std::time::Instant::now();
    let mut response = next.run(req).await;
    let status = response.status();
    let elapsed = start.elapsed();
    eprintln!(
        "[{}] {} {} {} {:?}",
        req_id,
        method,
        path,
        status.as_u16(),
        elapsed
    );
    if let Ok(val) = req_id.parse() {
        response.headers_mut().insert("x-request-id", val);
    }
    response
}

/// Bearer-token auth driven by the explicit [`Config`] (`VEYORA_API_AUTH`):
/// `token` requires `Authorization: Bearer <VEYORA_API_TOKEN>` on every
/// non-health endpoint; `disabled` is an explicit opt-out that must be set —
/// the entrypoint refuses to start without one of the two.
/// Constant-time equality for secrets: compares all bytes even on mismatch
/// so response timing does not reveal how much of the token was correct.
/// Length differences still short-circuit (length is not secret here).
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

async fn auth_middleware(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let expected_token = match &state.config.auth_mode {
        AuthMode::BearerToken(token) => token,
        AuthMode::Disabled => return next.run(req).await,
    };
    let path = req.uri().path();
    // Health endpoints are always open.
    if path == "/healthz" || path == "/readyz" || req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }
    // Check Authorization header.
    let auth_header = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if let Some(token) = auth_header.strip_prefix("Bearer ")
        && constant_time_eq(token, expected_token)
    {
        return next.run(req).await;
    }
    let mut response = error_response(
        axum::http::StatusCode::UNAUTHORIZED,
        "PM-API-UNAUTHORIZED",
        error_catalog::FALLBACK_LOCALE,
    );
    response
        .headers_mut()
        .insert("www-authenticate", "Bearer".parse().unwrap());
    response
}

/// Batch PUT multiple records in a single request. Returns per-record results.
async fn batch_put_records(
    State(state): State<AppState>,
    Json(dtos): Json<Vec<RecordDto>>,
) -> Result<Json<Vec<BatchResult>>, ApiError> {
    let mut results = Vec::with_capacity(dtos.len());
    for dto in dtos {
        let id = dto.record_id.clone();
        let expected = dto.expected_prior_revision;
        let record = dto.into_record();
        match state.run(move |store| store.put(record, expected)).await {
            Ok(rev) => results.push(BatchResult {
                record_id: id,
                ok: true,
                revision: Some(rev),
                error: None,
            }),
            Err(e) => results.push(BatchResult {
                record_id: id,
                ok: false,
                revision: None,
                error: Some(e.stable_code().to_string()),
            }),
        }
    }
    Ok(Json(results))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchResult {
    pub record_id: String,
    pub ok: bool,
    pub revision: Option<u64>,
    pub error: Option<String>,
}

/// Minimal CORS middleware for development: allows all origins/methods/headers.
/// Production uses an Envoy gateway that enforces strict CSP/origin policy.
async fn cors_middleware(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    // Handle CORS preflight (OPTIONS) directly without forwarding to routes.
    if req.method() == axum::http::Method::OPTIONS {
        return axum::response::Response::builder()
            .status(axum::http::StatusCode::NO_CONTENT)
            .header("access-control-allow-origin", "*")
            .header(
                "access-control-allow-methods",
                "GET, PUT, POST, DELETE, OPTIONS",
            )
            .header("access-control-allow-headers", "content-type")
            .body(axum::body::Body::empty())
            .unwrap();
    }
    let origin = req
        .headers()
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let allowed = cors_allow_origin(&state.config.cors_origins, origin.as_deref());
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    if let Some(value) = allowed {
        headers.insert("access-control-allow-origin", value.parse().unwrap());
        headers.insert("vary", "Origin".parse().unwrap());
    }
    headers.insert(
        "access-control-allow-methods",
        "GET, PUT, POST, DELETE, OPTIONS".parse().unwrap(),
    );
    headers.insert(
        "access-control-allow-headers",
        "content-type".parse().unwrap(),
    );
    response
}

/// Resolve the `Access-Control-Allow-Origin` header from the configured
/// allowlist. An empty allowlist keeps the development wildcard `*`.
fn cors_allow_origin(origins: &[String], request_origin: Option<&str>) -> Option<String> {
    if origins.is_empty() {
        return Some("*".to_string());
    }
    let request = request_origin?;
    if origins.iter().any(|allowed| allowed == request) {
        Some(request.to_string())
    } else {
        None
    }
}

async fn health() -> StatusCode {
    StatusCode::OK
}

/// Version info endpoint.
async fn version() -> Json<VersionInfo> {
    Json(VersionInfo {
        version: format!("v{}", env!("CARGO_PKG_VERSION")),
        protocol_version: 1,
        suite_id: 1,
    })
}

#[derive(Serialize, Deserialize)]
pub struct VersionInfo {
    pub version: String,
    pub protocol_version: u16,
    pub suite_id: u16,
}

/// Readiness check: verifies the store can list records (DB reachable).
async fn ready_check(State(state): State<AppState>) -> Result<Json<ReadyStatus>, ApiError> {
    match state.run(|store| store.list()).await {
        Ok(records) => Ok(Json(ReadyStatus {
            ready: true,
            record_count: records.len(),
        })),
        Err(_) => Ok(Json(ReadyStatus {
            ready: false,
            record_count: 0,
        })),
    }
}

#[derive(Serialize, Deserialize)]
pub struct ReadyStatus {
    pub ready: bool,
    pub record_count: usize,
}

/// Prometheus-style metrics endpoint.
async fn metrics(State(state): State<AppState>) -> String {
    let m = &state.metrics;
    format!(
        "# HELP veyora_requests_total Total HTTP requests.\n\
         # TYPE veyora_requests_total counter\n\
         veyora_requests_total {}\n\
         # HELP veyora_puts_total Total PUT (create/update) requests.\n\
         # TYPE veyora_puts_total counter\n\
         veyora_puts_total {}\n\
         # HELP veyora_gets_total Total GET requests.\n\
         # TYPE veyora_gets_total counter\n\
         veyora_gets_total {}\n\
         # HELP veyora_deletes_total Total DELETE requests.\n\
         # TYPE veyora_deletes_total counter\n\
         veyora_deletes_total {}\n\
         # HELP veyora_uptime_seconds Server uptime in seconds.\n\
         # TYPE veyora_uptime_seconds gauge\n\
         veyora_uptime_seconds {}\n",
        m.total_requests.load(Ordering::Relaxed),
        m.put_count.load(Ordering::Relaxed),
        m.get_count.load(Ordering::Relaxed),
        m.delete_count.load(Ordering::Relaxed),
        m.uptime_seconds(),
    )
}

/// Query parameters for the record list endpoint.
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// `?embed=bodies` returns full record DTOs (including ciphertext) so
    /// clients can hydrate a whole vault in one round trip instead of one
    /// GET per record. Any other value returns summaries only.
    pub embed: Option<String>,
}

/// List record summaries (metadata only), or full records with
/// `?embed=bodies` for single-round-trip hydration.
async fn list_records(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> Result<axum::response::Response, ApiError> {
    let embed_bodies = query.embed.as_deref() == Some("bodies");
    if embed_bodies {
        let records = state
            .run(|store| store.list_bodies())
            .await
            .map_err(ApiError::from)?;
        let dtos: Vec<RecordDto> = records.into_iter().map(RecordDto::from_record).collect();
        return Ok(Json(dtos).into_response());
    }
    let summaries = state
        .run(|store| store.list())
        .await
        .map_err(ApiError::from)?;
    let dtos: Vec<RecordSummaryDto> = summaries.into_iter().map(RecordSummaryDto::from).collect();
    Ok(Json(dtos).into_response())
}

async fn get_record(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<RecordDto>, ApiError> {
    let record = state
        .run(move |store| store.get(&id))
        .await
        .map_err(ApiError::from)?;
    Ok(Json(RecordDto::from_record(record)))
}

/// Revision echo for PUT/DELETE responses.
#[derive(Debug, Serialize, Deserialize)]
pub struct RevisionResponse {
    pub revision: u64,
}

async fn put_record(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(dto): Json<RecordDto>,
) -> Result<Response, ApiError> {
    if dto.record_id != id {
        return Err(ApiError::RouteMismatch);
    }
    let expected_prior_revision = dto.expected_prior_revision;
    let record = dto.into_record();
    let revision = state
        .run(move |store| store.put(record, expected_prior_revision))
        .await
        .map_err(ApiError::from)?;
    Ok((StatusCode::CREATED, Json(RevisionResponse { revision })).into_response())
}

async fn tombstone_record(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<TombstoneRequest>,
) -> Result<Response, ApiError> {
    let revision = state
        .run(move |store| store.tombstone(&id, body.expected_prior_revision))
        .await
        .map_err(ApiError::from)?;
    Ok((StatusCode::OK, Json(RevisionResponse { revision })).into_response())
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TombstoneRequest {
    pub expected_prior_revision: u64,
}

/// Purge all tombstoned records from the store.
async fn purge_tombstoned(State(state): State<AppState>) -> Result<Json<PurgeResult>, ApiError> {
    let purged = state
        .run(|store| store.purge_tombstoned())
        .await
        .map_err(ApiError::from)?;
    Ok(Json(PurgeResult { purged }))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PurgeResult {
    pub purged: u64,
}

/// Wire DTO for an opaque encrypted record. Carries only ciphertext + metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordDto {
    pub protocol_version: u16,
    pub suite_id: u16,
    pub deployment_id: String,
    pub vault_id: String,
    pub record_id: String,
    pub revision: u64,
    pub ciphertext: String,
    pub ciphertext_hash: String,
    pub ciphertext_length: u64,
    pub tombstone: bool,
    pub template_envelope_hash: String,
    pub manifest_binding: String,
    /// Optional CAS revision: None for a new record, Some(prior) for an update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_prior_revision: Option<u64>,
}

impl RecordDto {
    /// Convert a stored record into its wire DTO shape (no CAS expectation).
    pub fn from_record(record: GenericEncryptedRecordV1) -> Self {
        Self {
            protocol_version: record.protocol_version,
            suite_id: record.suite_id,
            deployment_id: record.deployment_id,
            vault_id: record.vault_id,
            record_id: record.record_id,
            revision: record.revision,
            ciphertext: record.ciphertext,
            ciphertext_hash: record.ciphertext_hash,
            ciphertext_length: record.ciphertext_length,
            tombstone: record.tombstone,
            template_envelope_hash: record.template_envelope_hash,
            manifest_binding: record.manifest_binding,
            expected_prior_revision: None,
        }
    }

    /// Convert a wire DTO into the storage record shape, dropping the CAS
    /// expectation (callers pass it separately to `put`).
    pub fn into_record(self) -> GenericEncryptedRecordV1 {
        GenericEncryptedRecordV1 {
            protocol_version: self.protocol_version,
            suite_id: self.suite_id,
            deployment_id: self.deployment_id,
            vault_id: self.vault_id,
            record_id: self.record_id,
            revision: self.revision,
            ciphertext: self.ciphertext,
            ciphertext_hash: self.ciphertext_hash,
            ciphertext_length: self.ciphertext_length,
            tombstone: self.tombstone,
            template_envelope_hash: self.template_envelope_hash,
            manifest_binding: self.manifest_binding,
        }
    }
}

/// Wire DTO for a record-list summary entry. Server-visible metadata only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordSummaryDto {
    pub record_id: String,
    pub revision: u64,
    pub tombstone: bool,
    pub ciphertext_hash: String,
}

impl From<RecordSummary> for RecordSummaryDto {
    fn from(summary: RecordSummary) -> Self {
        Self {
            record_id: summary.record_id,
            revision: summary.revision,
            tombstone: summary.tombstone,
            ciphertext_hash: summary.ciphertext_hash,
        }
    }
}

/// Closed, redacted API error surface. Bodies never echo record bytes.
///
/// Errors serialize as `{"error":{"code":…,"message":…}}`. The stable code is
/// the contract; the message is localized presentation resolved from
/// `Accept-Language` by [`localize_error_middleware`], defaulting to English.
#[derive(Debug)]
pub enum ApiError {
    Store(StoreError),
    RouteMismatch,
    BadBody,
}

/// Serializable error envelope shared by every error response path.
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

impl ApiError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::Store(StoreError::NotFound) => (StatusCode::NOT_FOUND, "PM-STORE-NOT-FOUND"),
            Self::Store(StoreError::Conflict) => (StatusCode::CONFLICT, "PM-STORE-CONFLICT"),
            Self::Store(StoreError::InvalidRecord) => {
                (StatusCode::BAD_REQUEST, "PM-STORE-INVALID-RECORD")
            }
            Self::Store(StoreError::StoreUnavailable) => {
                (StatusCode::SERVICE_UNAVAILABLE, "PM-STORE-UNAVAILABLE")
            }
            Self::RouteMismatch => (StatusCode::BAD_REQUEST, "PM-API-ROUTE-MISMATCH"),
            Self::BadBody => (StatusCode::BAD_REQUEST, "PM-API-BAD-BODY"),
        }
    }
}

/// Build a JSON error response for a stable code in the given locale.
fn error_response(status: StatusCode, code: &str, locale: &str) -> Response {
    let body = ErrorBody {
        error: ErrorDetail {
            code: code.to_string(),
            message: error_catalog::localized_message(code, locale).to_string(),
        },
    };
    (status, Json(body)).into_response()
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        error_response(status, code, error_catalog::FALLBACK_LOCALE)
    }
}

/// Fixed-window per-IP request counter for rate limiting.
///
/// Basis: NIST SP 800-63B §5.2.2 requires throttling on authentication
/// interfaces; OWASP API4:2023 (Unrestricted Resource Consumption)
/// recommends per-client quotas. The fixed window is O(1) memory per IP
/// and resets each minute, which is adequate for API gateways that also
/// run Envoy-level controls in production.
struct RateLimiter {
    limit: usize,
    windows: std::sync::Mutex<std::collections::HashMap<String, (u64, u64)>>,
}

impl RateLimiter {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            windows: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Returns true when the request is allowed; advances the counter.
    fn allow(&self, key: &str) -> bool {
        if self.limit == 0 {
            return true;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let minute = now / 60;
        let mut windows = self.windows.lock().unwrap_or_else(|p| p.into_inner());
        let entry = windows.entry(key.to_string()).or_insert((minute, 0));
        if entry.0 != minute {
            *entry = (minute, 0);
        }
        entry.1 += 1;
        entry.1 <= self.limit as u64
    }
}

/// Per-IP rate limiting middleware (429 + Retry-After on breach).
async fn rate_limit_middleware(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if state.config.rate_limit_per_minute > 0 {
        let ip = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .map(str::to_string)
            .or_else(|| {
                req.headers()
                    .get("x-real-ip")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "unknown".to_string());
        if !state.rate_limiter.allow(&ip) {
            let mut response = error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "PM-API-RATE-LIMITED",
                error_catalog::FALLBACK_LOCALE,
            );
            response
                .headers_mut()
                .insert("retry-after", "60".parse().unwrap());
            return response;
        }
    }
    next.run(req).await
}

/// Error bodies are at most a few hundred bytes; the guard only bounds the
/// buffering of bodies this middleware itself produced.
const ERROR_BODY_BUFFER_LIMIT: usize = 8 * 1024;

/// Localize error envelopes per `Accept-Language`.
///
/// Runs as the outermost layer so handler errors and middleware errors
/// (auth, body limit) are rewritten uniformly: the stable code stays
/// untouched and only the human-readable message is translated. Successful
/// responses pass through untouched.
async fn localize_error_middleware(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let locale = error_catalog::negotiate_locale(
        req.headers()
            .get(axum::http::header::ACCEPT_LANGUAGE)
            .and_then(|value| value.to_str().ok()),
    );
    let response = next.run(req).await;
    let status = response.status();
    if !status.is_client_error() && !status.is_server_error() {
        return response;
    }
    let content_type = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.starts_with("application/json") {
        return response;
    }
    let (parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, ERROR_BODY_BUFFER_LIMIT).await {
        Ok(bytes) => bytes,
        Err(_) => return Response::from_parts(parts, axum::body::Body::empty()),
    };
    let parsed: ErrorBody = match serde_json::from_slice(&bytes) {
        Ok(parsed) => parsed,
        Err(_) => {
            // Not one of our envelopes; restore it untouched.
            return Response::from_parts(parts, axum::body::Body::from(bytes));
        }
    };
    let message = error_catalog::localized_message(&parsed.error.code, locale).to_string();
    let localized = ErrorBody {
        error: ErrorDetail {
            code: parsed.error.code,
            message,
        },
    };
    let mut parts = parts;
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    if let Ok(value) = locale.parse() {
        parts
            .headers
            .insert(axum::http::header::CONTENT_LANGUAGE, value);
    }
    parts
        .headers
        .append(axum::http::header::VARY, "accept-language".parse().unwrap());
    let payload = serde_json::to_vec(&localized).unwrap_or_default();
    Response::from_parts(parts, axum::body::Body::from(payload))
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend_persistence::InMemoryStore;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn dto(id: &str, revision: u64) -> RecordDto {
        RecordDto {
            protocol_version: 1,
            suite_id: 1,
            deployment_id: "0000000000000000000000000000000f".to_string(),
            vault_id: "1010101010101010101010101010101f".to_string(),
            record_id: id.to_string(),
            revision,
            ciphertext: "a5".repeat(1040),
            ciphertext_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
                .to_string(),
            ciphertext_length: 1040,
            tombstone: false,
            template_envelope_hash:
                "0000000000000000000000000000000000000000000000000000000000000001".to_string(),
            manifest_binding: "0000000000000000000000000000000000000000000000000000000000000002"
                .to_string(),
            expected_prior_revision: None,
        }
    }

    fn app_with_store() -> Router {
        app(AppState::new(
            Arc::new(InMemoryStore::new()),
            // Explicit test configuration (production resolves the same type
            // from the environment and fails fast on anything missing).
            Config {
                bind: "127.0.0.1:0".to_string(),
                auth_mode: AuthMode::Disabled,
                max_body_bytes: 256 * 1024,
                cors_origins: Vec::new(),
                rate_limit_per_minute: 0,
            },
        ))
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let response = app_with_store()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/healthz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn put_then_get_round_trips_opaque_record() {
        let router = app_with_store();
        let body = serde_json::to_vec(&dto("record-aaaa", 1)).unwrap();
        let put_response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/record-aaaa")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(put_response.status(), StatusCode::CREATED);

        let get_response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records/record-aaaa")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_response.status(), StatusCode::OK);
        let bytes = get_response.into_body().collect().await.unwrap().to_bytes();
        let got: RecordDto = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(got.record_id, "record-aaaa");
        assert_eq!(got.ciphertext, "a5".repeat(1040));
    }

    #[tokio::test]
    async fn route_mismatch_between_path_and_body_rejected() {
        let router = app_with_store();
        let mut bad = dto("record-aaaa", 1);
        bad.record_id = "record-bbbb".to_string();
        let body = serde_json::to_vec(&bad).unwrap();
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/record-aaaa")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn cas_conflict_on_stale_expected_revision() {
        let router = app_with_store();
        let body = serde_json::to_vec(&dto("record-cccc", 1)).unwrap();
        let _ = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/record-cccc")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // The store assigned revision 1; a CAS claiming prior was 99 conflicts.
        let mut update = dto("record-cccc", 2);
        update.expected_prior_revision = Some(99);
        let body = serde_json::to_vec(&update).unwrap();
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/record-cccc")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn list_returns_records() {
        let router = app_with_store();
        for id in ["record-zeta", "record-alpha"] {
            let body = serde_json::to_vec(&dto(id, 1)).unwrap();
            let _ = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("PUT")
                        .uri(format!("/records/{id}"))
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
        }
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let summaries: Vec<RecordSummaryDto> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            summaries
                .into_iter()
                .map(|s| s.record_id)
                .collect::<Vec<_>>(),
            vec!["record-alpha", "record-zeta"]
        );
    }

    #[tokio::test]
    async fn delete_tombstones_a_record() {
        let router = app_with_store();
        let body = serde_json::to_vec(&dto("record-tomb", 1)).unwrap();
        let _ = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/record-tomb")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // DELETE with the expected prior revision.
        let del_response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("DELETE")
                    .uri("/records/record-tomb")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::to_vec(&TombstoneRequest {
                            expected_prior_revision: 1,
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(del_response.status(), StatusCode::OK);
        // GET confirms tombstone=true.
        let get_response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records/record-tomb")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = get_response.into_body().collect().await.unwrap().to_bytes();
        let got: RecordDto = serde_json::from_slice(&bytes).unwrap();
        assert!(got.tombstone);
    }

    #[tokio::test]
    async fn readyz_returns_record_count() {
        let router = app_with_store();
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/readyz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let status: ReadyStatus = serde_json::from_slice(&bytes).unwrap();
        assert!(status.ready);
        assert_eq!(status.record_count, 0);
    }

    #[tokio::test]
    async fn metrics_returns_prometheus_format() {
        let router = app_with_store();
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/metrics")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("veyora_requests_total"));
        assert!(text.contains("veyora_puts_total"));
        assert!(text.contains("veyora_gets_total"));
        assert!(text.contains("veyora_uptime_seconds"));
    }

    #[tokio::test]
    async fn batch_put_creates_multiple_records() {
        let router = app_with_store();
        let batch = vec![dto("batch-a", 1), dto("batch-b", 1), dto("batch-c", 1)];
        let body = serde_json::to_vec(&batch).unwrap();
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/records/batch")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let results: Vec<BatchResult> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.ok));
        // Verify they're actually in the store.
        let list_response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let list_bytes = list_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let summaries: Vec<RecordSummaryDto> = serde_json::from_slice(&list_bytes).unwrap();
        let ids: Vec<_> = summaries.iter().map(|s| s.record_id.as_str()).collect();
        assert!(ids.contains(&"batch-a"));
        assert!(ids.contains(&"batch-b"));
        assert!(ids.contains(&"batch-c"));
    }

    #[tokio::test]
    async fn cors_preflight_returns_no_content() {
        let router = app_with_store();
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("OPTIONS")
                    .uri("/records")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "*"
        );
    }

    #[tokio::test]
    async fn version_returns_protocol_info() {
        let router = app_with_store();
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/version")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let info: VersionInfo = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(info.protocol_version, 1);
        assert_eq!(info.suite_id, 1);
        assert!(info.version.starts_with("v"));
    }

    #[tokio::test]
    async fn oversized_body_is_rejected() {
        let router = app_with_store();
        let big_body = "x".repeat(300 * 1024);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/too-big")
                    .header("content-type", "application/json")
                    .header("content-length", big_body.len().to_string())
                    .body(axum::body::Body::from(big_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn purge_tombstoned_returns_count() {
        let router = app_with_store();
        // Create and tombstone a record
        let body = serde_json::to_vec(&dto("purge-test", 1)).unwrap();
        let _ = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/purge-test")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let _ = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("DELETE")
                    .uri("/records/purge-test")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::to_vec(&TombstoneRequest {
                            expected_prior_revision: 1,
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Purge (InMemoryStore is no-op, returns 0)
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/vault/purge")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let result: PurgeResult = serde_json::from_slice(&bytes).unwrap();
        // InMemoryStore returns 0 (tombstones retained for sync)
        assert_eq!(result.purged, 0);
    }

    #[tokio::test]
    async fn error_body_is_json_with_stable_code() {
        let response = app_with_store()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records/does-not-exist")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.error.code, "PM-STORE-NOT-FOUND");
        assert_eq!(body.error.message, "Record not found.");
    }

    #[tokio::test]
    async fn error_message_localizes_via_accept_language() {
        let response = app_with_store()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records/does-not-exist")
                    .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers().get("content-language").unwrap(), "zh-CN");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.error.code, "PM-STORE-NOT-FOUND");
        assert_eq!(
            body.error.message,
            error_catalog::localized_message("PM-STORE-NOT-FOUND", "zh-CN")
        );
    }

    #[tokio::test]
    async fn unknown_locale_falls_back_to_english() {
        let response = app_with_store()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records/does-not-exist")
                    .header("accept-language", "xx-YY")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers().get("content-language").unwrap(), "en");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.error.message, "Record not found.");
    }

    #[tokio::test]
    async fn unauthorized_error_is_json_envelope() {
        let router = app(AppState::new(
            Arc::new(InMemoryStore::new()),
            Config {
                bind: "127.0.0.1:0".to_string(),
                auth_mode: AuthMode::BearerToken("test-token".to_string()),
                max_body_bytes: 256 * 1024,
                cors_origins: Vec::new(),
                rate_limit_per_minute: 0,
            },
        ));
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get("www-authenticate").unwrap(),
            "Bearer"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.error.code, "PM-API-UNAUTHORIZED");
    }

    #[tokio::test]
    async fn oversized_body_error_is_json_envelope() {
        let router = app_with_store();
        let big_body = "x".repeat(300 * 1024);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/too-big")
                    .header("content-type", "application/json")
                    .header("accept-language", "ja")
                    .header("content-length", big_body.len().to_string())
                    .body(axum::body::Body::from(big_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.error.code, "PM-API-BODY-TOO-LARGE");
        assert_eq!(
            body.error.message,
            error_catalog::localized_message("PM-API-BODY-TOO-LARGE", "ja")
        );
    }

    #[tokio::test]
    async fn put_revision_response_is_json() {
        let router = app_with_store();
        let body = serde_json::to_vec(&dto("record-json", 1)).unwrap();
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/record-json")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let revision: RevisionResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(revision.revision, 1);
    }

    #[test]
    fn constant_time_comparison_behaves_like_equality() {
        assert!(constant_time_eq("secret-token", "secret-token"));
        assert!(!constant_time_eq("secret-token", "secret-tokeX"));
        assert!(!constant_time_eq("short", "longer-value"));
        assert!(constant_time_eq("", ""));
    }

    #[tokio::test]
    async fn list_embed_bodies_returns_full_records_in_one_round_trip() {
        let router = app_with_store();
        let body = serde_json::to_vec(&dto("embed-aaaa", 1)).unwrap();
        let _ = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/records/embed-aaaa")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records?embed=bodies")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let records: Vec<RecordDto> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].record_id, "embed-aaaa");
        assert_eq!(records[0].ciphertext, "a5".repeat(1040));

        // Default listing stays summary-shaped (no ciphertext leak).
        let summary_response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = summary_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value[0].get("ciphertext").is_none());
    }

    #[tokio::test]
    async fn rate_limit_blocks_after_threshold() {
        let router = app(AppState::new(
            Arc::new(InMemoryStore::new()),
            Config {
                bind: "127.0.0.1:0".to_string(),
                auth_mode: AuthMode::Disabled,
                max_body_bytes: 256 * 1024,
                cors_origins: Vec::new(),
                rate_limit_per_minute: 3,
            },
        ));
        // Three requests pass, the fourth is blocked with 429.
        for i in 0..3 {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/healthz")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "request {i} should pass");
        }
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/healthz")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers().get("retry-after").unwrap(), "60");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.error.code, "PM-API-RATE-LIMITED");
    }

    #[tokio::test]
    async fn cors_allowlist_restricts_origins() {
        let router = app(AppState::new(
            Arc::new(InMemoryStore::new()),
            Config {
                bind: "127.0.0.1:0".to_string(),
                auth_mode: AuthMode::Disabled,
                max_body_bytes: 256 * 1024,
                cors_origins: vec!["https://vault.example.com".to_string()],
                rate_limit_per_minute: 0,
            },
        ));
        // Allowed origin echoes back.
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records")
                    .header("origin", "https://vault.example.com")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "https://vault.example.com"
        );
        // Unknown origin gets no CORS header at all.
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/records")
                    .header("origin", "https://evil.example.net")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            response
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );
    }

    #[tokio::test]
    async fn metrics_count_observed_requests() {
        let router = app_with_store();
        for _ in 0..2 {
            let _ = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/healthz")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
        }
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/metrics")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        let total = text
            .lines()
            .find(|line| line.starts_with("veyora_requests_total "))
            .and_then(|line| line.split_whitespace().last())
            .and_then(|value| value.parse::<u64>().ok())
            .expect("requests counter present");
        assert!(total >= 2, "counter should observe requests, got {total}");
    }
}
