//! No-op telemetry sink.
//!
//! Open-source / `pnpm tauri dev` builds compile this crate. Official
//! installers may swap in `tencentcloud/telemetry-official` at pack time.
//! Public API must stay identical to that replacement.

use domain::AppEvent;

/// Start the reporter. OSS builds do nothing.
pub fn init(_app_version: &str) {}

/// Record a product event. OSS builds drop it.
///
/// `model` is the active model id when known. Implementations must not
/// persist prompt text, file paths, or API keys.
pub fn on_event(_event: &AppEvent, _model: Option<&str>) {}
