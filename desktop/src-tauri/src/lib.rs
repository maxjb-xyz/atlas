//! Atlas for the desktop (VISION §21.10): the Atlas app in a window, a menu
//! bar item, and a node (§16.3) that offers this Mac's notifications, links
//! and, once turned on in Atlas, its shell. The first run pairs it: the app
//! asks Atlas for a code, shows it as a QR code, and the owner says yes
//! signed in, on their phone or in the browser.

mod config;
mod node;

use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

pub struct Shared {
    pub node: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    status: Mutex<Option<MenuItem<Wry>>>,
    pairing: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// The menu bar item's status line: Online, Offline, Not paired.
pub fn set_status(app: &AppHandle, text: &str) {
    if let Ok(slot) = app.state::<Shared>().status.lock() {
        if let Some(item) = slot.as_ref() {
            let _ = item.set_text(format!("Status: {text}"));
        }
    }
}

/// The setup window: this app's own pages, which pair it.
pub fn open_setup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("index.html".into()))
        .title("Pair Atlas")
        .inner_size(520.0, 640.0)
        .resizable(false)
        .build();
}

/// The Atlas window: the owner's own Atlas, as a web page. It has no access to this app's commands.
pub fn open_main(app: &AppHandle) {
    let Some(cfg) = config::load(app) else {
        return open_setup(app);
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Ok(url) = cfg.url.parse() else {
        return open_setup(app);
    };
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Atlas")
        .inner_size(1280.0, 860.0)
        .min_inner_size(400.0, 500.0)
        .build();
}

#[derive(Serialize)]
struct PairStart {
    code: String,
    link: String,
    qr: String,
    expires: i64,
}

/// Asks Atlas for a pairing code, and waits in the background for the owner's yes.
#[tauri::command]
async fn start_pairing(app: AppHandle, url: String) -> Result<PairStart, String> {
    let base = config::normalize(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(format!("{base}/nodes/pair/start"))
        .json(&json!({ "name": config::computer_name(), "kind": "desktop", "platform": config::platform() }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {base}: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or(json!({}));
    if !status.is_success() {
        return Err(format!(
            "{base} answered {}: {}",
            status.as_u16(),
            body["error"].as_str().unwrap_or(
                "not an Atlas pairing address. Check the address, and that Atlas is updated."
            )
        ));
    }
    let code = body["code"]
        .as_str()
        .ok_or("Atlas didn't send a code.")?
        .to_string();
    let link = body["link"]
        .as_str()
        .ok_or("Atlas didn't send a link.")?
        .to_string();
    let poll = body["poll"]
        .as_str()
        .ok_or("Atlas didn't send a poll secret.")?
        .to_string();
    let qr = qrcode::QrCode::new(link.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .build();

    let waiter = {
        let app = app.clone();
        let base = base.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let Ok(res) = client
                    .post(format!("{base}/nodes/pair/poll"))
                    .json(&json!({ "poll": poll }))
                    .send()
                    .await
                else {
                    continue;
                };
                let Ok(v) = res.json::<serde_json::Value>().await else {
                    continue;
                };
                match v["state"].as_str() {
                    Some("waiting") => continue,
                    Some("paired") => {
                        let cfg = config::Config {
                            url: base.clone(),
                            node_id: v["node_id"].as_str().unwrap_or("").into(),
                            token: v["token"].as_str().unwrap_or("").into(),
                            name: v["name"].as_str().unwrap_or("").into(),
                        };
                        if let Err(e) = config::save(&app, &cfg) {
                            let _ = app.emit("pair-error", e);
                            return;
                        }
                        let _ = app.emit("paired", cfg.name.clone());
                        node::start(&app, cfg);
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                        open_main(&app);
                        if let Some(w) = app.get_webview_window("setup") {
                            let _ = w.close();
                        }
                        return;
                    }
                    _ => {
                        let _ = app.emit("pair-expired", ());
                        return;
                    }
                }
            }
        })
    };
    if let Ok(mut slot) = app.state::<Shared>().pairing.lock() {
        if let Some(old) = slot.replace(waiter) {
            old.abort();
        }
    };
    Ok(PairStart {
        code,
        link,
        qr,
        expires: body["expires"].as_i64().unwrap_or(0),
    })
}

/// Opens the pairing link in the default browser, for saying yes on this Mac.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only web addresses open.".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// The address this app was last paired with, to fill in when pairing again.
#[tauri::command]
fn last_address(app: AppHandle) -> Option<String> {
    config::load(&app).map(|c| c.url)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shared {
            node: Mutex::new(None),
            status: Mutex::new(None),
            pairing: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            start_pairing,
            open_link,
            last_address
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let status = MenuItem::with_id(app, "status", "Status: Starting", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Atlas", true, None::<&str>)?;
            let pair = MenuItem::with_id(app, "pair", "Pair again…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Atlas", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&status, &sep, &open, &pair, &quit])?;
            if let Ok(mut slot) = app.state::<Shared>().status.lock() {
                *slot = Some(status);
            }
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("atlas")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Atlas")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "open" => open_main(app),
                    "pair" => {
                        if let Ok(mut slot) = app.state::<Shared>().node.lock() {
                            if let Some(n) = slot.take() {
                                n.abort();
                            }
                        }
                        set_status(app, "Not paired");
                        open_setup(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            match config::load(&handle) {
                Some(cfg) => {
                    node::start(&handle, cfg);
                    open_main(&handle);
                }
                None => {
                    set_status(&handle, "Not paired");
                    open_setup(&handle);
                }
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            // Closing the Atlas window keeps the node running in the menu bar.
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if w.label() == "main" {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Atlas couldn't start")
        .run(|app, e| {
            // Keep running in the menu bar with no window open; on macOS, clicking the Dock icon opens Atlas again.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &e {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = e {
                open_main(app);
            }
            let _ = app;
        });
}
