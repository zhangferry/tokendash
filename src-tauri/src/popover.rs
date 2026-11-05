//! Popover window: creation, placement, sizing and focus behaviour.
//!
//! On Linux the tray has no reliable icon-rect geometry (appindicator does not
//! deliver click events), so the panel is anchored below the top-right corner of
//! the primary monitor — where the panel's own indicator sits.

use tauri::{AppHandle, Emitter, Manager, Position, Size, WebviewUrl, WebviewWindowBuilder};

use crate::daemon::DaemonState;

pub const POPOVER_LABEL: &str = "popover";
const POPOVER_WIDTH: f64 = 380.0;
const DEFAULT_HEIGHT: f64 = 620.0;
const MIN_HEIGHT: f64 = 160.0;
const MAX_HEIGHT: f64 = 900.0;
/// Vertical gap that clears the GNOME top bar.
#[cfg(not(windows))]
const PANEL_OFFSET: f64 = 32.0;
const EDGE_MARGIN: f64 = 8.0;

/// URL of the daemon-served popover page. `None` while the daemon is not ready.
pub fn popover_url(app: &AppHandle) -> Option<tauri::Url> {
    let port = app.state::<DaemonState>().port()?;
    tauri::Url::parse(&format!("http://127.0.0.1:{port}/menubar.html")).ok()
}

/// The dev server URL takes over in a source checkout: it serves the popover
/// with hot reload and proxies `/api` to the running API server.
fn dev_url(app: &AppHandle) -> Option<tauri::Url> {
    if !cfg!(debug_assertions) {
        return None;
    }
    app.config().build.dev_url.clone()
}

fn initial_url(app: &AppHandle) -> WebviewUrl {
    if let Some(url) = dev_url(app) {
        return WebviewUrl::External(url);
    }
    match popover_url(app) {
        Some(url) => WebviewUrl::External(url),
        // The daemon is not ready yet: show the bundled placeholder, which
        // navigates itself once `popover_status` reports ready.
        None => WebviewUrl::App("index.html".into()),
    }
}

pub fn toggle(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(POPOVER_LABEL) else {
            if let Err(error) = create(&handle) {
                eprintln!("[tokendash] Failed to create popover window: {error}");
            }
            return;
        };
        if window.is_visible().unwrap_or(false) {
            hide(&handle);
            return;
        }
        show(&handle);
    });
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        emit_visibility(app, true);
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        let _ = window.hide();
        emit_visibility(app, false);
    }
}

/// Lets the panel pause its own polling while hidden; the page keeps running in
/// the background otherwise.
fn emit_visibility(app: &AppHandle, visible: bool) {
    if let Err(error) = app.emit_to(POPOVER_LABEL, "popover-visibility", visible) {
        eprintln!("[tokendash] Failed to notify popover visibility: {error}");
    }
}

/// Creates the panel on demand so startup stays free of webview work and the
/// window can point at whatever port the daemon ended up on.
fn create(app: &AppHandle) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, POPOVER_LABEL, initial_url(app))
        .title("TokenDash")
        .inner_size(POPOVER_WIDTH, DEFAULT_HEIGHT)
        // 必须保持 resizable：GTK 在 resizable(false) 时把尺寸提示锁成 min==max，
        // mutter 会忽略 `set_content_height` 的 resize，窗口停在 620 而内容只有约 590，
        // 底部留下上一帧未重绘的残影。无边框窗口没有可供拖拽的边框，用户无法手动改变大小。
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()
        .map_err(|error| format!("Failed to create popover window: {error}"))?;

    // No focus-loss dismissal: the panel stays open until toggled from the tray,
    // matching the macOS behaviour where the NSPanel sets hidesOnDeactivate=false.
    place(app, &window);
    window
        .show()
        .map_err(|error| format!("Failed to show popover window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus popover window: {error}"))?;
    emit_visibility(app, true);
    Ok(())
}

/// Anchors the panel below the top-right corner of the primary monitor.
#[cfg(not(windows))]
fn place(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let origin = monitor.position();
    let width = (POPOVER_WIDTH * scale).round() as i32;
    let height = (DEFAULT_HEIGHT * scale).round() as i32;
    let margin = (EDGE_MARGIN * scale).round() as i32;
    let offset = (PANEL_OFFSET * scale).round() as i32;
    let x = origin.x + size.width as i32 - width - margin;
    let y = origin.y + offset;
    let _ = window.set_position(Position::Physical(tauri::PhysicalPosition::new(x, y)));
    let _ = window.set_size(Size::Physical(tauri::PhysicalSize::new(
        width as u32,
        height as u32,
    )));
}

/// Windows taskbars can sit on any edge; use the monitor work area so the
/// panel remains above the taskbar and inside the visible desktop at any DPI.
#[cfg(windows)]
fn place(app: &AppHandle, window: &tauri::WebviewWindow) {
    place_windows(app, window, DEFAULT_HEIGHT);
}

#[cfg(windows)]
fn place_windows(app: &AppHandle, window: &tauri::WebviewWindow, logical_height: f64) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let margin = (EDGE_MARGIN * scale).round() as i32;
    let width = ((POPOVER_WIDTH * scale).round() as u32)
        .min(area.size.width.saturating_sub(2 * margin as u32));
    let height = ((logical_height * scale).round() as u32)
        .min(area.size.height.saturating_sub(2 * margin as u32));
    let x = area.position.x + area.size.width as i32 - width as i32 - margin;
    let y = area.position.y + area.size.height as i32 - height as i32 - margin;
    let _ = window.set_size(Size::Physical(tauri::PhysicalSize::new(width, height)));
    let _ = window.set_position(Position::Physical(tauri::PhysicalPosition::new(x, y)));
}

/// Resizes the panel to its content height while keeping the top edge fixed.
pub fn set_content_height(app: &AppHandle, logical_height: f64) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    if !logical_height.is_finite() {
        return;
    }
    let height = logical_height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    #[cfg(windows)]
    {
        place_windows(app, &window, height);
    }
    #[cfg(not(windows))]
    resize_from_top(&window, height);
}

#[cfg(not(windows))]
fn resize_from_top(window: &tauri::WebviewWindow, height: f64) {
    let Ok(current) = window.outer_position() else {
        return;
    };
    if let Err(error) = window.set_size(Size::Logical(tauri::LogicalSize::new(
        POPOVER_WIDTH,
        height,
    ))) {
        eprintln!("[tokendash] Failed to resize popover: {error}");
        return;
    }
    let _ = window.set_position(Position::Physical(current));
}

/// Tells the open panel to reload its details now (the tray's manual refresh).
pub fn request_refresh(app: &AppHandle) {
    if let Err(error) = app.emit_to(POPOVER_LABEL, "popover-refresh", ()) {
        eprintln!("[tokendash] Failed to request popover refresh: {error}");
    }
}

/// After a daemon restart on a different port the open panel would keep talking
/// to a dead origin; reload it against the new one.
pub fn reload_if_port_changed(app: &AppHandle) {
    let (Some(window), Some(url)) = (app.get_webview_window(POPOVER_LABEL), popover_url(app))
    else {
        return;
    };
    if dev_url(app).is_some() {
        return;
    }
    let current = window.url().ok();
    let same_origin = current
        .as_ref()
        .map(|value| value.port() == url.port())
        .unwrap_or(false);
    if !same_origin {
        if let Err(error) = window.navigate(url) {
            eprintln!("[tokendash] Failed to change popover URL: {error}");
        }
    }
}
