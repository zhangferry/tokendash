//! System tray icon and menu.
//!
//! libayatana-appindicator (the Linux tray backend) shows the menu on left
//! click and does not deliver icon click events, so the panel is opened from
//! the menu instead of by clicking the icon. The menu also carries what the
//! macOS build shows in the icon itself: today's usage summary.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use crate::badge;
use crate::popover;
use crate::settings;
use crate::usage::TodayTotals;

const TRAY_ID: &str = "tokendash-tray";

/// Menu items that need their text or check state updated later on.
pub struct TrayHandles {
    summary: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    let summary = MenuItem::with_id(
        app,
        "summary",
        badge::summary_label(None, None),
        false,
        None::<&str>,
    )
    .map_err(|error| format!("Failed to create tray menu: {error}"))?;
    let toggle = MenuItem::with_id(app, "toggle", "Open Panel", true, None::<&str>)
        .map_err(|error| format!("Failed to create tray menu: {error}"))?;
    let dashboard = MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)
        .map_err(|error| format!("Failed to create tray menu: {error}"))?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh Now", true, None::<&str>)
        .map_err(|error| format!("Failed to create tray menu: {error}"))?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Launch at Login",
        true,
        settings::is_autostart_enabled(),
        None::<&str>,
    )
    .map_err(|error| format!("Failed to create tray menu: {error}"))?;
    let separator = PredefinedMenuItem::separator(app)
        .map_err(|error| format!("Failed to create tray menu: {error}"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit TokenDash", true, None::<&str>)
        .map_err(|error| format!("Failed to create tray menu: {error}"))?;

    let menu = Menu::with_items(
        app,
        &[
            &summary, &toggle, &dashboard, &refresh, &autostart, &separator, &quit,
        ],
    )
    .map_err(|error| format!("Failed to create tray menu: {error}"))?;

    app.manage(TrayHandles {
        summary: summary.clone(),
        autostart: autostart.clone(),
    });

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("TokenDash")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => popover::toggle(app),
            "dashboard" => open_dashboard(app),
            "refresh" => refresh_now(app),
            "autostart" => toggle_autostart(app),
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(image) = badge::render_badge(None) {
        builder = builder.icon(tauri::image::Image::new_owned(
            image.rgba,
            image.width,
            image.height,
        ));
    }
    builder
        .build(app)
        .map_err(|error| format!("Failed to create tray icon: {error}"))?;
    Ok(())
}

/// Replaces the tray bitmap and the summary line in one step so the two never
/// disagree about what today's usage is.
pub fn update_usage(app: &AppHandle, totals: Option<TodayTotals>) {
    let partial = totals
        .as_ref()
        .map(|value| {
            if !value.failed_sources.is_empty() {
                format!(
                    " · Some sources unavailable: {}",
                    value.failed_sources.join(", ")
                )
            } else if !value.cost_available {
                " · Partial cost estimate".to_string()
            } else {
                String::new()
            }
        })
        .unwrap_or_default();
    let (tokens, cost) = match totals {
        Some(totals) => (
            Some(totals.tokens),
            totals.cost_available.then_some(totals.cost),
        ),
        None => (None, None),
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Some(image) = badge::render_badge(tokens) {
            let icon = tauri::image::Image::new_owned(image.rgba, image.width, image.height);
            if let Err(error) = tray.set_icon(Some(icon)) {
                eprintln!("[tokendash] Failed to update tray icon: {error}");
            }
        }
    }
    let label = format!("{}{partial}", badge::summary_label(tokens, cost));
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("TokenDash · {label}")));
    }
    if let Some(handles) = app.try_state::<TrayHandles>() {
        if let Err(error) = handles.summary.set_text(label) {
            eprintln!("[tokendash] Failed to update tray summary: {error}");
        }
    }
}

/// Retains the last badge bitmap while making a failed refresh visible.
pub fn show_usage_error(app: &AppHandle) {
    let label = "Usage refresh failed · Keeping previous data";
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("TokenDash · {label}")));
    }
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.summary.set_text(label);
    }
}

pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        if let Err(error) = handles.autostart.set_checked(enabled) {
            eprintln!("[tokendash] Failed to update launch-at-login state: {error}");
        }
    }
}

fn toggle_autostart(app: &AppHandle) {
    let mut settings = settings::load();
    settings.launch_at_login = !settings::is_autostart_enabled();
    match settings::save(&settings)
        .and_then(|saved| settings::apply_autostart(saved.launch_at_login).map(|()| saved))
    {
        Ok(saved) => sync_autostart(app, saved.launch_at_login),
        Err(error) => eprintln!("[tokendash] Failed to toggle launch at login: {error}"),
    }
}

/// Forces the same fetches the background loops make, and tells an open panel
/// to reload its details too.
fn refresh_now(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(port) = handle.state::<crate::daemon::DaemonState>().port() else {
            return;
        };
        match crate::usage::fetch_today(port).await {
            Ok(totals) => update_usage(&handle, Some(totals)),
            Err(error) => {
                eprintln!("[tokendash] Failed to read today's usage: {error}");
                show_usage_error(&handle);
            }
        }
        let _ = crate::usage::warm_detail(port).await;
        popover::request_refresh(&handle);
    });
}

fn open_dashboard(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = crate::daemon::ensure_started(&handle).await;
        match result {
            Ok(port) => {
                if let Err(error) = open::that(format!("http://127.0.0.1:{port}/")) {
                    eprintln!("[tokendash] Failed to open dashboard: {error}");
                }
            }
            Err(error) => eprintln!("[tokendash] Dashboard unavailable: {error}"),
        }
    });
}
