//! TokenDash desktop shell for Linux and Windows: tray badge, popover window and the local
//! daemon that serves both the popover page and the web dashboard.

mod badge;
mod credentials;
mod daemon;
mod http;
mod paths;
mod popover;
mod settings;
mod tray;
mod usage;

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use daemon::DaemonState;

/// Badge refresh cadence while the panel is closed, mirroring the macOS
/// `.dormant` mode.
const BADGE_INTERVAL: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const START_RETRY_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PopoverStatus {
    /// `starting` | `ready` | `error`
    state: String,
    message: Option<String>,
    url: Option<String>,
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let (script, script_found) = daemon::find_daemon_script(&handle);
            let state = DaemonState::new(
                handle.package_info().version.to_string(),
                script,
                script_found,
                daemon::find_node(),
            );
            app.manage(state);
            tray::install(&handle).map_err(Box::<dyn std::error::Error>::from)?;
            start_supervisor(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            popover_status,
            get_desktop_settings,
            save_desktop_settings,
            get_configured_providers,
            save_credential,
            delete_credential,
            get_daemon_port,
            open_dashboard,
            open_external,
            hide_popover,
            set_popover_height,
            notify,
            app_version,
        ])
        .build(tauri::generate_context!())
        .expect("Failed to initialize TokenDash desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                daemon::stop(app);
            }
        });
}

/// Brings the daemon up, then keeps the badge fresh and the process supervised.
fn start_supervisor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            match daemon::ensure_started(&app).await {
                Ok(port) => {
                    eprintln!("[tokendash] Local server ready: 127.0.0.1:{port}");
                    break;
                }
                Err(message) => {
                    daemon::record_startup_error(&message);
                    eprintln!("[tokendash] Local server not ready: {message}");
                    tray::update_usage(&app, None);
                    tokio::time::sleep(START_RETRY_INTERVAL).await;
                }
            }
        }
        // An open placeholder window must move to the popover page now that the
        // origin exists.
        popover::reload_if_port_changed(&app);
        spawn_badge_loop(app.clone());
        spawn_health_loop(app);
    });
}

fn spawn_badge_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_warm = Instant::now();
        loop {
            match app.state::<DaemonState>().port() {
                Some(port) => match usage::fetch_today(port).await {
                    Ok(totals) => tray::update_usage(&app, Some(totals)),
                    Err(error) => {
                        eprintln!("[tokendash] Failed to read today's usage: {error}");
                        tray::show_usage_error(&app);
                    }
                },
                None => tray::update_usage(&app, None),
            }

            if let Some(port) = app.state::<DaemonState>().port() {
                let hidden = app
                    .get_webview_window(popover::POPOVER_LABEL)
                    .map(|window| !window.is_visible().unwrap_or(true))
                    .unwrap_or(true);
                let interval = Duration::from_secs(settings::load().background_refresh_secs);
                if hidden && last_warm.elapsed() >= interval {
                    // Warm the popover's caches while nobody is looking, so the
                    // panel opens with data instead of a spinner.
                    let _ = usage::warm_detail(port).await;
                    last_warm = Instant::now();
                }
            }

            popover::reload_if_port_changed(&app);
            tokio::time::sleep(BADGE_INTERVAL).await;
        }
    });
}

fn spawn_health_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(HEALTH_INTERVAL).await;
            // Same rule as the macOS build: restart only when both the process
            // table and the HTTP probe report the daemon gone.
            if daemon::is_alive(&app) || daemon::is_alive_via_probe(&app).await {
                continue;
            }
            eprintln!("[tokendash] Local server exited; restarting");
            if let Err(error) = daemon::ensure_started(&app).await {
                eprintln!("[tokendash] Failed to restart local server: {error}");
            }
            popover::reload_if_port_changed(&app);
        }
    });
}

// ---------------------------------------------------------------------------
// Commands used by the popover page
// ---------------------------------------------------------------------------

/// Polled by the bundled placeholder page until the daemon can serve the panel.
#[tauri::command]
fn popover_status(app: AppHandle) -> PopoverStatus {
    let state = app.state::<DaemonState>();
    if let Some(_port) = state.port() {
        return PopoverStatus {
            state: "ready".to_string(),
            message: None,
            url: popover::popover_url(&app).map(|url| url.to_string()),
        };
    }
    match state.error() {
        Some(message) => PopoverStatus {
            state: "error".to_string(),
            message: Some(message),
            url: None,
        },
        None => PopoverStatus {
            state: "starting".to_string(),
            message: None,
            url: None,
        },
    }
}

#[tauri::command]
fn get_desktop_settings() -> settings::DesktopSettings {
    settings::load()
}

#[tauri::command]
fn save_desktop_settings(
    app: AppHandle,
    settings: settings::DesktopSettings,
) -> Result<settings::DesktopSettings, String> {
    let saved = settings::save(&settings)?;
    // Only touch the autostart entry when the flag actually changed, so an
    // unrelated settings write cannot clobber a hand-edited .desktop file.
    if saved.launch_at_login != settings::is_autostart_enabled() {
        settings::apply_autostart(saved.launch_at_login)?;
    }
    tray::sync_autostart(&app, saved.launch_at_login);
    Ok(saved)
}

#[tauri::command]
fn get_configured_providers() -> Result<Vec<String>, String> {
    credentials::configured_providers()
}

#[tauri::command]
fn save_credential(
    provider: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<(), String> {
    credentials::save_credential(&provider, &api_key, base_url)
}

#[tauri::command]
fn delete_credential(provider: String) -> Result<(), String> {
    credentials::delete_credential(&provider)
}

#[tauri::command]
fn get_daemon_port(app: AppHandle) -> Option<u16> {
    app.state::<DaemonState>().port()
}

#[tauri::command]
async fn open_dashboard(app: AppHandle) -> Result<(), String> {
    let port = daemon::ensure_started(&app).await?;
    open::that(format!("http://127.0.0.1:{port}/"))
        .map_err(|error| format!("Failed to open browser: {error}"))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // Only web links ever reach this command; anything else could hand a local
    // file or a custom handler to the desktop.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("Refusing to open a non-HTTP link: {url}"));
    }
    open::that(&url).map_err(|error| format!("Failed to open link: {error}"))
}

#[tauri::command]
fn hide_popover(app: AppHandle) {
    popover::hide(&app);
}

#[tauri::command]
fn set_popover_height(app: AppHandle, height: f64) {
    popover::set_content_height(&app, height);
}

#[tauri::command]
fn notify(title: String, body: String) {
    #[cfg(not(windows))]
    if let Err(error) = paths::command("notify-send")
        .args(["-a", "TokenDash", &title, &body])
        .status()
    {
        eprintln!("[tokendash] Failed to send desktop notification: {error}");
    }
    #[cfg(windows)]
    std::thread::spawn(move || {
        // Balloon notifications need no elevated privileges or extra plugin.
        // Data travels through environment variables, never PowerShell source.
        let script = r#"Add-Type -AssemblyName System.Windows.Forms
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Visible = $true
$icon.ShowBalloonTip(5000, $env:TOKENDASH_NOTICE_TITLE, $env:TOKENDASH_NOTICE_BODY, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 6
$icon.Dispose()"#;
        let _ = paths::command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script])
            .env("TOKENDASH_NOTICE_TITLE", title)
            .env("TOKENDASH_NOTICE_BODY", body)
            .status();
    });
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
