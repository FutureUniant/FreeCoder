//! DashScope (阿里百炼) native media APIs — image + video.
//!
//! These are **not** OpenAI-compatible chat endpoints. Used by the bundled
//! `media-mcp` so the Grok agent can generate assets without touching the
//! engine's xAI Imagine tools.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{info, warn};

/// Turn a filesystem path into a user / markdown-safe absolute string.
///
/// Windows `canonicalize` yields `\\?\C:\...` which:
/// 1. users cannot paste into Explorer as-is (and markdown eats `\`)
/// 2. becomes garbage like `\?\C:\Users\ZCY.grokx\...` in chat
///
/// We strip the extended prefix and use `/` separators (valid on Windows,
/// copy-paste friendly, and survives markdown).
pub fn path_for_display(path: impl AsRef<Path>) -> String {
    let raw = path.as_ref().display().to_string();
    normalize_path_string(&raw)
}

/// Normalize a path string that may already include `\\?\` or mangled forms.
pub fn normalize_path_string(raw: &str) -> String {
    let s = raw.trim();
    let stripped = s
        .strip_prefix(r"\\?\")
        .or_else(|| s.strip_prefix(r"//?/"))
        .or_else(|| s.strip_prefix(r"\?\"))
        .or_else(|| s.strip_prefix(r"/?/"))
        .unwrap_or(s);
    stripped.replace('\\', "/")
}

/// Default Beijing DashScope API root (still supported; workspace domains optional).
pub const DEFAULT_API_BASE: &str = "https://dashscope.aliyuncs.com/api/v1";

pub const DEFAULT_IMAGE_MODEL: &str = "qwen-image-3.0-pro";
pub const DEFAULT_VIDEO_T2V_MODEL: &str = "happyhorse-1.1-t2v";
pub const DEFAULT_VIDEO_I2V_MODEL: &str = "happyhorse-1.1-i2v";
pub const DEFAULT_VIDEO_R2V_MODEL: &str = "happyhorse-1.1-r2v";

/// Resolve image model: request override → `GROKX_DEFAULT_IMAGE_MODEL` → built-in.
pub fn resolve_image_model(requested: Option<&str>) -> String {
    requested
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            std::env::var("GROKX_DEFAULT_IMAGE_MODEL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_IMAGE_MODEL.to_string())
}

const IMAGE_PATH: &str = "/services/aigc/multimodal-generation/generation";
const VIDEO_PATH: &str = "/services/aigc/video-generation/video-synthesis";
const TASK_PATH: &str = "/tasks";

const VIDEO_POLL_INTERVAL: Duration = Duration::from_secs(8);
/// HappyHorse queues can sit for a while; keep well under MCP `tool_timeout_sec`.
const VIDEO_POLL_TIMEOUT: Duration = Duration::from_secs(25 * 60);

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("DASHSCOPE_API_KEY / Bailian API key is missing")]
    MissingApiKey,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("api error: {code}: {message}")]
    Api { code: String, message: String },
    #[error("unexpected response: {0}")]
    Unexpected(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("video generation timed out")]
    Timeout,
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone)]
pub struct DashScopeClient {
    http: reqwest::Client,
    api_key: String,
    api_base: String,
}

impl DashScopeClient {
    pub fn new(api_key: impl Into<String>, api_base: Option<String>) -> Result<Self, MediaError> {
        let api_key = api_key.into().trim().to_string();
        if api_key.is_empty() {
            return Err(MediaError::MissingApiKey);
        }
        let api_base = api_base
            .unwrap_or_else(|| DEFAULT_API_BASE.to_string())
            .trim_end_matches('/')
            .to_string();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()?;
        Ok(Self {
            http,
            api_key,
            api_base,
        })
    }

    pub fn from_env() -> Result<Self, MediaError> {
        let key = std::env::var("DASHSCOPE_API_KEY")
            .or_else(|_| std::env::var("BAILIAN_API_KEY"))
            .unwrap_or_default();
        let base = std::env::var("DASHSCOPE_API_BASE").ok();
        Self::new(key, base)
    }

    /// Text-to-image via Qwen Image multimodal-generation (sync).
    pub async fn generate_image(
        &self,
        req: &GenerateImageRequest,
    ) -> Result<GeneratedMedia, MediaError> {
        let model = resolve_image_model(req.model.as_deref());
        let size = req
            .size
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("1664*928");
        let body = serde_json::json!({
            "model": model,
            "input": {
                "messages": [{
                    "role": "user",
                    "content": [{ "text": req.prompt }]
                }]
            },
            "parameters": {
                "negative_prompt": req.negative_prompt.clone().unwrap_or_default(),
                "prompt_extend": req.prompt_extend.unwrap_or(true),
                "watermark": req.watermark.unwrap_or(false),
                "size": size,
                "n": 1
            }
        });

        let url = format!("{}{}", self.api_base, IMAGE_PATH);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let value: serde_json::Value = resp.json().await?;
        if !status.is_success() {
            return Err(api_err_from_value(&value, status.as_u16()));
        }
        if let Some(code) = value.get("code").and_then(|c| c.as_str()) {
            if !code.is_empty() {
                let message = value
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                return Err(MediaError::Api {
                    code: code.to_string(),
                    message,
                });
            }
        }

        let image_url = value
            .pointer("/output/choices/0/message/content")
            .and_then(|c| c.as_array())
            .and_then(|arr| {
                arr.iter().find_map(|item| {
                    item.get("image")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string())
                })
            })
            .ok_or_else(|| MediaError::Unexpected(format!("no image url in response: {value}")))?;

        Ok(GeneratedMedia {
            kind: MediaKind::Image,
            model,
            remote_url: image_url,
            local_path: None,
        })
    }

    /// Text/image/reference-to-video via HappyHorse (async create + poll).
    pub async fn generate_video(
        &self,
        req: &GenerateVideoRequest,
    ) -> Result<GeneratedMedia, MediaError> {
        let mode = req.mode.unwrap_or(VideoMode::TextToVideo);
        let model = resolve_video_model(req.model.as_deref(), mode);
        let mut input = serde_json::json!({
            "prompt": req.prompt.clone().unwrap_or_default(),
        });
        match mode {
            VideoMode::TextToVideo => {}
            VideoMode::ImageToVideo => {
                let url = req
                    .image_url
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        MediaError::Message(
                            "image_to_video requires image_url (http(s) or data: URI)".into(),
                        )
                    })?;
                input["media"] = serde_json::json!([{
                    "type": "first_frame",
                    "url": url,
                }]);
            }
            VideoMode::ReferenceToVideo => {
                let refs = &req.reference_image_urls;
                if refs.is_empty() {
                    return Err(MediaError::Message(
                        "reference_to_video requires reference_image_urls".into(),
                    ));
                }
                let media: Vec<_> = refs
                    .iter()
                    .map(|u| serde_json::json!({ "type": "reference", "url": u }))
                    .collect();
                input["media"] = serde_json::Value::Array(media);
            }
        }

        let mut parameters = serde_json::json!({
            "resolution": req.resolution.as_deref().unwrap_or("720P"),
            "duration": req.duration.unwrap_or(5),
            "watermark": req.watermark.unwrap_or(false),
        });
        if matches!(mode, VideoMode::TextToVideo) {
            parameters["ratio"] = serde_json::json!(req.ratio.as_deref().unwrap_or("16:9"));
        }

        let body = serde_json::json!({
            "model": model,
            "input": input,
            "parameters": parameters,
        });

        let url = format!("{}{}", self.api_base, VIDEO_PATH);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("Content-Type", "application/json")
            .header("X-DashScope-Async", "enable")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let value: serde_json::Value = resp.json().await?;
        if !status.is_success() {
            return Err(api_err_from_value(&value, status.as_u16()));
        }
        let task_id = value
            .pointer("/output/task_id")
            .and_then(|t| t.as_str())
            .ok_or_else(|| MediaError::Unexpected(format!("no task_id: {value}")))?
            .to_string();

        info!(%task_id, %model, "dashscope video task created");
        let video_url = self.poll_video_task(&task_id).await?;
        Ok(GeneratedMedia {
            kind: MediaKind::Video,
            model,
            remote_url: video_url,
            local_path: None,
        })
    }

    async fn poll_video_task(&self, task_id: &str) -> Result<String, MediaError> {
        let url = format!("{}{TASK_PATH}/{task_id}", self.api_base);
        let deadline = tokio::time::Instant::now() + VIDEO_POLL_TIMEOUT;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(MediaError::Timeout);
            }
            let resp = self
                .http
                .get(&url)
                .bearer_auth(&self.api_key)
                .send()
                .await?;
            let value: serde_json::Value = resp.json().await?;
            let status = value
                .pointer("/output/task_status")
                .and_then(|s| s.as_str())
                .unwrap_or("UNKNOWN");
            match status {
                "SUCCEEDED" => {
                    return value
                        .pointer("/output/video_url")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string())
                        .ok_or_else(|| MediaError::Unexpected(format!("no video_url: {value}")));
                }
                "FAILED" | "CANCELED" | "UNKNOWN" => {
                    let code = value
                        .pointer("/output/code")
                        .and_then(|c| c.as_str())
                        .unwrap_or("TaskFailed")
                        .to_string();
                    let message = value
                        .pointer("/output/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or(status)
                        .to_string();
                    return Err(MediaError::Api { code, message });
                }
                _ => {
                    // PENDING / RUNNING
                    tokio::time::sleep(VIDEO_POLL_INTERVAL).await;
                }
            }
        }
    }

    /// Download a remote media URL into `dir` and return the **absolute** local path.
    pub async fn download_to_dir(
        &self,
        remote_url: &str,
        dir: &Path,
        file_stem: &str,
        ext: &str,
    ) -> Result<PathBuf, MediaError> {
        std::fs::create_dir_all(dir)?;
        let abs_dir = std::fs::canonicalize(dir).unwrap_or_else(|_| {
            if dir.is_absolute() {
                dir.to_path_buf()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(dir)
            }
        });
        let bytes = self.http.get(remote_url).send().await?.bytes().await?;
        let path = abs_dir.join(format!("{file_stem}.{ext}"));
        std::fs::write(&path, &bytes)?;
        Ok(std::fs::canonicalize(&path).unwrap_or(path))
    }
}

fn api_err_from_value(value: &serde_json::Value, status: u16) -> MediaError {
    let code = value
        .get("code")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("HTTP_{status}"));
    let message = value
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("request failed")
        .to_string();
    MediaError::Api { code, message }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoMode {
    TextToVideo,
    ImageToVideo,
    ReferenceToVideo,
}

/// Resolve video model: request override → `GROKX_DEFAULT_VIDEO_MODEL` → built-in.
pub fn resolve_video_model(requested: Option<&str>, mode: VideoMode) -> String {
    if let Some(m) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        return m.to_string();
    }
    if let Ok(env_m) = std::env::var("GROKX_DEFAULT_VIDEO_MODEL") {
        let env_m = env_m.trim();
        if !env_m.is_empty() {
            let lower = env_m.to_ascii_lowercase();
            let mode_ok = match mode {
                VideoMode::TextToVideo => {
                    lower.contains("t2v") || (!lower.contains("i2v") && !lower.contains("r2v"))
                }
                VideoMode::ImageToVideo => lower.contains("i2v"),
                VideoMode::ReferenceToVideo => lower.contains("r2v"),
            };
            // t2v default applies to text_to_video; other modes only if SKU matches.
            if matches!(mode, VideoMode::TextToVideo) || mode_ok {
                return env_m.to_string();
            }
        }
    }
    match mode {
        VideoMode::TextToVideo => DEFAULT_VIDEO_T2V_MODEL.to_string(),
        VideoMode::ImageToVideo => DEFAULT_VIDEO_I2V_MODEL.to_string(),
        VideoMode::ReferenceToVideo => DEFAULT_VIDEO_R2V_MODEL.to_string(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateImageRequest {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub prompt_extend: Option<bool>,
    #[serde(default)]
    pub watermark: Option<bool>,
    /// Optional directory to download the result into.
    #[serde(default)]
    pub output_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateVideoRequest {
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: Option<VideoMode>,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub reference_image_urls: Vec<String>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub ratio: Option<String>,
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub watermark: Option<bool>,
    #[serde(default)]
    pub output_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedMedia {
    pub kind: MediaKind,
    pub model: String,
    pub remote_url: String,
    pub local_path: Option<String>,
}

impl GeneratedMedia {
    pub async fn with_download(
        mut self,
        client: &DashScopeClient,
        output_dir: Option<&str>,
    ) -> Result<Self, MediaError> {
        let Some(dir) = output_dir.map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()) else {
            return Ok(self);
        };
        let ext = match self.kind {
            MediaKind::Image => "png",
            MediaKind::Video => "mp4",
        };
        let stem = format!(
            "{}-{}",
            match self.kind {
                MediaKind::Image => "image",
                MediaKind::Video => "video",
            },
            &uuid::Uuid::new_v4().to_string()[..8]
        );
        match client
            .download_to_dir(&self.remote_url, &dir, &stem, ext)
            .await
        {
            Ok(path) => {
                // Always store a copy-paste / markdown-safe absolute path
                // (no Windows `\\?\` prefix; forward slashes).
                self.local_path = Some(path_for_display(&path));
                Ok(self)
            }
            Err(err) => {
                warn!(error = %err, "failed to download media; returning remote url only");
                // Keep remote success, but surface download failure in local_path marker
                // via a follow-up message from the MCP layer (format_media_result).
                Err(MediaError::Message(format!(
                    "media generated (remote_url={}) but download to {} failed: {err}",
                    self.remote_url,
                    dir.display()
                )))
            }
        }
    }
}

/// Encode a local image file as a `data:` URI for i2v / r2v inputs.
pub fn file_to_data_uri(path: &Path) -> Result<String, MediaError> {
    let bytes = std::fs::read(path)?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

impl Serialize for MediaKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
        })
    }
}

impl<'de> Deserialize<'de> for MediaKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "image" => Ok(MediaKind::Image),
            "video" => Ok(MediaKind::Video),
            other => Err(serde::de::Error::custom(format!("unknown media kind: {other}"))),
        }
    }
}

#[cfg(test)]
mod path_display_tests {
    use super::*;

    #[test]
    fn strips_windows_extended_prefix() {
        assert_eq!(
            normalize_path_string(r"\\?\C:\Users\ZCY\.grokx\a.png"),
            "C:/Users/ZCY/.grokx/a.png"
        );
        assert_eq!(
            normalize_path_string(r"\?\C:\Users\x\.grokx\a.png"),
            "C:/Users/x/.grokx/a.png"
        );
    }

    #[test]
    fn forward_slashes_only() {
        assert_eq!(
            normalize_path_string(r"C:\Users\ZCY\.grokx\workspace\.grokx\tasks\1\images\a.png"),
            "C:/Users/ZCY/.grokx/workspace/.grokx/tasks/1/images/a.png"
        );
    }
}
