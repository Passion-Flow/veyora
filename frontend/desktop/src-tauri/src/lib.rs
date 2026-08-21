//! Veyora desktop shell.
//!
//! The window hosts the static web client (frontend/web) in the system
//! WebView. Everything vault-related — UI, the WebAssembly kernel, and
//! end-to-end encryption — runs inside the WebView. This shell adds two
//! desktop-only behaviors:
//!
//! * a first-run "connect to your server" screen, injected before the
//!   client scripts load (`connect.js`), which stores the server URL and
//!   optional API token in the WebView's localStorage — the same keys the
//!   web client already reads (`veyora-api-url`, `veyora-api-token`);
//! * a Connection menu with a "Change Server…" action that clears those
//!   keys and reloads.

const URL_STORAGE_KEY: &str = "veyora-api-url";
const TOKEN_STORAGE_KEY: &str = "veyora-api-token";

/// Script executed by the Change Server menu entry.
fn change_server_script() -> String {
    [
        "try { localStorage.removeItem('",
        URL_STORAGE_KEY,
        "'); localStorage.removeItem('",
        TOKEN_STORAGE_KEY,
        "'); } catch (e) {} location.reload();",
    ]
    .concat()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("Veyora")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(960.0, 640.0)
                    .initialization_script(include_str!("connect.js"))
                    .build()?;

            let change_server = tauri::menu::MenuItem::with_id(
                app,
                "change-server",
                "Change Server…",
                true,
                Some("CmdOrCtrl+Shift+L"),
            )?;
            let connection_menu =
                tauri::menu::Submenu::with_items(app, "Connection", true, &[&change_server])?;
            let menu = tauri::menu::Menu::with_items(app, &[&connection_menu])?;

            // macOS renders the menu in the global menu bar; the other
            // platforms show it in the window.
            #[cfg(target_os = "macos")]
            app.set_menu(menu)?;
            #[cfg(not(target_os = "macos"))]
            window.set_menu(menu)?;

            let view = window.clone();
            window.on_menu_event(move |_, event| {
                if event.id() == change_server.id() {
                    let _ = view.eval(change_server_script());
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the Veyora desktop client");
}
