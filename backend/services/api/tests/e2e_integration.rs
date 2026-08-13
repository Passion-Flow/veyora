//! End-to-end integration test: a real kernel-sealed record through the API
//! store, with compare-and-set semantics.
//!
//! The opaque record below was produced ONCE by the security kernel — fixed
//! password/salt/context/nonce/plaintext, XChaCha20-Poly1305, deterministic —
//! and embedded here as a fixture. This keeps the backend workspace
//! self-contained: no path dependency on `security-kernel/`, so the backend
//! architecture closure sentinel (`workspace_metadata_and_package_dependency_
//! edges_are_closed`) stays green, while still exercising the exact ciphertext
//! shape the kernel emits.
//!
//! Live seal/open verification lives in the kernel's own KAT suite and in the
//! browser web client (which round-trips a real entry through this same API).
//! The inline `lib.rs` tests cover the API's CAS/conflict/tombstone matrix;
//! this test asserts end-to-end store fidelity for an authentic record.

use api::{AppState, AuthMode, Config, app};
use backend_persistence::InMemoryStore;
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

/// Precomputed: nonce = 0x42 × 24, then `seal_record` of
/// `b"my-github-password-123"` under Argon2id(b"correct horse battery staple",
/// [0xaa;16]) → derive_record_key(context [0x82,0x40,0x40]), aad
/// `b"pm-v1/record-aad"`, LimitProfile::V1. 24-byte nonce || 38-byte ciphertext
/// (22 plaintext + 16 Poly1305 tag).
const RECORD_ID: &str = "e2e-test-entry";
const CIPHERTEXT: &str = "424242424242424242424242424242424242424242424242d246dc5066c4084dea30c864f38d2da8028907b2554a8379d5f1b9a2e43045262ffc753128ef";
const CIPHERTEXT_HASH: &str = "258eeb7c101cc89b2d7a785e23bb08e7389fd34a1fba00483efe1de83b39f7f6";
const CIPHERTEXT_LEN: u64 = 38;

fn record_body(prior: Option<u64>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "protocol_version": 1,
        "suite_id": 1,
        "deployment_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "vault_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "record_id": RECORD_ID,
        "revision": 1,
        "ciphertext": CIPHERTEXT,
        "ciphertext_hash": CIPHERTEXT_HASH,
        "ciphertext_length": CIPHERTEXT_LEN,
        "tombstone": false,
        "template_envelope_hash": "0".repeat(64),
        "manifest_binding": "0".repeat(64),
    });
    body["expected_prior_revision"] = match prior {
        Some(r) => serde_json::Value::from(r),
        None => serde_json::Value::Null,
    };
    body
}

async fn put(router: axum::Router, body: serde_json::Value) -> axum::http::StatusCode {
    router
        .oneshot(
            axum::http::Request::builder()
                .method("PUT")
                .uri(format!("/records/{RECORD_ID}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn real_kernel_record_round_trips_opaque_through_the_api() {
    let store = Arc::new(InMemoryStore::new());
    let router = app(AppState::new(
        store,
        // Explicit test configuration; production resolves from the
        // environment and fails fast on anything missing.
        Config {
            bind: "127.0.0.1:0".to_string(),
            auth_mode: AuthMode::Disabled,
            max_body_bytes: 256 * 1024,
        },
    ));

    // 1. Create with the authentic kernel-sealed ciphertext.
    let created = router
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("PUT")
                .uri(format!("/records/{RECORD_ID}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(record_body(None).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), axum::http::StatusCode::CREATED);
    let created_body: serde_json::Value =
        serde_json::from_slice(&created.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let revision = created_body["revision"].as_u64().expect("revision");
    assert_eq!(revision, 1);

    // 2. Retrieve — the store must return the exact opaque bytes untouched.
    let fetched = router
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("/records/{RECORD_ID}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(fetched.status(), axum::http::StatusCode::OK);
    let record: serde_json::Value =
        serde_json::from_slice(&fetched.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(record["ciphertext"].as_str().unwrap(), CIPHERTEXT);
    assert_eq!(record["ciphertext_hash"].as_str().unwrap(), CIPHERTEXT_HASH);
    assert_eq!(record["revision"].as_u64().unwrap(), 1);
    assert!(!record["tombstone"].as_bool().unwrap());

    // 3. Compare-and-set: a correct prior revision advances; a wrong one conflicts.
    let updated = put(router.clone(), record_body(Some(revision))).await;
    assert_eq!(updated, axum::http::StatusCode::CREATED);
    let conflict = put(router.clone(), record_body(Some(99))).await;
    assert_eq!(conflict, axum::http::StatusCode::CONFLICT);

    // 4. The ciphertext is still byte-identical after the CAS update.
    let after = router
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("/records/{RECORD_ID}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let after_rec: serde_json::Value =
        serde_json::from_slice(&after.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(after_rec["ciphertext"].as_str().unwrap(), CIPHERTEXT);
    assert_eq!(after_rec["revision"].as_u64().unwrap(), 2);
}
