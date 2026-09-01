//! Vault storage layout, user preferences, and backup rotation.
//!
//! The vault data itself always lives in a user-chosen directory:
//!
//! ```text
//! <chosen dir>/vault.db          the SQLite vault (opaque ciphertext only)
//! <chosen dir>/backups/          rolling startup snapshots (vault-<ms>.db)
//! ```
//!
//! The OS app-data directory holds only `settings.json` — a pointer to the
//! chosen directory plus backup preferences. Nothing in the chosen directory
//! is required to stay secret from the user: it is their vault, in their
//! place, and copying the directory to another machine carries the vault
//! with it (records stay locked without the master password).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const VAULT_DB_NAME: &str = "vault.db";
pub const BACKUP_DIR_NAME: &str = "backups";

/// User-controlled desktop preferences, persisted next to nothing: just where
/// the vault lives and how startup backups behave.
#[derive(Clone, Serialize, Deserialize)]
pub struct DesktopSettings {
    /// Directory the user chose for `vault.db` + `backups/`.
    pub vault_dir: PathBuf,
    /// Snapshot the vault into `backups/` before opening it at startup.
    #[serde(default = "default_auto_backup")]
    pub auto_backup_on_start: bool,
    /// How many startup snapshots to keep in `backups/`.
    #[serde(default = "default_retention")]
    pub backup_retention: u32,
}

fn default_auto_backup() -> bool {
    true
}

fn default_retention() -> u32 {
    10
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            vault_dir: PathBuf::new(),
            auto_backup_on_start: default_auto_backup(),
            backup_retention: default_retention(),
        }
    }
}

#[must_use]
pub fn settings_path(app_data: &Path) -> PathBuf {
    app_data.join("settings.json")
}

#[must_use]
pub fn load_settings(app_data: &Path) -> Option<DesktopSettings> {
    let raw = fs::read_to_string(settings_path(app_data)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_settings(app_data: &Path, settings: &DesktopSettings) -> Result<(), String> {
    fs::create_dir_all(app_data).map_err(|e| format!("create app-data dir: {e}"))?;
    let raw =
        serde_json::to_string_pretty(settings).map_err(|e| format!("encode settings: {e}"))?;
    fs::write(settings_path(app_data), raw).map_err(|e| format!("write settings: {e}"))
}

#[must_use]
pub fn vault_db(vault_dir: &Path) -> PathBuf {
    vault_dir.join(VAULT_DB_NAME)
}

#[must_use]
pub fn backup_dir(vault_dir: &Path) -> PathBuf {
    vault_dir.join(BACKUP_DIR_NAME)
}

/// Copy the (checkpointed) database into `backups/` under a sortable
/// epoch-milliseconds name, then trim snapshots beyond the retention count.
/// Returns the new snapshot path, or `None` when there is no database yet.
pub fn rotate_backup(vault_dir: &Path, retention: u32) -> Result<Option<PathBuf>, String> {
    let db = vault_db(vault_dir);
    if !db.exists() {
        return Ok(None);
    }
    let backups = backup_dir(vault_dir);
    fs::create_dir_all(&backups).map_err(|e| format!("create backups dir: {e}"))?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or_default();
    let target = backups.join(format!("vault-{millis:013}.db"));
    fs::copy(&db, &target).map_err(|e| format!("copy snapshot: {e}"))?;
    trim_backups(&backups, retention);
    Ok(Some(target))
}

/// Keep only the newest `retention` snapshots (lexicographic order on the
/// zero-padded epoch names is chronological order).
fn trim_backups(backups: &Path, retention: u32) {
    let Ok(entries) = fs::read_dir(backups) else {
        return;
    };
    let mut snapshots: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "db"))
        .collect();
    let excess = snapshots.len().saturating_sub(retention as usize);
    if excess == 0 {
        return;
    }
    snapshots.sort();
    for stale in &snapshots[..excess] {
        let _ = fs::remove_file(stale);
    }
}

/// Number of snapshots currently kept for the vault.
#[must_use]
pub fn backup_count(vault_dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(backup_dir(vault_dir)) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "db")
        })
        .count()
}

/// Relocate the vault to a new directory by copying the checkpointed
/// database and the backup history. The old directory is deliberately left
/// untouched — redundancy beats data loss; the user deletes it when ready.
pub fn migrate_storage(old_dir: &Path, new_dir: &Path) -> Result<(), String> {
    if vault_db(new_dir).exists() {
        return Err("the selected folder already contains a vault database".to_string());
    }
    fs::create_dir_all(new_dir).map_err(|e| format!("create target dir: {e}"))?;
    fs::copy(vault_db(old_dir), vault_db(new_dir)).map_err(|e| format!("copy vault.db: {e}"))?;
    let old_backups = backup_dir(old_dir);
    if old_backups.is_dir() {
        let new_backups = backup_dir(new_dir);
        fs::create_dir_all(&new_backups).map_err(|e| format!("create backups dir: {e}"))?;
        for entry in fs::read_dir(&old_backups)
            .map_err(|e| format!("read backups dir: {e}"))?
            .flatten()
        {
            if entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "db")
            {
                let _ = fs::copy(entry.path(), new_backups.join(entry.file_name()));
            }
        }
    }
    Ok(())
}

/// File size of the vault database in bytes, when present.
#[must_use]
pub fn vault_db_size(vault_dir: &Path) -> Option<u64> {
    fs::metadata(vault_db(vault_dir))
        .ok()
        .map(|meta| meta.len())
}
