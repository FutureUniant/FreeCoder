//! Application paths, settings, and bundled runtime metadata.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const APP_QUALIFIER: &str = "app";
pub const APP_ORGANIZATION: &str = "grokx";
pub const APP_NAME: &str = "grokx";

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("could not resolve application data directory")]
    NoDataDir,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Well-known directories for the desktop product (isolated from ~/.grok).
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub config_file: PathBuf,
    pub sessions_db: PathBuf,
    pub logs_dir: PathBuf,
    pub engine_data_dir: PathBuf,
}

impl AppPaths {
    pub fn discover() -> Result<Self, ConfigError> {
        let base = directories::ProjectDirs::from(APP_QUALIFIER, APP_ORGANIZATION, APP_NAME)
            .ok_or(ConfigError::NoDataDir)?;
        let data_dir = base.data_dir().to_path_buf();
        Ok(Self {
            config_file: data_dir.join("settings.json"),
            sessions_db: data_dir.join("sessions.db"),
            logs_dir: data_dir.join("logs"),
            engine_data_dir: data_dir.join("engine-data"),
            data_dir,
        })
    }

    pub fn ensure_dirs(&self) -> Result<(), ConfigError> {
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::create_dir_all(&self.logs_dir)?;
        std::fs::create_dir_all(&self.engine_data_dir)?;
        // Ensure task workspaces root exists for history recovery.
        let _ = std::fs::create_dir_all(Self::tasks_root());
        Ok(())
    }

    /// Product install root: directory that contains the desktop executable
    /// (packaged install), or the repo root when running from `cargo`/`target/*`.
    ///
    /// Dependency downloads (Bonsai runtime/models, optional grok.exe) live under
    /// this tree — not under AppData.
    pub fn product_install_root() -> PathBuf {
        resolve_product_install_root()
    }

    /// `{install}/models/llama-prism-win-cuda12` — CUDA llama.cpp + GGUF download location.
    pub fn llama_runtime_deps_dir(&self) -> PathBuf {
        Self::product_install_root()
            .join("models")
            .join("llama-prism-win-cuda12")
    }

    /// `{install}/models/llama-prism-win-cpu` — leftover CPU llama.cpp dir (no longer launched).
    pub fn llama_cpu_runtime_deps_dir(&self) -> PathBuf {
        Self::product_install_root()
            .join("models")
            .join("llama-prism-win-cpu")
    }

    /// `{install}/resources/runtime/grok[.exe]` — same path the bundled engine uses.
    pub fn downloaded_grok_exe(&self) -> PathBuf {
        let runtime = Self::product_install_root()
            .join("resources")
            .join("runtime");
        if cfg!(windows) {
            runtime.join("grok.exe")
        } else {
            runtime.join("grok")
        }
    }

    /// Display / catalog helper: install root (dependencies are fixed under it).
    pub fn deps_dir(&self) -> PathBuf {
        Self::product_install_root()
    }

    /// JSON index of projects + sessions (survives app restarts).
    pub fn sessions_index_file(&self) -> PathBuf {
        self.data_dir.join("sessions-index.json")
    }

    /// Manifest of MCP / Skills installed via the Extensions UI.
    pub fn extensions_manifest_file(&self) -> PathBuf {
        self.data_dir.join("extensions-manifest.json")
    }

    /// Default path of the Grok CLI config that the engine reads.
    pub fn grok_cli_config() -> PathBuf {
        directories::UserDirs::new()
            .map(|u| u.home_dir().join(".grok").join("config.toml"))
            .unwrap_or_else(|| PathBuf::from("~/.grok/config.toml"))
    }

    /// User-level skills directory scanned by the engine (`~/.grok/skills`).
    pub fn grok_skills_dir() -> PathBuf {
        directories::UserDirs::new()
            .map(|u| u.home_dir().join(".grok").join("skills"))
            .unwrap_or_else(|| PathBuf::from("~/.grok/skills"))
    }

    /// Legacy / recovery root: `~/.grokx/tasks/<session_id>/`.
    ///
    /// New project tasks use [`Self::project_tasks_root`] instead. This path
    /// remains for importing older installs and for safe-delete checks.
    pub fn tasks_root() -> PathBuf {
        directories::UserDirs::new()
            .map(|u| u.home_dir().join(".grokx").join("tasks"))
            .unwrap_or_else(|| PathBuf::from("~/.grokx/tasks"))
    }

    /// Per-project chat/task metadata root: `<project>/.grokx/tasks/`.
    ///
    /// Agent cwd stays at `project_root`; only UI chat history / meta live here.
    pub fn project_tasks_root(project_root: &Path) -> PathBuf {
        project_root.join(".grokx").join("tasks")
    }

    /// Metadata directory for one task under a project.
    pub fn project_task_dir(project_root: &Path, session_id: &str) -> PathBuf {
        Self::project_tasks_root(project_root).join(session_id)
    }

    /// True if `work` is a managed task metadata dir we may delete:
    /// - `~/.grokx/tasks/<id>` (legacy), or
    /// - `<any>/.grokx/tasks/<id>` (project-local).
    ///
    /// Never returns true for a project source root itself.
    pub fn is_managed_task_dir(work: &Path) -> bool {
        let Some(name) = work.file_name() else {
            return false;
        };
        if name.is_empty() || name == "." || name == ".." {
            return false;
        }
        // Must be exactly one level under a `tasks` directory.
        let Some(tasks) = work.parent() else {
            return false;
        };
        if tasks.file_name().and_then(|s| s.to_str()) != Some("tasks") {
            return false;
        }

        // Legacy home location: ~/.grokx/tasks/<id>
        let global = Self::tasks_root();
        if work.starts_with(&global) && work != global {
            return true;
        }
        if let (Ok(w), Ok(g)) = (
            std::fs::canonicalize(work),
            std::fs::canonicalize(&global),
        ) {
            if w.starts_with(&g) && w != g {
                return true;
            }
        }

        // Project-local: <project>/.grokx/tasks/<id>
        let Some(grokx) = tasks.parent() else {
            return false;
        };
        if grokx.file_name().and_then(|s| s.to_str()) != Some(".grokx") {
            return false;
        }
        // Must have a project root parent (not filesystem root alone).
        grokx.parent().is_some()
    }

    /// Default project directory when the user creates a task without
    /// picking a folder: `~/.grokx/workspace`.
    pub fn default_project_root() -> PathBuf {
        directories::UserDirs::new()
            .map(|u| u.home_dir().join(".grokx").join("workspace"))
            .unwrap_or_else(|| PathBuf::from("~/.grokx/workspace"))
    }
}

/// LLM endpoint / model parameters used by the desktop app and engine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelEndpointSettings {
    /// Model id (e.g. grok-4.5).
    pub model_id: String,
    /// Display name.
    pub name: Option<String>,
    /// OpenAI-compatible base URL, e.g. https://api.x.ai/v1
    pub base_url: Option<String>,
    /// API key (stored locally; never log).
    pub api_key: Option<String>,
    /// Env var name to read key from instead of api_key (optional).
    pub env_key: Option<String>,
    /// chat_completions | responses | anthropic_messages (engine field).
    pub api_backend: Option<String>,
    pub context_window: Option<u64>,
    /// Max tokens per model response (engine `max_completion_tokens`).
    #[serde(default)]
    pub max_completion_tokens: Option<u64>,
    /// Default reasoning effort for new turns.
    pub default_effort: Option<String>,
    /// When false, profile is kept in settings but not offered in the composer.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Stable Settings → vendor row id (groups models that share credentials).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<String>,
    /// Product-layer capability: `llm` | `vlm` | `image` | `video` | `local`.
    /// Used by the desktop UI; media caps stay out of grok chat model sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,
    /// Custom-vendor performance tier: `strong` | `medium` | `weak`.
    /// Curated catalogs ignore this (hard-coded membership in the UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub performance_tier: Option<String>,
    /// True when last successful remote `/models` fetch confirmed this id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_confirmed: Option<bool>,
}

impl Default for ModelEndpointSettings {
    fn default() -> Self {
        // First-install default: bundled Bonsai 1Bit via local llama-server.
        Self {
            model_id: "bonsai-local".into(),
            name: Some("Bonsai 27B (1Bit)".into()),
            base_url: Some("http://127.0.0.1:8080/v1".into()),
            api_key: Some("local".into()),
            env_key: None,
            api_backend: Some("chat_completions".into()),
            // Placeholder; AppCore overwrites with this host's GPU tune on load.
            context_window: Some(98_304),
            max_completion_tokens: Some(16_384),
            default_effort: Some("medium".into()),
            enabled: true,
            vendor_id: Some("vendor-bonsai".into()),
            capability: Some("vlm".into()),
            performance_tier: Some("weak".into()),
            remote_confirmed: Some(true),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    /// Optional override for the grok binary (debug / power users).
    pub custom_engine_path: Option<String>,
    /// Prefer bundled runtime when no custom path is set.
    pub prefer_bundled_engine: bool,
    /// Last selected model id (composer).
    pub model: Option<String>,
    /// Last selected effort.
    pub effort: Option<String>,
    /// LLM endpoint configuration.
    #[serde(default)]
    pub endpoint: ModelEndpointSettings,
    /// Saved model profiles (Settings → Models list).
    #[serde(default)]
    pub model_profiles: Vec<ModelEndpointSettings>,
    /// Also write endpoint into ~/.grok/config.toml so the engine picks it up.
    #[serde(default = "default_true")]
    pub sync_to_grok_config: bool,
    /// Tool permission mode: `ask` | `auto` | `always-approve` (full trust).
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Legacy bool (older settings.json). Migrated into `permission_mode` on load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_approve: Option<bool>,
    /// Desktop UI language: `zh-CN` | `en`.
    #[serde(default = "default_ui_language")]
    pub ui_language: String,
    /// Default Bailian image model id (e.g. `qwen-image-3.0-pro`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_image_model: Option<String>,
    /// Default Bailian video model id (e.g. `happyhorse-1.1-t2v`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_video_model: Option<String>,
    /// Engine `[ui]` / `[cli]` fields synced to ~/.grok/config.toml.
    #[serde(default)]
    pub grok_engine: GrokEngineFormSettings,
    /// Domestic (CN) download acceleration for MCP / Skills installs.
    #[serde(default)]
    pub cn_acceleration: CnAccelerationSettings,
    /// Download URLs + policies for Bonsai model / runtime / grok.exe.
    #[serde(default)]
    pub dependency_downloads: DependencyDownloadSettings,
}

/// Configurable CN / international download sources for product dependencies.
///
/// URLs are never hard-coded at call sites — callers read from this settings
/// blob (defaults live here so installs work out of the box).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DependencyDownloadSettings {
    /// When `None`, follow [`CnAccelerationSettings::enabled`]. `Some(true/false)` overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_cn_sources: Option<bool>,
    /// After install / on launch, pull missing deps in the background when online.
    #[serde(default = "default_true")]
    pub auto_download_on_startup: bool,
    /// Dependency ids the user explicitly paused — auto-download must not resume these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub user_paused_ids: Vec<String>,

    /// Bonsai GGUF (CN). ModelScope page URLs are normalized to `/resolve/` at download time.
    #[serde(default = "default_bonsai_model_url_cn")]
    pub bonsai_model_url_cn: String,
    #[serde(default = "default_bonsai_model_url_intl")]
    pub bonsai_model_url_intl: String,
    #[serde(default = "default_bonsai_mmproj_url_cn")]
    pub bonsai_mmproj_url_cn: String,
    #[serde(default = "default_bonsai_mmproj_url_intl")]
    pub bonsai_mmproj_url_intl: String,

    /// CUDA llama-server + DLL zip (CN left blank until a domestic mirror is ready).
    #[serde(default)]
    pub llama_runtime_zip_url_cn: String,
    #[serde(default = "default_llama_runtime_zip_url_intl")]
    pub llama_runtime_zip_url_intl: String,
    /// CPU llama-server zip (unused: hosts below 8 GB VRAM cannot run local Bonsai).
    #[serde(default)]
    pub llama_cpu_runtime_zip_url_cn: String,
    #[serde(default = "default_llama_cpu_runtime_zip_url_intl")]
    pub llama_cpu_runtime_zip_url_intl: String,
    /// CUDA runtime redistributable zip for the Prism llama build.
    #[serde(default)]
    pub cudart_zip_url_cn: String,
    #[serde(default = "default_cudart_zip_url_intl")]
    pub cudart_zip_url_intl: String,

    /// Optional grok.exe download (fill in when a release URL is available).
    /// Accepts a raw PE or a zip from `release/Pack-Grok.ps1` (unzipped on download).
    #[serde(default)]
    pub grok_exe_url_cn: String,
    #[serde(default)]
    pub grok_exe_url_intl: String,
}

fn default_bonsai_model_url_cn() -> String {
    // Product config keeps the ModelScope file page; downloader rewrites to /resolve/.
    "https://modelscope.cn/models/prism-ml/Bonsai-27B-gguf/file/view/master/Bonsai-27B-Q1_0.gguf?status=2"
        .into()
}

fn default_bonsai_model_url_intl() -> String {
    "https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/main/Bonsai-27B-Q1_0.gguf".into()
}

fn default_bonsai_mmproj_url_cn() -> String {
    "https://modelscope.cn/models/prism-ml/Bonsai-27B-gguf/file/view/master/Bonsai-27B-mmproj-Q8_0.gguf?status=2"
        .into()
}

fn default_bonsai_mmproj_url_intl() -> String {
    "https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/main/Bonsai-27B-mmproj-Q8_0.gguf".into()
}

fn default_llama_runtime_zip_url_intl() -> String {
    "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b9599-9ca265a/llama-prism-b1-9ca265a-bin-win-cuda-12.4-x64.zip"
        .into()
}

fn default_llama_cpu_runtime_zip_url_intl() -> String {
    "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b9599-9ca265a/llama-bin-win-cpu-x64.zip"
        .into()
}

fn default_cudart_zip_url_intl() -> String {
    "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b9599-9ca265a/cudart-llama-bin-win-cuda-12.4-x64.zip"
        .into()
}

impl Default for DependencyDownloadSettings {
    fn default() -> Self {
        Self {
            use_cn_sources: None,
            auto_download_on_startup: true,
            user_paused_ids: Vec::new(),
            bonsai_model_url_cn: default_bonsai_model_url_cn(),
            bonsai_model_url_intl: default_bonsai_model_url_intl(),
            bonsai_mmproj_url_cn: default_bonsai_mmproj_url_cn(),
            bonsai_mmproj_url_intl: default_bonsai_mmproj_url_intl(),
            llama_runtime_zip_url_cn: String::new(),
            llama_runtime_zip_url_intl: default_llama_runtime_zip_url_intl(),
            llama_cpu_runtime_zip_url_cn: String::new(),
            llama_cpu_runtime_zip_url_intl: default_llama_cpu_runtime_zip_url_intl(),
            cudart_zip_url_cn: String::new(),
            cudart_zip_url_intl: default_cudart_zip_url_intl(),
            grok_exe_url_cn: String::new(),
            grok_exe_url_intl: String::new(),
        }
    }
}

impl DependencyDownloadSettings {
    /// Whether to prefer domestic (CN) download URLs.
    pub fn prefer_cn(&self, cn_acceleration_enabled: bool) -> bool {
        self.use_cn_sources.unwrap_or(cn_acceleration_enabled)
    }

    /// Pick a download URL.
    ///
    /// - Only CN configured → CN  
    /// - Only intl configured → intl  
    /// - Both configured → follow `prefer_cn`  
    ///
    /// Second value is `true` only when the **CN slot** was chosen (so GitHub
    /// proxy may apply). Falling back to intl never counts as CN.
    pub fn pick_url<'a>(prefer_cn: bool, cn: &'a str, intl: &'a str) -> (&'a str, bool) {
        let cn = cn.trim();
        let intl = intl.trim();
        match (!cn.is_empty(), !intl.is_empty()) {
            (true, false) => (cn, true),
            (false, true) => (intl, false),
            (true, true) => {
                if prefer_cn {
                    (cn, true)
                } else {
                    (intl, false)
                }
            }
            (false, false) => ("", false),
        }
    }

    pub fn bonsai_model_url(&self, prefer_cn: bool) -> (&str, bool) {
        Self::pick_url(
            prefer_cn,
            &self.bonsai_model_url_cn,
            &self.bonsai_model_url_intl,
        )
    }

    pub fn bonsai_mmproj_url(&self, prefer_cn: bool) -> (&str, bool) {
        Self::pick_url(
            prefer_cn,
            &self.bonsai_mmproj_url_cn,
            &self.bonsai_mmproj_url_intl,
        )
    }

    pub fn llama_runtime_zip_url(&self, prefer_cn: bool) -> (&str, bool) {
        Self::pick_url(
            prefer_cn,
            &self.llama_runtime_zip_url_cn,
            &self.llama_runtime_zip_url_intl,
        )
    }

    pub fn llama_cpu_runtime_zip_url(&self, prefer_cn: bool) -> (&str, bool) {
        Self::pick_url(
            prefer_cn,
            &self.llama_cpu_runtime_zip_url_cn,
            &self.llama_cpu_runtime_zip_url_intl,
        )
    }

    pub fn cudart_zip_url(&self, prefer_cn: bool) -> (&str, bool) {
        Self::pick_url(
            prefer_cn,
            &self.cudart_zip_url_cn,
            &self.cudart_zip_url_intl,
        )
    }

    pub fn grok_exe_url(&self, prefer_cn: bool) -> (&str, bool) {
        Self::pick_url(prefer_cn, &self.grok_exe_url_cn, &self.grok_exe_url_intl)
    }

    pub fn is_user_paused(&self, id: &str) -> bool {
        self.user_paused_ids.iter().any(|x| x == id)
    }

    pub fn set_user_paused(&mut self, id: &str, paused: bool) {
        let id = id.trim();
        if id.is_empty() {
            return;
        }
        if paused {
            if !self.is_user_paused(id) {
                self.user_paused_ids.push(id.to_string());
            }
        } else {
            self.user_paused_ids.retain(|x| x != id);
        }
    }

    /// Rewrite ModelScope file-view pages into direct `/resolve/` download URLs.
    ///
    /// The ModelScope UI page (`/file/view/...`) returns HTML; binary downloads
    /// need `/resolve/{revision}/{filename}` (and may set anti-bot cookies).
    pub fn normalize_download_url(url: &str) -> String {
        let u = url.trim();
        if u.is_empty() {
            return String::new();
        }
        let (base, _query) = u.split_once('?').unwrap_or((u, ""));
        if let Some(rest) = base
            .strip_prefix("https://modelscope.cn/models/")
            .or_else(|| base.strip_prefix("https://www.modelscope.cn/models/"))
        {
            if let Some(idx) = rest.find("/file/view/") {
                let owner_repo = &rest[..idx];
                let after = &rest[idx + "/file/view/".len()..];
                return format!(
                    "https://modelscope.cn/models/{owner_repo}/resolve/{after}"
                );
            }
        }
        base.to_string()
    }
}

/// Mirrors / proxies used when installing MCP packages and Skills in China.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CnAccelerationSettings {
    /// Default on for this product (China-first). User can disable in Settings.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// npm registry for `npx` / npm-based MCP servers.
    #[serde(default = "default_npm_registry")]
    pub npm_registry: String,
    /// PyPI simple index for `uvx` / pip-based MCP servers.
    #[serde(default = "default_pypi_index")]
    pub pypi_index: String,
    /// Prefix proxy for GitHub raw/zip downloads (empty = direct).
    #[serde(default = "default_github_proxy")]
    pub github_proxy: String,
    /// ModelScope skills base URL (`npx skills add {base}/{id}`).
    #[serde(default = "default_modelscope_skills_base")]
    pub modelscope_skills_base: String,
}

fn default_npm_registry() -> String {
    "https://registry.npmmirror.com".into()
}

fn default_pypi_index() -> String {
    "https://pypi.tuna.tsinghua.edu.cn/simple".into()
}

fn default_github_proxy() -> String {
    "https://ghproxy.net/".into()
}

fn default_modelscope_skills_base() -> String {
    "https://modelscope.cn/skills".into()
}

impl Default for CnAccelerationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            npm_registry: default_npm_registry(),
            pypi_index: default_pypi_index(),
            github_proxy: default_github_proxy(),
            modelscope_skills_base: default_modelscope_skills_base(),
        }
    }
}

impl CnAccelerationSettings {
    /// Env vars to inject into the engine (and inherited MCP child processes).
    pub fn install_env_vars(&self) -> Vec<(String, String)> {
        if !self.enabled {
            return Vec::new();
        }
        let mut env = Vec::new();
        let npm = self.npm_registry.trim();
        if !npm.is_empty() {
            env.push(("npm_config_registry".into(), npm.to_string()));
            env.push(("NPM_CONFIG_REGISTRY".into(), npm.to_string()));
        }
        let pypi = self.pypi_index.trim();
        if !pypi.is_empty() {
            env.push(("UV_INDEX_URL".into(), pypi.to_string()));
            env.push(("PIP_INDEX_URL".into(), pypi.to_string()));
            env.push(("UV_DEFAULT_INDEX".into(), pypi.to_string()));
        }
        let gh = self.github_proxy.trim();
        if !gh.is_empty() {
            // Consumed by `npx skills` / skills-cn style CLIs when present.
            env.push(("SKILLS_GITHUB_MIRROR".into(), gh.trim_end_matches('/').to_string()));
            env.push(("GROKX_GITHUB_PROXY".into(), gh.to_string()));
        }
        let ms = self.modelscope_skills_base.trim();
        if !ms.is_empty() {
            env.push((
                "GROKX_MODELSCOPE_SKILLS_BASE".into(),
                ms.trim_end_matches('/').to_string(),
            ));
        }
        env.push(("GROKX_CN_ACCELERATION".into(), "1".into()));
        env
    }

    /// Rewrite a GitHub https URL through the configured proxy (when enabled).
    pub fn proxied_github_url(&self, url: &str) -> String {
        let u = url.trim();
        if !self.enabled || self.github_proxy.trim().is_empty() {
            return u.to_string();
        }
        if !(u.contains("github.com") || u.contains("codeload.github.com")) {
            return u.to_string();
        }
        if u.contains("ghproxy") || u.contains("mirror.gitcode") {
            return u.to_string();
        }
        let proxy = self.github_proxy.trim().trim_end_matches('/');
        format!("{proxy}/{u}")
    }

    /// Build a ModelScope skills install URL for `npx skills add`.
    pub fn modelscope_skill_url(&self, skill_id: &str) -> String {
        let base = self
            .modelscope_skills_base
            .trim()
            .trim_end_matches('/');
        let id = skill_id.trim().trim_start_matches('/');
        format!("{base}/{id}")
    }
}

/// Subset of ~/.grok/config.toml exposed in Settings → Engine config.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GrokEngineFormSettings {
    #[serde(default = "default_max_thoughts_width")]
    pub max_thoughts_width: u32,
    pub fork_secondary_model: Option<String>,
    #[serde(default)]
    pub compact_mode: bool,
    #[serde(default)]
    pub auto_update: bool,
}

fn default_max_thoughts_width() -> u32 {
    120
}

impl Default for GrokEngineFormSettings {
    fn default() -> Self {
        Self {
            max_thoughts_width: default_max_thoughts_width(),
            fork_secondary_model: None,
            compact_mode: false,
            auto_update: false,
        }
    }
}

impl GrokEngineFormSettings {
    /// Overlay values from raw Grok config TOML (file wins over stored defaults).
    pub fn merge_from_grok_config(&mut self, content: &str) {
        if let Some(v) = parse_toml_key_in_section(content, "ui", "max_thoughts_width") {
            if let Ok(n) = v.trim().parse::<u32>() {
                self.max_thoughts_width = n;
            }
        }
        if let Some(v) = parse_toml_key_in_section(content, "ui", "fork_secondary_model") {
            let s = v.trim().trim_matches('"').trim().to_string();
            self.fork_secondary_model = if s.is_empty() { None } else { Some(s) };
        }
        if let Some(v) = parse_toml_bool(content, "ui", "compact_mode") {
            self.compact_mode = v;
        }
        if let Some(v) = parse_toml_bool(content, "cli", "auto_update") {
            self.auto_update = v;
        }
    }
}

fn default_permission_mode() -> String {
    "ask".into()
}

fn default_ui_language() -> String {
    "zh-CN".into()
}

/// Canonical UI locale codes for the desktop shell.
pub mod ui_languages {
    pub const ZH_CN: &str = "zh-CN";
    pub const EN: &str = "en";

    pub fn normalize(raw: &str) -> &'static str {
        match raw.trim() {
            "en" | "en-US" | "en-GB" | "english" => EN,
            _ => ZH_CN,
        }
    }
}

/// Canonical permission modes used by Grokx + engine `[ui].permission_mode`.
pub mod permission_modes {
    pub const ASK: &str = "ask";
    pub const AUTO: &str = "auto";
    pub const ALWAYS_APPROVE: &str = "always-approve";

    pub fn normalize(raw: &str) -> &'static str {
        match raw.trim().to_ascii_lowercase().as_str() {
            "auto" => AUTO,
            "always-approve" | "always_approve" | "yolo" | "full-trust" | "full_trust"
            | "trusted" => ALWAYS_APPROVE,
            _ => ASK,
        }
    }

    pub fn is_full_trust(mode: &str) -> bool {
        normalize(mode) == ALWAYS_APPROVE
    }

    pub fn label(mode: &str) -> &'static str {
        match normalize(mode) {
            AUTO => "Auto",
            ALWAYS_APPROVE => "Full trust",
            _ => "Needs approval",
        }
    }
}

fn default_true() -> bool {
    true
}

impl Default for UserSettings {
    fn default() -> Self {
        Self::product_defaults()
    }
}

impl UserSettings {
    pub fn product_defaults() -> Self {
        Self {
            custom_engine_path: None,
            prefer_bundled_engine: true,
            model: Some("bonsai-local".into()),
            effort: Some("medium".into()),
            endpoint: ModelEndpointSettings::default(),
            model_profiles: Vec::new(),
            sync_to_grok_config: true,
            permission_mode: default_permission_mode(),
            auto_approve: None,
            ui_language: default_ui_language(),
            default_image_model: Some("qwen-image-3.0-pro".into()),
            default_video_model: Some("happyhorse-1.1-t2v".into()),
            grok_engine: GrokEngineFormSettings::default(),
            cn_acceleration: CnAccelerationSettings::default(),
            dependency_downloads: DependencyDownloadSettings::default(),
        }
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let path = path.as_ref();
        if !path.is_file() {
            let mut s = Self::product_defaults();
            if let Ok(raw) = std::fs::read_to_string(AppPaths::grok_cli_config()) {
                s.grok_engine.merge_from_grok_config(&raw);
            }
            return Ok(s);
        }
        let raw = std::fs::read_to_string(path)?;
        let mut s: Self = serde_json::from_str(&raw)?;
        if s.endpoint.model_id.is_empty() {
            s.endpoint.model_id = "bonsai-local".into();
        }
        // Migrate legacy auto_approve bool → permission_mode.
        if let Some(true) = s.auto_approve {
            if s.permission_mode.trim().is_empty()
                || s.permission_mode == default_permission_mode()
            {
                s.permission_mode = permission_modes::ALWAYS_APPROVE.into();
            }
        }
        s.permission_mode = permission_modes::normalize(&s.permission_mode).into();
        s.auto_approve = None;
        s.ui_language = ui_languages::normalize(&s.ui_language).into();
        if s.endpoint.max_completion_tokens.is_none() {
            s.endpoint.max_completion_tokens = Some(16_384);
        }
        if s.endpoint.context_window.is_none() {
            // Filled with this host's GPU tune in AppCore::bootstrap.
            s.endpoint.context_window = Some(98_304);
        }
        if s.model_profiles.is_empty() {
            s.model_profiles = vec![s.endpoint.clone()];
        }
        fill_missing_api_keys_among_profiles(&mut s.model_profiles);
        // Keep active endpoint key in sync with the selected profile / siblings.
        if let Some(model) = s.model.clone() {
            if let Some(p) = s.find_profile(&model).cloned() {
                s.apply_profile_to_endpoint(&p);
            }
        }
        if let Ok(raw) = std::fs::read_to_string(AppPaths::grok_cli_config()) {
            s.grok_engine.merge_from_grok_config(&raw);
        }
        Ok(s)
    }

    fn endpoint_public(ep: &ModelEndpointSettings) -> PublicEndpointSettings {
        let key = ep.api_key.as_deref().unwrap_or("");
        let (has_key, key_hint) = if key.is_empty() {
            (false, None)
        } else {
            (true, Some(mask_api_key_hint(key)))
        };
        PublicEndpointSettings {
            model_id: ep.model_id.clone(),
            name: ep.name.clone(),
            base_url: ep.base_url.clone(),
            has_api_key: has_key,
            api_key_hint: key_hint,
            env_key: ep.env_key.clone(),
            api_backend: ep.api_backend.clone(),
            context_window: ep.context_window,
            max_completion_tokens: ep.max_completion_tokens,
            default_effort: ep.default_effort.clone(),
            enabled: ep.enabled,
            vendor_id: ep.vendor_id.clone(),
            capability: ep.capability.clone(),
            performance_tier: ep.performance_tier.clone(),
            remote_confirmed: ep.remote_confirmed,
        }
    }

    pub fn apply_profile_to_endpoint(&mut self, profile: &ModelEndpointSettings) {
        let mut resolved = profile.clone();
        if resolved
            .api_key
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            if let Some(key) = self.sibling_api_key_for(&resolved) {
                resolved.api_key = Some(key);
            }
        }
        // Never keep a prior "local" key when switching to a remote endpoint.
        if !is_local_openai_base(resolved.base_url.as_deref())
            && resolved
                .api_key
                .as_deref()
                .map(is_local_placeholder_key)
                .unwrap_or(false)
        {
            resolved.api_key = self.sibling_api_key_for(&resolved);
        }
        self.endpoint = resolved;
        self.model = Some(profile.model_id.clone());
    }

    /// One API key per vendor: look up only within the same `vendor_id`.
    fn sibling_api_key_for(&self, target: &ModelEndpointSettings) -> Option<String> {
        let vid = target
            .vendor_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        for p in &self.model_profiles {
            if p.model_id == target.model_id {
                continue;
            }
            if p.vendor_id.as_deref().map(str::trim) != Some(vid) {
                continue;
            }
            if let Some(k) = p.api_key.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                if api_key_usable_for_profile(k, target) {
                    return Some(k.to_string());
                }
            }
        }
        None
    }

    pub fn find_profile(&self, model_id: &str) -> Option<&ModelEndpointSettings> {
        let id = model_id.trim();
        self.model_profiles
            .iter()
            .find(|p| p.model_id == id)
            .or_else(|| {
                if self.endpoint.model_id == id {
                    Some(&self.endpoint)
                } else {
                    None
                }
            })
    }

    pub fn permission_mode_normalized(&self) -> &'static str {
        permission_modes::normalize(&self.permission_mode)
    }

    pub fn is_full_trust(&self) -> bool {
        permission_modes::is_full_trust(&self.permission_mode)
    }

    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), ConfigError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(path, raw)?;
        Ok(())
    }

    /// Public view for UI: mask api_key.
    pub fn public_view(&self) -> PublicUserSettings {
        PublicUserSettings {
            custom_engine_path: self.custom_engine_path.clone(),
            prefer_bundled_engine: self.prefer_bundled_engine,
            model: self.model.clone(),
            effort: self.effort.clone(),
            sync_to_grok_config: self.sync_to_grok_config,
            permission_mode: self.permission_mode_normalized().to_string(),
            // Legacy mirror for older UI builds.
            auto_approve: self.is_full_trust(),
            ui_language: ui_languages::normalize(&self.ui_language).to_string(),
            endpoint: Self::endpoint_public(&self.endpoint),
            model_profiles: self
                .model_profiles
                .iter()
                .map(Self::endpoint_public)
                .collect(),
            grok_config_path: AppPaths::grok_cli_config().display().to_string(),
            grok_default_model: parse_grok_config_default_model(
                &std::fs::read_to_string(AppPaths::grok_cli_config()).unwrap_or_default(),
            ),
            default_image_model: self.default_image_model.clone(),
            default_video_model: self.default_video_model.clone(),
            grok_engine: self.grok_engine.clone(),
            cn_acceleration: self.cn_acceleration.clone(),
            dependency_downloads: self.dependency_downloads.clone(),
        }
    }

    /// Env vars to inject when spawning the engine.
    pub fn engine_env(&self) -> Vec<(String, String)> {
        let mut env = Vec::new();
        let mut seen = std::collections::HashSet::new();

        // Inject every remote profile secret under its stable env_key name so
        // ~/.grok/config.toml can reference env_key without storing plaintext.
        for p in &self.model_profiles {
            if p.model_id.starts_with("__vendor__") {
                continue;
            }
            let Some(key) = p
                .api_key
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if is_local_placeholder_key(key) {
                continue;
            }
            let name = p
                .env_key
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| secret_env_name_for_profile(p));
            if seen.insert(name.clone()) {
                env.push((name, key.to_string()));
            }
        }

        if let Some(key) = self
            .endpoint
            .api_key
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            // Active endpoint still exported as XAI_* for engine auth helpers.
            if !is_local_placeholder_key(key) {
                env.push(("XAI_API_KEY".into(), key.to_string()));
                env.push(("GROK_CODE_XAI_API_KEY".into(), key.to_string()));
            }
        } else if let Some(env_key) = self
            .endpoint
            .env_key
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if let Ok(v) = std::env::var(env_key) {
                env.push(("XAI_API_KEY".into(), v));
            }
        }
        if let Some(base) = self
            .endpoint
            .base_url
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            env.push(("GROK_MODELS_BASE_URL".into(), base.to_string()));
        }
        // Bailian media MCP (default-mounted) reads DASHSCOPE_API_KEY.
        if let Some(key) = find_bailian_api_key(self) {
            if seen.insert("DASHSCOPE_API_KEY".into()) {
                env.push(("DASHSCOPE_API_KEY".into(), key));
            }
        }
        if let Some(m) = self
            .default_image_model
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            env.push(("GROKX_DEFAULT_IMAGE_MODEL".into(), m.to_string()));
        }
        if let Some(m) = self
            .default_video_model
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            env.push(("GROKX_DEFAULT_VIDEO_MODEL".into(), m.to_string()));
        }
        // CN mirrors for npx/uvx MCP cold-starts and skills CLIs.
        for (k, v) in self.cn_acceleration.install_env_vars() {
            if seen.insert(k.clone()) {
                env.push((k, v));
            }
        }
        env
    }

    /// Merge endpoint fields into ~/.grok/config.toml without wiping other keys.
    pub fn sync_endpoint_to_grok_toml(&self) -> Result<(), ConfigError> {
        if !self.sync_to_grok_config {
            return Ok(());
        }
        let path = AppPaths::grok_cli_config();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existing = if path.is_file() {
            let raw = std::fs::read_to_string(&path)?;
            raw.trim_start_matches('\u{feff}').to_string()
        } else {
            String::new()
        };
        let mut profiles = self.model_profiles.clone();
        fill_missing_api_keys_among_profiles(&mut profiles);
        let merged = merge_models_into_toml(&existing, &profiles, self.model.as_deref());
        // Write UTF-8 without BOM — a BOM makes `[models]` unmatchable and sync
        // appends a second `[models]`, which grok rejects as duplicate key.
        std::fs::write(&path, merged)?;
        // Default-mount Bailian media MCP + built-in npx MCPs.
        if let Err(err) = ensure_default_media_mcp_in_grok_toml(None) {
            let _ = err;
        }
        let _ = ensure_default_builtin_mcps_in_grok_toml(Some(&self.cn_acceleration));
        Ok(())
    }

    /// Sync this app's permission mode into ~/.grok/config.toml for the engine.
    pub fn sync_permission_mode_to_grok_toml(&self) -> Result<(), ConfigError> {
        self.sync_grok_engine_form_to_grok_toml()
    }

    /// Write `[ui]` / `[cli]` engine settings into ~/.grok/config.toml.
    pub fn sync_grok_engine_form_to_grok_toml(&self) -> Result<(), ConfigError> {
        if !self.sync_to_grok_config {
            return Ok(());
        }
        let path = AppPaths::grok_cli_config();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existing = if path.is_file() {
            std::fs::read_to_string(&path)?
        } else {
            String::new()
        };
        let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
        if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        let mode = self.permission_mode_normalized();
        let yolo = mode == permission_modes::ALWAYS_APPROVE;
        upsert_toml_section_key(
            &mut lines,
            "ui",
            "permission_mode",
            &format!("\"{mode}\""),
        );
        upsert_toml_section_key(
            &mut lines,
            "ui",
            "yolo",
            if yolo { "true" } else { "false" },
        );
        upsert_toml_section_key(
            &mut lines,
            "ui",
            "max_thoughts_width",
            &self.grok_engine.max_thoughts_width.to_string(),
        );
        if let Some(ref fork) = self
            .grok_engine
            .fork_secondary_model
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
            upsert_toml_section_key(
                &mut lines,
                "ui",
                "fork_secondary_model",
                &format!("\"{}\"", escape_toml_str(fork.trim())),
            );
        }
        upsert_toml_section_key(
            &mut lines,
            "ui",
            "compact_mode",
            if self.grok_engine.compact_mode {
                "true"
            } else {
                "false"
            },
        );
        upsert_toml_section_key(
            &mut lines,
            "cli",
            "auto_update",
            if self.grok_engine.auto_update {
                "true"
            } else {
                "false"
            },
        );
        let mut out = lines.join("\n");
        if !out.ends_with('\n') {
            out.push('\n');
        }
        std::fs::write(path, out)?;
        Ok(())
    }

    /// Write a specific mode into ~/.grok/config.toml (used at agent spawn).
    pub fn apply_engine_permission_mode(&self, mode: &str) -> Result<(), ConfigError> {
        let mode = permission_modes::normalize(mode);
        let yolo = mode == permission_modes::ALWAYS_APPROVE;
        self.write_ui_permission_mode(mode, yolo)
    }

    /// Force the engine to ask for tool permissions (overrides always-approve in config).
    pub fn force_permission_mode_ask(&self) -> Result<(), ConfigError> {
        self.apply_engine_permission_mode(permission_modes::ASK)
    }

    /// Force engine YOLO / always-approve in ~/.grok/config.toml.
    pub fn force_permission_mode_always_approve(&self) -> Result<(), ConfigError> {
        self.apply_engine_permission_mode(permission_modes::ALWAYS_APPROVE)
    }

    fn write_ui_permission_mode(&self, mode: &str, yolo: bool) -> Result<(), ConfigError> {
        let path = AppPaths::grok_cli_config();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existing = if path.is_file() {
            std::fs::read_to_string(&path)?
        } else {
            String::new()
        };
        let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
        if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        upsert_toml_section_key(
            &mut lines,
            "ui",
            "permission_mode",
            &format!("\"{mode}\""),
        );
        upsert_toml_section_key(
            &mut lines,
            "ui",
            "yolo",
            if yolo { "true" } else { "false" },
        );
        let mut out = lines.join("\n");
        if !out.ends_with('\n') {
            out.push('\n');
        }
        std::fs::write(path, out)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicEndpointSettings {
    pub model_id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
    pub env_key: Option<String>,
    pub api_backend: Option<String>,
    pub context_window: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    pub default_effort: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub performance_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_confirmed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicUserSettings {
    pub custom_engine_path: Option<String>,
    pub prefer_bundled_engine: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub sync_to_grok_config: bool,
    /// `ask` | `auto` | `always-approve`
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Legacy mirror: true when mode is full trust.
    #[serde(default)]
    pub auto_approve: bool,
    /// `zh-CN` | `en`
    #[serde(default = "default_ui_language")]
    pub ui_language: String,
    pub endpoint: PublicEndpointSettings,
    pub model_profiles: Vec<PublicEndpointSettings>,
    pub grok_config_path: String,
    /// `[models].default` from ~/.grok/config.toml (if readable).
    pub grok_default_model: Option<String>,
    /// Default Bailian image model (settings.json).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_image_model: Option<String>,
    /// Default Bailian video model (settings.json).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_video_model: Option<String>,
    /// `[ui]` / `[cli]` fields for Settings → Engine config.
    #[serde(default)]
    pub grok_engine: GrokEngineFormSettings,
    /// Domestic download acceleration.
    #[serde(default)]
    pub cn_acceleration: CnAccelerationSettings,
    /// Dependency download URLs / policies.
    #[serde(default)]
    pub dependency_downloads: DependencyDownloadSettings,
}

/// One model profile patch from the Settings UI.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelProfileInput {
    pub model_id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub clear_api_key: Option<bool>,
    pub api_backend: Option<String>,
    pub context_window: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    /// Omit / null → keep previous or default true.
    pub enabled: Option<bool>,
    /// Stable vendor row id from Settings UI.
    pub vendor_id: Option<String>,
    /// `llm` | `vlm` | `image` | `video` | `local`
    pub capability: Option<String>,
    /// `strong` | `medium` | `weak` (custom vendors)
    pub performance_tier: Option<String>,
    /// Confirmed by remote `/models` fetch
    pub remote_confirmed: Option<bool>,
}

/// Patch used by the UI save form.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SettingsUpdate {
    pub custom_engine_path: Option<String>,
    pub prefer_bundled_engine: Option<bool>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub sync_to_grok_config: Option<bool>,
    /// Preferred: `ask` | `auto` | `always-approve`
    pub permission_mode: Option<String>,
    /// Legacy: maps to always-approve when true, ask when false (if permission_mode omitted).
    pub auto_approve: Option<bool>,
    /// `zh-CN` | `en`
    pub ui_language: Option<String>,
    /// Replace the full model profile list.
    pub model_profiles: Option<Vec<ModelProfileInput>>,
    /// Active / default model id (composer + engine default).
    pub active_model_id: Option<String>,
    /// Update `[models].default` in ~/.grok/config.toml only.
    pub grok_default_model: Option<String>,
    /// Default Bailian image model id.
    pub default_image_model: Option<String>,
    /// Default Bailian video model id.
    pub default_video_model: Option<String>,
    pub grok_max_thoughts_width: Option<u32>,
    pub grok_fork_secondary_model: Option<String>,
    pub grok_compact_mode: Option<bool>,
    pub grok_auto_update: Option<bool>,
    /// Toggle CN acceleration (mirrors for npm / PyPI / GitHub / ModelScope).
    pub cn_acceleration_enabled: Option<bool>,
    pub cn_npm_registry: Option<String>,
    pub cn_pypi_index: Option<String>,
    pub cn_github_proxy: Option<String>,
    pub cn_modelscope_skills_base: Option<String>,
    /// When set, replaces `dependency_downloads.use_cn_sources` (`null` JSON → clear override).
    #[serde(default)]
    pub dependency_use_cn_sources: Option<Option<bool>>,
    pub dependency_auto_download_on_startup: Option<bool>,
    /// Full replace of dependency download URL config (from Settings → Dependencies).
    pub dependency_downloads: Option<DependencyDownloadSettings>,
    pub endpoint_model_id: Option<String>,
    pub endpoint_name: Option<String>,
    pub endpoint_base_url: Option<String>,
    /// Empty string clears; omit to keep existing.
    pub endpoint_api_key: Option<String>,
    pub clear_api_key: Option<bool>,
    pub endpoint_env_key: Option<String>,
    pub endpoint_api_backend: Option<String>,
    pub endpoint_context_window: Option<u64>,
    pub endpoint_max_completion_tokens: Option<u64>,
    pub endpoint_default_effort: Option<String>,
}

impl UserSettings {
    pub fn apply_update(&mut self, u: SettingsUpdate) {
        if let Some(v) = u.custom_engine_path {
            self.custom_engine_path = empty_to_none(v);
        }
        if let Some(v) = u.prefer_bundled_engine {
            self.prefer_bundled_engine = v;
        }
        if let Some(v) = u.model {
            self.model = empty_to_none(v);
            if let Some(ref m) = self.model {
                self.endpoint.model_id = m.clone();
            }
        }
        if let Some(v) = u.effort {
            self.effort = empty_to_none(v.clone());
            self.endpoint.default_effort = empty_to_none(v);
        }
        if let Some(v) = u.sync_to_grok_config {
            self.sync_to_grok_config = v;
        }
        if let Some(v) = u.permission_mode {
            self.permission_mode = permission_modes::normalize(&v).into();
            self.auto_approve = None;
        } else if let Some(v) = u.auto_approve {
            self.permission_mode = if v {
                permission_modes::ALWAYS_APPROVE.into()
            } else {
                permission_modes::ASK.into()
            };
            self.auto_approve = None;
        }
        if let Some(v) = u.ui_language {
            self.ui_language = ui_languages::normalize(&v).into();
        }
        if let Some(profiles) = u.model_profiles {
            let existing: std::collections::HashMap<String, ModelEndpointSettings> = self
                .model_profiles
                .iter()
                .map(|p| (p.model_id.clone(), p.clone()))
                .collect();
            // One key per vendor — never share across vendor_id.
            let mut key_by_vendor: std::collections::HashMap<String, String> = self
                .model_profiles
                .iter()
                .filter_map(|p| {
                    let vid = p.vendor_id.as_deref()?.trim();
                    let key = p.api_key.as_deref()?.trim();
                    if vid.is_empty() || key.is_empty() {
                        None
                    } else if !api_key_usable_for_profile(key, p) {
                        None
                    } else {
                        Some((vid.to_string(), key.to_string()))
                    }
                })
                .collect();
            // Fresh keys typed in this save (vendor form may only attach the draft to one row).
            for input in &profiles {
                let key = input
                    .api_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && !s.contains('•') && !s.contains('*'));
                let Some(key) = key else { continue };
                let Some(vid) = input
                    .vendor_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let probe = ModelEndpointSettings {
                    model_id: input.model_id.clone(),
                    name: None,
                    base_url: input.base_url.clone(),
                    api_key: None,
                    env_key: None,
                    api_backend: None,
                    context_window: None,
                    max_completion_tokens: None,
                    default_effort: None,
                    enabled: true,
                    vendor_id: Some(vid.to_string()),
                    capability: None,
                    performance_tier: None,
                    remote_confirmed: None,
                };
                if api_key_usable_for_profile(key, &probe) {
                    key_by_vendor.insert(vid.to_string(), key.to_string());
                }
            }
            self.model_profiles = profiles
                .into_iter()
                .filter_map(|input| {
                    let id = input.model_id.trim().to_string();
                    if id.is_empty() {
                        return None;
                    }
                    let mut ep = model_profile_input_to_settings(input)?;
                    if ep.api_key.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
                        // Prefer same model id, but only if that prior row actually had a key
                        // and still belongs to the same vendor.
                        if let Some(prev) = existing.get(&id) {
                            let same_vendor = match (
                                ep.vendor_id.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                                prev.vendor_id.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                            ) {
                                (Some(a), Some(b)) => a == b,
                                // Legacy rows without vendor_id: keep by model id only.
                                (None, None) => true,
                                _ => false,
                            };
                            if same_vendor {
                                if let Some(k) = prev
                                    .api_key
                                    .as_ref()
                                    .map(|s| s.trim())
                                    .filter(|s| !s.is_empty())
                                {
                                    if api_key_usable_for_profile(k, &ep) {
                                        ep.api_key = Some(k.to_string());
                                    }
                                }
                            }
                            ep.max_completion_tokens = ep
                                .max_completion_tokens
                                .or(prev.max_completion_tokens);
                        }
                    }
                    if ep.api_key.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
                        if let Some(vid) =
                            ep.vendor_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
                        {
                            if let Some(key) = key_by_vendor.get(vid) {
                                if api_key_usable_for_profile(key, &ep) {
                                    ep.api_key = Some(key.clone());
                                }
                            }
                        }
                    }
                    Some(ep)
                })
                .collect();
            fill_missing_api_keys_among_profiles(&mut self.model_profiles);
            if self.model_profiles.is_empty() {
                self.model_profiles = vec![self.endpoint.clone()];
            }
        }
        let mut applied_active_model = false;
        if let Some(ref id) = u.active_model_id {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                self.model = Some(trimmed.to_string());
                if let Some(p) = self.find_profile(trimmed).cloned() {
                    self.apply_profile_to_endpoint(&p);
                } else {
                    self.endpoint.model_id = trimmed.to_string();
                }
                applied_active_model = true;
            }
        }
        if let Some(v) = u.endpoint_model_id {
            if !v.trim().is_empty() {
                self.endpoint.model_id = v.trim().to_string();
                self.model = Some(self.endpoint.model_id.clone());
            }
        }
        if let Some(v) = u.endpoint_name {
            self.endpoint.name = empty_to_none(v);
        }
        if let Some(v) = u.endpoint_base_url {
            self.endpoint.base_url = empty_to_none(v);
        }
        if u.clear_api_key == Some(true) {
            self.endpoint.api_key = None;
        } else if let Some(v) = u.endpoint_api_key {
            // Ignore masked placeholders from UI.
            if !v.trim().is_empty() && !v.contains('•') && !v.contains('*') {
                self.endpoint.api_key = Some(v.trim().to_string());
            }
        }
        if let Some(v) = u.endpoint_env_key {
            self.endpoint.env_key = empty_to_none(v);
        }
        if let Some(v) = u.endpoint_api_backend {
            self.endpoint.api_backend = empty_to_none(v);
        }
        if let Some(v) = u.endpoint_context_window {
            self.endpoint.context_window = Some(v);
        }
        if let Some(v) = u.endpoint_max_completion_tokens {
            self.endpoint.max_completion_tokens = Some(v);
        }
        if let Some(v) = u.endpoint_default_effort {
            self.endpoint.default_effort = empty_to_none(v.clone());
            self.effort = empty_to_none(v);
        }
        if let Some(default) = u.grok_default_model {
            let trimmed = default.trim();
            if !trimmed.is_empty() {
                // When the UI also sends active_model_id, that is the live
                // session/composer model — do not overwrite it with the default.
                if !applied_active_model {
                    self.model = Some(trimmed.to_string());
                    if let Some(p) = self.find_profile(trimmed).cloned() {
                        self.apply_profile_to_endpoint(&p);
                    }
                }
                let _ = write_grok_default_model(trimmed);
            }
        }
        if let Some(v) = u.default_image_model {
            self.default_image_model = empty_to_none(v);
        }
        if let Some(v) = u.default_video_model {
            self.default_video_model = empty_to_none(v);
        }
        if let Some(v) = u.grok_max_thoughts_width {
            self.grok_engine.max_thoughts_width = v.max(1);
        }
        if let Some(v) = u.grok_fork_secondary_model {
            self.grok_engine.fork_secondary_model = empty_to_none(v);
        }
        if let Some(v) = u.grok_compact_mode {
            self.grok_engine.compact_mode = v;
        }
        if let Some(v) = u.grok_auto_update {
            self.grok_engine.auto_update = v;
        }
        if let Some(v) = u.cn_acceleration_enabled {
            self.cn_acceleration.enabled = v;
        }
        if let Some(v) = u.cn_npm_registry {
            let t = v.trim().to_string();
            if !t.is_empty() {
                self.cn_acceleration.npm_registry = t;
            }
        }
        if let Some(v) = u.cn_pypi_index {
            let t = v.trim().to_string();
            if !t.is_empty() {
                self.cn_acceleration.pypi_index = t;
            }
        }
        if let Some(v) = u.cn_github_proxy {
            self.cn_acceleration.github_proxy = v.trim().to_string();
        }
        if let Some(v) = u.cn_modelscope_skills_base {
            let t = v.trim().to_string();
            if !t.is_empty() {
                self.cn_acceleration.modelscope_skills_base = t;
            }
        }
        if let Some(v) = u.dependency_use_cn_sources {
            self.dependency_downloads.use_cn_sources = v;
        }
        if let Some(v) = u.dependency_auto_download_on_startup {
            self.dependency_downloads.auto_download_on_startup = v;
        }
        if let Some(deps) = u.dependency_downloads {
            // UI URL form does not edit pause latch — keep existing paused ids.
            let paused = self.dependency_downloads.user_paused_ids.clone();
            self.dependency_downloads = deps;
            self.dependency_downloads.user_paused_ids = paused;
        }
    }
}

fn normalize_base_url_key(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if !s.contains("://") && !s.is_empty() {
        s = format!("http://{s}");
    }
    while s.ends_with('/') {
        s.pop();
    }
    s.to_ascii_lowercase()
}

fn is_local_openai_base(base: Option<&str>) -> bool {
    let Some(b) = base.map(normalize_base_url_key).filter(|s| !s.is_empty()) else {
        return false;
    };
    b.contains("127.0.0.1") || b.contains("localhost")
}

fn is_local_placeholder_key(key: &str) -> bool {
    key.trim().eq_ignore_ascii_case("local")
}

/// Do not copy the Bonsai `local` key onto remote vendor endpoints.
fn api_key_usable_for_profile(key: &str, profile: &ModelEndpointSettings) -> bool {
    if is_local_placeholder_key(key) && !is_local_openai_base(profile.base_url.as_deref()) {
        return false;
    }
    true
}

/// Fill empty keys from siblings that share the same `vendor_id` only.
fn fill_missing_api_keys_among_profiles(profiles: &mut [ModelEndpointSettings]) {
    let key_by_vendor: std::collections::HashMap<String, String> = profiles
        .iter()
        .filter_map(|p| {
            let vid = p.vendor_id.as_deref()?.trim();
            let key = p.api_key.as_deref()?.trim();
            if vid.is_empty() || key.is_empty() {
                None
            } else if !api_key_usable_for_profile(key, p) {
                None
            } else {
                Some((vid.to_string(), key.to_string()))
            }
        })
        .collect();
    for p in profiles.iter_mut() {
        if p.api_key
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            continue;
        }
        let Some(vid) = p.vendor_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if let Some(key) = key_by_vendor.get(vid) {
            if api_key_usable_for_profile(key, p) {
                p.api_key = Some(key.clone());
            }
        }
    }
}

/// Mask for UI: first 4 + bullets + last 4 (or short placeholder).
pub fn mask_api_key_hint(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    if key.len() <= 8 {
        return format!("{}••••", &key[..key.len().min(2)]);
    }
    let prefix = &key[..4];
    let suffix = &key[key.len().saturating_sub(4)..];
    format!("{prefix}••••{suffix}")
}

fn model_profile_input_to_settings(input: ModelProfileInput) -> Option<ModelEndpointSettings> {
    let model_id = input.model_id.trim();
    if model_id.is_empty() {
        return None;
    }
    let mut ep = ModelEndpointSettings {
        model_id: model_id.to_string(),
        name: input.name.and_then(|s| empty_to_none(s)),
        base_url: input.base_url.and_then(|s| empty_to_none(s)),
        api_key: None,
        env_key: None,
        api_backend: input.api_backend.and_then(|s| empty_to_none(s)),
        context_window: input.context_window,
        max_completion_tokens: input.max_completion_tokens,
        default_effort: None,
        enabled: input.enabled.unwrap_or(true),
        vendor_id: input.vendor_id.and_then(|s| empty_to_none(s)),
        capability: input
            .capability
            .and_then(|s| empty_to_none(s))
            .map(|s| s.to_ascii_lowercase()),
        performance_tier: input
            .performance_tier
            .and_then(|s| empty_to_none(s))
            .map(|s| s.to_ascii_lowercase()),
        remote_confirmed: input.remote_confirmed,
    };
    if input.clear_api_key == Some(true) {
        ep.api_key = None;
    } else if let Some(v) = input.api_key {
        if !v.trim().is_empty() && !v.contains('•') && !v.contains('*') {
            ep.api_key = Some(v.trim().to_string());
        }
    }
    Some(ep)
}

fn write_grok_default_model(model_id: &str) -> Result<(), ConfigError> {
    let path = AppPaths::grok_cli_config();
    let existing = if path.is_file() {
        std::fs::read_to_string(&path)?
    } else {
        String::new()
    };
    let mut lines: Vec<String> = existing
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|s| s.to_string())
        .collect();
    dedupe_toml_section_headers(&mut lines);
    if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }
    upsert_toml_section_key(
        &mut lines,
        "models",
        "default",
        &format!("\"{}\"", escape_toml_str(model_id)),
    );
    upsert_toml_section_key(&mut lines, "models", "remote_fetch", "false");
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// Read `[models].default` from raw Grok config TOML.
pub fn parse_grok_config_default_model(content: &str) -> Option<String> {
    parse_toml_key_in_section(content, "models", "default").map(|s| {
        s.trim_matches('"').trim().to_string()
    })
}

fn parse_toml_bool(content: &str, section: &str, key: &str) -> Option<bool> {
    parse_toml_key_in_section(content, section, key).and_then(|s| {
        match s.trim().trim_matches('"').to_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        }
    })
}

fn parse_toml_key_in_section(content: &str, section: &str, key: &str) -> Option<String> {
    let header = format!("[{section}]");
    let mut in_section = false;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            in_section = t == header;
            continue;
        }
        if !in_section || t.starts_with('#') || t.is_empty() {
            continue;
        }
        if let Some((k, v)) = t.split_once('=') {
            if k.trim() == key {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn empty_to_none(s: String) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Merge all model profiles + default into ~/.grok/config.toml.
fn merge_models_into_toml(
    existing: &str,
    profiles: &[ModelEndpointSettings],
    default_model: Option<&str>,
) -> String {
    let chat_profiles: Vec<&ModelEndpointSettings> = profiles
        .iter()
        .filter(|p| !p.model_id.starts_with("__vendor__"))
        .filter(|p| !profile_is_media_tool(p))
        .collect();

    let enabled_chat: Vec<&ModelEndpointSettings> = chat_profiles
        .iter()
        .copied()
        .filter(|p| p.enabled)
        .collect();

    let default = default_model
        .filter(|s| !s.trim().is_empty())
        .filter(|s| !s.starts_with("__vendor__"))
        .filter(|s| {
            !profiles
                .iter()
                .find(|p| p.model_id == *s)
                .map(profile_is_media_tool)
                .unwrap_or_else(|| is_media_tool_model_id(s))
        })
        .or_else(|| enabled_chat.first().map(|p| p.model_id.as_str()))
        .unwrap_or("bonsai-local");

    let mut lines: Vec<String> = existing
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|s| s.to_string())
        .collect();
    dedupe_toml_section_headers(&mut lines);
    if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }

    upsert_toml_section_key(&mut lines, "models", "default", &format!("\"{default}\""));
    upsert_toml_section_key(&mut lines, "models", "remote_fetch", "false");

    // Scheme B: built-in web_search uses Bailian Qwen hosted tools; keep local
    // web_fetch off (legal / product policy).
    let web_search_model = pick_bailian_web_search_model(&enabled_chat, &chat_profiles);
    upsert_toml_section_key(
        &mut lines,
        "models",
        "web_search",
        &format!("\"{web_search_model}\""),
    );
    upsert_toml_section_key(&mut lines, "features", "web_fetch", "false");

    let mut keep_ids = std::collections::HashSet::new();
    for ep in &enabled_chat {
        keep_ids.insert(ep.model_id.trim().to_string());
        merge_one_model_profile(&mut lines, ep);
    }
    // Always retain the default id even if somehow filtered.
    keep_ids.insert(default.to_string());

    // Ensure the web_search model section exists (env_key → DASHSCOPE_API_KEY)
    // even when the user has not enabled that Qwen id for chat.
    if keep_ids.insert(web_search_model.clone()) {
        let bailian_base = chat_profiles
            .iter()
            .find(|p| looks_like_bailian_profile(p))
            .and_then(|p| p.base_url.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("https://dashscope.aliyuncs.com/compatible-mode/v1");
        let synthetic = ModelEndpointSettings {
            model_id: web_search_model.clone(),
            name: Some(web_search_model.clone()),
            base_url: Some(bailian_base.to_string()),
            api_key: find_bailian_api_key_from_profiles(profiles),
            env_key: Some("DASHSCOPE_API_KEY".into()),
            api_backend: Some("responses".into()),
            context_window: Some(1_048_576),
            max_completion_tokens: Some(8192),
            default_effort: None,
            enabled: true,
            vendor_id: None,
            capability: Some("llm".into()),
            performance_tier: None,
            remote_confirmed: None,
        };
        merge_one_model_profile(&mut lines, &synthetic);
    } else if let Some(ep) = chat_profiles
        .iter()
        .find(|p| p.model_id.trim() == web_search_model)
    {
        // Already kept via enabled_chat or will be pruned — re-merge to force
        // responses backend for networking.
        let mut ep = (*ep).clone();
        if ep.api_backend.as_deref().unwrap_or("").trim().is_empty() {
            ep.api_backend = Some("responses".into());
        }
        if ep.env_key.as_deref().unwrap_or("").trim().is_empty()
            && ep.api_key.as_deref().unwrap_or("").trim().is_empty()
        {
            ep.env_key = Some("DASHSCOPE_API_KEY".into());
        }
        merge_one_model_profile(&mut lines, &ep);
    }

    prune_stale_model_sections(&mut lines, &keep_ids);

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

const DEFAULT_BAILIAN_WEB_SEARCH_MODEL: &str = "qwen3.7-flash";

fn is_qwen_web_search_model_id(model_id: &str) -> bool {
    let id = model_id.trim().to_ascii_lowercase();
    id.starts_with("qwen3.7-")
        || id.starts_with("qwen3.6-")
        || id.starts_with("qwen3.5-")
        || id.starts_with("qwen3.8-")
}

fn pick_bailian_web_search_model(
    enabled_chat: &[&ModelEndpointSettings],
    all_chat: &[&ModelEndpointSettings],
) -> String {
    const PREFERRED: &[&str] = &[
        "qwen3.7-flash",
        "qwen3.7-plus",
        "qwen3.7-max",
    ];
    for id in PREFERRED {
        if enabled_chat.iter().any(|p| p.model_id.trim() == *id) {
            return (*id).to_string();
        }
    }
    if let Some(p) = enabled_chat
        .iter()
        .find(|p| is_qwen_web_search_model_id(&p.model_id))
    {
        return p.model_id.trim().to_string();
    }
    for id in PREFERRED {
        if all_chat.iter().any(|p| p.model_id.trim() == *id) {
            return (*id).to_string();
        }
    }
    DEFAULT_BAILIAN_WEB_SEARCH_MODEL.to_string()
}

fn find_bailian_api_key_from_profiles(profiles: &[ModelEndpointSettings]) -> Option<String> {
    for p in profiles {
        if !looks_like_bailian_profile(p) {
            continue;
        }
        if let Some(k) = p.api_key.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if k.eq_ignore_ascii_case("local") {
                continue;
            }
            return Some(k.to_string());
        }
    }
    None
}

/// Media backends are MCP tools — never sync as grok chat `[model.*]` entries.
fn is_media_tool_model_id(model_id: &str) -> bool {
    let id = model_id.trim().to_ascii_lowercase();
    id.starts_with("qwen-image") || id.starts_with("happyhorse")
}

fn profile_is_media_tool(ep: &ModelEndpointSettings) -> bool {
    match ep.capability.as_deref().map(str::trim) {
        Some(c) if c.eq_ignore_ascii_case("image") || c.eq_ignore_ascii_case("video") => true,
        _ => is_media_tool_model_id(&ep.model_id),
    }
}

/// Stable process-env name for a profile's secret (written as `env_key` in toml).
fn secret_env_name_for_profile(ep: &ModelEndpointSettings) -> String {
    if is_local_openai_base(ep.base_url.as_deref())
        || ep.model_id.eq_ignore_ascii_case("bonsai-local")
    {
        return "AGENT_LOCAL_API_KEY".into();
    }
    let url = ep
        .base_url
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let id = ep.model_id.to_ascii_lowercase();
    if url.contains("deepseek") || id.starts_with("deepseek") {
        return "DEEPSEEK_API_KEY".into();
    }
    if url.contains("dashscope")
        || url.contains("aliyun")
        || url.contains("bailian")
        || id.starts_with("qwen")
        || id.starts_with("happyhorse")
    {
        return "DASHSCOPE_API_KEY".into();
    }
    if url.contains("x.ai") || url.contains("xai") || id.starts_with("grok") {
        return "XAI_API_KEY".into();
    }
    let mut safe = String::new();
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() {
            safe.push(ch.to_ascii_uppercase());
        } else {
            safe.push('_');
        }
    }
    if safe.is_empty() {
        "AGENT_MODEL_API_KEY".into()
    } else {
        format!("AGENT_MODEL_KEY_{safe}")
    }
}

/// Drop `[model."…"]` / `[model.id]` sections that are no longer in Settings.
fn prune_stale_model_sections(
    lines: &mut Vec<String>,
    keep_ids: &std::collections::HashSet<String>,
) {
    let headers: Vec<(usize, String)> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, line)| {
            let t = line.trim();
            if !(t.starts_with('[') && t.ends_with(']')) {
                return None;
            }
            let inner = &t[1..t.len() - 1];
            let id = parse_model_section_id(inner)?;
            Some((i, id))
        })
        .collect();

    let mut remove_ids = Vec::new();
    for (_idx, id) in headers {
        if !keep_ids.contains(&id) {
            remove_ids.push(id);
        }
    }
    remove_ids.sort();
    remove_ids.dedup();
    for id in remove_ids {
        remove_toml_section(lines, &format!("model.\"{id}\""));
        remove_toml_section(lines, &format!("model.{id}"));
    }
}

fn parse_model_section_id(inner: &str) -> Option<String> {
    let inner = inner.trim();
    if let Some(rest) = inner.strip_prefix("model.") {
        let rest = rest.trim();
        if let Some(quoted) = rest
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
        {
            return Some(quoted.to_string());
        }
        if !rest.is_empty() && !rest.contains('.') && !rest.contains('[') {
            return Some(rest.to_string());
        }
    }
    None
}

fn remove_toml_section_key(lines: &mut Vec<String>, section: &str, key: &str) {
    let header = format!("[{section}]");
    let mut section_start = None;
    let mut section_end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t == header {
            section_start = Some(i);
            continue;
        }
        if section_start.is_some() && t.starts_with('[') && t.ends_with(']') {
            section_end = i;
            break;
        }
    }
    let Some(start) = section_start else {
        return;
    };
    let mut remove_at = None;
    for i in (start + 1)..section_end {
        let t = lines[i].trim();
        if t.starts_with('#') || t.is_empty() {
            continue;
        }
        if let Some((k, _)) = t.split_once('=') {
            if k.trim() == key {
                remove_at = Some(i);
                break;
            }
        }
    }
    if let Some(i) = remove_at {
        lines.remove(i);
    }
}

/// Minimal TOML merge: set [models].default and [model."id"] fields for one profile.
fn merge_one_model_profile(lines: &mut Vec<String>, endpoint: &ModelEndpointSettings) {
    merge_model_into_toml_lines(lines, endpoint);
}

fn merge_model_into_toml_lines(lines: &mut Vec<String>, endpoint: &ModelEndpointSettings) {
    let model_id = if endpoint.model_id.trim().is_empty() {
        "bonsai-local"
    } else {
        endpoint.model_id.trim()
    };
    let section = format!("model.\"{model_id}\"");
    // Remove unquoted twin `[model.id]` if present — same table path as quoted form.
    remove_toml_section(lines, &format!("model.{model_id}"));
    upsert_toml_section_key(
        lines,
        &section,
        "model",
        &format!("\"{model_id}\""),
    );
    if let Some(name) = endpoint.name.as_ref().filter(|s| !s.trim().is_empty()) {
        upsert_toml_section_key(
            lines,
            &section,
            "name",
            &format!("\"{}\"", escape_toml_str(name)),
        );
    }
    if let Some(base) = endpoint.base_url.as_ref().filter(|s| !s.trim().is_empty()) {
        upsert_toml_section_key(
            lines,
            &section,
            "base_url",
            &format!("\"{}\"", escape_toml_str(base.trim())),
        );
    }

    // Secrets: prefer env_key (no plaintext in ~/.grok/config.toml).
    // Local Bonsai keeps the harmless placeholder inline.
    let key = endpoint
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let is_local = is_local_openai_base(endpoint.base_url.as_deref())
        || model_id.eq_ignore_ascii_case("bonsai-local")
        || key.is_some_and(is_local_placeholder_key);
    if is_local {
        upsert_toml_section_key(lines, &section, "api_key", "\"local\"");
        remove_toml_section_key(lines, &section, "env_key");
    } else {
        let env_name = endpoint
            .env_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| secret_env_name_for_profile(endpoint));
        upsert_toml_section_key(
            lines,
            &section,
            "env_key",
            &format!("\"{}\"", escape_toml_str(&env_name)),
        );
        // Strip any previously synced plaintext secret.
        remove_toml_section_key(lines, &section, "api_key");
    }

    if let Some(backend) = endpoint
        .api_backend
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        upsert_toml_section_key(
            lines,
            &section,
            "api_backend",
            &format!("\"{}\"", escape_toml_str(backend.trim())),
        );
    }
    if let Some(cw) = endpoint.context_window {
        upsert_toml_section_key(lines, &section, "context_window", &cw.to_string());
    }
    if let Some(max_tok) = endpoint.max_completion_tokens {
        upsert_toml_section_key(
            lines,
            &section,
            "max_completion_tokens",
            &max_tok.to_string(),
        );
    }
}

fn escape_toml_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Keep the first `[section]` block; drop later duplicate headers of the same name.
fn dedupe_toml_section_headers(lines: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(lines.len());
    let mut skipping_dup = false;
    for line in lines.iter() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            skipping_dup = !seen.insert(t.to_string());
            if skipping_dup {
                continue;
            }
        } else if skipping_dup {
            // Skip body of duplicate section until next header.
            continue;
        }
        out.push(line.clone());
    }
    *lines = out;
}

fn remove_toml_section(lines: &mut Vec<String>, section: &str) {
    let header = format!("[{section}]");
    let mut start = None;
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t == header {
            start = Some(i);
            continue;
        }
        if start.is_some() && t.starts_with('[') && t.ends_with(']') {
            end = i;
            break;
        }
    }
    if let Some(s) = start {
        lines.drain(s..end);
    }
}

/// Insert or replace `key = value` under `[section]` (section may contain quotes).
fn upsert_toml_section_key(lines: &mut Vec<String>, section: &str, key: &str, value: &str) {
    let header = format!("[{section}]");
    let header_alt = if section.starts_with("model.\"") {
        // also accept [model.id] form without quotes for simple ids
        None
    } else {
        None
    };

    let mut section_start = None;
    let mut section_end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        let matches_header = t == header
            || header_alt
                .as_ref()
                .map(|h: &String| t == h.as_str())
                .unwrap_or(false);
        if matches_header {
            section_start = Some(i);
            continue;
        }
        if section_start.is_some() && t.starts_with('[') && t.ends_with(']') {
            section_end = i;
            break;
        }
    }

    let assign = format!("{key} = {value}");
    if let Some(start) = section_start {
        // find key in section
        let mut found = None;
        for i in (start + 1)..section_end {
            let t = lines[i].trim();
            if t.starts_with('#') || t.is_empty() {
                continue;
            }
            if let Some((k, _)) = t.split_once('=') {
                if k.trim() == key {
                    found = Some(i);
                    break;
                }
            }
        }
        if let Some(i) = found {
            lines[i] = assign;
        } else {
            // insert after header, skip blank
            let mut insert_at = start + 1;
            while insert_at < section_end && lines[insert_at].trim().is_empty() {
                insert_at += 1;
            }
            lines.insert(insert_at, assign);
        }
    } else {
        if !lines.is_empty() && !lines.last().map(|s| s.trim().is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        lines.push(header);
        lines.push(assign);
        lines.push(String::new());
    }
}

/// Resolve the product install directory.
///
/// Packaged: parent of the running exe.  
/// Cargo/dev (`…/target/debug|release`): walk up to the workspace / repo root so
/// large GGUF files land in `models/` instead of `target/`.
pub fn resolve_product_install_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let folder = parent
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let looks_like_cargo_target = folder == "debug"
                || folder == "release"
                || parent
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("target"))
                    .unwrap_or(false);
            if looks_like_cargo_target {
                if let Some(repo) = find_repo_root_from_manifest() {
                    return repo;
                }
            }
            return parent.to_path_buf();
        }
    }
    find_repo_root_from_manifest().unwrap_or_else(|| PathBuf::from("."))
}

fn find_repo_root_from_manifest() -> Option<PathBuf> {
    // When built as the desktop crate, manifest is `…/frontend/apps/desktop/src-tauri`.
    let start = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for anc in start.ancestors().take(10) {
        let has_workspace = anc.join("Cargo.toml").is_file()
            && (anc.join("frontend").is_dir() || anc.join("models").is_dir());
        if has_workspace {
            return Some(anc.to_path_buf());
        }
    }
    None
}

/// Relative resource path used inside the Tauri bundle.
pub fn bundled_runtime_relative() -> &'static str {
    if cfg!(windows) {
        "runtime/grok.exe"
    } else {
        "runtime/grok"
    }
}

pub fn bundled_version_relative() -> &'static str {
    "runtime/version.json"
}

/// Bundled default Bailian media MCP binary (next to `grok` in resources/runtime).
pub fn bundled_media_mcp_relative() -> &'static str {
    if cfg!(windows) {
        "runtime/media-mcp.exe"
    } else {
        "runtime/media-mcp"
    }
}

pub const DEFAULT_MEDIA_MCP_SERVER_NAME: &str = "bailian-media";

fn looks_like_bailian_profile(ep: &ModelEndpointSettings) -> bool {
    let id = ep.model_id.to_ascii_lowercase();
    let url = ep
        .base_url
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    url.contains("dashscope")
        || url.contains("aliyun")
        || url.contains("bailian")
        || id.starts_with("qwen")
        || id.starts_with("happyhorse")
}

fn find_bailian_api_key(settings: &UserSettings) -> Option<String> {
    for p in &settings.model_profiles {
        if !looks_like_bailian_profile(p) {
            continue;
        }
        if let Some(k) = p.api_key.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if k.eq_ignore_ascii_case("local") {
                continue;
            }
            return Some(k.to_string());
        }
    }
    if looks_like_bailian_profile(&settings.endpoint) {
        if let Some(k) = settings
            .endpoint
            .api_key
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("local"))
        {
            return Some(k.to_string());
        }
    }
    std::env::var("DASHSCOPE_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve `media-mcp` binary for default MCP mount.
pub fn resolve_media_mcp_binary(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AGENT_MEDIA_MCP") {
        let path = PathBuf::from(p.trim());
        if path.is_file() {
            return Some(path);
        }
    }

    let rel = bundled_media_mcp_relative();
    let mut candidates = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join(rel));
        candidates.push(dir.join("resources").join(rel));
        candidates.push(dir.join("runtime").join("media-mcp.exe"));
        candidates.push(dir.join("runtime").join("media-mcp"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("media-mcp.exe"));
            candidates.push(parent.join("media-mcp"));
            candidates.push(parent.join("runtime").join("media-mcp.exe"));
            candidates.push(parent.join("runtime").join("media-mcp"));
            // Walk up a few levels (dev: target/debug → workspace root).
            let mut walk = parent.to_path_buf();
            for _ in 0..6 {
                candidates.push(walk.join("runtime-dist").join("media-mcp.exe"));
                candidates.push(walk.join("runtime-dist").join("media-mcp"));
                candidates.push(walk.join("target").join("release").join("media-mcp.exe"));
                candidates.push(walk.join("target").join("release").join("media-mcp"));
                candidates.push(walk.join("target").join("debug").join("media-mcp.exe"));
                candidates.push(walk.join("target").join("debug").join("media-mcp"));
                candidates.push(
                    walk.join("frontend")
                        .join("apps")
                        .join("desktop")
                        .join("src-tauri")
                        .join("resources")
                        .join(rel),
                );
                if let Some(contents) = walk.parent() {
                    let resources = contents.join("Resources");
                    candidates.push(resources.join(rel));
                    candidates.push(resources.join("resources").join(rel));
                }
                if !walk.pop() {
                    break;
                }
            }
        }
    }
    for root in [
        PathBuf::from("."),
        PathBuf::from("runtime-dist"),
        PathBuf::from("target/debug"),
        PathBuf::from("target/release"),
        PathBuf::from("frontend/apps/desktop/src-tauri/resources"),
    ] {
        candidates.push(root.join("media-mcp.exe"));
        candidates.push(root.join("media-mcp"));
        candidates.push(root.join(rel));
        candidates.push(root.join("runtime").join("media-mcp.exe"));
        candidates.push(root.join("runtime").join("media-mcp"));
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// Ensure default Bailian media MCP is mounted and xAI Imagine builtins are off.
///
/// Idempotent: updates `command` when the binary moves; does not uninstall the
/// server (product default — keep mounted).
pub fn ensure_default_media_mcp_in_grok_toml(
    resource_dir: Option<&Path>,
) -> Result<(), ConfigError> {
    let Some(bin) = resolve_media_mcp_binary(resource_dir) else {
        return Ok(());
    };
    let path = AppPaths::grok_cli_config();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = if path.is_file() {
        let raw = std::fs::read_to_string(&path)?;
        raw.trim_start_matches('\u{feff}').to_string()
    } else {
        String::new()
    };
    let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
    if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }

    upsert_toml_section_key(&mut lines, "features", "image_gen", "false");
    upsert_toml_section_key(&mut lines, "features", "video_gen", "false");
    upsert_toml_section_key(&mut lines, "features", "web_fetch", "false");

    let section = format!("mcp_servers.{DEFAULT_MEDIA_MCP_SERVER_NAME}");
    let cmd = bin.display().to_string().replace('\\', "/");
    upsert_toml_section_key(
        &mut lines,
        &section,
        "command",
        &format!("\"{}\"", escape_toml_str(&cmd)),
    );
    upsert_toml_section_key(&mut lines, &section, "args", "[]");
    upsert_toml_section_key(&mut lines, &section, "enabled", "true");
    upsert_toml_section_key(&mut lines, &section, "startup_timeout_sec", "60");
    // Image is usually fast; video (HappyHorse) often needs 10–25+ min under load.
    upsert_toml_section_key(&mut lines, &section, "tool_timeout_sec", "1800");
    upsert_toml_section_key(
        &mut lines,
        &section,
        "env",
        "{ DASHSCOPE_API_KEY = \"${DASHSCOPE_API_KEY}\", GROKX_TASK_DIR = \"${GROKX_TASK_DIR}\", GROKX_PROJECT_ROOT = \"${GROKX_PROJECT_ROOT}\", GROKX_DEFAULT_IMAGE_MODEL = \"${GROKX_DEFAULT_IMAGE_MODEL}\", GROKX_DEFAULT_VIDEO_MODEL = \"${GROKX_DEFAULT_VIDEO_MODEL}\" }",
    );

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// Built-in stdio MCP servers that ship enabled by default (no user install step).
pub const BUILTIN_NPX_MCP: &[(&str, &str, &str)] = &[
    (
        "filesystem",
        "@modelcontextprotocol/server-filesystem",
        "Workspace filesystem tools",
    ),
    (
        "memory",
        "@modelcontextprotocol/server-memory",
        "Persistent memory tools",
    ),
    (
        "fetch",
        "@modelcontextprotocol/server-fetch",
        "Fetch URL / web content",
    ),
];

/// Ensure Filesystem / Memory / Fetch MCP servers are mounted in `~/.grok/config.toml`.
///
/// Idempotent. Uses CN acceleration env when provided (or product defaults).
pub fn ensure_default_builtin_mcps_in_grok_toml(
    cn: Option<&CnAccelerationSettings>,
) -> Result<(), ConfigError> {
    let cn_owned;
    let cn_ref = match cn {
        Some(c) => c,
        None => {
            cn_owned = CnAccelerationSettings::default();
            &cn_owned
        }
    };
    let env = cn_ref.install_env_vars();
    let fs_root = AppPaths::default_project_root();
    for &(name, package, _) in BUILTIN_NPX_MCP {
        let args = if name == "filesystem" {
            vec![
                "-y".into(),
                package.to_string(),
                fs_root.display().to_string(),
            ]
        } else {
            vec!["-y".into(), package.to_string()]
        };
        upsert_stdio_mcp_server(&StdioMcpServerSpec {
            name: name.to_string(),
            command: "npx".into(),
            args,
            env: env.clone(),
            startup_timeout_sec: 120,
            tool_timeout_sec: Some(600),
            enabled: true,
        })?;
    }
    Ok(())
}

/// Stdio MCP server fields written into `~/.grok/config.toml`.
#[derive(Debug, Clone)]
pub struct StdioMcpServerSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub startup_timeout_sec: u32,
    pub tool_timeout_sec: Option<u32>,
    pub enabled: bool,
}

/// Upsert a local stdio MCP server section in `~/.grok/config.toml`.
pub fn upsert_stdio_mcp_server(spec: &StdioMcpServerSpec) -> Result<(), ConfigError> {
    let path = AppPaths::grok_cli_config();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = if path.is_file() {
        let raw = std::fs::read_to_string(&path)?;
        raw.trim_start_matches('\u{feff}').to_string()
    } else {
        String::new()
    };
    let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
    if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }

    let section = format!("mcp_servers.{}", spec.name.trim());
    let cmd = spec.command.replace('\\', "/");
    upsert_toml_section_key(
        &mut lines,
        &section,
        "command",
        &format!("\"{}\"", escape_toml_str(&cmd)),
    );
    let args_toml = format!(
        "[{}]",
        spec.args
            .iter()
            .map(|a| format!("\"{}\"", escape_toml_str(a)))
            .collect::<Vec<_>>()
            .join(", ")
    );
    upsert_toml_section_key(&mut lines, &section, "args", &args_toml);
    upsert_toml_section_key(
        &mut lines,
        &section,
        "enabled",
        if spec.enabled { "true" } else { "false" },
    );
    upsert_toml_section_key(
        &mut lines,
        &section,
        "startup_timeout_sec",
        &spec.startup_timeout_sec.to_string(),
    );
    if let Some(t) = spec.tool_timeout_sec {
        upsert_toml_section_key(&mut lines, &section, "tool_timeout_sec", &t.to_string());
    }
    if !spec.env.is_empty() {
        let env_body = spec
            .env
            .iter()
            .map(|(k, v)| format!("{} = \"{}\"", k, escape_toml_str(v)))
            .collect::<Vec<_>>()
            .join(", ");
        upsert_toml_section_key(&mut lines, &section, "env", &format!("{{ {env_body} }}"));
    }

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// Remove an MCP server section from `~/.grok/config.toml` (no-op if missing).
pub fn remove_mcp_server_from_grok_toml(server_name: &str) -> Result<(), ConfigError> {
    let name = server_name.trim();
    if name.is_empty() {
        return Ok(());
    }
    let path = AppPaths::grok_cli_config();
    if !path.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&path)?;
    let mut lines: Vec<String> = raw
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|s| s.to_string())
        .collect();
    remove_toml_section(&mut lines, &format!("mcp_servers.{name}"));
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// Whether `[mcp_servers.<name>]` exists in the user grok config.
pub fn mcp_server_configured(server_name: &str) -> bool {
    let path = AppPaths::grok_cli_config();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let header = format!("[mcp_servers.{}]", server_name.trim());
    raw.lines().any(|l| l.trim() == header)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_writes_model_section() {
        let ep = ModelEndpointSettings {
            model_id: "grok-4.5".into(),
            name: Some("Grok 4.5".into()),
            base_url: Some("https://api.x.ai/v1".into()),
            api_key: Some("sk-test".into()),
            env_key: None,
            api_backend: Some("chat_completions".into()),
            context_window: Some(128000),
            max_completion_tokens: Some(4096),
            default_effort: Some("high".into()),
            enabled: true,
            vendor_id: None,
            capability: None,
            performance_tier: None,
            remote_confirmed: None,
        };
        let out = merge_models_into_toml("", std::slice::from_ref(&ep), Some("grok-4.5"));
        assert!(out.contains("[models]"));
        assert!(out.contains("default = \"grok-4.5\""));
        assert!(out.contains("[model.\"grok-4.5\"]"));
        assert!(out.contains("base_url = \"https://api.x.ai/v1\""));
        // Remote secrets must not be written as plaintext api_key.
        assert!(!out.contains("api_key = \"sk-test\""));
        assert!(out.contains("env_key = \"XAI_API_KEY\""));
        assert!(out.contains("context_window = 128000"));
        assert!(out.contains("max_completion_tokens = 4096"));
    }

    #[test]
    fn merge_prunes_stale_and_media_models() {
        let existing = r#"
[models]
default = "old"

[model."old-junk"]
model = "old-junk"
api_key = "sk-leak"

[model."qwen-image-3.0"]
model = "qwen-image-3.0"
api_key = "sk-leak"

[model."deepseek-v4-flash"]
model = "deepseek-v4-flash"
api_key = "sk-old"
"#;
        let ep = ModelEndpointSettings {
            model_id: "deepseek-v4-flash".into(),
            name: Some("deepseek-v4-flash".into()),
            base_url: Some("https://api.deepseek.com/v1".into()),
            api_key: Some("sk-new".into()),
            env_key: None,
            api_backend: Some("chat_completions".into()),
            context_window: Some(262_144),
            max_completion_tokens: Some(131_072),
            default_effort: None,
            enabled: true,
            vendor_id: Some("vendor-deepseek".into()),
            capability: None,
            performance_tier: None,
            remote_confirmed: None,
        };
        let out = merge_models_into_toml(existing, std::slice::from_ref(&ep), Some("deepseek-v4-flash"));
        assert!(out.contains("[model.\"deepseek-v4-flash\"]"));
        assert!(out.contains("env_key = \"DEEPSEEK_API_KEY\""));
        assert!(!out.contains("api_key = \"sk-new\""));
        assert!(!out.contains("api_key = \"sk-old\""));
        assert!(!out.contains("old-junk"));
        assert!(!out.contains("qwen-image-3.0"));
        assert!(!out.contains("sk-leak"));
    }

    #[test]
    fn apply_update_keeps_key_when_masked() {
        let mut s = UserSettings::product_defaults();
        s.endpoint.api_key = Some("sk-real-secret".into());
        s.apply_update(SettingsUpdate {
            endpoint_api_key: Some("••••cret".into()),
            ..Default::default()
        });
        assert_eq!(s.endpoint.api_key.as_deref(), Some("sk-real-secret"));
        s.apply_update(SettingsUpdate {
            endpoint_api_key: Some("sk-new".into()),
            ..Default::default()
        });
        assert_eq!(s.endpoint.api_key.as_deref(), Some("sk-new"));
    }

    #[test]
    fn inherit_api_key_across_sibling_models() {
        let mut s = UserSettings::product_defaults();
        s.model_profiles = vec![
            ModelEndpointSettings {
                model_id: "deepseek-v4-flash".into(),
                name: Some("deepseek-v4-flash".into()),
                base_url: Some("https://api.deepseek.com/v1".into()),
                api_key: Some("sk-shared-secret".into()),
                env_key: None,
                api_backend: Some("chat_completions".into()),
                context_window: Some(262_144),
                max_completion_tokens: Some(131_072),
                default_effort: None,
                enabled: true,
                vendor_id: Some("vendor-deepseek-1".into()),
                capability: None,
                performance_tier: None,
                remote_confirmed: None,
            },
            ModelEndpointSettings {
                model_id: "deepseek-v4-pro".into(),
                name: Some("deepseek-v4-pro".into()),
                base_url: Some("https://api.deepseek.com/v1".into()),
                api_key: None,
                env_key: None,
                api_backend: Some("chat_completions".into()),
                context_window: Some(262_144),
                max_completion_tokens: Some(131_072),
                default_effort: None,
                enabled: true,
                vendor_id: Some("vendor-deepseek-1".into()),
                capability: None,
                performance_tier: None,
                remote_confirmed: None,
            },
        ];
        // Save without keys (UI empty draft) — pro must keep inheriting flash's key.
        s.apply_update(SettingsUpdate {
            model_profiles: Some(vec![
                ModelProfileInput {
                    model_id: "deepseek-v4-flash".into(),
                    name: Some("deepseek-v4-flash".into()),
                    base_url: Some("https://api.deepseek.com/v1".into()),
                    api_key: None,
                    vendor_id: Some("vendor-deepseek-1".into()),
                    enabled: Some(true),
                    ..Default::default()
                },
                ModelProfileInput {
                    model_id: "deepseek-v4-pro".into(),
                    name: Some("deepseek-v4-pro".into()),
                    base_url: Some("https://api.deepseek.com/v1".into()),
                    api_key: None,
                    vendor_id: Some("vendor-deepseek-1".into()),
                    enabled: Some(true),
                    ..Default::default()
                },
            ]),
            active_model_id: Some("deepseek-v4-pro".into()),
            ..Default::default()
        });
        let pro = s.find_profile("deepseek-v4-pro").unwrap();
        assert_eq!(pro.api_key.as_deref(), Some("sk-shared-secret"));
        assert_eq!(s.endpoint.api_key.as_deref(), Some("sk-shared-secret"));
        assert!(!s
            .endpoint
            .api_key
            .as_deref()
            .unwrap()
            .eq_ignore_ascii_case("local"));
    }

    #[test]
    fn vendor_api_keys_do_not_cross() {
        let mut s = UserSettings::product_defaults();
        s.model_profiles = vec![
            ModelEndpointSettings {
                model_id: "bonsai-local".into(),
                name: Some("Bonsai".into()),
                base_url: Some("http://127.0.0.1:8080/v1".into()),
                api_key: Some("local".into()),
                env_key: None,
                api_backend: Some("chat_completions".into()),
                context_window: Some(98_304),
                max_completion_tokens: Some(16_384),
                default_effort: None,
                enabled: true,
                vendor_id: Some("vendor-bonsai".into()),
                capability: Some("vlm".into()),
                performance_tier: Some("weak".into()),
                remote_confirmed: Some(true),
            },
            ModelEndpointSettings {
                model_id: "deepseek-v4-pro".into(),
                name: Some("deepseek-v4-pro".into()),
                base_url: Some("https://api.deepseek.com/v1".into()),
                api_key: Some("sk-deepseek".into()),
                env_key: None,
                api_backend: Some("chat_completions".into()),
                context_window: Some(262_144),
                max_completion_tokens: Some(131_072),
                default_effort: None,
                enabled: true,
                vendor_id: Some("vendor-deepseek-1".into()),
                capability: None,
                performance_tier: None,
                remote_confirmed: None,
            },
            ModelEndpointSettings {
                model_id: "qwen3.7-plus".into(),
                name: Some("qwen3.7-plus".into()),
                base_url: Some("https://dashscope.aliyuncs.com/compatible-mode/v1".into()),
                api_key: None,
                env_key: None,
                api_backend: Some("chat_completions".into()),
                context_window: Some(262_144),
                max_completion_tokens: Some(131_072),
                default_effort: None,
                enabled: true,
                vendor_id: Some("vendor-bailian-2".into()),
                capability: None,
                performance_tier: None,
                remote_confirmed: None,
            },
        ];
        fill_missing_api_keys_among_profiles(&mut s.model_profiles);
        let qwen = s.find_profile("qwen3.7-plus").unwrap();
        assert!(qwen.api_key.is_none(), "bailian must not inherit deepseek/bonsai key");

        // Switching active model must use that vendor's key only.
        let ds = s.find_profile("deepseek-v4-pro").cloned().unwrap();
        s.apply_profile_to_endpoint(&ds);
        assert_eq!(s.endpoint.api_key.as_deref(), Some("sk-deepseek"));

        let bonsai = s.find_profile("bonsai-local").cloned().unwrap();
        s.apply_profile_to_endpoint(&bonsai);
        assert_eq!(s.endpoint.api_key.as_deref(), Some("local"));

        let qwen = s.find_profile("qwen3.7-plus").cloned().unwrap();
        s.apply_profile_to_endpoint(&qwen);
        assert!(
            s.endpoint.api_key.is_none(),
            "switching to bailian must not keep previous vendor key"
        );
    }

    #[test]
    fn public_view_masks_key() {
        let mut s = UserSettings::product_defaults();
        s.endpoint.api_key = Some("sk-abcdefghij".into());
        let v = s.public_view();
        assert!(v.endpoint.has_api_key);
        let hint = v.endpoint.api_key_hint.as_deref().unwrap();
        assert!(hint.starts_with("sk-a"));
        assert!(hint.ends_with("ghij"));
        assert!(hint.contains('•'));
        assert!(!hint.contains("sk-abcdefghij"));
    }

    #[test]
    fn normalize_modelscope_view_to_resolve() {
        let raw = "https://modelscope.cn/models/prism-ml/Bonsai-27B-gguf/file/view/master/Bonsai-27B-Q1_0.gguf?status=2";
        assert_eq!(
            DependencyDownloadSettings::normalize_download_url(raw),
            "https://modelscope.cn/models/prism-ml/Bonsai-27B-gguf/resolve/master/Bonsai-27B-Q1_0.gguf"
        );
        let mm = "https://modelscope.cn/models/prism-ml/Bonsai-27B-gguf/file/view/master/Bonsai-27B-mmproj-Q8_0.gguf?status=2";
        assert_eq!(
            DependencyDownloadSettings::normalize_download_url(mm),
            "https://modelscope.cn/models/prism-ml/Bonsai-27B-gguf/resolve/master/Bonsai-27B-mmproj-Q8_0.gguf"
        );
    }

    #[test]
    fn pick_url_falls_back_when_cn_blank() {
        let d = DependencyDownloadSettings::default();
        assert!(d.llama_runtime_zip_url_cn.is_empty());
        let (url, from_cn) = d.llama_runtime_zip_url(true);
        assert!(!url.is_empty(), "CN blank should fall back to intl runtime zip");
        assert!(!from_cn, "intl fallback must not be treated as CN (no ghproxy)");
        assert!(url.starts_with("https://github.com/"));
        let (cpu_url, cpu_cn) = d.llama_cpu_runtime_zip_url(true);
        assert!(cpu_url.contains("llama-bin-win-cpu-x64.zip"));
        assert!(!cpu_cn);
        assert!(d.grok_exe_url(true).0.is_empty());
        assert!(d.grok_exe_url(false).0.is_empty());
    }

    #[test]
    fn pick_url_single_side_only() {
        let (u, from_cn) = DependencyDownloadSettings::pick_url(
            true,
            "",
            "https://github.com/example/a.zip",
        );
        assert_eq!(u, "https://github.com/example/a.zip");
        assert!(!from_cn);

        let (u, from_cn) = DependencyDownloadSettings::pick_url(
            false,
            "https://modelscope.cn/a",
            "",
        );
        assert_eq!(u, "https://modelscope.cn/a");
        assert!(from_cn);

        let (u, from_cn) = DependencyDownloadSettings::pick_url(
            true,
            "https://cn.example/a",
            "https://intl.example/a",
        );
        assert_eq!(u, "https://cn.example/a");
        assert!(from_cn);
    }
}
