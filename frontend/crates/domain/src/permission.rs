use serde::{Deserialize, Serialize};

use crate::ToolCallId;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Reads auto; writes and shell require approval.
    Standard,
    /// Most actions require approval.
    Strict,
    /// Project-local writes auto; dangerous shell still gated.
    TrustedProject,
}

impl Default for PermissionMode {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    Deny,
    /// Allow this and remember similar ops for the rest of the session
    /// (same file edit, same command kind, etc.).
    AllowSession,
}

/// One choice offered by the agent in `session/request_permission`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    /// ACP kind hint: `allow_once` | `allow_always` | `reject_once` | `reject_always`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: String,
    pub tool_call_id: Option<ToolCallId>,
    pub tool_name: String,
    pub summary: String,
    pub detail: Option<String>,
    pub risk: PermissionRisk,
    /// Options from the agent (may be empty for older agents).
    #[serde(default)]
    pub options: Vec<PermissionOption>,
    /// Client-side key for "allow similar" matching within a session.
    #[serde(default)]
    pub similarity_key: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionRisk {
    Low,
    Medium,
    High,
}
