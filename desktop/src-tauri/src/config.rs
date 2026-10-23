//! Where this Mac is paired: the Atlas address, the node's id and its token,
//! kept in the app's own config folder. Removing the device in Atlas makes
//! the token stop working; the app then forgets it and asks to pair again.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    /// The Atlas address, like https://atlas.example.workers.dev, without a trailing slash.
    pub url: String,
    pub node_id: String,
    pub token: String,
    pub name: String,
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("atlas.json"))
}

pub fn load(app: &AppHandle) -> Option<Config> {
    let text = std::fs::read_to_string(path(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(app: &AppHandle, c: &Config) -> Result<(), String> {
    let p = path(app).ok_or("No config folder for the app.")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| format!("Couldn't save {}: {e}", p.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn clear(app: &AppHandle) {
    if let Some(p) = path(app) {
        let _ = std::fs::remove_file(p);
    }
}

/// An Atlas address as typed ("atlas.example.workers.dev/") made into https://atlas.example.workers.dev.
pub fn normalize(url: &str) -> Result<String, String> {
    let t = url.trim().trim_end_matches('/');
    let with_scheme = if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        format!("https://{t}")
    };
    let u = url::Url::parse(&with_scheme).map_err(|e| format!("That isn't an address: {e}"))?;
    let host = u.host_str().ok_or("That address has no host.")?;
    let local = host == "localhost" || host == "127.0.0.1";
    if u.scheme() != "https" && !local {
        return Err("Atlas's address starts with https://.".into());
    }
    Ok(format!(
        "{}://{}{}",
        u.scheme(),
        host,
        u.port().map(|p| format!(":{p}")).unwrap_or_default()
    ))
}

/// This Mac's name as people know it ("Max's MacBook Air"), or the host name.
pub fn computer_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This computer".into())
}

/// "macOS 15.1 (arm64)", or the OS and architecture.
pub fn platform() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
    {
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !v.is_empty() {
            return format!(
                "macOS {v} ({})",
                if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    std::env::consts::ARCH
                }
            );
        }
    }
    format!("{} ({})", std::env::consts::OS, std::env::consts::ARCH)
}
