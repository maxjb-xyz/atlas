//! The node (VISION §16.3): one outgoing WebSocket to the person agent,
//! which says what this Mac offers, sends events, and answers calls. It
//! reconnects by itself with a growing wait, and forgets the pairing when
//! Atlas says the device was removed. The protocol is in core/src/nodes.ts.

use crate::config::{self, Config};
use crate::Shared;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::HeaderValue, Error as WsError, Message,
};

/// What this Mac offers. Running a command is sensitive and acts, so it starts off and asks first (§12.1, §16.3).
fn hello() -> Value {
    json!({
        "type": "node.hello",
        "node": {
            "name": config::computer_name(),
            "kind": "desktop",
            "platform": config::platform(),
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": [
            {
                "name": "notify",
                "description": "Show a notification on this Mac, with a title and a line of text.",
                "input": { "type": "object", "properties": { "title": { "type": "string" }, "text": { "type": "string" } }, "required": ["text"] },
                "sensitive": false,
                "acts": false
            },
            {
                "name": "open_url",
                "description": "Open a web page in this Mac's default browser. The browser loads it, so it asks first.",
                "input": { "type": "object", "properties": { "url": { "type": "string", "description": "An https:// address." } }, "required": ["url"] },
                "sensitive": false,
                "acts": true
            },
            {
                "name": "run_command",
                "description": "Run a shell command on this Mac (zsh, in the home folder) and return its exit code and what it printed, up to 20,000 characters.",
                "input": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "timeout_s": { "type": "integer", "minimum": 1, "maximum": 300 }
                    },
                    "required": ["command"]
                },
                "sensitive": true,
                "acts": true
            }
        ],
        "events": [
            { "name": "idle", "description": "Whether someone is at this Mac: \"at the Mac\", or \"away\" after five minutes without input." }
        ]
    })
}

fn ws_url(base: &str) -> String {
    let rest = base
        .strip_prefix("https://")
        .map(|r| format!("wss://{r}"))
        .or_else(|| base.strip_prefix("http://").map(|r| format!("ws://{r}")));
    format!("{}/nodes/connect", rest.unwrap_or_else(|| base.to_string()))
}

/// Runs until the pairing is removed. Never returns early otherwise: a dropped connection is tried again.
pub async fn run(app: AppHandle, cfg: Config) {
    let mut wait = 1u64;
    loop {
        crate::set_status(&app, "Connecting");
        match session(&app, &cfg).await {
            Ok(Ended::Unpaired) => {
                config::clear(&app);
                crate::set_status(&app, "Not paired");
                let _ = app.emit("unpaired", ());
                crate::open_setup(&app);
                return;
            }
            Ok(Ended::Closed) => wait = 1,
            Err(e) => eprintln!("atlas node: {e}"),
        }
        crate::set_status(&app, "Offline, trying again");
        tokio::time::sleep(Duration::from_secs(wait)).await;
        wait = (wait * 2).min(60);
    }
}

enum Ended {
    Closed,
    Unpaired,
}

async fn session(app: &AppHandle, cfg: &Config) -> Result<Ended, String> {
    let mut req = ws_url(&cfg.url)
        .into_client_request()
        .map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", cfg.token)).map_err(|e| e.to_string())?,
    );
    let (ws, _) = match tokio_tungstenite::connect_async(req).await {
        Ok(x) => x,
        Err(WsError::Http(res)) if res.status().as_u16() == 401 => return Ok(Ended::Unpaired),
        Err(e) => return Err(format!("couldn't connect to {}: {e}", cfg.url)),
    };
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let allowed: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    tx.send(hello()).ok();
    crate::set_status(app, "Online");

    // Everything to Atlas goes through one writer.
    let writer = tokio::spawn(async move {
        while let Some(v) = rx.recv().await {
            if sink
                .send(Message::Text(v.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let pinger = {
        let tx = tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if tx.send(json!({ "type": "node.ping" })).is_err() {
                    break;
                }
            }
        })
    };
    let idler = tokio::spawn(idle_events(tx.clone()));
    // If this session is dropped (Pair again aborts it), its writer, pinger and idle watcher stop with it,
    // so the old socket doesn't linger and keep pinging.
    let _tasks = Tasks(vec![writer, pinger, idler]);

    let mut ended = Ended::Closed;
    while let Some(msg) = stream.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t.to_string(),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let Ok(m) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        match m["type"].as_str().unwrap_or("") {
            "node.welcome" | "node.allowed" => {
                if let Some(map) = m["allowed"].as_object() {
                    let mut a = allowed.lock().await;
                    a.clear();
                    for (k, v) in map {
                        a.insert(k.clone(), v.as_bool().unwrap_or(false));
                    }
                }
            }
            "node.call" => {
                let (id, tool, input) = (
                    m["id"].as_str().unwrap_or("").to_string(),
                    m["tool"].as_str().unwrap_or("").to_string(),
                    m["input"].clone(),
                );
                let (app, tx, allowed) = (app.clone(), tx.clone(), allowed.clone());
                tokio::spawn(async move {
                    // The device checks too: a capability turned off in Atlas isn't run, whatever arrives.
                    let on = allowed.lock().await.get(&tool).copied().unwrap_or(false);
                    let out = if on {
                        call(&app, &tool, &input).await
                    } else {
                        Err(format!("{tool} is turned off for this Mac in Atlas."))
                    };
                    let reply = match out {
                        Ok(o) => {
                            json!({ "type": "node.result", "id": id, "ok": true, "output": o })
                        }
                        Err(e) => {
                            json!({ "type": "node.result", "id": id, "ok": false, "error": e })
                        }
                    };
                    tx.send(reply).ok();
                });
            }
            "node.unpaired" => {
                ended = Ended::Unpaired;
                break;
            }
            _ => {}
        }
    }
    drop(tx);
    Ok(ended)
}

/// Tasks that end when their session does, however it ends.
struct Tasks(Vec<tokio::task::JoinHandle<()>>);

impl Drop for Tasks {
    fn drop(&mut self) {
        for t in &self.0 {
            t.abort();
        }
    }
}

/// Says when someone sits down at the Mac or walks away (five minutes without input), on change only.
async fn idle_events(tx: mpsc::UnboundedSender<Value>) {
    #[cfg(target_os = "macos")]
    {
        let mut last: Option<bool> = None;
        loop {
            if let Ok(idle) = user_idle::UserIdle::get_time() {
                let away = idle.as_seconds() >= 300;
                if last != Some(away) {
                    last = Some(away);
                    let value = if away { "away" } else { "at the Mac" };
                    if tx.send(json!({ "type": "node.event", "event": "idle", "body": { "value": value } })).is_err() {
                        return;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = tx;
        std::future::pending::<()>().await;
    }
}

async fn call(app: &AppHandle, tool: &str, input: &Value) -> Result<String, String> {
    match tool {
        "notify" => {
            let text = input["text"].as_str().ok_or("notify needs text.")?;
            let title = input["title"].as_str().unwrap_or("Atlas");
            app.notification()
                .builder()
                .title(title)
                .body(text)
                .show()
                .map_err(|e| format!("macOS didn't show it: {e}"))?;
            Ok("Shown.".into())
        }
        "open_url" => {
            let url = input["url"].as_str().ok_or("open_url needs a url.")?;
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err("Only web addresses (https://) open.".into());
            }
            tauri_plugin_opener::open_url(url, None::<&str>)
                .map_err(|e| format!("Couldn't open it: {e}"))?;
            Ok(format!("Opened {url}."))
        }
        "run_command" => {
            let command = input["command"]
                .as_str()
                .ok_or("run_command needs a command.")?;
            let secs = input["timeout_s"].as_u64().unwrap_or(60).clamp(1, 300);
            let home = app.path().home_dir().map_err(|e| e.to_string())?;
            let run = tokio::process::Command::new(if cfg!(target_os = "macos") {
                "/bin/zsh"
            } else {
                "/bin/sh"
            })
            .arg("-lc")
            .arg(command)
            .current_dir(home)
            .kill_on_drop(true)
            .output();
            let out = tokio::time::timeout(Duration::from_secs(secs), run)
                .await
                .map_err(|_| format!("It ran past {secs} s and was stopped."))?
                .map_err(|e| format!("It didn't start: {e}"))?;
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                text.push_str(&format!("\n[stderr]\n{err}"));
            }
            if text.chars().count() > 20_000 {
                text = format!(
                    "{}\n… (cut at 20,000 characters)",
                    text.chars().take(20_000).collect::<String>()
                );
            }
            Ok(format!(
                "exit {}\n{}",
                out.status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "?".into()),
                text.trim_end()
            ))
        }
        _ => Err(format!("This Mac has no tool called {tool}.")),
    }
}

/// Keeps the node's task, so pairing again or quitting can stop it.
pub fn start(app: &AppHandle, cfg: Config) {
    let shared = app.state::<Shared>();
    let handle = tauri::async_runtime::spawn(run(app.clone(), cfg));
    if let Ok(mut slot) = shared.node.lock() {
        if let Some(old) = slot.replace(handle) {
            old.abort();
        }
    };
}
