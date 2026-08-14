use serde::{Deserialize, Serialize};

use crate::SessionId;

/// High-level turn state for a single user prompt cycle.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Idle,
    Streaming,
    WaitingPermission,
    RunningTools,
    Completed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnSnapshot {
    pub session_id: SessionId,
    pub state: TurnState,
    pub error: Option<String>,
}

/// Events the UI should render. Produced by the ACP bridge, consumed by app-core.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppEvent {
    AgentStatus {
        status: AgentConnectionStatus,
        detail: Option<String>,
    },
    SessionReady {
        session_id: SessionId,
        engine_session_id: Option<String>,
    },
    UserMessage {
        session_id: SessionId,
        text: String,
    },
    MessageDelta {
        session_id: SessionId,
        text: String,
    },
    ThoughtDelta {
        session_id: SessionId,
        text: String,
    },
    ToolStarted {
        session_id: SessionId,
        tool: crate::ToolCall,
    },
    ToolUpdated {
        session_id: SessionId,
        tool: crate::ToolCall,
    },
    PermissionNeeded {
        session_id: SessionId,
        request: crate::PermissionRequest,
    },
    PlanUpdated {
        session_id: SessionId,
        steps: Vec<String>,
    },
    /// Grok Build `/goal` orchestration update (`x.ai/session_notification`).
    GoalUpdated {
        session_id: SessionId,
        goal_id: String,
        objective: String,
        status: String,
        phase: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pause_message: Option<String>,
    },
    TurnState {
        session_id: SessionId,
        state: TurnState,
    },
    TurnFinished {
        session_id: SessionId,
        state: TurnState,
    },
    /// Session context usage from engine `_meta.totalTokens` when available.
    ContextUsage {
        session_id: SessionId,
        /// Accumulated tokens used in the session (engine-reported).
        used_tokens: u64,
    },
    AgentError {
        message: String,
        /// Product routing code (`NETWORK`, `CONTEXT_OVERFLOW`, …) when known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_code: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnectionStatus {
    MissingBinary,
    Starting,
    Ready,
    Reconnecting,
    Failed,
}

impl AgentConnectionStatus {
    /// Stable wire/UI token (snake_case). Prefer this over `Debug`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingBinary => "missing_binary",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Reconnecting => "reconnecting",
            Self::Failed => "failed",
        }
    }
}

impl std::fmt::Display for AgentConnectionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
