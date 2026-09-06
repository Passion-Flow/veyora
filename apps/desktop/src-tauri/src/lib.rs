//! Veyora standalone desktop shell.
//!
//! The window hosts the static web client (apps/web) in the system
//! WebView. Everything vault-related — UI, the WebAssembly kernel, and
//! end-to-end encryption — runs inside the WebView, talking to the full
//! records API embedded in this process (`server`) backed by a SQLite vault
//! in a user-chosen directory (`vault`).
//!
//! Desktop-only behaviors:
//!
//! * a first-run screen (`setup.js`) offering the four Welcome routes —
//!   create, open, import-into-a-new-vault, and the advanced self-hosted
//!   connection — where the vault routes pick the storage location first and
//!   then point the client at the embedded loopback server through the same
//!   localStorage key the web client already reads (`veyora-api-url`);
//! * a Vault menu exposing every storage control: change location (with
//!   data migration), storage info, open folder, and JSON backup
//!   export/import compatible with the server `backup`/`restore` tools.

mod atomic_file;
mod server;
mod vault;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use backend_persistence::OpaqueStore;
use backend_sqlite::SqliteStore;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use server::EmbeddedServer;
use vault::DesktopSettings;

const URL_STORAGE_KEY: &str = "veyora-api-url";
const TOKEN_STORAGE_KEY: &str = "veyora-api-token";

/// Process-wide desktop state, managed by Tauri as `Arc<SharedDesktopState>`
/// so worker threads (menus, commands) can hold a handle across dialogs.
struct SharedDesktopState {
    app_data: PathBuf,
    settings: Mutex<Option<DesktopSettings>>,
    server: Mutex<Option<EmbeddedServer>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Client view of the shell state, consumed by the first-run screen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStateDto {
    configured: bool,
    port: Option<u16>,
    vault_dir: Option<String>,
    suggested_dir: String,
}

#[tauri::command]
fn desktop_state(app: AppHandle, state: State<'_, Arc<SharedDesktopState>>) -> DesktopStateDto {
    let settings = lock(&state.settings).clone();
    let server = lock(&state.server);
    DesktopStateDto {
        configured: settings.is_some() && server.is_some(),
        port: server.as_ref().map(EmbeddedServer::port),
        vault_dir: settings
            .as_ref()
            .map(|settings| settings.vault_dir.display().to_string()),
        suggested_dir: suggested_vault_dir(&app).display().to_string(),
    }
}

/// Result of the folder picker used by the first-run screen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickResult {
    ok: bool,
    existing: bool,
    port: Option<u16>,
    dir: Option<String>,
    reason: Option<String>,
}

/// First-run route semantics (UX-ONB-002): `Create` must start from a folder
/// without a vault database and `Open` must find one, so neither route can
/// silently turn into the other.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SetupRoute {
    Create,
    Open,
}

impl SetupRoute {
    fn parse(id: &str) -> Option<Self> {
        match id {
            "create" => Some(Self::Create),
            "open" => Some(Self::Open),
            _ => None,
        }
    }

    /// Refuse a picked folder that contradicts the route's promise; the
    /// message names the alternative route instead of silently switching.
    fn guard_existing(self, db_exists: bool) -> Result<(), String> {
        match (self, db_exists) {
            (Self::Create, true) => Err("that folder already contains a vault database — use \
                 Open an existing vault instead"
                .to_string()),
            (Self::Open, false) => Err("no vault database found in that folder — use \
                 Create a new vault instead"
                .to_string()),
            _ => Ok(()),
        }
    }
}

#[tauri::command]
async fn pick_vault_dir(
    app: AppHandle,
    state: State<'_, Arc<SharedDesktopState>>,
    route: String,
) -> Result<PickResult, String> {
    let shared = state.inner().clone();
    let suggested = suggested_vault_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(route) = SetupRoute::parse(&route) else {
            return PickResult {
                ok: false,
                existing: false,
                port: None,
                dir: None,
                reason: Some("unknown setup route".to_string()),
            };
        };
        let Some(picked) = app
            .dialog()
            .file()
            .set_directory(suggested)
            .blocking_pick_folder()
        else {
            return PickResult {
                ok: false,
                existing: false,
                port: None,
                dir: None,
                reason: None,
            };
        };
        let Some(dir) = picked.as_path().map(Path::to_path_buf) else {
            return PickResult {
                ok: false,
                existing: false,
                port: None,
                dir: None,
                reason: Some("unsupported folder location".to_string()),
            };
        };
        let db_exists = vault::vault_db(&dir).exists();
        if let Err(reason) = route.guard_existing(db_exists) {
            return PickResult {
                ok: false,
                existing: false,
                port: None,
                dir: None,
                reason: Some(reason),
            };
        }
        match configure_storage(&shared, &dir) {
            Ok((port, existing)) => PickResult {
                ok: true,
                existing,
                port: Some(port),
                dir: Some(dir.display().to_string()),
                reason: None,
            },
            Err(reason) => PickResult {
                ok: false,
                existing: false,
                port: None,
                dir: None,
                reason: Some(reason),
            },
        }
    })
    .await
    .map_err(|error| error.to_string())
}

/// Open (or adopt an existing) vault in `dir` and start the embedded API.
/// Persists the choice and the previous backup preferences.
fn configure_storage(shared: &SharedDesktopState, dir: &Path) -> Result<(u16, bool), String> {
    let database = vault::vault_db(dir);
    let existing = database.exists();
    fs::create_dir_all(vault::backup_dir(dir))
        .map_err(|error| format!("create backups folder: {error}"))?;
    let previous = vault::load_settings(&shared.app_data);
    let settings = DesktopSettings {
        vault_dir: dir.to_path_buf(),
        auto_backup_on_start: previous
            .as_ref()
            .is_none_or(|prev| prev.auto_backup_on_start),
        backup_retention: previous.map_or(10, |prev| prev.backup_retention),
    };
    let store = Arc::new(
        SqliteStore::open(&database)
            .map_err(|error| format!("open vault database: {}", error.stable_code()))?,
    );
    if existing && settings.auto_backup_on_start {
        // Fold the WAL so the snapshot file is self-contained.
        let _ = store.checkpoint();
        let _ = vault::rotate_backup(dir, settings.backup_retention);
    }
    let server = EmbeddedServer::start(store)?;
    vault::save_settings(&shared.app_data, &settings)?;
    let port = server.port();
    *lock(&shared.settings) = Some(settings);
    *lock(&shared.server) = Some(server);
    Ok((port, existing))
}

/// Only exact http/https addresses may be handed to the system browser from
/// the Advanced connect route — no other scheme and no embedded whitespace.
fn validate_external_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("enter the address of your Veyora server first".to_string());
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the address must not contain spaces".to_string());
    }
    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Err("the address must start with http:// or https://".to_string());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

fn suggested_vault_dir(app: &AppHandle) -> PathBuf {
    suggested_vault_dir_from(
        app.path().document_dir().ok(),
        app.path().app_data_dir().ok(),
    )
}

/// Pure core of [`suggested_vault_dir`] (INST-006 path conventions): the
/// Documents folder is the suggestion; app-data is the fallback; a bare
/// relative name is the last resort so the result never resolves inside the
/// application bundle, the download folder, or the source checkout.
fn suggested_vault_dir_from(documents: Option<PathBuf>, app_data: Option<PathBuf>) -> PathBuf {
    if let Some(documents) = documents {
        return documents.join("Veyora");
    }
    app_data
        .map(|dir| dir.join("Veyora"))
        .unwrap_or_else(|| PathBuf::from("Veyora"))
}

/// Initialization script for launches that already have a vault: expose the
/// desktop flag and repoint the client at this launch's loopback port before
/// any client script runs. A stale token from the old thin client is cleared
/// so no Authorization header is sent against the tokenless local API.
fn boot_script(port: u16) -> String {
    format!(
        "window.VEYORA_DESKTOP = true;
         try {{
             localStorage.removeItem('{TOKEN_STORAGE_KEY}');
             localStorage.setItem('{URL_STORAGE_KEY}', 'http://127.0.0.1:{port}');
         }} catch (e) {{}}"
    )
}

/// Initialization script for first runs (or a vault that failed to open):
/// expose the desktop flag, then run the storage-location setup screen.
fn first_run_script() -> String {
    format!(
        "window.VEYORA_DESKTOP = true;\n{}",
        include_str!("setup.js")
    )
}

fn notify(app: &AppHandle, message: &str) {
    let _ = app
        .dialog()
        .message(message.to_string())
        .kind(MessageDialogKind::Info)
        .title("Veyora")
        .blocking_show();
}

fn change_storage_location(app: &AppHandle) {
    let shared = app.state::<Arc<SharedDesktopState>>().inner().clone();
    let Some(current) = lock(&shared.settings).clone() else {
        notify(app, "Storage has not been configured yet.");
        return;
    };
    // Checkpoint so the copied file is self-contained.
    if let Some(server) = lock(&shared.server).as_ref() {
        let _ = server.store().checkpoint();
    }
    let Some(picked) = app
        .dialog()
        .file()
        .set_directory(current.vault_dir.clone())
        .blocking_pick_folder()
    else {
        return;
    };
    let Some(new_dir) = picked.as_path().map(Path::to_path_buf) else {
        notify(app, "Unsupported folder location.");
        return;
    };
    if new_dir == current.vault_dir {
        notify(app, "That folder is already the active storage location.");
        return;
    }
    if vault::vault_db(&new_dir).exists() {
        notify(
            app,
            "The selected folder already contains a vault database.\n\
             Pick an empty folder to move to, or open that vault from the \
             first-run screen instead.",
        );
        return;
    }
    match vault::migrate_storage(&current.vault_dir, &new_dir) {
        Ok(()) => {
            let updated = DesktopSettings {
                vault_dir: new_dir,
                ..current
            };
            if let Err(error) = vault::save_settings(&shared.app_data, &updated) {
                notify(
                    app,
                    &format!("Could not save the new storage location: {error}"),
                );
                return;
            }
            let _ = app
                .dialog()
                .message(
                    "Vault storage moved. Veyora will restart to use the new \
                     location.\n\n\
                     The previous folder was kept and can be deleted manually \
                     once everything looks right.",
                )
                .kind(MessageDialogKind::Info)
                .title("Veyora")
                .blocking_show();
            app.restart();
        }
        Err(error) => notify(app, &format!("Moving the vault failed: {error}")),
    }
}

fn storage_info(app: &AppHandle) {
    let shared = app.state::<Arc<SharedDesktopState>>().inner().clone();
    let Some(settings) = lock(&shared.settings).clone() else {
        notify(app, "Storage has not been configured yet.");
        return;
    };
    let record_count = lock(&shared.server)
        .as_ref()
        .and_then(|server| {
            // A local vault holds exactly one vault scope; an unpopulated
            // database has none and therefore no records.
            let vault = server.store().vault_ids().ok()?.into_iter().next()?;
            server
                .store()
                .list(&vault, 100_000, 0)
                .ok()
                .map(|records| records.len())
        })
        .unwrap_or(0);
    let size = vault::vault_db_size(&settings.vault_dir)
        .map_or("not created yet".to_string(), |bytes| {
            format!("{bytes} bytes")
        });
    let backups = vault::backup_count(&settings.vault_dir);
    let auto_backup = if settings.auto_backup_on_start {
        "on"
    } else {
        "off"
    };
    notify(
        app,
        &format!(
            "Storage location: {}\nRecords: {record_count}\nDatabase size: {size}\n\
             Backups kept: {backups} (auto-backup on start: {auto_backup}, retention: {})",
            settings.vault_dir.display(),
            settings.backup_retention,
        ),
    );
}

fn open_storage_folder(app: &AppHandle) {
    let shared = app.state::<Arc<SharedDesktopState>>().inner().clone();
    let Some(settings) = lock(&shared.settings).clone() else {
        notify(app, "Storage has not been configured yet.");
        return;
    };
    if !settings.vault_dir.exists() {
        notify(app, "The storage folder does not exist yet.");
        return;
    }
    use tauri_plugin_opener::OpenerExt;
    if let Err(error) = app.opener().open_path(
        settings.vault_dir.to_string_lossy().to_string(),
        None::<&str>,
    ) {
        notify(app, &format!("Could not open the folder: {error}"));
    }
}

fn export_backup(app: &AppHandle) {
    let shared = app.state::<Arc<SharedDesktopState>>().inner().clone();
    let Some(server) = lock(&shared.server).clone() else {
        notify(app, "The vault is not open.");
        return;
    };
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or_default();
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Veyora backup", &["json"])
        .set_file_name(format!("veyora-backup-{millis}.json"))
        .blocking_save_file()
    else {
        return;
    };
    let Some(path) = picked.as_path().map(Path::to_path_buf) else {
        notify(app, "Unsupported save location.");
        return;
    };
    // Same shape the server `backup` tool writes: a JSON array of wire DTOs.
    // A local vault holds exactly one vault scope; an unpopulated database
    // has none, and an empty backup is the honest result for it.
    let vault = server
        .store()
        .vault_ids()
        .ok()
        .and_then(|ids| ids.into_iter().next())
        .unwrap_or_default();
    let records = server
        .store()
        .list_bodies(&vault, 100_000, 0)
        .map_err(|error| format!("read vault: {}", error.stable_code()))
        .and_then(|records| {
            let dtos: Vec<api::RecordDto> = records
                .into_iter()
                .map(api::RecordDto::from_record)
                .collect();
            let count = dtos.len();
            let json = serde_json::to_string_pretty(&dtos)
                .map_err(|error| format!("encode backup: {error}"))?;
            atomic_file::write_file(&path, &json)
                .map_err(|error| format!("write backup: {error}"))?;
            Ok(count)
        });
    match records {
        Ok(count) => notify(
            app,
            &format!("Exported {count} record(s) to {}", path.display()),
        ),
        Err(error) => notify(app, &format!("Export failed: {error}")),
    }
}

fn import_backup(app: &AppHandle) {
    let shared = app.state::<Arc<SharedDesktopState>>().inner().clone();
    let Some(server) = lock(&shared.server).clone() else {
        notify(app, "The vault is not open.");
        return;
    };
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Veyora backup", &["json"])
        .blocking_pick_file()
    else {
        return;
    };
    let Some(path) = picked.as_path().map(Path::to_path_buf) else {
        notify(app, "Unsupported file location.");
        return;
    };
    let outcome = fs::read_to_string(&path)
        .map_err(|error| format!("read backup: {error}"))
        .and_then(|raw| {
            serde_json::from_str::<Vec<api::RecordDto>>(&raw)
                .map_err(|error| format!("not a Veyora backup file: {error}"))
        })
        .and_then(|dtos| {
            // Same semantics as the server `restore` tool: skip records that
            // already exist instead of overwriting them.
            let mut imported = 0usize;
            let mut skipped = 0usize;
            for dto in dtos {
                let record_id = dto.record_id.clone();
                match server.store().put(dto.into_record(), None) {
                    Ok(_) => imported += 1,
                    Err(backend_persistence::StoreError::Conflict) => skipped += 1,
                    Err(error) => {
                        return Err(format!(
                            "record {record_id} rejected: {}",
                            error.stable_code()
                        ))
                    }
                }
            }
            Ok((imported, skipped))
        });
    match outcome {
        Ok((imported, skipped)) => {
            notify(
                app,
                &format!("Imported {imported} record(s), skipped {skipped} already present."),
            );
        }
        Err(error) => notify(app, &format!("Import failed: {error}")),
    }
}

fn build_menus(app: &mut tauri::App, window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let change_location = MenuItem::with_id(
        app,
        "change-storage-location",
        "Change Storage Location…",
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;
    let storage_info_item =
        MenuItem::with_id(app, "storage-info", "Storage Info…", true, None::<&str>)?;
    let open_folder = MenuItem::with_id(
        app,
        "open-storage-folder",
        "Open Storage Folder",
        true,
        None::<&str>,
    )?;
    let export_item =
        MenuItem::with_id(app, "export-backup", "Export Backup…", true, None::<&str>)?;
    let import_item =
        MenuItem::with_id(app, "import-backup", "Import Backup…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let vault_menu = Submenu::with_items(
        app,
        "Vault",
        true,
        &[
            &change_location,
            &storage_info_item,
            &open_folder,
            &separator,
            &export_item,
            &import_item,
        ],
    )?;
    let menu = Menu::with_items(app, &[&vault_menu])?;

    // macOS renders the menu in the global menu bar; the other platforms
    // show it in the window.
    #[cfg(target_os = "macos")]
    app.set_menu(menu)?;
    #[cfg(not(target_os = "macos"))]
    window.set_menu(menu)?;

    window.on_menu_event(move |window, event| {
        let id = event.id().as_ref().to_string();
        let app = window.app_handle().clone();
        // Dialogs block; keep them off the event loop thread.
        std::thread::spawn(move || match id.as_str() {
            "change-storage-location" => change_storage_location(&app),
            "storage-info" => storage_info(&app),
            "open-storage-folder" => open_storage_folder(&app),
            "export-backup" => export_backup(&app),
            "import-backup" => import_backup(&app),
            _ => {}
        });
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            desktop_state,
            pick_vault_dir,
            open_external_url
        ])
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("resolve app-data dir: {error}"))?;
            fs::create_dir_all(&app_data)
                .map_err(|error| format!("create app-data dir: {error}"))?;
            let shared = Arc::new(SharedDesktopState {
                app_data,
                settings: Mutex::new(None),
                server: Mutex::new(None),
            });
            *lock(&shared.settings) = vault::load_settings(&shared.app_data);
            let mut port: Option<u16> = None;
            if let Some(settings) = lock(&shared.settings).clone() {
                // A configured vault that fails to open (moved folder, broken
                // disk) falls back to the first-run screen instead of exiting:
                // the user picks a location and keeps working.
                match configure_storage(&shared, &settings.vault_dir) {
                    Ok((bound, _)) => port = Some(bound),
                    Err(error) => eprintln!("veyora: could not open configured vault: {error}"),
                }
            }
            app.manage(shared);

            let initialization = match port {
                Some(port) => boot_script(port),
                None => first_run_script(),
            };
            let window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("Veyora")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(960.0, 640.0)
                    .initialization_script(initialization)
                    .build()?;
            build_menus(app, &window)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the Veyora desktop client");
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn suggested_vault_dir_prefers_documents_then_app_data() {
        let documents = std::env::temp_dir().join("veyora-test-documents");
        let app_data = std::env::temp_dir().join("veyora-test-app-data");
        assert_eq!(
            suggested_vault_dir_from(Some(documents.clone()), Some(app_data.clone())),
            documents.join("Veyora")
        );
        assert_eq!(
            suggested_vault_dir_from(None, Some(app_data.clone())),
            app_data.join("Veyora")
        );
        // The last resort is a bare relative name the user must place
        // deliberately — never a bundle, download, or checkout location.
        assert_eq!(
            suggested_vault_dir_from(None, None),
            PathBuf::from("Veyora")
        );
    }

    use super::*;

    #[test]
    fn create_route_refuses_a_folder_that_already_holds_a_vault() {
        assert_eq!(
            SetupRoute::guard_existing(SetupRoute::Create, false),
            Ok(())
        );
        let error = SetupRoute::guard_existing(SetupRoute::Create, true)
            .expect_err("create must not silently adopt an existing vault");
        assert!(error.contains("Open an existing vault"));
    }

    #[test]
    fn open_route_requires_an_existing_vault_database() {
        assert_eq!(SetupRoute::guard_existing(SetupRoute::Open, true), Ok(()));
        let error = SetupRoute::guard_existing(SetupRoute::Open, false)
            .expect_err("open must not silently create a vault");
        assert!(error.contains("Create a new vault"));
    }

    #[test]
    fn setup_routes_parse_from_the_first_run_screen_ids() {
        assert_eq!(SetupRoute::parse("create"), Some(SetupRoute::Create));
        assert_eq!(SetupRoute::parse("open"), Some(SetupRoute::Open));
        assert_eq!(SetupRoute::parse("connect"), None);
        assert_eq!(SetupRoute::parse(""), None);
    }

    #[test]
    fn external_urls_must_be_plain_http_addresses() {
        assert_eq!(
            validate_external_url(" https://vault.example.com ").as_deref(),
            Ok("https://vault.example.com")
        );
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("vault.example.com").is_err());
        assert!(validate_external_url("ftp://vault.example.com").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("https://a b.example.com").is_err());
        assert!(validate_external_url("https://ex.com\0").is_err());
    }
}
