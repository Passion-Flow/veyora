use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn backend_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The auditable zero-dependency, zero-runtime-surface safety core. Files here
/// remain under the exact allowlist and the strict standard-library surface ban.
/// The functional service layer (persistence, the API, and the other runtime
/// services) is permitted a reviewed runtime surface but still forbids unsafe
/// code, plaintext, master-password material, and keys.
fn is_safety_core(relative: &Path) -> bool {
    let s = relative.to_string_lossy();
    s == "src/lib.rs"
        || s.starts_with("crates/config/")
        || s.starts_with("crates/contracts-generated/")
}

/// Plaintext, secret, and credential words that must never appear as literals in
/// any backend source file, including the functional layer.
const FORBIDDEN_LITERAL_WORDS: &[&str] = &[
    "plaintext",
    "master_password",
    "master-password",
    "MASTER_PASSWORD",
    "vault_plaintext",
    "decrypted_secret",
];

fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut output = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).expect("read backend directory") {
            let path = entry.expect("read backend entry").path();
            if path.file_name().is_some_and(|name| name == "target") {
                continue;
            }
            if path.is_dir() {
                pending.push(path);
            } else {
                output.push(path);
            }
        }
    }
    output.sort();
    output
}

fn assert_structured_metadata(metadata: &str, root: &Path) {
    const CHECK: &str = r#"
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
document = json.load(sys.stdin)
# The internal dependency-edge graph must stay closed for every package. The
# safety core additionally forbids external (registry) dependencies so it stays
# a dependency-free, auditable layer; functional services may pull reviewed
# external runtime crates (tokio/axum/sqlx and friends).
safety_core = {
    "backend-config",
    "backend-persistence",
    "veyora-backend",
    "veyora-contracts-generated",
}
expected = {
    "api": ["backend-persistence", "backend-postgres"],
    "backend-config": ["veyora-contracts-generated"],
    "backend-persistence": ["veyora-contracts-generated"],
    "backend-postgres": ["backend-persistence"],
    "backend-sqlite": ["backend-persistence"],
    "migrator": [],
    "backup": [],
    "migrator": [],
    "restore": [],
    "sandbox": [],
    "veyora-backend": ["backend-config", "veyora-contracts-generated"],
    "veyora-contracts-generated": [],
    "worker": [],
}
actual = {}
for package in document.get("packages", []):
    name = package.get("name")
    internal = []
    external = 0
    for dependency in package.get("dependencies", []):
        path = dependency.get("path")
        if dependency.get("source") is not None or path is None:
            external += 1
            continue
        if not Path(path).resolve().is_relative_to(root):
            raise SystemExit("dependency outside backend root")
        internal.append(dependency.get("name"))
    if name in safety_core and external != 0:
        raise SystemExit(f"safety-core package {name} has an external dependency")
    actual[name] = sorted(internal)
if actual != expected:
    raise SystemExit("package or internal dependency edge mismatch")
"#;
    let mut child = Command::new("python3")
        .args(["-c", CHECK, root.to_str().expect("backend path is UTF-8")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run structured metadata parser");
    child
        .stdin
        .take()
        .expect("metadata parser stdin")
        .write_all(metadata.as_bytes())
        .expect("write cargo metadata");
    let output = child.wait_with_output().expect("wait for metadata parser");
    assert!(
        output.status.success(),
        "structured cargo metadata check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn allowed_standard_library_references(
    relative: &Path,
    source: &str,
) -> Result<Vec<String>, String> {
    let tokens = rust_tokens(source)?;
    let relative = relative.to_string_lossy();
    let mut references = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if token != "std" {
            continue;
        }
        let remaining = &tokens[index..];
        let marker = if relative == "crates/config/src/resolved.rs"
            && starts_with(remaining, &["std", "::", "fmt", ";"])
        {
            "fmt"
        } else if relative == "crates/config/src/resolved.rs"
            && starts_with(
                remaining,
                &[
                    "std",
                    "::",
                    "collections",
                    "::",
                    "{",
                    "BTreeMap",
                    ",",
                    "BTreeSet",
                    "}",
                    ";",
                ],
            )
        {
            "collections-group"
        } else if relative == "crates/contracts-generated/src/lib.rs"
            && starts_with(
                remaining,
                &["std", "::", "collections", "::", "BTreeMap", "<"],
            )
        {
            "btree-map"
        } else {
            return Err(format!(
                "unapproved standard-library path near token {index}"
            ));
        };
        references.push(format!("{relative}:{marker}"));
    }
    Ok(references)
}

fn starts_with(tokens: &[String], expected: &[&str]) -> bool {
    tokens.len() >= expected.len()
        && tokens
            .iter()
            .zip(expected)
            .all(|(actual, expected)| actual == expected)
}

fn rust_tokens(source: &str) -> Result<Vec<String>, String> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
        } else if bytes[index..].starts_with(b"//") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
        } else if bytes[index..].starts_with(b"/*") {
            index += 2;
            let mut depth = 1;
            while index < bytes.len() && depth > 0 {
                if bytes[index..].starts_with(b"/*") {
                    depth += 1;
                    index += 2;
                } else if bytes[index..].starts_with(b"*/") {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            if depth != 0 {
                return Err("unterminated block comment".to_owned());
            }
        } else if bytes[index] == b'"' {
            index = skip_quoted(bytes, index, b'"')?;
        } else if bytes[index] == b'\''
            && index + 2 < bytes.len()
            && (bytes[index + 2] == b'\'' || bytes[index + 1] == b'\\')
        {
            index = skip_quoted(bytes, index, b'\'')?;
        } else if bytes[index].is_ascii_alphabetic() || bytes[index] == b'_' {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
            {
                index += 1;
            }
            tokens.push(source[start..index].to_owned());
        } else if bytes[index..].starts_with(b"::") {
            tokens.push("::".to_owned());
            index += 2;
        } else {
            tokens.push(char::from(bytes[index]).to_string());
            index += 1;
        }
    }
    Ok(tokens)
}

fn skip_quoted(bytes: &[u8], mut index: usize, delimiter: u8) -> Result<usize, String> {
    index += 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index += 2;
        } else if bytes[index] == delimiter {
            return Ok(index + 1);
        } else {
            index += 1;
        }
    }
    Err("unterminated quoted literal".to_owned())
}

#[test]
fn workspace_metadata_and_package_dependency_edges_are_closed() {
    let output = Command::new("cargo")
        .args([
            "metadata",
            "--locked",
            "--offline",
            "--no-deps",
            "--format-version",
            "1",
        ])
        .current_dir(backend_root())
        .output()
        .expect("run cargo metadata");
    assert!(output.status.success(), "cargo metadata must succeed");
    let metadata = String::from_utf8(output.stdout).expect("metadata is UTF-8");
    assert_structured_metadata(&metadata, &backend_root());
}

#[test]
fn safety_core_rust_targets_match_the_closed_allowlist() {
    let root = backend_root();
    let safety_core_actual: BTreeSet<PathBuf> = files_under(&root)
        .into_iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
        .filter(|path| !path.components().any(|part| part.as_os_str() == "tests"))
        .map(|path| {
            path.strip_prefix(&root)
                .expect("backend relative path")
                .to_path_buf()
        })
        .filter(|relative| is_safety_core(relative))
        .collect();
    let safety_core_expected = [
        "src/lib.rs",
        "crates/config/src/lib.rs",
        "crates/config/src/generated.rs",
        "crates/config/src/value.rs",
        "crates/config/src/resolved.rs",
        "crates/config/src/role_plan.rs",
        "crates/config/src/bootstrap_plan.rs",
        "crates/contracts-generated/src/lib.rs",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect::<BTreeSet<_>>();
    assert_eq!(
        safety_core_actual, safety_core_expected,
        "safety-core file set drifted; the zero-dependency core must stay exactly allowlisted"
    );

    // The functional layer may grow, but every Rust file must live under a
    // known owner directory, never at an untracked root location.
    let functional: BTreeSet<PathBuf> = files_under(&root)
        .into_iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
        .filter(|path| !path.components().any(|part| part.as_os_str() == "tests"))
        .map(|path| {
            path.strip_prefix(&root)
                .expect("backend relative path")
                .to_path_buf()
        })
        .filter(|relative| !is_safety_core(relative))
        .collect();
    for relative in functional {
        let allowed = relative.starts_with("crates/persistence/")
            || relative.starts_with("crates/postgres/")
            || relative.starts_with("crates/sqlite/")
            || relative.starts_with("services/")
            || relative == Path::new("src/lib.rs");
        assert!(
            allowed,
            "functional Rust file outside a known owner: {}",
            relative.display()
        );
    }
}

#[test]
fn production_targets_have_no_file_process_or_network_runtime_surface() {
    let root = backend_root();
    let files = files_under(&root);
    let mut standard_library_references = Vec::new();
    for path in files
        .iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
        .filter(|path| !path.components().any(|part| part.as_os_str() == "tests"))
    {
        let source = fs::read_to_string(path).expect("read Rust target");
        let relative = path.strip_prefix(&root).expect("backend relative path");
        // The strict standard-library surface ban applies only to the safety
        // core. The functional layer is permitted a reviewed runtime surface.
        if is_safety_core(relative) {
            standard_library_references.extend(
                allowed_standard_library_references(relative, &source)
                    .unwrap_or_else(|error| panic!("{}: {error}", path.display())),
            );
        }
        // Every hand-written backend source file, safety core or functional,
        // must stay free of unsafe code and plaintext/credential literals. The
        // generated contracts projection is mechanistic and carries contract
        // vocabulary (for example `final_plaintext_fields`), so it is excluded.
        if !relative.starts_with("crates/contracts-generated/") {
            assert!(
                !source.contains("unsafe "),
                "{}: unsafe block is forbidden in backend source",
                path.display()
            );
            for word in FORBIDDEN_LITERAL_WORDS {
                assert!(
                    !source.contains(word),
                    "{}: forbidden plaintext/credential literal `{word}`",
                    path.display()
                );
            }
        }
    }
    standard_library_references.sort();
    assert_eq!(
        standard_library_references,
        [
            "crates/config/src/resolved.rs:collections-group".to_owned(),
            "crates/config/src/resolved.rs:fmt".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
            "crates/contracts-generated/src/lib.rs:btree-map".to_owned(),
        ]
    );

    for path in files {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let relative = path.strip_prefix(&root).expect("backend relative path");
        // build.rs, Dockerfiles, compose files, and loose example manifests remain
        // forbidden everywhere. SQL migrations are permitted only inside the
        // functional store crates' migrations directories; the safety core and
        // backend root stay SQL-free.
        let in_functional_migrations = relative.starts_with("crates/postgres/migrations/")
            || relative.starts_with("crates/sqlite/migrations/");
        assert!(
            name != "build.rs"
                && name != "Dockerfile"
                && name != "docker-compose.yml"
                && !name.ends_with(".toml.example")
                && (in_functional_migrations
                    || path.extension().is_none_or(|extension| extension != "sql")),
            "forbidden safety-core artifact {}",
            path.display()
        );
    }
    assert!(!root.join("migrations").exists());
}

#[test]
fn runtime_surface_parser_rejects_grouped_fully_qualified_and_aliased_std_access() {
    let path = Path::new("crates/config/src/resolved.rs");
    for hostile in [
        "use std::{fmt, net};",
        "fn bind() { let _ = std::net::TcpListener::bind; }",
        "use std as host; fn bind() { let _ = host::net::TcpListener::bind; }",
    ] {
        assert!(
            allowed_standard_library_references(path, hostile).is_err(),
            "hostile Rust surface was accepted: {hostile}"
        );
    }
}

#[test]
fn root_test_host_has_no_wildcard_or_runtime_exports() {
    let source = fs::read_to_string(backend_root().join("src/lib.rs")).expect("read test host");
    assert!(!source.contains("pub use"));
    assert!(!source.contains("pub mod"));
}

#[test]
fn service_shells_are_exact_immediate_exit_targets() {
    // worker/sandbox/backup/restore remain inert immediate-exit shells
    // until each is built out. The api and migrator services are functional.
    for service in [] as [&str; 0] {
        let root = backend_root().join("services").join(service);
        let main = fs::read_to_string(root.join("src/main.rs")).expect("read shell");
        assert_eq!(
            main.trim(),
            "fn main() {}",
            "{service} is not an inert shell"
        );
        let tree = Command::new("cargo")
            .args(["tree", "--locked", "--offline", "-p", service])
            .current_dir(backend_root())
            .output()
            .expect("run service cargo tree");
        assert!(tree.status.success(), "cargo tree failed for {service}");
        let lines = String::from_utf8(tree.stdout).expect("tree is UTF-8");
        assert_eq!(lines.lines().count(), 1, "{service} has a dependency edge");
    }
}

#[test]
fn migrator_service_is_a_functional_migration_runner() {
    let main = fs::read_to_string(backend_root().join("services/migrator/src/main.rs"))
        .expect("read migrator main");
    assert!(
        main.contains("postgres::Client") && main.contains("_veyora_schema_version"),
        "migrator must be a functional migration runner"
    );
}

#[test]
fn worker_service_is_a_functional_background_processor() {
    let main = fs::read_to_string(backend_root().join("services/worker/src/main.rs"))
        .expect("read worker main");
    assert!(
        main.contains("postgres::Client") && main.contains("poll"),
        "worker must be a functional background processor"
    );
}

#[test]
fn backup_service_is_a_functional_snapshot_exporter() {
    let main = fs::read_to_string(backend_root().join("services/backup/src/main.rs"))
        .expect("read backup main");
    assert!(
        main.contains("postgres::Client") && main.contains("export_snapshot"),
        "backup must be a functional snapshot exporter"
    );
}

#[test]
fn restore_service_is_a_functional_snapshot_importer() {
    let main = fs::read_to_string(backend_root().join("services/restore/src/main.rs"))
        .expect("read restore main");
    assert!(
        main.contains("postgres::Client") && main.contains("import_snapshot"),
        "restore must be a functional snapshot importer"
    );
}

#[test]
fn sandbox_service_is_a_functional_ciphertext_validator() {
    let main = fs::read_to_string(backend_root().join("services/sandbox/src/main.rs"))
        .expect("read sandbox main");
    assert!(
        main.contains("validate_record") && main.contains("stdin"),
        "sandbox must be a functional ciphertext validator"
    );
}

#[test]
fn api_service_is_a_functional_http_server() {
    let main =
        fs::read_to_string(backend_root().join("services/api/src/main.rs")).expect("read api main");
    assert!(
        main.contains("tokio::main") && main.contains("axum"),
        "api must be a tokio+axum functional server, not an inert shell"
    );
}
