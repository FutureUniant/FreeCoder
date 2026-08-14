//! Local LLM runtime manager.
//!
//! Spawns and supervises an OpenAI-compatible `llama-server` process so the
//! Grok Build agent can talk to a bundled Bonsai (or other) GGUF model over HTTP.
//! Cloud providers are untouched — they continue to use remote `base_url`s.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::process::{Child, Command};
use tracing::{info, warn};

/// Stable provider / model id used in app settings and `~/.grok/config.toml`.
pub const BONSAI_LOCAL_ID: &str = "bonsai-local";

/// Directory name under `models/` for the Windows CUDA 12 llama.cpp build.
pub const CUDA_RUNTIME_DIR_NAME: &str = "llama-prism-win-cuda12";
/// Directory name under `models/` for the Windows CPU llama.cpp build (legacy).
pub const CPU_RUNTIME_DIR_NAME: &str = "llama-prism-win-cpu";
/// Alias kept for older call sites (CUDA runtime dir).
pub const RUNTIME_DIR_NAME: &str = CUDA_RUNTIME_DIR_NAME;
/// Local Bonsai requires at least this much NVIDIA VRAM (≈8 GB).
pub const GPU_MIN_VRAM_MIB: u32 = 8_000;
/// Kept for the unused CPU llama.cpp path (hosts below 8 GB no longer launch).
#[allow(dead_code)]
pub const CPU_CTX_SIZE: u32 = 32_768;

/// Default GGUF filename (1-bit Q1_0).
pub const DEFAULT_MODEL_FILE: &str = "Bonsai-27B-Q1_0.gguf";

/// Multimodal projector GGUF (vision / VLM). Loaded with `--mmproj` when present.
pub const DEFAULT_MMPROJ_FILE: &str = "Bonsai-27B-mmproj-Q8_0.gguf";

/// llama.cpp binaries that must sit in the runtime dir (min size catches truncated extracts).
pub const REQUIRED_LLAMA_BINARIES: &[(&str, u64)] = &[
    ("llama-server.exe", 1),
    ("llama-server-impl.dll", 1_000_000),
    ("ggml-cuda.dll", 1_000_000),
];

/// CUDA 12 redistributable DLLs from the companion cudart zip.
/// Min sizes catch truncated extracts (e.g. cublas written as ~22MB of ~95MB).
pub const REQUIRED_CUDA_RUNTIME_FILES: &[(&str, u64)] = &[
    ("cudart64_12.dll", 100_000),
    ("cublas64_12.dll", 50_000_000),
    ("cublasLt64_12.dll", 200_000_000),
];

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8080;
const DEFAULT_API_KEY: &str = "local";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(300);
const HEALTH_POLL: Duration = Duration::from_millis(750);

#[derive(Debug, Error)]
pub enum LlmRuntimeError {
    #[error("local LLM runtime directory not found (expected models/{dir})")]
    RuntimeDirMissing { dir: &'static str },
    #[error("llama-server binary missing: {0}")]
    BinaryMissing(PathBuf),
    #[error("model file missing: {0}")]
    ModelMissing(PathBuf),
    #[error("mmproj (vision) file missing: {0}")]
    MmprojMissing(PathBuf),
    #[error("local runtime incomplete under {dir}: missing {missing}")]
    RuntimeIncomplete { dir: PathBuf, missing: String },
    #[error("failed to start llama-server: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("llama-server exited before becoming ready")]
    ExitedEarly,
    #[error("llama-server did not become healthy in time")]
    NotReady,
    #[error("local Bonsai requires an NVIDIA GPU with at least 8 GB VRAM ({detail})")]
    UnsupportedGpu { detail: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

/// How a provider is hosted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Local,
    Remote,
}

/// Resolved paths + launch parameters for the bundled Bonsai runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRuntimeSpec {
    pub id: String,
    pub display_name: String,
    pub runtime_dir: PathBuf,
    pub binary: PathBuf,
    pub model_path: PathBuf,
    /// Multimodal projector (`--mmproj`). Required for local vision / 识图.
    pub mmproj_path: Option<PathBuf>,
    pub host: String,
    pub port: u16,
    pub auto_start: bool,
    /// `-ngl` / `--n-gpu-layers`. `99` means all layers; `0` keeps weights on CPU.
    pub n_gpu_layers: i32,
    pub ctx_size: u32,
    pub api_key: String,
    pub api_backend: String,
    pub context_window: u64,
    pub max_completion_tokens: u64,
    /// Pass `--device none` so inference does not offload to CUDA.
    pub force_cpu: bool,
}

impl LocalRuntimeSpec {
    pub fn base_url(&self) -> String {
        format!("http://{}:{}/v1", self.host, self.port)
    }

    /// Endpoint fields suitable for `app_config::ModelEndpointSettings`.
    pub fn endpoint_fields(&self) -> LocalEndpointFields {
        LocalEndpointFields {
            model_id: self.id.clone(),
            name: self.display_name.clone(),
            base_url: self.base_url(),
            api_key: self.api_key.clone(),
            api_backend: self.api_backend.clone(),
            context_window: self.context_window,
            max_completion_tokens: self.max_completion_tokens,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LocalEndpointFields {
    pub model_id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_backend: String,
    pub context_window: u64,
    pub max_completion_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalRuntimeStatus {
    Stopped,
    Starting,
    Ready,
    Failed { message: String },
}

/// Supervises a single local `llama-server` child process.
pub struct LlmRuntimeManager {
    spec: Option<LocalRuntimeSpec>,
    child: Option<Child>,
    status: LocalRuntimeStatus,
}

impl Default for LlmRuntimeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LlmRuntimeManager {
    pub fn new() -> Self {
        Self {
            spec: None,
            child: None,
            status: LocalRuntimeStatus::Stopped,
        }
    }

    pub fn status(&self) -> LocalRuntimeStatus {
        self.status.clone()
    }

    pub fn spec(&self) -> Option<&LocalRuntimeSpec> {
        self.spec.as_ref()
    }

    /// Discover the CUDA llama.cpp runtime (NVIDIA ≥8GB VRAM) and remember it.
    pub fn bind_default_bonsai(
        &mut self,
        search_roots: &[PathBuf],
    ) -> Result<&LocalRuntimeSpec, LlmRuntimeError> {
        let tune = tune_bonsai_for_host();
        if tune.blocked {
            return Err(LlmRuntimeError::UnsupportedGpu {
                detail: tune.label,
            });
        }
        let runtime_dir = resolve_named_runtime_dir(search_roots, CUDA_RUNTIME_DIR_NAME)?;
        let binary = runtime_dir.join(if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        });
        let (model_path, mmproj_path) = find_model_files(search_roots)?;
        if !binary.is_file() {
            return Err(LlmRuntimeError::BinaryMissing(binary));
        }
        if !model_path.is_file() {
            return Err(LlmRuntimeError::ModelMissing(model_path));
        }
        if !mmproj_path.is_file() {
            return Err(LlmRuntimeError::MmprojMissing(mmproj_path));
        }
        let missing = missing_runtime_binaries(&runtime_dir);
        if !missing.is_empty() {
            return Err(LlmRuntimeError::RuntimeIncomplete {
                dir: runtime_dir,
                missing: missing.join(", "),
            });
        }
        ensure_msvc_crt(&runtime_dir);
        info!(
            ngl = tune.n_gpu_layers,
            ctx = tune.ctx_size,
            cpu = tune.force_cpu,
            hw = %tune.label,
            "local Bonsai hardware tune"
        );
        self.spec = Some(LocalRuntimeSpec {
            id: BONSAI_LOCAL_ID.into(),
            display_name: "Bonsai 27B (1Bit)".into(),
            runtime_dir,
            binary,
            model_path,
            mmproj_path: Some(mmproj_path),
            host: DEFAULT_HOST.into(),
            port: DEFAULT_PORT,
            auto_start: true,
            n_gpu_layers: tune.n_gpu_layers,
            ctx_size: tune.ctx_size,
            api_key: DEFAULT_API_KEY.into(),
            api_backend: "chat_completions".into(),
            context_window: u64::from(tune.ctx_size),
            max_completion_tokens: tune.max_completion_tokens,
            force_cpu: tune.force_cpu,
        });
        Ok(self.spec.as_ref().expect("just set"))
    }

    /// Start the local server if needed and wait until `/v1/models` responds.
    pub async fn ensure_running(&mut self) -> Result<&LocalRuntimeSpec, LlmRuntimeError> {
        let mut spec = self
            .spec
            .clone()
            .ok_or_else(|| LlmRuntimeError::Message("no local runtime bound".into()))?;

        if self.is_healthy(&spec).await {
            self.status = LocalRuntimeStatus::Ready;
            return Ok(self.spec.as_ref().expect("bound"));
        }

        // Reap a dead child before respawning.
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    warn!(?status, "previous llama-server exited; restarting");
                    self.child = None;
                }
                Ok(None) => {
                    // Still running but not healthy yet — fall through to wait loop.
                }
                Err(err) => {
                    warn!(error = %err, "failed to poll llama-server");
                    self.child = None;
                }
            }
        }

        if self.child.is_none() {
            ensure_msvc_crt(&spec.runtime_dir);
            self.status = LocalRuntimeStatus::Starting;
            info!(
                binary = %spec.binary.display(),
                model = %spec.model_path.display(),
                ngl = spec.n_gpu_layers,
                ctx = spec.ctx_size,
                cpu = spec.force_cpu,
                mmproj = %spec
                    .mmproj_path
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "(none)".into()),
                url = %spec.base_url(),
                "starting local llama-server"
            );
            let child = spawn_llama_server(&spec)?;
            self.child = Some(child);
        }

        let mut deadline = tokio::time::Instant::now() + HEALTH_TIMEOUT;
        let mut retried_cpu = spec.force_cpu;
        loop {
            if let Some(child) = self.child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    self.child = None;
                    if !retried_cpu {
                        retried_cpu = true;
                        warn!(
                            status = %describe_exit(status),
                            "llama-server exited on GPU path; retrying CPU (--device none -ngl 0)"
                        );
                        spec.force_cpu = true;
                        spec.n_gpu_layers = 0;
                        spec.ctx_size = 8192;
                        spec.context_window = 8192;
                        spec.max_completion_tokens = 4096;
                        self.spec = Some(spec.clone());
                        self.status = LocalRuntimeStatus::Starting;
                        let child = spawn_llama_server(&spec)?;
                        self.child = Some(child);
                        deadline = tokio::time::Instant::now() + HEALTH_TIMEOUT;
                        continue;
                    }
                    let detail = describe_exit(status);
                    let tail = log_tail(&spec.runtime_dir.join("llama-server.log"));
                    let message = if tail.is_empty() {
                        format!("llama-server exited early: {detail}")
                    } else {
                        format!("llama-server exited early: {detail}. log: {tail}")
                    };
                    self.status = LocalRuntimeStatus::Failed {
                        message: message.clone(),
                    };
                    return Err(LlmRuntimeError::Message(message));
                }
            }
            if self.is_healthy(&spec).await {
                self.status = LocalRuntimeStatus::Ready;
                self.spec = Some(spec);
                info!(url = %self.spec.as_ref().expect("bound").base_url(), "local llama-server ready");
                return Ok(self.spec.as_ref().expect("bound"));
            }
            if tokio::time::Instant::now() >= deadline {
                self.status = LocalRuntimeStatus::Failed {
                    message: "timed out waiting for llama-server".into(),
                };
                return Err(LlmRuntimeError::NotReady);
            }
            tokio::time::sleep(HEALTH_POLL).await;
        }
    }

    /// Best-effort stop of in-flight Bonsai generation. Keeps llama-server alive
    /// so the next prompt does not pay model-load cost.
    pub async fn interrupt_generation(&self) {
        let Some(spec) = self.spec.as_ref() else {
            return;
        };
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_millis(800))
            .build()
        else {
            return;
        };
        let root = format!("http://{}:{}", spec.host, spec.port);
        let mut req = client.post(format!("{root}/slots/0?action=cancel"));
        if !spec.api_key.is_empty() {
            req = req.bearer_auth(&spec.api_key);
        }
        match req.send().await {
            Ok(resp) => {
                info!(status = %resp.status(), "interrupted local llama generation");
            }
            Err(err) => {
                warn!(error = %err, "could not interrupt local llama generation");
            }
        }
    }

    pub async fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.status = LocalRuntimeStatus::Stopped;
    }

    async fn is_healthy(&self, spec: &LocalRuntimeSpec) -> bool {
        let url = format!("{}/models", spec.base_url());
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .ok();
        let Some(client) = client else {
            return false;
        };
        let mut req = client.get(&url);
        if !spec.api_key.is_empty() {
            req = req.bearer_auth(&spec.api_key);
        }
        match req.send().await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }
}

fn spawn_llama_server(spec: &LocalRuntimeSpec) -> Result<Child, LlmRuntimeError> {
    let log_path = spec.runtime_dir.join("llama-server.log");
    let mut cmd = Command::new(&spec.binary);
    cmd.current_dir(&spec.runtime_dir)
        .arg("-m")
        .arg(&spec.model_path)
        .arg("-a")
        .arg(&spec.id)
        .arg("--host")
        .arg(&spec.host)
        .arg("--port")
        .arg(spec.port.to_string())
        .arg("-c")
        .arg(spec.ctx_size.to_string())
        .arg("-ngl")
        .arg(spec.n_gpu_layers.to_string())
        .arg("--fit")
        .arg("off")
        .arg("--jinja")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .kill_on_drop(true);
    if spec.force_cpu {
        cmd.arg("--device").arg("none");
    }
    match fs::File::create(&log_path) {
        Ok(file) => {
            cmd.stderr(Stdio::from(file));
        }
        Err(err) => {
            warn!(error = %err, path = %log_path.display(), "could not create llama-server.log");
            cmd.stderr(Stdio::piped());
        }
    }
    if let Some(mmproj) = &spec.mmproj_path {
        // Multimodal projector (mtmd) — enables OpenAI-compatible vision inputs.
        cmd.arg("--mmproj").arg(mmproj);
    }
    if !spec.api_key.is_empty() {
        cmd.arg("--api-key").arg(&spec.api_key);
    }
    cmd.spawn().map_err(LlmRuntimeError::Spawn)
}

/// Measured launch profile for Bonsai-27B-Q1_0 + mmproj.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareTune {
    pub n_gpu_layers: i32,
    pub ctx_size: u32,
    pub max_completion_tokens: u64,
    pub force_cpu: bool,
    /// True when this PC cannot run local Bonsai (no NVIDIA GPU or VRAM &lt; 8 GB).
    #[serde(default)]
    pub blocked: bool,
    pub label: String,
}

pub fn tune_bonsai_for_host() -> HardwareTune {
    tune_bonsai(detect_nvidia_vram_mib(), nvcuda_available())
}

/// Pick llama.cpp `-ngl` / `-c` from VRAM.
///
/// - No NVIDIA / VRAM unknown / **&lt; 8 GB**: blocked (do not start)
/// - 8 GB: CUDA, ctx 48k
/// - 12 GB+: CUDA all layers, ctx 48k
pub fn tune_bonsai(vram_mib: Option<u32>, has_nvcuda: bool) -> HardwareTune {
    let blocked = |label: String| HardwareTune {
        n_gpu_layers: 0,
        ctx_size: 0,
        max_completion_tokens: 0,
        force_cpu: false,
        blocked: true,
        label,
    };
    if !has_nvcuda {
        return blocked("blocked: NVIDIA GPU ≥8GB required (no nvcuda)".into());
    }
    let Some(vram) = vram_mib.filter(|v| *v >= 512) else {
        return blocked("blocked: NVIDIA GPU ≥8GB required (VRAM unknown)".into());
    };
    if vram < GPU_MIN_VRAM_MIB {
        return blocked(format!("blocked: {vram}MiB < 8GB"));
    }
    if vram >= 11_000 {
        HardwareTune {
            n_gpu_layers: 99,
            ctx_size: 49_152,
            max_completion_tokens: 16_384,
            force_cpu: false,
            blocked: false,
            label: format!("cuda {vram}MiB all-layers ctx48k"),
        }
    } else {
        HardwareTune {
            n_gpu_layers: 20,
            ctx_size: 49_152,
            max_completion_tokens: 16_384,
            force_cpu: false,
            blocked: false,
            label: format!("cuda {vram}MiB ctx48k"),
        }
    }
}

/// CPU llama.cpp zip is no longer used for launch (hosts below 8 GB are blocked).
pub fn host_wants_cpu_runtime() -> bool {
    false
}

/// True when this PC may download and start the local Bonsai llama-server.
pub fn host_supports_local_bonsai() -> bool {
    !tune_bonsai_for_host().blocked
}

/// User-facing reason when [`host_supports_local_bonsai`] is false.
pub fn bonsai_gpu_requirement_message() -> String {
    let tune = tune_bonsai_for_host();
    format!(
        "本机无法运行 Bonsai 本地模型：需要 NVIDIA 显卡且显存不少于 8GB（当前：{}）",
        tune.label
    )
}

fn detect_nvidia_vram_mib() -> Option<u32> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .max()
}

fn nvcuda_available() -> bool {
    #[cfg(windows)]
    {
        Path::new(r"C:\Windows\System32\nvcuda.dll").is_file()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// Copy a newer MSVC CRT next to llama-server when System32 is too old (e.g. 14.34).
/// Prism llama-server crashes in MSVCP140.dll (0xC0000005) without 14.40+.
pub fn ensure_msvc_crt(runtime_dir: &Path) {
    #[cfg(windows)]
    {
        let dest = runtime_dir.join("msvcp140.dll");
        if dest.is_file() {
            return;
        }
        let Some(src_dir) = find_newer_crt_dir() else {
            warn!(
                "MSVC CRT 14.40+ not found next to llama-server; install Microsoft Visual C++ 2015-2022 Redistributable (x64) if llama-server crashes on start"
            );
            return;
        };
        const NAMES: &[&str] = &[
            "msvcp140.dll",
            "msvcp140_codecvt_ids.dll",
            "vcruntime140.dll",
            "vcruntime140_1.dll",
            "concrt140.dll",
        ];
        for name in NAMES {
            let src = src_dir.join(name);
            if !src.is_file() {
                continue;
            }
            match fs::copy(&src, runtime_dir.join(name)) {
                Ok(_) => info!(dll = name, from = %src.display(), "copied MSVC CRT next to llama-server"),
                Err(err) => warn!(dll = name, error = %err, "failed to copy MSVC CRT DLL"),
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = runtime_dir;
    }
}

#[cfg(windows)]
fn find_newer_crt_dir() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
        roots.push(PathBuf::from(pf).join(r"Microsoft\Edge\Application"));
        roots.push(PathBuf::from(std::env::var("ProgramFiles(x86)").unwrap_or_default()).join(r"Microsoft\EdgeCore"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        roots.push(PathBuf::from(&pf).join(r"Microsoft\Edge\Application"));
        roots.push(PathBuf::from(pf).join(r"Dell\DTP\DiagnosticsSubAgent"));
    }
    roots.push(PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application"));

    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for root in roots {
        let mut consider = |dir: PathBuf| {
            let dll = dir.join("msvcp140.dll");
            let Ok(meta) = fs::metadata(&dll) else {
                return;
            };
            if !meta.is_file() {
                return;
            }
            let t = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                best = Some((t, dir));
            }
        };
        consider(root.clone());
        if let Ok(entries) = fs::read_dir(&root) {
            for ent in entries.flatten() {
                consider(ent.path());
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Names of runtime files that are missing or smaller than the expected minimum.
pub fn missing_runtime_binaries(runtime_dir: &Path) -> Vec<String> {
    let mut missing = Vec::new();
    for (name, min_size) in REQUIRED_LLAMA_BINARIES
        .iter()
        .chain(REQUIRED_CUDA_RUNTIME_FILES.iter())
    {
        let path = runtime_dir.join(name);
        match fs::metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() >= *min_size => {}
            Ok(meta) if meta.is_file() => {
                missing.push(format!("{name} (truncated, {} bytes)", meta.len()));
            }
            _ => missing.push((*name).to_string()),
        }
    }
    missing
}

pub fn llama_server_binaries_ready(runtime_dir: &Path) -> bool {
    REQUIRED_LLAMA_BINARIES.iter().all(|(name, min_size)| {
        fs::metadata(runtime_dir.join(name))
            .map(|m| m.is_file() && m.len() >= *min_size)
            .unwrap_or(false)
    })
}

fn llama_server_exe_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// CPU zip is a different binary (no `ggml-cuda.dll` / CUDA redistributable).
pub fn missing_cpu_runtime_binaries(runtime_dir: &Path) -> Vec<String> {
    let exe = llama_server_exe_name();
    let path = runtime_dir.join(exe);
    match fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() >= 1 => Vec::new(),
        Ok(meta) if meta.is_file() => {
            vec![format!("{exe} (truncated, {} bytes)", meta.len())]
        }
        _ => vec![exe.to_string()],
    }
}

pub fn cpu_runtime_binaries_ready(runtime_dir: &Path) -> bool {
    missing_cpu_runtime_binaries(runtime_dir).is_empty()
}

pub fn cuda_runtime_is_ready(runtime_dir: &Path) -> bool {
    REQUIRED_CUDA_RUNTIME_FILES.iter().all(|(name, min_size)| {
        fs::metadata(runtime_dir.join(name))
            .map(|m| m.is_file() && m.len() >= *min_size)
            .unwrap_or(false)
    })
}

/// True when llama-server + CUDA redistributable DLLs are present and not truncated.
pub fn runtime_binaries_ready(runtime_dir: &Path) -> bool {
    missing_runtime_binaries(runtime_dir).is_empty()
}

fn describe_exit(status: std::process::ExitStatus) -> String {
    let raw = status.to_string();
    #[cfg(windows)]
    {
        if let Some(code) = status.code() {
            let nt = code as u32;
            if nt == 0xC000_0135 {
                return format!(
                    "{raw} (STATUS_DLL_NOT_FOUND — CUDA runtime DLLs missing or truncated)"
                );
            }
        }
    }
    raw
}

fn log_tail(path: &Path) -> String {
    let Ok(text) = fs::read_to_string(path) else {
        return String::new();
    };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    let start = lines.len().saturating_sub(16);
    let tail = lines[start..].join(" | ");
    if tail.len() > 1500 {
        format!("…{}", &tail[tail.len() - 1500..])
    } else {
        tail
    }
}

/// Resolve the host-appropriate runtime dir (`llama-prism-win-cpu` or `…-cuda12`).
pub fn resolve_runtime_dir(search_roots: &[PathBuf]) -> Result<PathBuf, LlmRuntimeError> {
    let name = if host_wants_cpu_runtime() {
        CPU_RUNTIME_DIR_NAME
    } else {
        CUDA_RUNTIME_DIR_NAME
    };
    resolve_named_runtime_dir(search_roots, name)
}

fn resolve_named_runtime_dir(
    search_roots: &[PathBuf],
    dir_name: &'static str,
) -> Result<PathBuf, LlmRuntimeError> {
    if let Ok(dir) = std::env::var("AGENT_LLM_RUNTIME_DIR") {
        let p = PathBuf::from(dir.trim());
        if p.is_dir() {
            return Ok(p);
        }
    }

    for root in search_roots {
        if let Some(found) = find_named_runtime_under(root, dir_name) {
            return Ok(found);
        }
        for ancestor in root.ancestors().take(10) {
            if let Some(found) = find_named_runtime_under(ancestor, dir_name) {
                return Ok(found);
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for ancestor in parent.ancestors().take(8) {
                if let Some(found) = find_named_runtime_under(ancestor, dir_name) {
                    return Ok(found);
                }
            }
        }
    }

    Err(LlmRuntimeError::RuntimeDirMissing { dir: dir_name })
}

fn find_named_runtime_under(root: &Path, dir_name: &str) -> Option<PathBuf> {
    let candidate = root.join("models").join(dir_name);
    if candidate.is_dir() {
        return Some(candidate);
    }
    if root.file_name().and_then(|s| s.to_str()) == Some(dir_name) && root.is_dir() {
        return Some(root.to_path_buf());
    }
    let direct = root.join(dir_name);
    if direct.is_dir() {
        return Some(direct);
    }
    None
}

fn push_unique(out: &mut Vec<PathBuf>, p: PathBuf) {
    if !out.iter().any(|x| x == &p) {
        out.push(p);
    }
}

fn collect_model_search_dirs(search_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = std::env::var("AGENT_LLM_RUNTIME_DIR") {
        let p = PathBuf::from(dir.trim());
        if p.is_dir() {
            push_unique(&mut out, p);
        }
    }
    // Prefer the CUDA dir for GGUF (canonical download location), then CPU dir.
    for name in [CUDA_RUNTIME_DIR_NAME, CPU_RUNTIME_DIR_NAME] {
        for root in search_roots {
            if let Some(found) = find_named_runtime_under(root, name) {
                push_unique(&mut out, found);
            }
            for ancestor in root.ancestors().take(10) {
                if let Some(found) = find_named_runtime_under(ancestor, name) {
                    push_unique(&mut out, found);
                }
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                for ancestor in parent.ancestors().take(8) {
                    if let Some(found) = find_named_runtime_under(ancestor, name) {
                        push_unique(&mut out, found);
                    }
                }
            }
        }
    }
    out
}

fn find_model_files(search_roots: &[PathBuf]) -> Result<(PathBuf, PathBuf), LlmRuntimeError> {
    for dir in collect_model_search_dirs(search_roots) {
        let model = dir.join("models").join(DEFAULT_MODEL_FILE);
        let mmproj = dir.join("models").join(DEFAULT_MMPROJ_FILE);
        if model.is_file() && mmproj.is_file() {
            return Ok((model, mmproj));
        }
    }
    Err(LlmRuntimeError::ModelMissing(PathBuf::from(DEFAULT_MODEL_FILE)))
}

/// True when the active model id / base URL refers to the local Bonsai server.
pub fn is_local_bonsai_target(model_id: Option<&str>, base_url: Option<&str>) -> bool {
    if model_id
        .map(|m| m.trim().eq_ignore_ascii_case(BONSAI_LOCAL_ID))
        .unwrap_or(false)
    {
        return true;
    }
    base_url
        .map(|u| {
            let u = u.to_ascii_lowercase();
            u.contains("127.0.0.1:8080") || u.contains("localhost:8080")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_shape() {
        let spec = LocalRuntimeSpec {
            id: BONSAI_LOCAL_ID.into(),
            display_name: "Bonsai".into(),
            runtime_dir: PathBuf::from("."),
            binary: PathBuf::from("llama-server"),
            model_path: PathBuf::from("m.gguf"),
            mmproj_path: Some(PathBuf::from("mmproj.gguf")),
            host: "127.0.0.1".into(),
            port: 8080,
            auto_start: true,
            n_gpu_layers: 99,
            ctx_size: 8192,
            api_key: "local".into(),
            api_backend: "chat_completions".into(),
            context_window: 8192,
            max_completion_tokens: 4096,
            force_cpu: false,
        };
        assert_eq!(spec.base_url(), "http://127.0.0.1:8080/v1");
    }

    #[test]
    fn detects_local_target() {
        assert!(is_local_bonsai_target(Some("bonsai-local"), None));
        assert!(is_local_bonsai_target(
            Some("other"),
            Some("http://127.0.0.1:8080/v1")
        ));
        assert!(!is_local_bonsai_target(
            Some("grok-4.5"),
            Some("https://api.x.ai/v1")
        ));
    }

    #[test]
    fn detects_truncated_or_missing_cuda_dlls() {
        let dir = std::env::temp_dir().join(format!(
            "llm-rt-cuda-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("llama-server.exe"), vec![0u8; 16]).unwrap();
        fs::write(dir.join("llama-server-impl.dll"), vec![0u8; 1_500_000]).unwrap();
        fs::write(dir.join("ggml-cuda.dll"), vec![0u8; 1_500_000]).unwrap();
        fs::write(dir.join("cudart64_12.dll"), vec![0u8; 200_000]).unwrap();
        fs::write(dir.join("cublas64_12.dll"), vec![0u8; 1024]).unwrap();
        let missing = missing_runtime_binaries(&dir);
        assert!(
            missing.iter().any(|m| m.contains("cublas64_12")),
            "{missing:?}"
        );
        assert!(
            missing.iter().any(|m| m.contains("cublasLt64_12")),
            "{missing:?}"
        );
        assert!(!runtime_binaries_ready(&dir));
        assert!(llama_server_binaries_ready(&dir));
        assert!(!cuda_runtime_is_ready(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tunes_2gb_and_12gb_and_cpu() {
        let cpu = tune_bonsai(None, false);
        assert!(cpu.blocked);
        assert!(!cpu.force_cpu);
        assert_eq!(cpu.n_gpu_layers, 0);
        assert_eq!(cpu.ctx_size, 0);

        let two_gb = tune_bonsai(Some(2048), true);
        assert!(two_gb.blocked);
        assert!(!two_gb.force_cpu);
        assert_eq!(two_gb.n_gpu_layers, 0);

        let four_gb = tune_bonsai(Some(4096), true);
        assert!(four_gb.blocked);
        assert_eq!(four_gb.ctx_size, 0);

        let just_under_8 = tune_bonsai(Some(7_999), true);
        assert!(just_under_8.blocked);
        assert_eq!(just_under_8.ctx_size, 0);

        let eight_gb = tune_bonsai(Some(8192), true);
        assert!(!eight_gb.blocked);
        assert!(!eight_gb.force_cpu);
        assert_eq!(eight_gb.ctx_size, 49_152);
        assert_eq!(eight_gb.n_gpu_layers, 20);

        let twelve = tune_bonsai(Some(12288), true);
        assert!(!twelve.blocked);
        assert!(!twelve.force_cpu);
        assert_eq!(twelve.n_gpu_layers, 99);
        assert_eq!(twelve.ctx_size, 49_152);
    }

    #[test]
    fn cpu_runtime_does_not_require_cuda_dlls() {
        let dir = std::env::temp_dir().join(format!(
            "llm-rt-cpu-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("llama-server.exe"), vec![0u8; 16]).unwrap();
        assert!(cpu_runtime_binaries_ready(&dir));
        assert!(missing_cpu_runtime_binaries(&dir).is_empty());
        assert!(!runtime_binaries_ready(&dir));
        let _ = fs::remove_dir_all(&dir);
    }
}
