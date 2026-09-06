use std::{collections::BTreeSet, fs, path::Path, process::Command};

use serde_json::Value;

#[test]
fn kernel_core_dependency_graph_has_no_transport_storage_ui_or_runtime_framework() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap();
    let output = Command::new(env!("CARGO"))
        .args(["metadata", "--locked", "--format-version", "1"])
        .current_dir(workspace)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: Value = serde_json::from_slice(&output.stdout).unwrap();
    let core_id = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|package| package["name"] == "kernel-core")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let nodes = metadata["resolve"]["nodes"].as_array().unwrap();
    let mut pending = vec![core_id];
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id) {
            continue;
        }
        if let Some(node) = nodes.iter().find(|node| node["id"] == id) {
            pending.extend(
                node["dependencies"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap()),
            );
        }
    }
    let package_names: BTreeSet<_> = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|package| visited.contains(package["id"].as_str().unwrap()))
        .map(|package| package["name"].as_str().unwrap())
        .collect();
    let forbidden = [
        "actix-web",
        "async-std",
        "axum",
        "cap-std",
        "curl",
        "diesel",
        "eframe",
        "http",
        "http-body",
        "hyper",
        "isahc",
        "reqwest",
        "rocket",
        "rusqlite",
        "sea-orm",
        "sqlx",
        "surf",
        "tauri",
        "tempfile",
        "tokio",
        "tower-http",
        "ureq",
        "walkdir",
        "warp",
    ];

    for name in forbidden {
        assert!(!package_names.contains(name), "forbidden dependency {name}");
    }
}

#[test]
fn kernel_core_source_has_no_filesystem_network_or_unsafe_escape_hatch() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let forbidden = [
        "std::fs",
        "std::net",
        "std::path",
        "std::process",
        "unsafe {",
        "unsafe fn",
        "unsafe extern",
        "unsafe impl",
        "unsafe trait",
    ];

    let mut pending = vec![source_root];
    while let Some(path) = pending.pop() {
        if path.is_dir() {
            pending.extend(
                fs::read_dir(path)
                    .unwrap()
                    .map(|entry| entry.unwrap().path()),
            );
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            let source = fs::read_to_string(&path).unwrap();
            for denied in forbidden {
                assert!(
                    !source.contains(denied),
                    "{} contains {denied}",
                    path.display()
                );
            }
        }
    }
}
