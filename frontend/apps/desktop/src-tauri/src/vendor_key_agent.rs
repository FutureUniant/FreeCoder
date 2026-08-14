//! Semi-automatic vendor API key capture via Playwright (in-app agent).
//! Lives under `src/vendor-key-agent/` next to the desktop UI code.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Platforms exposed to the UI (volcengine intentionally omitted).
const SUPPORTED_PLATFORMS: &[&str] = &["deepseek", "bailian"];

/// Windows canonicalize may add a `\\?\` prefix that Node/Playwright cannot handle.
fn normalize_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn resolve_existing(path: PathBuf) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or(path);
    normalize_path(canonical)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInfo {
    pub id: String,
    pub name: String,
}

#[derive(Default)]
pub struct VendorKeyAgentState {
    pub child: Mutex<Option<Child>>,
    pub stdin: Mutex<Option<ChildStdin>>,
    pub platform: Mutex<Option<String>>,
    pub run_id: AtomicU64,
    /// Latest API key from the agent (memory + temp file for GUI polling).
    pub last_key: Mutex<Option<String>>,
}

fn key_file_path() -> PathBuf {
    std::env::temp_dir().join("grokx-vendor-key-last.txt")
}

fn clear_extracted_key(state: &VendorKeyAgentState) {
    if let Ok(mut g) = state.last_key.lock() {
        *g = None;
    }
    let _ = std::fs::remove_file(key_file_path());
}

fn agent_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let p = manifest.join("../src/vendor-key-agent/src/index.js");
        if p.exists() {
            return Ok(resolve_existing(p));
        }
        Err(format!(
            "dev: missing src/vendor-key-agent/src/index.js (expected {}). Run: pnpm setup:api-key",
            p.display()
        ))
    }

    #[cfg(not(debug_assertions))]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().ok_or("cannot locate executable directory")?;
        let name = if cfg!(target_os = "windows") {
            "vendor-key-agent.exe"
        } else {
            "vendor-key-agent"
        };
        let p = dir.join(name);
        if p.exists() {
            Ok(resolve_existing(p))
        } else {
            let p2 = dir.join("binaries").join(name);
            if p2.exists() {
                Ok(resolve_existing(p2))
            } else if let Ok(resource) = app.path().resource_dir() {
                let script = resource
                    .join("vendor-key-agent")
                    .join("src")
                    .join("index.js");
                if script.exists() {
                    Ok(normalize_path(script))
                } else {
                    Err(format!("vendor-key-agent not found: {}", p.display()))
                }
            } else {
                Err(format!("vendor-key-agent not found: {}", p.display()))
            }
        }
    }
}

fn flows_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let p = manifest.join("../src/vendor-key-agent/flows");
        if p.exists() {
            return Ok(resolve_existing(p));
        }
    }
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
    let p = resource.join("flows");
    if p.exists() {
        Ok(normalize_path(p))
    } else {
        Err(format!("flows dir not found: {}", p.display()))
    }
}

fn browsers_path_populated(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    for ent in entries.flatten() {
        let name = ent.file_name().to_string_lossy().to_lowercase();
        if name.starts_with("chromium") || name.starts_with("chrome") {
            return true;
        }
    }
    false
}

fn browsers_path(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let p = manifest.join("../ms-playwright");
        if p.exists() && browsers_path_populated(&p) {
            return Some(resolve_existing(p));
        }
    }

    if let Ok(resource) = app.path().resource_dir() {
        let p = resource.join("ms-playwright");
        if p.exists() && browsers_path_populated(&p) {
            return Some(normalize_path(p));
        }
    }

    if let Ok(p) = std::env::var("PLAYWRIGHT_BROWSERS_PATH") {
        let path = PathBuf::from(p);
        if path.exists() && browsers_path_populated(&path) {
            return Some(normalize_path(path));
        }
    }

    let _ = app;
    None
}

fn agent_workdir(script_or_bin: &Path) -> PathBuf {
    // .../vendor-key-agent/src/index.js -> .../vendor-key-agent/
    if let Some(src) = script_or_bin.parent() {
        if src.file_name().and_then(|s| s.to_str()) == Some("src") {
            if let Some(agent_dir) = src.parent() {
                return agent_dir.to_path_buf();
            }
        }
    }
    script_or_bin
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn emit_event(app: &AppHandle, payload: Value) {
    let _ = app.emit("sidecar-event", &payload);
    let _ = app.emit_to("main", "sidecar-event", &payload);
}

fn list_platforms_from_disk(app: &AppHandle) -> Result<Vec<PlatformInfo>, String> {
    let dir = flows_dir(app)?;
    let mut list = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("yaml") {
            continue;
        }
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        let mut name = id.clone();
        for line in content.lines() {
            if let Some(v) = line.strip_prefix("id:") {
                id = v.trim().to_string();
            }
            if let Some(v) = line.strip_prefix("name:") {
                name = v.trim().to_string();
            }
        }
        if !SUPPORTED_PLATFORMS.contains(&id.as_str()) {
            continue;
        }
        list.push(PlatformInfo { id, name });
    }
    list.sort_by(|a, b| a.id.cmp(&b.id));
    if list.is_empty() {
        return Ok(vec![
            PlatformInfo {
                id: "bailian".into(),
                name: "Aliyun Bailian".into(),
            },
            PlatformInfo {
                id: "deepseek".into(),
                name: "DeepSeek".into(),
            },
        ]);
    }
    Ok(list)
}

fn start_agent(
    app: AppHandle,
    state: &VendorKeyAgentState,
    platform: &str,
) -> Result<(), String> {
    if !SUPPORTED_PLATFORMS.contains(&platform) {
        return Err(format!(
            "unsupported platform: {platform} (deepseek / bailian only)"
        ));
    }

    stop_agent(state);
    clear_extracted_key(state);

    let run_id = state.run_id.fetch_add(1, Ordering::SeqCst) + 1;

    let script_or_bin = agent_script_path(&app)?;
    let flows = flows_dir(&app)?;
    let workdir = agent_workdir(&script_or_bin);
    let key_file = key_file_path();
    let export_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("vendor-key-exports");
    std::fs::create_dir_all(&export_dir)
        .map_err(|e| format!("cannot create export dir {}: {e}", export_dir.display()))?;

    let is_js = script_or_bin
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| e.eq_ignore_ascii_case("js"))
        .unwrap_or(false);

    let mut cmd = if is_js || cfg!(debug_assertions) {
        let mut c = Command::new("node");
        c.arg(&script_or_bin).arg("--platform").arg(platform);
        c
    } else {
        let mut c = Command::new(&script_or_bin);
        c.arg("--platform").arg(platform);
        c
    };

    cmd.current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GETKEY_FLOWS_DIR", &flows)
        .env("GETKEY_KEY_FILE", &key_file)
        .env("GETKEY_EXPORT_DIR", &export_dir);

    if let Some(bp) = browsers_path(&app) {
        cmd.env("PLAYWRIGHT_BROWSERS_PATH", bp);
    }

    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    emit_event(
        &app,
        serde_json::json!({
            "type": "status",
            "step": "init",
            "message": format!("starting vendor-key-agent ({})", script_or_bin.display()),
            "runId": run_id,
        }),
    );

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "failed to start vendor-key-agent: {e} (need Node.js; run pnpm setup:api-key)"
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or("cannot take vendor-key-agent stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("cannot take vendor-key-agent stderr")?;
    let stdin = child
        .stdin
        .take()
        .ok_or("cannot take vendor-key-agent stdin")?;

    {
        let mut s = state.stdin.lock().map_err(|e| e.to_string())?;
        *s = Some(stdin);
    }
    {
        let mut p = state.platform.lock().map_err(|e| e.to_string())?;
        *p = Some(platform.to_string());
    }
    {
        let mut c = state.child.lock().map_err(|e| e.to_string())?;
        *c = Some(child);
    }

    let app_out = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(mut v) => {
                    if let Some(key) = v.get("key").and_then(|k| k.as_str()) {
                        let key = key.trim();
                        if key.starts_with("sk-") && key.len() >= 16 {
                            let _ = std::fs::write(key_file_path(), key);
                            emit_event(
                                &app_out,
                                serde_json::json!({
                                    "type": "key_extracted",
                                    "key": key,
                                    "message": format!("received API key (len {}), filling UI", key.len()),
                                    "runId": run_id,
                                }),
                            );
                        }
                    }
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("runId".into(), serde_json::json!(run_id));
                    }
                    emit_event(&app_out, v);
                }
                Err(_) => {
                    if let Some(start) = trimmed.find("sk-") {
                        let cand: String = trimmed[start..]
                            .chars()
                            .take_while(|c| {
                                c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.'
                            })
                            .collect();
                        if cand.len() >= 16 {
                            let _ = std::fs::write(key_file_path(), &cand);
                            emit_event(
                                &app_out,
                                serde_json::json!({
                                    "type": "key_extracted",
                                    "key": cand,
                                    "message": "parsed API key from log line",
                                    "runId": run_id,
                                }),
                            );
                        }
                    }
                    emit_event(
                        &app_out,
                        serde_json::json!({ "type": "log", "message": trimmed, "runId": run_id }),
                    );
                }
            }
        }
        emit_event(
            &app_out,
            serde_json::json!({ "type": "sidecar_exited", "runId": run_id }),
        );
    });

    let app_err = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            emit_event(
                &app_err,
                serde_json::json!({
                    "type": "log",
                    "level": "stderr",
                    "message": line,
                    "runId": run_id
                }),
            );
        }
    });

    Ok(())
}

fn write_command(state: &VendorKeyAgentState, cmd: Value) -> Result<(), String> {
    let mut stdin = state.stdin.lock().map_err(|e| e.to_string())?;
    let Some(ref mut s) = *stdin else {
        return Err("vendor-key-agent is not running".into());
    };
    let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())? + "\n";
    s.write_all(line.as_bytes())
        .map_err(|e| format!("write vendor-key-agent failed: {e}"))?;
    s.flush()
        .map_err(|e| format!("flush vendor-key-agent failed: {e}"))?;
    Ok(())
}

fn stop_agent(state: &VendorKeyAgentState) {
    let _ = write_command(state, serde_json::json!({ "type": "cancel" }));

    if let Ok(mut guard) = state.child.lock() {
        if let Some(ref mut child) = *guard {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
    if let Ok(mut s) = state.stdin.lock() {
        *s = None;
    }
    if let Ok(mut p) = state.platform.lock() {
        *p = None;
    }
}

#[tauri::command]
pub fn list_getkey_platforms(app: AppHandle) -> Result<Vec<PlatformInfo>, String> {
    list_platforms_from_disk(&app)
}

#[tauri::command]
pub fn start_get_key(
    app: AppHandle,
    state: State<'_, VendorKeyAgentState>,
    platform: String,
) -> Result<(), String> {
    start_agent(app, &state, &platform)
}

#[tauri::command]
pub fn continue_get_key(
    app: AppHandle,
    state: State<'_, VendorKeyAgentState>,
) -> Result<(), String> {
    write_command(&state, serde_json::json!({ "type": "continue" }))?;
    emit_event(
        &app,
        serde_json::json!({
            "type": "status",
            "step": "user_action",
            "message": "continue sent ? creating and extracting API key?",
        }),
    );
    Ok(())
}

#[tauri::command]
pub fn cancel_get_key(state: State<'_, VendorKeyAgentState>) -> Result<(), String> {
    stop_agent(&state);
    Ok(())
}

#[tauri::command]
pub fn mask_getkey(key: String) -> String {
    let key = key.trim();
    if key.len() < 16 {
        return format!("(incomplete, {} chars) {}", key.len(), key);
    }
    format!("{}...{}", &key[..7], &key[key.len() - 4..])
}

#[tauri::command]
pub fn poll_extracted_key(state: State<'_, VendorKeyAgentState>) -> Option<String> {
    if let Ok(g) = state.last_key.lock() {
        if let Some(ref k) = *g {
            if k.starts_with("sk-") && k.len() >= 16 {
                return Some(k.clone());
            }
        }
    }
    let path = key_file_path();
    let content = std::fs::read_to_string(&path).ok()?;
    let key = content.trim().to_string();
    if key.starts_with("sk-") && key.len() >= 16 {
        if let Ok(mut g) = state.last_key.lock() {
            *g = Some(key.clone());
        }
        Some(key)
    } else {
        None
    }
}

#[tauri::command]
pub fn read_clipboard_text() -> Result<Option<String>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    match clipboard.get_text() {
        Ok(t) => {
            let t = t.trim().to_string();
            if t.is_empty() {
                Ok(None)
            } else {
                Ok(Some(t))
            }
        }
        Err(_) => Ok(None),
    }
}
