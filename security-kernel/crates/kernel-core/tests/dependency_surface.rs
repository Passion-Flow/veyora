use std::{collections::BTreeMap, fs, path::Path, process::Command};

use serde_json::Value;

const REVIEWED: &[(&str, &str)] = &[
    ("argon2", "0.5.3"),
    ("base64ct", "1.8.3"),
    ("chacha20poly1305", "0.11.0"),
    ("ed25519-dalek", "3.0.0"),
    ("getrandom", "0.4.3"),
    ("hkdf", "0.13.0"),
    ("hpke", "0.14.0"),
    ("minicbor", "2.3.0"),
    ("p256", "0.14.0"),
    ("serde_json", "1.0.151"),
    ("sha2", "0.11.0"),
    ("subtle", "2.6.1"),
    ("zeroize", "1.9.0"),
];

const REVIEWED_CHECKSUMS: &[(&str, &str)] = &[
    (
        "argon2",
        "3c3610892ee6e0cbce8ae2700349fcf8f98adb0dbfbee85aec3c9179d29cc072",
    ),
    (
        "base64ct",
        "2af50177e190e07a26ab74f8b1efbfe2ef87da2116221318cb1c2e82baf7de06",
    ),
    (
        "chacha20poly1305",
        "9b89e1c441e926b9c82a8d023f6e1b7ae0adcfaa7d621814e4d60789bac751cb",
    ),
    (
        "ed25519-dalek",
        "6ebaa1a2bf1290ab3bfe5a7b771d050ebffab2711c19a81691c683a5144a25de",
    ),
    (
        "getrandom",
        "300e883d756b2e4ec94e02791f39b04b522276138852cfc41d9fb7e904106099",
    ),
    (
        "hkdf",
        "4aaa26c720c68b866f2c96ef5c1264b3e6f473fe5d4ce61cd44bbe913e553018",
    ),
    (
        "hpke",
        "dd5130e119706b4d8c2180da6126f7e60b6c38c2d340d539219f57051f0a7af7",
    ),
    (
        "minicbor",
        "c12b4033ffaa92fbf9df03df38d19324f52bad130dd223f811734a8006dd2d69",
    ),
    (
        "p256",
        "d2c9239b2dbc807adbbe147e8cf72ea7450c3a0aabe62cb8e75ff4ec22e1f72a",
    ),
    (
        "serde_json",
        "c841b55ecdae098c80dcae9cf767f6f8a0c2cdb3416bbef72181df4d0fe73f14",
    ),
    (
        "sha2",
        "446ba717509524cb3f22f17ecc096f10f4822d76ab5c0b9822c5f9c284e825f4",
    ),
    (
        "subtle",
        "13c2bddecc57b384dee18652358fb23172facb8a2c51ccc10d74c157bdea3292",
    ),
    (
        "zeroize",
        "e13c156562582aa81c60cb29407084cdb54c4164760106ab78e6c5b0858cf64e",
    ),
];

fn reviewed_features() -> BTreeMap<&'static str, &'static [&'static str]> {
    BTreeMap::from([
        ("argon2", &["alloc", "zeroize"][..]),
        ("base64ct", &["alloc"][..]),
        ("chacha20poly1305", &["alloc", "zeroize"][..]),
        (
            "ed25519-dalek",
            &["alloc", "digest", "signature", "zeroize"][..],
        ),
        ("getrandom", &[][..]),
        ("hkdf", &[][..]),
        ("hpke", &["alloc", "chacha", "hkdfsha2", "x25519"][..]),
        ("minicbor", &["alloc"][..]),
        ("p256", &["alloc", "ecdsa"][..]),
        ("serde_json", &["alloc"][..]),
        ("sha2", &[][..]),
        ("subtle", &[][..]),
        ("zeroize", &["alloc"][..]),
    ])
}

fn workspace_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("kernel workspace root")
}

fn metadata() -> Value {
    let output = Command::new(env!("CARGO"))
        .args(["metadata", "--locked", "--format-version", "1"])
        .current_dir(workspace_root())
        .output()
        .expect("cargo metadata executes");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("metadata is JSON")
}

#[test]
fn direct_dependency_versions_and_features_match_the_reviewed_lock() {
    let metadata = metadata();
    let core = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|package| package["name"] == "kernel-core")
        .unwrap();
    let direct: BTreeMap<_, _> = core["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|dependency| dependency["source"].as_str().is_some())
        .map(|dependency| (dependency["name"].as_str().unwrap(), dependency))
        .collect();

    for (name, version) in REVIEWED {
        let dependency = direct.get(name).unwrap_or_else(|| panic!("missing {name}"));
        assert_eq!(dependency["req"], format!("={version}"), "{name}");
        assert_eq!(dependency["uses_default_features"], false, "{name}");
        assert!(dependency["target"].is_null(), "{name}");
        assert_eq!(
            dependency["features"],
            serde_json::json!(reviewed_features()[name]),
            "{name}"
        );
    }
    assert!(
        !direct.contains_key("libsodium-rs"),
        "native backup adapter stays blocked until immutable source provenance is approved"
    );
}

#[test]
fn cargo_lock_uses_registry_sources_and_sha256_checksums() {
    let lock = fs::read_to_string(workspace_root().join("Cargo.lock")).unwrap();
    for (name, checksum) in REVIEWED_CHECKSUMS {
        let version = REVIEWED
            .iter()
            .find_map(|(reviewed_name, version)| (*reviewed_name == *name).then_some(*version))
            .unwrap();
        let marker = format!("name = \"{name}\"\nversion = \"{version}\"");
        let start = lock
            .find(&marker)
            .unwrap_or_else(|| panic!("missing {name} {version}"));
        let package = lock[start..].split("\n[[package]]").next().unwrap();
        assert!(
            package.contains("source = \"registry+https://github.com/rust-lang/crates.io-index\"")
        );
        let locked_checksum = package
            .lines()
            .find_map(|line| {
                line.strip_prefix("checksum = \"")
                    .and_then(|s| s.strip_suffix('"'))
            })
            .unwrap();
        assert_eq!(locked_checksum, *checksum, "{name}");
    }
}

#[test]
fn target_specific_bindings_stay_in_their_owned_packages() {
    let metadata = metadata();
    let packages = metadata["packages"].as_array().unwrap();
    let wasm = packages
        .iter()
        .find(|package| package["name"] == "kernel-wasm")
        .unwrap();
    let wasm_dependencies: BTreeMap<_, _> = wasm["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| (dependency["name"].as_str().unwrap(), dependency))
        .collect();
    for name in ["getrandom", "wasm-bindgen"] {
        let dependency = wasm_dependencies[name];
        assert_eq!(
            dependency["target"], "cfg(target_arch = \"wasm32\")",
            "{name}"
        );
        assert_eq!(dependency["uses_default_features"], false, "{name}");
    }
    assert_eq!(
        wasm_dependencies["getrandom"]["features"],
        serde_json::json!(["wasm_js"])
    );
    assert_eq!(wasm_dependencies["wasm-bindgen"]["req"], "=0.2.127");

    let ffi = packages
        .iter()
        .find(|package| package["name"] == "kernel-ffi")
        .unwrap();
    let jni = ffi["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|dependency| dependency["name"] == "jni")
        .unwrap();
    assert_eq!(jni["req"], "=0.22.4");
    assert_eq!(jni["target"], "cfg(target_os = \"android\")");
    assert_eq!(jni["uses_default_features"], false);
}

#[test]
fn semantic_policy_labels_are_not_treated_as_cargo_features() {
    let metadata = metadata();
    let project_root = workspace_root().parent().unwrap();
    let tool_lock: Value = serde_json::from_slice(
        &fs::read(project_root.join("contracts/release/toolchain-lock-v1.json")).unwrap(),
    )
    .unwrap();
    let packages = metadata["packages"].as_array().unwrap();

    for reviewed in tool_lock["reviewed_dependencies"].as_array().unwrap() {
        let Some(package) = packages
            .iter()
            .find(|package| package["name"] == reviewed["id"])
        else {
            continue;
        };
        for semantic_label in reviewed["features"].as_array().unwrap() {
            assert!(
                package["features"]
                    .get(semantic_label.as_str().unwrap())
                    .is_none(),
                "semantic policy label became a Cargo feature: {semantic_label}"
            );
        }
    }
}

#[test]
fn complete_resolved_graph_has_no_git_source_or_msrv_above_the_toolchain() {
    let metadata = metadata();
    for package in metadata["packages"].as_array().unwrap() {
        if let Some(source) = package["source"].as_str() {
            assert!(source.starts_with("registry+https://github.com/rust-lang/crates.io-index"));
        }
        let Some(rust_version) = package["rust_version"].as_str() else {
            continue;
        };
        let mut parts = rust_version
            .split('.')
            .map(|part| part.parse::<u64>().unwrap())
            .collect::<Vec<_>>();
        parts.resize(3, 0);
        assert!(
            parts[..3] <= [1_u64, 93, 1][..],
            "{} requires {rust_version}",
            package["name"]
        );
    }
}

#[test]
fn reviewed_lock_matches_the_manifest_authority() {
    let project_root = workspace_root().parent().unwrap();
    let lock: Value = serde_json::from_slice(
        &fs::read(project_root.join("contracts/release/toolchain-lock-v1.json")).unwrap(),
    )
    .unwrap();
    let reviewed: BTreeMap<_, _> = lock["reviewed_dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["id"].as_str().unwrap(),
                entry["version"].as_str().unwrap(),
            )
        })
        .collect();

    for (name, version) in REVIEWED {
        assert_eq!(reviewed.get(name), Some(version), "{name}");
    }
    assert_eq!(reviewed.get("libsodium-rs"), Some(&"0.2.4"));
}
