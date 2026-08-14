//! Product dependency downloads: Bonsai GGUF, llama/CUDA runtime zips, grok.exe.
//!
//! URLs come from [`app_config::DependencyDownloadSettings`] (CN + international).
//! Hosts without an NVIDIA GPU ≥8 GB do not list or download Bonsai / llama.cpp.
//! `grok.exe` is packed as a zip by `release/pack.bat` → `Pack-Grok.ps1` and
//! extracted into `{install}/resources/runtime/` on download.
//! Progress is emitted as Tauri events (`dependency-progress`) for the Settings UI.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use app_config::{
    AppPaths, CnAccelerationSettings, DependencyDownloadSettings, UserSettings,
};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{info, warn};

pub const PROGRESS_EVENT: &str = "dependency-progress";

pub const ID_BONSAI_MODEL: &str = "bonsai-model";
pub const ID_BONSAI_MMPROJ: &str = "bonsai-mmproj";
pub const ID_LLAMA_RUNTIME: &str = "llama-runtime";
pub const ID_GROK_EXE: &str = "grok-exe";

const MODEL_FILE: &str = "Bonsai-27B-Q1_0.gguf";
const MMPROJ_FILE: &str = "Bonsai-27B-mmproj-Q8_0.gguf";
const LLAMA_SERVER_EXE: &str = "llama-server.exe";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DepState {
    Missing,
    Downloading,
    Paused,
    Ready,
    Error,
    /// No download URL configured for the active region (e.g. CN runtime 留白).
    Unavailable,
}

#[derive(Debug)]
enum DlOutcome {
    Done,
    Paused { bytes_done: u64, bytes_total: Option<u64> },
}

#[derive(Debug, Clone, Serialize)]
pub struct DepItemStatus {
    pub id: String,
    pub title: String,
    pub description: String,
    pub state: DepState,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub percent: Option<f32>,
    pub message: String,
    pub local_path: String,
    pub resolved_url: String,
    pub size_on_disk: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DependenciesCatalog {
    pub prefer_cn: bool,
    pub auto_download_on_startup: bool,
    pub use_cn_sources: Option<bool>,
    pub deps_dir: String,
    pub config: DependencyDownloadSettings,
    pub items: Vec<DepItemStatus>,
    /// One active download URL per file for the current environment (editable).
    pub active_urls: Vec<ActiveDownloadUrl>,
    /// True when this PC cannot run local Bonsai (no NVIDIA GPU or VRAM &lt; 8 GB).
    /// Bonsai GGUF / llama.cpp items are omitted from `items` and `active_urls`.
    pub local_llm_blocked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveDownloadUrl {
    /// Stable key: bonsai-model | bonsai-mmproj | llama-runtime-zip | llama-cpu-runtime-zip | cudart-zip | grok-exe
    pub id: String,
    pub title: String,
    /// Raw configured URL currently in use (before GitHub proxy rewrite).
    pub url: String,
    /// True when this value is stored in the CN slot.
    pub from_cn: bool,
    /// Related dependency item id for restart (e.g. llama-runtime).
    pub dep_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DepProgressEvent {
    pub id: String,
    pub state: DepState,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub percent: Option<f32>,
    pub message: String,
}

#[derive(Debug, Clone)]
struct LiveProgress {
    bytes_done: u64,
    bytes_total: Option<u64>,
    message: String,
    state: DepState,
}

impl Default for LiveProgress {
    fn default() -> Self {
        Self {
            bytes_done: 0,
            bytes_total: None,
            message: String::new(),
            state: DepState::Missing,
        }
    }
}

pub struct DependencyManager {
    live: Mutex<std::collections::HashMap<String, LiveProgress>>,
    /// Prevent concurrent downloads of the same id.
    inflight: Mutex<std::collections::HashSet<String>>,
    /// Ids that should pause at the next chunk boundary.
    pause_requests: Mutex<std::collections::HashSet<String>>,
}

impl Default for DependencyManager {
    fn default() -> Self {
        Self {
            live: Mutex::new(std::collections::HashMap::new()),
            inflight: Mutex::new(std::collections::HashSet::new()),
            pause_requests: Mutex::new(std::collections::HashSet::new()),
        }
    }
}

impl DependencyManager {
    fn request_pause(&self, id: &str) {
        self.pause_requests.lock().insert(id.to_string());
    }

    fn clear_pause_request(&self, id: &str) {
        self.pause_requests.lock().remove(id);
    }

    fn take_pause_request(&self, id: &str) -> bool {
        self.pause_requests.lock().remove(id)
    }
}

fn load_settings() -> UserSettings {
    AppPaths::discover()
        .ok()
        .and_then(|p| UserSettings::load(&p.config_file).ok())
        .unwrap_or_default()
}

fn paths_or_err() -> Result<AppPaths, String> {
    let p = AppPaths::discover().map_err(|e| e.to_string())?;
    p.ensure_dirs().map_err(|e| e.to_string())?;
    Ok(p)
}

fn save_settings(settings: &UserSettings) -> Result<(), String> {
    let paths = paths_or_err()?;
    settings
        .save(&paths.config_file)
        .map_err(|e| e.to_string())
}

fn set_user_paused_persist(id: &str, paused: bool) -> Result<(), String> {
    let mut settings = load_settings();
    settings.dependency_downloads.set_user_paused(id, paused);
    save_settings(&settings)
}

/// Release builds require downloading grok.exe when missing. Dev builds use bundled/PATH.
fn require_grok_download() -> bool {
    !cfg!(debug_assertions)
}

async fn network_seems_online() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .user_agent("FreeCoder/1.0")
        .build()
    else {
        return false;
    };
    // Light probes — any success means we can attempt dependency downloads.
    let probes = [
        "https://modelscope.cn",
        "https://huggingface.co",
        "https://github.com",
    ];
    for url in probes {
        if let Ok(resp) = client.head(url).send().await {
            if resp.status().is_success() || resp.status().is_redirection() {
                return true;
            }
        }
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() || resp.status().is_redirection() {
                return true;
            }
        }
    }
    false
}

fn model_path(paths: &AppPaths) -> PathBuf {
    paths.llama_runtime_deps_dir().join("models").join(MODEL_FILE)
}

fn mmproj_path(paths: &AppPaths) -> PathBuf {
    paths
        .llama_runtime_deps_dir()
        .join("models")
        .join(MMPROJ_FILE)
}

fn llama_server_path(paths: &AppPaths) -> PathBuf {
    paths.llama_runtime_deps_dir().join(LLAMA_SERVER_EXE)
}

fn runtime_payload_ready(paths: &AppPaths) -> bool {
    llm_runtime::runtime_binaries_ready(&paths.llama_runtime_deps_dir())
}

fn is_local_bonsai_dep(id: &str) -> bool {
    matches!(id, ID_BONSAI_MODEL | ID_BONSAI_MMPROJ | ID_LLAMA_RUNTIME)
}

/// GGUF + llama-server + CUDA redistributable are all present and not truncated.
pub fn local_llm_files_on_disk() -> bool {
    if !llm_runtime::host_supports_local_bonsai() {
        return false;
    }
    let Ok(paths) = paths_or_err() else {
        return false;
    };
    is_ready_file(&model_path(&paths))
        && is_ready_file(&mmproj_path(&paths))
        && runtime_payload_ready(&paths)
}

fn file_size(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| m.len())
}

fn is_ready_file(path: &Path) -> bool {
    path.is_file() && file_size(path).unwrap_or(0) > 0
}

/// grok is usable only after the release zip is extracted (or a raw PE is in place).
fn grok_exe_is_usable(path: &Path) -> bool {
    if !is_ready_file(path) || is_zip_file(path) {
        return false;
    }
    #[cfg(windows)]
    {
        is_pe_file(path)
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn grok_staging_dir(dest: &Path) -> PathBuf {
    dest.parent()
        .unwrap_or_else(|| Path::new("."))
        .join("_staging_grok")
}

fn percent(done: u64, total: Option<u64>) -> Option<f32> {
    let t = total.filter(|n| *n > 0)?;
    Some(((done as f64 / t as f64) * 100.0).clamp(0.0, 100.0) as f32)
}

fn emit_progress(app: &AppHandle, mgr: &DependencyManager, id: &str, ev: DepProgressEvent) {
    {
        let mut map = mgr.live.lock();
        let entry = map.entry(id.to_string()).or_default();
        entry.bytes_done = ev.bytes_done;
        entry.bytes_total = ev.bytes_total;
        entry.message = ev.message.clone();
        entry.state = ev.state.clone();
    }
    let _ = app.emit(PROGRESS_EVENT, &ev);
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .cookie_store(true)
        .timeout(Duration::from_secs(60 * 60))
        .connect_timeout(Duration::from_secs(30))
        .user_agent("FreeCoder/1.0 (dependency-downloader)")
        .redirect(reqwest::redirect::Policy::limited(12))
        .build()
        .map_err(|e| e.to_string())
}

/// Resolve a configured URL. GitHub proxy applies only when the **CN slot** was chosen.
fn resolve_url(raw: &str, cn: &CnAccelerationSettings, from_cn_slot: bool) -> String {
    let normalized = DependencyDownloadSettings::normalize_download_url(raw);
    if normalized.is_empty() {
        return String::new();
    }
    if from_cn_slot {
        return cn.proxied_github_url(&normalized);
    }
    normalized
}

fn pick_resolved(
    deps: &DependencyDownloadSettings,
    cn: &CnAccelerationSettings,
    prefer_cn: bool,
    pick: impl FnOnce(&DependencyDownloadSettings, bool) -> (&str, bool),
) -> String {
    let (raw, from_cn) = pick(deps, prefer_cn);
    resolve_url(raw, cn, from_cn)
}

fn partial_path(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.download.partial", dest.display()))
}

fn partial_size(dest: &Path) -> u64 {
    file_size(&partial_path(dest)).unwrap_or(0)
}

fn build_item(
    id: &str,
    title: &str,
    description: &str,
    path: &Path,
    url: &str,
    mgr: &DependencyManager,
    user_paused: bool,
) -> DepItemStatus {
    let live = mgr.live.lock().get(id).cloned();
    let on_disk = is_ready_file(path);
    let partial_bytes = partial_size(path);
    let (state, bytes_done, bytes_total, message) = if let Some(live) = live {
        if live.state == DepState::Downloading {
            (
                DepState::Downloading,
                live.bytes_done,
                live.bytes_total,
                live.message,
            )
        } else if live.state == DepState::Paused || user_paused {
            (
                DepState::Paused,
                live.bytes_done.max(partial_bytes),
                live.bytes_total,
                if live.message.is_empty() {
                    "Paused by user".into()
                } else {
                    live.message
                },
            )
        } else if live.state == DepState::Error && !on_disk {
            (DepState::Error, live.bytes_done, live.bytes_total, live.message)
        } else if on_disk {
            (DepState::Ready, 0, None, String::new())
        } else if url.trim().is_empty() {
            (
                DepState::Unavailable,
                0,
                None,
                "No download URL configured for this region".into(),
            )
        } else if partial_bytes > 0 {
            // Incomplete file without an explicit user pause → treat as missing so auto-download resumes.
            (DepState::Missing, partial_bytes, None, "Incomplete — will resume".into())
        } else {
            (DepState::Missing, 0, None, String::new())
        }
    } else if on_disk {
        (DepState::Ready, 0, None, String::new())
    } else if user_paused {
        (
            DepState::Paused,
            partial_bytes,
            None,
            "Paused by user".into(),
        )
    } else if url.trim().is_empty() {
        (
            DepState::Unavailable,
            0,
            None,
            "No download URL configured for this region".into(),
        )
    } else if partial_bytes > 0 {
        (DepState::Missing, partial_bytes, None, "Incomplete — will resume".into())
    } else {
        (DepState::Missing, 0, None, String::new())
    };

    DepItemStatus {
        id: id.into(),
        title: title.into(),
        description: description.into(),
        state,
        bytes_done,
        bytes_total,
        percent: percent(bytes_done, bytes_total),
        message,
        local_path: path.display().to_string(),
        resolved_url: url.to_string(),
        size_on_disk: file_size(path).or_else(|| {
            if partial_bytes > 0 {
                Some(partial_bytes)
            } else {
                None
            }
        }),
    }
}

fn catalog_from(settings: &UserSettings, mgr: &DependencyManager) -> Result<DependenciesCatalog, String> {
    let paths = paths_or_err()?;
    let deps = &settings.dependency_downloads;
    let prefer_cn = deps.prefer_cn(settings.cn_acceleration.enabled);
    let cn = &settings.cn_acceleration;

    let model_url = pick_resolved(deps, cn, prefer_cn, DependencyDownloadSettings::bonsai_model_url);
    let mmproj_url =
        pick_resolved(deps, cn, prefer_cn, DependencyDownloadSettings::bonsai_mmproj_url);
    let llama_url =
        pick_resolved(deps, cn, prefer_cn, DependencyDownloadSettings::llama_runtime_zip_url);
    let llama_cpu_url = pick_resolved(
        deps,
        cn,
        prefer_cn,
        DependencyDownloadSettings::llama_cpu_runtime_zip_url,
    );
    let cudart_url =
        pick_resolved(deps, cn, prefer_cn, DependencyDownloadSettings::cudart_zip_url);
    let grok_url = pick_resolved(deps, cn, prefer_cn, DependencyDownloadSettings::grok_exe_url);

    let supports_local = llm_runtime::host_supports_local_bonsai();
    let wants_cpu = llm_runtime::host_wants_cpu_runtime();
    let runtime_url_display = if wants_cpu {
        llama_cpu_url.clone()
    } else if llama_url.is_empty() && cudart_url.is_empty() {
        String::new()
    } else if !llama_url.is_empty() && !cudart_url.is_empty() {
        format!("{llama_url}\n{cudart_url}")
    } else if !llama_url.is_empty() {
        llama_url.clone()
    } else {
        cudart_url.clone()
    };

    // No NVIDIA GPU / VRAM < 8GB: do not list Bonsai GGUF or llama.cpp at all.
    let mut items = Vec::new();
    if supports_local {
        items.push(build_item(
            ID_BONSAI_MODEL,
            "Bonsai 27B (Q1_0)",
            "Bundled local model weights (GGUF)",
            &model_path(&paths),
            &model_url,
            mgr,
            deps.is_user_paused(ID_BONSAI_MODEL),
        ));
        items.push(build_item(
            ID_BONSAI_MMPROJ,
            "Bonsai vision projector",
            "mmproj GGUF required for local vision",
            &mmproj_path(&paths),
            &mmproj_url,
            mgr,
            deps.is_user_paused(ID_BONSAI_MMPROJ),
        ));
        items.push(build_item(
            ID_LLAMA_RUNTIME,
            if wants_cpu {
                "Bonsai runtime (CPU)"
            } else {
                "Bonsai runtime (CUDA)"
            },
            if wants_cpu {
                "llama-server CPU build (no GPU or VRAM under 8GB)"
            } else {
                "llama-server + CUDA redistributable (zip)"
            },
            &llama_server_path(&paths),
            &runtime_url_display,
            mgr,
            deps.is_user_paused(ID_LLAMA_RUNTIME),
        ));
    }
    items.push(build_item(
        ID_GROK_EXE,
        "grok.exe",
        if require_grok_download() {
            "Agent engine zip — extracted to resources/runtime/"
        } else {
            "Agent engine (dev build — download not required)"
        },
        &paths.downloaded_grok_exe(),
        &grok_url,
        mgr,
        deps.is_user_paused(ID_GROK_EXE),
    ));

    // Dev builds: do not require / auto-check grok.exe download.
    if !require_grok_download() {
        if let Some(item) = items.iter_mut().find(|i| i.id == ID_GROK_EXE) {
            if item.state != DepState::Ready && item.state != DepState::Downloading {
                item.state = DepState::Ready;
                item.message = "Dev build — using bundled/PATH grok".into();
                item.percent = Some(100.0);
            }
        }
    }

    // Runtime zips stage under `_staging_runtime/` (CUDA) or `_staging_runtime_cpu/`.
    if let Some(item) = items.iter_mut().find(|i| i.id == ID_LLAMA_RUNTIME) {
        let payload_ok = runtime_payload_ready(&paths);
        if !payload_ok && item.state == DepState::Ready {
            item.state = DepState::Missing;
            let missing = if wants_cpu {
                llm_runtime::missing_cpu_runtime_binaries(&paths.llama_cpu_runtime_deps_dir())
            } else {
                llm_runtime::missing_runtime_binaries(&paths.llama_runtime_deps_dir())
            };
            item.message = if missing.is_empty() {
                if wants_cpu {
                    "Incomplete CPU runtime — llama-server.exe missing".into()
                } else {
                    "Incomplete runtime — CUDA DLLs missing or truncated".into()
                }
            } else {
                format!("Incomplete runtime: {}", missing.join(", "))
            };
            item.percent = None;
        }
        if item.state == DepState::Missing || item.state == DepState::Paused {
            let staging_name = if wants_cpu {
                "_staging_runtime_cpu"
            } else {
                "_staging_runtime"
            };
            let staging_parent = if wants_cpu {
                paths.llama_cpu_runtime_deps_dir()
            } else {
                paths.llama_runtime_deps_dir()
            };
            let staging = staging_parent
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(staging_name);
            let zip_name = if wants_cpu {
                "llama-cpu.zip"
            } else {
                "llama-runtime.zip"
            };
            let llama_p = partial_size(&staging.join(zip_name))
                .max(file_size(&staging.join(zip_name)).unwrap_or(0));
            let cudart_p = if wants_cpu {
                0
            } else {
                partial_size(&staging.join("cudart.zip"))
                    .max(file_size(&staging.join("cudart.zip")).unwrap_or(0))
            };
            let staged = llama_p + cudart_p;
            if staged > 0 && item.state != DepState::Downloading {
                item.bytes_done = item.bytes_done.max(staged);
                item.size_on_disk = Some(staged);
                if deps.is_user_paused(ID_LLAMA_RUNTIME) {
                    item.state = DepState::Paused;
                    if item.message.is_empty() {
                        item.message = "Paused by user".into();
                    }
                } else {
                    item.state = DepState::Missing;
                    item.message = "Incomplete — will resume".into();
                }
                item.percent = percent(item.bytes_done, item.bytes_total);
            }
        }
    }

    // Zip leftover named grok.exe (old downloader) is not ready until extracted.
    if let Some(item) = items.iter_mut().find(|i| i.id == ID_GROK_EXE) {
        let grok_path = paths.downloaded_grok_exe();
        if item.state == DepState::Ready && !grok_exe_is_usable(&grok_path) {
            item.state = DepState::Missing;
            item.message = "Incomplete — grok zip not extracted to resources/runtime".into();
            item.percent = None;
        }
        if item.state == DepState::Missing || item.state == DepState::Paused {
            let staging = grok_staging_dir(&grok_path);
            let zip_p = partial_size(&staging.join("grok.zip"))
                .max(file_size(&staging.join("grok.zip")).unwrap_or(0));
            let leftover = if grok_path.is_file() && is_zip_file(&grok_path) {
                file_size(&grok_path).unwrap_or(0)
            } else {
                partial_size(&grok_path)
            };
            let staged = zip_p.max(leftover);
            if staged > 0 && item.state != DepState::Downloading {
                item.bytes_done = item.bytes_done.max(staged);
                item.size_on_disk = Some(staged);
                if deps.is_user_paused(ID_GROK_EXE) {
                    item.state = DepState::Paused;
                    if item.message.is_empty() {
                        item.message = "Paused by user".into();
                    }
                } else {
                    item.state = DepState::Missing;
                    item.message = "Incomplete — will resume".into();
                }
                item.percent = percent(item.bytes_done, item.bytes_total);
            }
        }
    }

    let active_urls = {
        let slot = |raw: &str, from_cn: bool| -> bool {
            if raw.is_empty() {
                prefer_cn
            } else {
                from_cn
            }
        };
        let (grok_raw, grok_cn) = deps.grok_exe_url(prefer_cn);
        let mut urls = Vec::new();
        if supports_local {
            let (model_raw, model_cn) = deps.bonsai_model_url(prefer_cn);
            let (mmproj_raw, mmproj_cn) = deps.bonsai_mmproj_url(prefer_cn);
            let (llama_raw, llama_cn) = deps.llama_runtime_zip_url(prefer_cn);
            let (llama_cpu_raw, llama_cpu_cn) = deps.llama_cpu_runtime_zip_url(prefer_cn);
            let (cudart_raw, cudart_cn) = deps.cudart_zip_url(prefer_cn);
            urls.push(ActiveDownloadUrl {
                id: "bonsai-model".into(),
                title: "Bonsai 27B".into(),
                url: model_raw.to_string(),
                from_cn: slot(model_raw, model_cn),
                dep_id: ID_BONSAI_MODEL.into(),
            });
            urls.push(ActiveDownloadUrl {
                id: "bonsai-mmproj".into(),
                title: "Bonsai vision projector".into(),
                url: mmproj_raw.to_string(),
                from_cn: slot(mmproj_raw, mmproj_cn),
                dep_id: ID_BONSAI_MMPROJ.into(),
            });
            if wants_cpu {
                urls.push(ActiveDownloadUrl {
                    id: "llama-cpu-runtime-zip".into(),
                    title: "llama CPU runtime zip".into(),
                    url: llama_cpu_raw.to_string(),
                    from_cn: slot(llama_cpu_raw, llama_cpu_cn),
                    dep_id: ID_LLAMA_RUNTIME.into(),
                });
            } else {
                urls.push(ActiveDownloadUrl {
                    id: "llama-runtime-zip".into(),
                    title: "llama runtime zip".into(),
                    url: llama_raw.to_string(),
                    from_cn: slot(llama_raw, llama_cn),
                    dep_id: ID_LLAMA_RUNTIME.into(),
                });
                urls.push(ActiveDownloadUrl {
                    id: "cudart-zip".into(),
                    title: "CUDA runtime zip".into(),
                    url: cudart_raw.to_string(),
                    from_cn: slot(cudart_raw, cudart_cn),
                    dep_id: ID_LLAMA_RUNTIME.into(),
                });
            }
        }
        urls.push(ActiveDownloadUrl {
            id: "grok-exe".into(),
            title: "grok.exe".into(),
            url: grok_raw.to_string(),
            from_cn: slot(grok_raw, grok_cn),
            dep_id: ID_GROK_EXE.into(),
        });
        urls
    };

    Ok(DependenciesCatalog {
        prefer_cn,
        auto_download_on_startup: deps.auto_download_on_startup,
        use_cn_sources: deps.use_cn_sources,
        deps_dir: paths.deps_dir().display().to_string(),
        config: deps.clone(),
        items,
        active_urls,
        local_llm_blocked: !supports_local,
    })
}

async fn download_to_file(
    app: &AppHandle,
    mgr: &DependencyManager,
    id: &str,
    url: &str,
    dest: &Path,
    label: &str,
) -> Result<DlOutcome, String> {
    if url.trim().is_empty() {
        return Err(format!("{label}: download URL is empty"));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let partial = partial_path(dest);
    let existing = file_size(&partial).unwrap_or(0);
    mgr.clear_pause_request(id);

    let client = http_client()?;
    emit_progress(
        app,
        mgr,
        id,
        DepProgressEvent {
            id: id.into(),
            state: DepState::Downloading,
            bytes_done: existing,
            bytes_total: None,
            percent: None,
            message: if existing > 0 {
                format!("Resuming… ({label})")
            } else {
                format!("Connecting… ({label})")
            },
        },
    );

    let mut req = client.get(url).header(reqwest::header::ACCEPT, "*/*");
    if existing > 0 {
        req = req.header(
            reqwest::header::RANGE,
            format!("bytes={existing}-"),
        );
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status().as_u16();
    // 206 = resumed; 200 = full body (restart if we expected a range).
    let resume_ok = status == 206;
    let full_ok = status == 200;
    if !(resume_ok || full_ok) {
        return Err(format!("HTTP {status} downloading {label}"));
    }

    if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
        let ct = ct.to_str().unwrap_or("").to_ascii_lowercase();
        if ct.contains("text/html") {
            return Err(format!(
                "{label}: server returned HTML (check URL; ModelScope needs /resolve/ not /file/view/)"
            ));
        }
    }

    let mut done = existing;
    let mut total = resp.content_length().map(|n| {
        if resume_ok {
            existing.saturating_add(n)
        } else {
            n
        }
    });
    if let Some(cr) = resp.headers().get(reqwest::header::CONTENT_RANGE) {
        // bytes start-end/total
        if let Ok(s) = cr.to_str() {
            if let Some(t) = s.rsplit('/').next() {
                if let Ok(n) = t.parse::<u64>() {
                    total = Some(n);
                }
            }
        }
    }

    let mut file = if resume_ok && existing > 0 {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&partial)
            .map_err(|e| e.to_string())?
    } else {
        // Server ignored Range — rewrite from scratch.
        done = 0;
        File::create(&partial).map_err(|e| e.to_string())?
    };

    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        if mgr.take_pause_request(id) {
            file.flush().map_err(|e| e.to_string())?;
            drop(file);
            emit_progress(
                app,
                mgr,
                id,
                DepProgressEvent {
                    id: id.into(),
                    state: DepState::Paused,
                    bytes_done: done,
                    bytes_total: total,
                    percent: percent(done, total),
                    message: format!("Paused ({label})"),
                },
            );
            return Ok(DlOutcome::Paused {
                bytes_done: done,
                bytes_total: total,
            });
        }

        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) || total == Some(done) {
            last_emit = std::time::Instant::now();
            emit_progress(
                app,
                mgr,
                id,
                DepProgressEvent {
                    id: id.into(),
                    state: DepState::Downloading,
                    bytes_done: done,
                    bytes_total: total,
                    percent: percent(done, total),
                    message: format!("Downloading {label}…"),
                },
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    if dest.exists() {
        let _ = fs::remove_file(dest);
    }
    fs::rename(&partial, dest).map_err(|e| {
        let _ = fs::remove_file(&partial);
        e.to_string()
    })?;

    if dest
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false)
    {
        let mut f = File::open(dest).map_err(|e| e.to_string())?;
        let mut magic = [0u8; 4];
        f.read_exact(&mut magic).map_err(|e| e.to_string())?;
        if &magic != b"GGUF" {
            let _ = fs::remove_file(dest);
            return Err(format!("{label}: downloaded file is not a GGUF"));
        }
    }

    Ok(DlOutcome::Done)
}

fn file_starts_with(path: &Path, magic: &[u8]) -> bool {
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    let mut buf = vec![0u8; magic.len()];
    f.read_exact(&mut buf).is_ok() && buf == magic
}

fn is_zip_file(path: &Path) -> bool {
    file_starts_with(path, b"PK\x03\x04")
        || file_starts_with(path, b"PK\x05\x06")
        || file_starts_with(path, b"PK\x07\x08")
}

#[cfg(windows)]
fn is_pe_file(path: &Path) -> bool {
    file_starts_with(path, b"MZ")
}

fn find_named_file(dir: &Path, names: &[&str], depth: u32) -> Option<PathBuf> {
    if depth > 4 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if path.is_dir() {
            subdirs.push(path);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if names.iter().any(|n| name.eq_ignore_ascii_case(n)) {
            return Some(path);
        }
    }
    for sub in subdirs {
        if let Some(found) = find_named_file(&sub, names, depth + 1) {
            return Some(found);
        }
    }
    None
}

/// Download grok as a raw PE **or** a zip from `release/Pack-Grok.ps1` (`pack.bat`).
/// The zip is extracted into `{install}/resources/runtime/` (same layout as packing:
/// zip root contains `grok.exe` and optional `version.json`).
async fn download_grok_bundle(
    app: &AppHandle,
    mgr: &DependencyManager,
    url: &str,
    dest: &Path,
) -> Result<DlOutcome, String> {
    if grok_exe_is_usable(dest) {
        return Ok(DlOutcome::Done);
    }

    let runtime_dir = dest.parent().unwrap_or(dest);
    fs::create_dir_all(runtime_dir).map_err(|e| e.to_string())?;
    let staging = grok_staging_dir(dest);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let payload = staging.join("grok.zip");

    // Previous downloader saved the zip as grok.exe — move it to staging and resume extract.
    if dest.is_file() && is_zip_file(dest) && !payload.is_file() {
        fs::rename(dest, &payload).map_err(|e| e.to_string())?;
    }
    let old_partial = partial_path(dest);
    let new_partial = partial_path(&payload);
    if old_partial.is_file() && !payload.is_file() && !new_partial.is_file() {
        let _ = fs::rename(&old_partial, &new_partial);
    }

    if !payload.is_file() {
        match download_to_file(app, mgr, ID_GROK_EXE, url, &payload, "grok").await? {
            DlOutcome::Paused {
                bytes_done,
                bytes_total,
            } => {
                return Ok(DlOutcome::Paused {
                    bytes_done,
                    bytes_total,
                });
            }
            DlOutcome::Done => {}
        }
    }

    if is_zip_file(&payload) {
        emit_progress(
            app,
            mgr,
            ID_GROK_EXE,
            DepProgressEvent {
                id: ID_GROK_EXE.into(),
                state: DepState::Downloading,
                bytes_done: 0,
                bytes_total: None,
                percent: Some(90.0),
                message: "Extracting grok.zip into resources/runtime…".into(),
            },
        );
        extract_zip_flat(&payload, runtime_dir)?;
        if !grok_exe_is_usable(dest) {
            let exe = find_named_file(runtime_dir, &["grok.exe", "grok"], 0)
                .ok_or_else(|| "grok zip does not contain grok.exe".to_string())?;
            if exe != dest {
                if dest.exists() {
                    let _ = fs::remove_file(dest);
                }
                fs::copy(&exe, dest).map_err(|e| e.to_string())?;
            }
        }
        if let Some(ver) = find_named_file(runtime_dir, &["version.json"], 0) {
            let target = runtime_dir.join("version.json");
            if ver != target {
                let _ = fs::copy(&ver, &target);
            }
        }
    } else {
        if dest.exists() {
            let _ = fs::remove_file(dest);
        }
        fs::rename(&payload, dest).or_else(|_| {
            fs::copy(&payload, dest).map(|_| ())
        }).map_err(|e| e.to_string())?;
    }

    if !grok_exe_is_usable(dest) {
        let _ = fs::remove_file(dest);
        return Err(
            "downloaded grok is not a usable engine binary (zip from pack.bat must contain grok.exe)"
                .into(),
        );
    }

    let _ = fs::remove_dir_all(&staging);
    Ok(DlOutcome::Done)
}

fn extract_zip_flat(zip_path: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // If the zip has a single top-level directory, strip it.
    let mut top_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut has_root_file = false;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        if name.is_empty() {
            continue;
        }
        if let Some((first, rest)) = name.split_once('/') {
            if rest.is_empty() && entry.is_dir() {
                top_dirs.insert(first.to_string());
            } else if !first.is_empty() {
                top_dirs.insert(first.to_string());
            }
        } else {
            has_root_file = true;
        }
    }
    let strip_prefix = if !has_root_file && top_dirs.len() == 1 {
        top_dirs.into_iter().next()
    } else {
        None
    };

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw = entry.name().replace('\\', "/");
        let mut rel = raw.as_str();
        if let Some(ref prefix) = strip_prefix {
            let p = format!("{prefix}/");
            if rel == prefix.as_str() || rel == format!("{prefix}/") {
                continue;
            }
            if let Some(stripped) = rel.strip_prefix(&p) {
                rel = stripped;
            } else {
                continue;
            }
        }
        if rel.is_empty() || rel.contains("..") {
            continue;
        }
        let out = dest.join(rel);
        if entry.is_dir() || raw.ends_with('/') {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let expected = entry.size();
        let mut outfile = File::create(&out).map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        outfile.flush().map_err(|e| e.to_string())?;
        drop(outfile);
        if copied != expected {
            let _ = fs::remove_file(&out);
            return Err(format!(
                "truncated zip entry {rel}: copied {copied} bytes, expected {expected}"
            ));
        }
    }
    Ok(())
}

async fn download_runtime_bundle(
    app: &AppHandle,
    mgr: &DependencyManager,
    llama_url: &str,
    cudart_url: &str,
    dest_dir: &Path,
) -> Result<DlOutcome, String> {
    if llama_url.is_empty() && cudart_url.is_empty() {
        return Err("Runtime download URLs are empty for this region".into());
    }
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let staging = dest_dir
        .parent()
        .unwrap_or(dest_dir)
        .join("_staging_runtime");
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let llama_zip = staging.join("llama-runtime.zip");
    let cudart_zip = staging.join("cudart.zip");
    let need_llama = !llm_runtime::llama_server_binaries_ready(dest_dir);
    let need_cudart = !llm_runtime::cuda_runtime_is_ready(dest_dir);

    if need_llama {
        if !llama_zip.is_file() {
            if llama_url.is_empty() {
                return Err("llama runtime zip URL is empty and binaries are incomplete".into());
            }
            match download_to_file(
                app,
                mgr,
                ID_LLAMA_RUNTIME,
                llama_url,
                &llama_zip,
                "llama runtime zip",
            )
            .await?
            {
                DlOutcome::Paused {
                    bytes_done,
                    bytes_total,
                } => {
                    return Ok(DlOutcome::Paused {
                        bytes_done,
                        bytes_total,
                    });
                }
                DlOutcome::Done => {}
            }
        }
        emit_progress(
            app,
            mgr,
            ID_LLAMA_RUNTIME,
            DepProgressEvent {
                id: ID_LLAMA_RUNTIME.into(),
                state: DepState::Downloading,
                bytes_done: 0,
                bytes_total: None,
                percent: Some(55.0),
                message: "Extracting llama runtime…".into(),
            },
        );
        extract_zip_flat(&llama_zip, dest_dir)?;
    }

    if need_cudart {
        if !cudart_zip.is_file() {
            if cudart_url.is_empty() {
                return Err("CUDA runtime zip URL is empty and CUDA DLLs are incomplete".into());
            }
            match download_to_file(
                app,
                mgr,
                ID_LLAMA_RUNTIME,
                cudart_url,
                &cudart_zip,
                "CUDA runtime zip",
            )
            .await?
            {
                DlOutcome::Paused {
                    bytes_done,
                    bytes_total,
                } => {
                    return Ok(DlOutcome::Paused {
                        bytes_done,
                        bytes_total,
                    });
                }
                DlOutcome::Done => {}
            }
        }
        emit_progress(
            app,
            mgr,
            ID_LLAMA_RUNTIME,
            DepProgressEvent {
                id: ID_LLAMA_RUNTIME.into(),
                state: DepState::Downloading,
                bytes_done: 0,
                bytes_total: None,
                percent: Some(90.0),
                message: "Extracting CUDA runtime…".into(),
            },
        );
        extract_zip_flat(&cudart_zip, dest_dir)?;
    }

    if !llm_runtime::runtime_binaries_ready(dest_dir) {
        let missing = llm_runtime::missing_runtime_binaries(dest_dir).join(", ");
        return Err(format!(
            "Runtime incomplete after extract in {}: {missing}",
            dest_dir.display()
        ));
    }
    llm_runtime::ensure_msvc_crt(dest_dir);

    let _ = fs::remove_dir_all(&staging);
    let _ = fs::create_dir_all(dest_dir.join("models"));
    Ok(DlOutcome::Done)
}

async fn download_cpu_runtime_bundle(
    app: &AppHandle,
    mgr: &DependencyManager,
    llama_url: &str,
    dest_dir: &Path,
) -> Result<DlOutcome, String> {
    if llama_url.is_empty() {
        return Err("CPU llama.cpp zip URL is empty".into());
    }
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let staging = dest_dir
        .parent()
        .unwrap_or(dest_dir)
        .join("_staging_runtime_cpu");
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let llama_zip = staging.join("llama-cpu.zip");
    if !llm_runtime::cpu_runtime_binaries_ready(dest_dir) {
        if !llama_zip.is_file() {
            match download_to_file(
                app,
                mgr,
                ID_LLAMA_RUNTIME,
                llama_url,
                &llama_zip,
                "llama CPU runtime zip",
            )
            .await?
            {
                DlOutcome::Paused {
                    bytes_done,
                    bytes_total,
                } => {
                    return Ok(DlOutcome::Paused {
                        bytes_done,
                        bytes_total,
                    });
                }
                DlOutcome::Done => {}
            }
        }
        emit_progress(
            app,
            mgr,
            ID_LLAMA_RUNTIME,
            DepProgressEvent {
                id: ID_LLAMA_RUNTIME.into(),
                state: DepState::Downloading,
                bytes_done: 0,
                bytes_total: None,
                percent: Some(70.0),
                message: "Extracting CPU llama runtime…".into(),
            },
        );
        extract_zip_flat(&llama_zip, dest_dir)?;
    }

    if !llm_runtime::cpu_runtime_binaries_ready(dest_dir) {
        let missing = llm_runtime::missing_cpu_runtime_binaries(dest_dir).join(", ");
        return Err(format!(
            "CPU runtime incomplete after extract in {}: {missing}",
            dest_dir.display()
        ));
    }
    llm_runtime::ensure_msvc_crt(dest_dir);

    let _ = fs::remove_dir_all(&staging);
    let _ = fs::create_dir_all(dest_dir.join("models"));
    Ok(DlOutcome::Done)
}

async fn run_download(app: AppHandle, mgr: Arc<DependencyManager>, id: String) -> Result<(), String> {
    if is_local_bonsai_dep(&id) && !llm_runtime::host_supports_local_bonsai() {
        return Err(llm_runtime::bonsai_gpu_requirement_message());
    }
    let settings = load_settings();
    let paths = paths_or_err()?;
    let deps = &settings.dependency_downloads;
    let prefer_cn = deps.prefer_cn(settings.cn_acceleration.enabled);
    let cn = &settings.cn_acceleration;

    let result = match id.as_str() {
        ID_BONSAI_MODEL => {
            let url = pick_resolved(
                deps,
                cn,
                prefer_cn,
                DependencyDownloadSettings::bonsai_model_url,
            );
            let dest = model_path(&paths);
            download_to_file(&app, &mgr, &id, &url, &dest, MODEL_FILE).await
        }
        ID_BONSAI_MMPROJ => {
            let url = pick_resolved(
                deps,
                cn,
                prefer_cn,
                DependencyDownloadSettings::bonsai_mmproj_url,
            );
            let dest = mmproj_path(&paths);
            download_to_file(&app, &mgr, &id, &url, &dest, MMPROJ_FILE).await
        }
        ID_LLAMA_RUNTIME => {
            if llm_runtime::host_wants_cpu_runtime() {
                let llama_url = pick_resolved(
                    deps,
                    cn,
                    prefer_cn,
                    DependencyDownloadSettings::llama_cpu_runtime_zip_url,
                );
                download_cpu_runtime_bundle(
                    &app,
                    &mgr,
                    &llama_url,
                    &paths.llama_cpu_runtime_deps_dir(),
                )
                .await
            } else {
                let llama_url = pick_resolved(
                    deps,
                    cn,
                    prefer_cn,
                    DependencyDownloadSettings::llama_runtime_zip_url,
                );
                let cudart_url = pick_resolved(
                    deps,
                    cn,
                    prefer_cn,
                    DependencyDownloadSettings::cudart_zip_url,
                );
                download_runtime_bundle(
                    &app,
                    &mgr,
                    &llama_url,
                    &cudart_url,
                    &paths.llama_runtime_deps_dir(),
                )
                .await
            }
        }
        ID_GROK_EXE => {
            let url =
                pick_resolved(deps, cn, prefer_cn, DependencyDownloadSettings::grok_exe_url);
            if url.is_empty() {
                Err("grok.exe download URL is not configured yet".into())
            } else {
                let dest = paths.downloaded_grok_exe();
                download_grok_bundle(&app, &mgr, &url, &dest).await
            }
        }
        other => Err(format!("unknown dependency id: {other}")),
    };

    match result {
        Ok(DlOutcome::Done) => {
            emit_progress(
                &app,
                &mgr,
                &id,
                DepProgressEvent {
                    id: id.clone(),
                    state: DepState::Ready,
                    bytes_done: 0,
                    bytes_total: None,
                    percent: Some(100.0),
                    message: "Ready".into(),
                },
            );
            mgr.live.lock().remove(&id);
            mgr.inflight.lock().remove(&id);
            info!(id = %id, "dependency download finished");
            Ok(())
        }
        Ok(DlOutcome::Paused {
            bytes_done,
            bytes_total,
        }) => {
            // Keep progress in `live`; clear inflight so Resume can restart.
            emit_progress(
                &app,
                &mgr,
                &id,
                DepProgressEvent {
                    id: id.clone(),
                    state: DepState::Paused,
                    bytes_done,
                    bytes_total,
                    percent: percent(bytes_done, bytes_total),
                    message: "Paused".into(),
                },
            );
            mgr.inflight.lock().remove(&id);
            info!(id = %id, "dependency download paused");
            Ok(())
        }
        Err(err) => {
            emit_progress(
                &app,
                &mgr,
                &id,
                DepProgressEvent {
                    id: id.clone(),
                    state: DepState::Error,
                    bytes_done: 0,
                    bytes_total: None,
                    percent: None,
                    message: err.clone(),
                },
            );
            mgr.inflight.lock().remove(&id);
            warn!(id = %id, error = %err, "dependency download failed");
            Err(err)
        }
    }
}

fn delete_dep(id: &str) -> Result<(), String> {
    let paths = paths_or_err()?;
    match id {
        ID_BONSAI_MODEL => {
            let p = model_path(&paths);
            let _ = fs::remove_file(partial_path(&p));
            if p.exists() {
                fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
        }
        ID_BONSAI_MMPROJ => {
            let p = mmproj_path(&paths);
            let _ = fs::remove_file(partial_path(&p));
            if p.exists() {
                fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
        }
        ID_LLAMA_RUNTIME => {
            // Remove binaries/dlls but keep models/ folder (GGUF lives under the CUDA dir).
            let dir = if llm_runtime::host_wants_cpu_runtime() {
                paths.llama_cpu_runtime_deps_dir()
            } else {
                paths.llama_runtime_deps_dir()
            };
            let staging_name = if llm_runtime::host_wants_cpu_runtime() {
                "_staging_runtime_cpu"
            } else {
                "_staging_runtime"
            };
            let staging = dir.parent().unwrap_or(&dir).join(staging_name);
            let _ = fs::remove_dir_all(&staging);
            if dir.is_dir() {
                for ent in fs::read_dir(&dir).map_err(|e| e.to_string())? {
                    let ent = ent.map_err(|e| e.to_string())?;
                    let p = ent.path();
                    let name = ent.file_name().to_string_lossy().to_string();
                    if name.eq_ignore_ascii_case("models") {
                        continue;
                    }
                    if p.is_dir() {
                        fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
                    } else {
                        fs::remove_file(&p).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        ID_GROK_EXE => {
            let p = paths.downloaded_grok_exe();
            let _ = fs::remove_file(partial_path(&p));
            if p.exists() {
                fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
            let staging = grok_staging_dir(&p);
            let _ = fs::remove_dir_all(&staging);
            if let Some(parent) = p.parent() {
                let ver = parent.join("version.json");
                if ver.is_file() {
                    let _ = fs::remove_file(&ver);
                }
            }
        }
        other => return Err(format!("unknown dependency id: {other}")),
    }
    Ok(())
}

/// Probe that a model URL answers with GGUF bytes (Range 0-15). Does not download the full file.
pub async fn probe_model_url(url: &str) -> Result<String, String> {
    let normalized = DependencyDownloadSettings::normalize_download_url(url);
    if normalized.is_empty() {
        return Err("URL is empty".into());
    }
    let client = http_client()?;
    let resp = client
        .get(&normalized)
        .header(reqwest::header::RANGE, "bytes=0-15")
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if !(status == 200 || status == 206) {
        return Err(format!("HTTP {status} from {normalized}"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() >= 4 && &bytes[..4] == b"GGUF" {
        Ok(format!("OK — GGUF magic verified ({normalized})"))
    } else {
        let preview: String = bytes
            .iter()
            .take(32)
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(" ");
        Err(format!(
            "Response is not GGUF (status={status}, first bytes={preview})"
        ))
    }
}

#[tauri::command]
pub fn get_dependencies_catalog(
    mgr: State<'_, Arc<DependencyManager>>,
) -> Result<DependenciesCatalog, String> {
    catalog_from(&load_settings(), &mgr)
}

/// Update the active-slot URL for one file (CN or intl only — never both).
/// If the related dependency is downloading or failed, restart the download.
#[tauri::command]
pub async fn set_dependency_download_url(
    app: AppHandle,
    mgr: State<'_, Arc<DependencyManager>>,
    id: String,
    url: String,
) -> Result<DependenciesCatalog, String> {
    let id = id.trim().to_string();
    let url = url.trim().to_string();
    let mut settings = load_settings();
    let prefer_cn = settings
        .dependency_downloads
        .prefer_cn(settings.cn_acceleration.enabled);
    let deps = &mut settings.dependency_downloads;

    let (from_cn, dep_id) = match id.as_str() {
        "bonsai-model" => {
            let (raw, from_cn) = deps.bonsai_model_url(prefer_cn);
            let write_cn = if raw.is_empty() { prefer_cn } else { from_cn };
            if write_cn {
                deps.bonsai_model_url_cn = url.clone();
            } else {
                deps.bonsai_model_url_intl = url.clone();
            }
            (write_cn, ID_BONSAI_MODEL)
        }
        "bonsai-mmproj" => {
            let (raw, from_cn) = deps.bonsai_mmproj_url(prefer_cn);
            let write_cn = if raw.is_empty() { prefer_cn } else { from_cn };
            if write_cn {
                deps.bonsai_mmproj_url_cn = url.clone();
            } else {
                deps.bonsai_mmproj_url_intl = url.clone();
            }
            (write_cn, ID_BONSAI_MMPROJ)
        }
        "llama-runtime-zip" => {
            let (raw, from_cn) = deps.llama_runtime_zip_url(prefer_cn);
            let write_cn = if raw.is_empty() { prefer_cn } else { from_cn };
            if write_cn {
                deps.llama_runtime_zip_url_cn = url.clone();
            } else {
                deps.llama_runtime_zip_url_intl = url.clone();
            }
            (write_cn, ID_LLAMA_RUNTIME)
        }
        "llama-cpu-runtime-zip" => {
            let (raw, from_cn) = deps.llama_cpu_runtime_zip_url(prefer_cn);
            let write_cn = if raw.is_empty() { prefer_cn } else { from_cn };
            if write_cn {
                deps.llama_cpu_runtime_zip_url_cn = url.clone();
            } else {
                deps.llama_cpu_runtime_zip_url_intl = url.clone();
            }
            (write_cn, ID_LLAMA_RUNTIME)
        }
        "cudart-zip" => {
            let (raw, from_cn) = deps.cudart_zip_url(prefer_cn);
            let write_cn = if raw.is_empty() { prefer_cn } else { from_cn };
            if write_cn {
                deps.cudart_zip_url_cn = url.clone();
            } else {
                deps.cudart_zip_url_intl = url.clone();
            }
            (write_cn, ID_LLAMA_RUNTIME)
        }
        "grok-exe" => {
            let (raw, from_cn) = deps.grok_exe_url(prefer_cn);
            let write_cn = if raw.is_empty() { prefer_cn } else { from_cn };
            if write_cn {
                deps.grok_exe_url_cn = url.clone();
            } else {
                deps.grok_exe_url_intl = url.clone();
            }
            (write_cn, ID_GROK_EXE)
        }
        other => return Err(format!("unknown url id: {other}")),
    };
    let _ = from_cn;
    save_settings(&settings)?;

    let cat = catalog_from(&settings, &mgr)?;
    let state = cat
        .items
        .iter()
        .find(|i| i.id == dep_id)
        .map(|i| i.state.clone());

    // Restart when downloading or failed so the new URL takes effect.
    if matches!(state, Some(DepState::Downloading) | Some(DepState::Error)) {
        if mgr.inflight.lock().contains(dep_id) {
            mgr.request_pause(dep_id);
            // Give the download loop a moment to observe pause.
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        let _ = set_user_paused_persist(dep_id, false);
        mgr.clear_pause_request(dep_id);
        mgr.live.lock().remove(dep_id);
        // Drop partials for a clean retry with the new URL.
        let _ = delete_dep(dep_id);
        {
            let mut set = mgr.inflight.lock();
            set.remove(dep_id);
            set.insert(dep_id.to_string());
        }
        let mgr_arc = mgr.inner().clone();
        let dep = dep_id.to_string();
        tauri::async_runtime::spawn(async move {
            let _ = run_download(app, mgr_arc, dep).await;
        });
    }

    catalog_from(&load_settings(), &mgr)
}

#[tauri::command]
pub async fn start_dependency_download(
    app: AppHandle,
    mgr: State<'_, Arc<DependencyManager>>,
    id: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("dependency id required".into());
    }
    if id == ID_GROK_EXE && !require_grok_download() {
        return Err("dev build does not download grok.exe".into());
    }
    if is_local_bonsai_dep(&id) && !llm_runtime::host_supports_local_bonsai() {
        return Err(llm_runtime::bonsai_gpu_requirement_message());
    }
    // Explicit resume clears the user-pause latch.
    let _ = set_user_paused_persist(&id, false);
    mgr.clear_pause_request(&id);
    {
        let mut set = mgr.inflight.lock();
        if !set.insert(id.clone()) {
            return Err("download already in progress".into());
        }
    }
    let mgr_arc = mgr.inner().clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_download(app, mgr_arc, id).await;
    });
    Ok(())
}

#[tauri::command]
pub fn pause_dependency_download(
    mgr: State<'_, Arc<DependencyManager>>,
    id: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("dependency id required".into());
    }
    if !mgr.inflight.lock().contains(&id) {
        // Allow marking pause even if not inflight (incomplete file) so auto-download stays off.
        set_user_paused_persist(&id, true)?;
        return Ok(());
    }
    set_user_paused_persist(&id, true)?;
    mgr.request_pause(&id);
    Ok(())
}

#[tauri::command]
pub async fn redownload_dependency(
    app: AppHandle,
    mgr: State<'_, Arc<DependencyManager>>,
    id: String,
) -> Result<(), String> {
    let id_trim = id.trim().to_string();
    if mgr.inflight.lock().contains(&id_trim) {
        return Err("cannot re-download while downloading — pause first".into());
    }
    delete_dep(&id_trim)?;
    mgr.live.lock().remove(&id_trim);
    mgr.clear_pause_request(&id_trim);
    let _ = set_user_paused_persist(&id_trim, false);
    start_dependency_download(app, mgr, id).await
}

#[tauri::command]
pub fn delete_dependency(
    mgr: State<'_, Arc<DependencyManager>>,
    id: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if mgr.inflight.lock().contains(&id) {
        return Err("cannot delete while downloading".into());
    }
    delete_dep(&id)?;
    mgr.live.lock().remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn probe_dependency_url(url: String) -> Result<String, String> {
    probe_model_url(&url).await
}

#[tauri::command]
pub async fn download_all_missing_dependencies(
    app: AppHandle,
    mgr: State<'_, Arc<DependencyManager>>,
) -> Result<Vec<String>, String> {
    let mgr_arc = mgr.inner().clone();
    let cat = catalog_from(&load_settings(), &mgr_arc)?;
    let mut started = Vec::new();
    for item in cat.items {
        if item.id == ID_GROK_EXE && !require_grok_download() {
            continue;
        }
        if is_local_bonsai_dep(&item.id) && !llm_runtime::host_supports_local_bonsai() {
            continue;
        }
        if item.state != DepState::Missing {
            continue;
        }
        {
            let mut set = mgr_arc.inflight.lock();
            if !set.insert(item.id.clone()) {
                continue;
            }
        }
        started.push(item.id.clone());
        let app2 = app.clone();
        let mgr2 = mgr_arc.clone();
        let id = item.id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = run_download(app2, mgr2, id).await;
        });
    }
    Ok(started)
}

/// Background: when online, auto-download missing/incomplete deps (skip user-paused).
pub fn spawn_auto_download(app: AppHandle) {
    let mgr = match app.try_state::<Arc<DependencyManager>>() {
        Some(s) => s.inner().clone(),
        None => return,
    };
    tauri::async_runtime::spawn(async move {
        let settings = load_settings();
        if !settings.dependency_downloads.auto_download_on_startup {
            return;
        }
        if !network_seems_online().await {
            warn!("skip dependency auto-download — network unavailable");
            return;
        }
        let cat = match catalog_from(&settings, &mgr) {
            Ok(c) => c,
            Err(err) => {
                warn!(error = %err, "dependency catalog failed on startup");
                return;
            }
        };
        for item in cat.items {
            if item.id == ID_GROK_EXE && !require_grok_download() {
                continue;
            }
            if is_local_bonsai_dep(&item.id) && !llm_runtime::host_supports_local_bonsai() {
                continue;
            }
            // Only auto-fetch missing/incomplete; never override an explicit user pause.
            if item.state != DepState::Missing {
                continue;
            }
            if settings
                .dependency_downloads
                .is_user_paused(&item.id)
            {
                continue;
            }
            {
                let mut set = mgr.inflight.lock();
                if !set.insert(item.id.clone()) {
                    continue;
                }
            }
            info!(id = %item.id, "auto-downloading missing dependency");
            let app2 = app.clone();
            let mgr2 = mgr.clone();
            let id = item.id.clone();
            let _ = run_download(app2, mgr2, id).await;
        }
    });
}

#[derive(Debug, Clone, Serialize)]
pub struct DependencyReadiness {
    pub ok: bool,
    /// Human-readable reminder when not ready.
    pub message: String,
    pub missing_ids: Vec<String>,
    pub downloading_ids: Vec<String>,
    pub paused_ids: Vec<String>,
    /// Local Bonsai model/runtime ready for use.
    pub local_llm_ready: bool,
    /// True when this PC cannot run local Bonsai (NVIDIA GPU ≥8 GB required).
    pub local_llm_blocked: bool,
    /// grok engine binary ready (always true in dev builds).
    pub grok_ready: bool,
}

fn readiness_from_catalog(cat: &DependenciesCatalog) -> DependencyReadiness {
    let mut missing = Vec::new();
    let mut downloading = Vec::new();
    let mut paused = Vec::new();
    let mut local_llm_ready = true;
    let mut grok_ready = true;
    let local_llm_blocked = !llm_runtime::host_supports_local_bonsai();
    if local_llm_blocked {
        local_llm_ready = false;
    }

    for item in &cat.items {
        match item.id.as_str() {
            ID_BONSAI_MODEL | ID_BONSAI_MMPROJ | ID_LLAMA_RUNTIME => {
                if local_llm_blocked {
                    continue;
                }
                match item.state {
                    DepState::Ready => {}
                    DepState::Downloading => {
                        local_llm_ready = false;
                        downloading.push(item.id.clone());
                    }
                    DepState::Paused => {
                        local_llm_ready = false;
                        paused.push(item.id.clone());
                    }
                    DepState::Missing | DepState::Error => {
                        local_llm_ready = false;
                        missing.push(item.id.clone());
                    }
                    DepState::Unavailable => {
                        local_llm_ready = false;
                    }
                }
            }
            ID_GROK_EXE => {
                if !require_grok_download() {
                    continue;
                }
                match item.state {
                    DepState::Ready => {}
                    DepState::Downloading => {
                        grok_ready = false;
                        downloading.push(item.id.clone());
                    }
                    DepState::Paused => {
                        grok_ready = false;
                        paused.push(item.id.clone());
                    }
                    DepState::Missing | DepState::Error | DepState::Unavailable => {
                        grok_ready = false;
                        missing.push(item.id.clone());
                    }
                }
            }
            _ => {}
        }
    }

    let ok = local_llm_ready && grok_ready;
    let message = if ok {
        String::new()
    } else if local_llm_blocked && grok_ready {
        llm_runtime::bonsai_gpu_requirement_message()
    } else if !downloading.is_empty() {
        "Dependencies are still downloading. Open Settings → Dependencies to view progress."
            .into()
    } else if !paused.is_empty() {
        "Some dependencies were paused. Resume them in Settings → Dependencies before use."
            .into()
    } else {
        "Required dependencies are not installed yet. They will download automatically when online, or open Settings → Dependencies."
            .into()
    };

    DependencyReadiness {
        ok,
        message,
        missing_ids: missing,
        downloading_ids: downloading,
        paused_ids: paused,
        local_llm_ready,
        local_llm_blocked,
        grok_ready,
    }
}

#[tauri::command]
pub fn get_dependency_readiness(
    mgr: State<'_, Arc<DependencyManager>>,
) -> Result<DependencyReadiness, String> {
    let cat = catalog_from(&load_settings(), &mgr)?;
    Ok(readiness_from_catalog(&cat))
}

/// Include the product install root in local-LLM discovery.
pub fn deps_search_root() -> Option<PathBuf> {
    Some(AppPaths::product_install_root())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_modelscope_view_url() {
        let raw = "https://modelscope.cn/models/prism-ml/Bonsai-27B-gguf/file/view/master/Bonsai-27B-Q1_0.gguf?status=2";
        let n = DependencyDownloadSettings::normalize_download_url(raw);
        assert_eq!(
            n,
            "https://modelscope.cn/models/prism-ml/Bonsai-27B-gguf/resolve/master/Bonsai-27B-Q1_0.gguf"
        );
    }
}
