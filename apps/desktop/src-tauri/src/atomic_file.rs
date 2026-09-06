//! Durable file replacement for user-facing exports and snapshots (EXP-004).
//!
//! Every file a user can point at from a save dialog is finalized through
//! this module: bytes go to a hidden temporary file next to the target, are
//! flushed to the storage device, and only then replace the target with an
//! atomic rename. Any failure along the way removes the temporary file and
//! leaves a previously valid target untouched, so an interrupted export can
//! never destroy an older file or leave a truncated result under the final
//! name.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Points where a caller (tests only) can inject a failure to prove the
/// cleanup and old-file-preservation guarantees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    /// No injected failure.
    None,
    /// Fail after the temporary file has been created but before any bytes
    /// are written.
    CreateTemp,
    /// Fail after the temporary file is fully written but before it is
    /// flushed.
    WriteTemp,
    /// Fail after the flush but before the atomic rename.
    Flush,
    /// Fail after the rename (the operation has committed; nothing to undo).
    Rename,
}

fn temp_path_for(target: &Path) -> PathBuf {
    let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = target.file_name().map_or_else(
        || format!(".veyora-tmp-{id}"),
        |name| format!(".{}.veyora-tmp-{id}", name.to_string_lossy()),
    );
    target.with_file_name(name)
}

/// Write `contents` to `target` through a temporary file, a flush, and an
/// atomic rename. On any error the temporary file is removed and a previously
/// existing target keeps its old bytes.
pub fn write_file(target: &Path, contents: &str) -> Result<(), String> {
    write_file_with_faults(target, contents, FaultPoint::None)
}

pub fn write_file_with_faults(
    target: &Path,
    contents: &str,
    fault: FaultPoint,
) -> Result<(), String> {
    let temp = temp_path_for(target);
    let result = write_via_temp(target, &temp, contents, fault);
    if result.is_err() {
        // Failure cleanup: a partial temporary file must never survive.
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_via_temp(
    target: &Path,
    temp: &Path,
    contents: &str,
    fault: FaultPoint,
) -> Result<(), String> {
    let mut file = File::create(temp).map_err(|e| format!("create temporary file: {e}"))?;
    if fault == FaultPoint::CreateTemp {
        return Err("injected create-temp failure".to_string());
    }
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("write temporary file: {e}"))?;
    if fault == FaultPoint::WriteTemp {
        return Err("injected write-temp failure".to_string());
    }
    file.sync_all()
        .map_err(|e| format!("flush temporary file: {e}"))?;
    if fault == FaultPoint::Flush {
        return Err("injected flush failure".to_string());
    }
    drop(file);
    // Replaces an existing target atomically on Unix and Windows alike.
    fs::rename(temp, target).map_err(|e| format!("finalize file: {e}"))?;
    if fault == FaultPoint::Rename {
        return Err("injected rename failure".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "veyora-atomic-{tag}-{}-{}",
                std::process::id(),
                TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).expect("create scratch dir");
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("read scratch dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("veyora-tmp"))
            .collect()
    }

    #[test]
    fn success_replaces_target_and_leaves_no_temporary() {
        let scratch = Scratch::new("success");
        let target = scratch.path("export.json");
        write_file(&target, "first").expect("first write");
        write_file(&target, "second").expect("second write");
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
        assert!(temp_leftovers(&scratch.0).is_empty());
    }

    #[test]
    fn failure_before_rename_keeps_old_target_and_cleans_up() {
        for fault in [
            FaultPoint::CreateTemp,
            FaultPoint::WriteTemp,
            FaultPoint::Flush,
        ] {
            let scratch = Scratch::new("old-kept");
            let target = scratch.path("export.json");
            write_file(&target, "valid older export").expect("seed older export");
            let error = write_file_with_faults(&target, "new partial", fault)
                .expect_err("injected failure must fail");
            assert!(!error.is_empty());
            assert_eq!(
                fs::read_to_string(&target).unwrap(),
                "valid older export",
                "an interrupted export must not replace a valid older file"
            );
            assert!(
                temp_leftovers(&scratch.0).is_empty(),
                "partial temporary files must be deleted on failure"
            );
        }
    }

    #[test]
    fn failure_without_existing_target_cleans_up() {
        let scratch = Scratch::new("no-target");
        let target = scratch.path("export.json");
        assert!(write_file_with_faults(&target, "partial", FaultPoint::WriteTemp).is_err());
        assert!(!target.exists(), "a failed first export must leave no file");
        assert!(temp_leftovers(&scratch.0).is_empty());
    }

    #[test]
    fn failure_after_rename_is_reported_but_committed() {
        let scratch = Scratch::new("committed");
        let target = scratch.path("export.json");
        // The rename fault fires after finalization, so the new bytes are
        // committed; only the (already removed) temp path is gone.
        let _ = write_file_with_faults(&target, "committed", FaultPoint::Rename);
        assert_eq!(fs::read_to_string(&target).unwrap(), "committed");
        assert!(temp_leftovers(&scratch.0).is_empty());
    }

    #[test]
    fn temp_files_always_share_the_target_directory() {
        let scratch = Scratch::new("same-dir");
        let target = scratch.path("nested-export.json");
        assert!(temp_path_for(&target)
            .parent()
            .is_some_and(|parent| parent == scratch.0));
    }
}
