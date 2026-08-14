use domain::{
    AppEvent, PermissionRequest, PermissionRisk, SessionId, ToolCall, ToolCallId, ToolCallStatus,
    TurnState,
};
use serde_json::Value;

/// Pull `totalTokens` from ACP update / notification `_meta` when present.
fn extract_total_tokens(update: &Value, params: Option<&Value>) -> Option<u64> {
    let from_meta = |meta: Option<&Value>| -> Option<u64> {
        meta?.get("totalTokens")
            .or_else(|| meta?.get("total_tokens"))
            .and_then(|v| v.as_u64())
    };
    from_meta(update.get("_meta"))
        .or_else(|| from_meta(update.get("meta")))
        .or_else(|| from_meta(params.and_then(|p| p.get("_meta"))))
        .or_else(|| from_meta(params.and_then(|p| p.get("meta"))))
}

/// Map a subset of ACP `session/update` payloads into app events.
/// Returns an empty list when the update type is unknown (forward-compatible).
///
/// `params` is the full notification params (may carry `_meta.totalTokens`).
pub fn map_session_update(
    session_id: SessionId,
    update: &Value,
    params: Option<&Value>,
) -> Vec<AppEvent> {
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut events = match kind {
        "agent_message_chunk" => {
            let text = extract_text(update).unwrap_or_default();
            if text.is_empty() {
                vec![]
            } else {
                vec![AppEvent::MessageDelta {
                    session_id: session_id.clone(),
                    text,
                }]
            }
        }
        "agent_thought_chunk" => {
            let text = extract_text(update).unwrap_or_default();
            if text.is_empty() {
                vec![]
            } else {
                vec![AppEvent::ThoughtDelta {
                    session_id: session_id.clone(),
                    text,
                }]
            }
        }
        "tool_call" => {
            let tool = ToolCall {
                id: ToolCallId(tool_call_id(update)),
                title: update
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string(),
                kind: update
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("other")
                    .to_string(),
                status: ToolCallStatus::Running,
                input: update
                    .get("rawInput")
                    .cloned()
                    .or_else(|| update.get("input").cloned()),
                output_preview: None,
            };
            vec![AppEvent::ToolStarted {
                session_id: session_id.clone(),
                tool,
            }]
        }
        "tool_call_update" => {
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .map(map_tool_status)
                .unwrap_or(ToolCallStatus::Running);
            let tool = ToolCall {
                id: ToolCallId(tool_call_id(update)),
                title: update
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string(),
                kind: update
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("other")
                    .to_string(),
                status,
                input: update
                    .get("rawInput")
                    .cloned()
                    .or_else(|| update.get("input").cloned()),
                output_preview: extract_tool_output(update),
            };
            vec![AppEvent::ToolUpdated {
                session_id: session_id.clone(),
                tool,
            }]
        }
        "plan" => {
            let steps = update
                .get("entries")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| {
                            e.get("content")
                                .or_else(|| e.get("title"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            vec![AppEvent::PlanUpdated {
                session_id: session_id.clone(),
                steps,
            }]
        }
        "goal_updated" => {
            let goal_id = update
                .get("goal_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let objective = update
                .get("objective")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let phase = update
                .get("phase")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let pause_message = update
                .get("pause_message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if goal_id.is_empty() && status.is_empty() {
                vec![]
            } else {
                vec![AppEvent::GoalUpdated {
                    session_id: session_id.clone(),
                    goal_id,
                    objective,
                    status,
                    phase,
                    pause_message,
                }]
            }
        }
        _ => vec![],
    };

    if let Some(used) = extract_total_tokens(update, params) {
        events.push(AppEvent::ContextUsage {
            session_id,
            used_tokens: used,
        });
    }

    events
}

/// Map a `session/request_permission` params object into a UI event.
///
/// `request_id` is the app-facing id used to resolve the parked RPC.
pub fn map_permission_request(
    session_id: SessionId,
    params: &Value,
    request_id: String,
) -> AppEvent {
    let tool_name = params
        .pointer("/toolCall/title")
        .or_else(|| params.pointer("/toolCall/kind"))
        .or_else(|| params.get("toolName"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();

    let summary = params
        .pointer("/toolCall/title")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("summary").and_then(|v| v.as_str()))
        .unwrap_or("Agent requests permission")
        .to_string();

    let detail = params
        .pointer("/toolCall/rawInput")
        .map(|v| v.to_string())
        .or_else(|| {
            params
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    let tool_call_id = params
        .pointer("/toolCall/toolCallId")
        .or_else(|| params.pointer("/toolCall/id"))
        .and_then(|v| v.as_str())
        .map(|s| ToolCallId(s.to_string()));

    let options = extract_permission_options(params);
    let similarity_key = permission_similarity_key(params, &tool_name);

    AppEvent::PermissionNeeded {
        session_id,
        request: PermissionRequest {
            id: request_id,
            tool_call_id,
            tool_name,
            summary,
            detail,
            risk: PermissionRisk::Medium,
            options,
            similarity_key,
        },
    }
}

/// Extract display fields without building a full event (for parking metadata).
pub fn permission_meta(params: &Value) -> (String, String) {
    let tool_name = params
        .pointer("/toolCall/title")
        .or_else(|| params.pointer("/toolCall/kind"))
        .or_else(|| params.get("toolName"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let summary = params
        .pointer("/toolCall/title")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("summary").and_then(|v| v.as_str()))
        .unwrap_or("Agent requests permission")
        .to_string();
    (tool_name, summary)
}

fn extract_permission_options(params: &Value) -> Vec<domain::PermissionOption> {
    let Some(arr) = params.get("options").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|o| {
            let option_id = o
                .get("optionId")
                .or_else(|| o.get("option_id"))
                .or_else(|| o.get("id"))
                .and_then(|v| v.as_str())?
                .to_string();
            let name = o
                .get("name")
                .or_else(|| o.get("label"))
                .and_then(|v| v.as_str())
                .unwrap_or(option_id.as_str())
                .to_string();
            let kind = o
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(domain::PermissionOption {
                option_id,
                name,
                kind,
            })
        })
        .collect()
}

/// Build a stable key so "allow similar" can match same-file edits / same command kinds.
pub fn permission_similarity_key(params: &Value, tool_name: &str) -> String {
    let kind = params
        .pointer("/toolCall/kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let raw = params.pointer("/toolCall/rawInput");

    if let Some(path) = extract_path(raw, params) {
        return format!("edit:{}", normalize_path_key(&path));
    }

    if let Some(cmd) = extract_command(raw) {
        let token = command_kind_token(&cmd);
        if !token.is_empty() {
            return format!("bash:{token}");
        }
    }

    let title = tool_name.trim().to_ascii_lowercase();
    // MCP / use_tool: key by qualified tool name so "allow similar" covers
    // repeated generate_image calls without also matching unrelated MCP tools.
    if title.contains("generate_image")
        || title.contains("generate_video")
        || title.contains("bailian-media")
        || title.starts_with("mcp:")
        || title.contains("__")
    {
        return format!("mcp:{}", title);
    }
    if !kind.is_empty() {
        format!("tool:{kind}:{title}")
    } else if !title.is_empty() {
        format!("tool:{title}")
    } else {
        "tool:unknown".into()
    }
}

fn extract_path(raw: Option<&Value>, params: &Value) -> Option<String> {
    let from_raw = raw.and_then(|r| {
        r.get("path")
            .or_else(|| r.get("file"))
            .or_else(|| r.get("file_path"))
            .or_else(|| r.get("filePath"))
            .or_else(|| r.get("target_file"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                r.get("locations")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|loc| loc.get("path").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
            })
    });
    from_raw.or_else(|| {
        params
            .pointer("/toolCall/locations/0/path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    })
}

fn extract_command(raw: Option<&Value>) -> Option<String> {
    raw.and_then(|r| {
        r.get("command")
            .or_else(|| r.get("cmd"))
            .or_else(|| r.get("shell_command"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    })
}

fn normalize_path_key(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase()
}

fn command_kind_token(cmd: &str) -> String {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Strip common wrappers: `cd foo && npm run` → look at last segment after &&/||/;
    let segment = trimmed
        .rsplit_once("&&")
        .or_else(|| trimmed.rsplit_once("||"))
        .or_else(|| trimmed.rsplit_once(';'))
        .map(|(_, r)| r.trim())
        .unwrap_or(trimmed);
    let mut parts = segment.split_whitespace();
    let mut first = parts.next().unwrap_or("").to_ascii_lowercase();
    // Drop env assignments: FOO=1 npm → npm
    while first.contains('=') {
        first = parts.next().unwrap_or("").to_ascii_lowercase();
    }
    // Normalize path-like binaries: ./node_modules/.bin/vite → vite
    if let Some(name) = first.rsplit(['/', '\\']).next() {
        return name.to_string();
    }
    first
}

pub fn turn_finished(session_id: SessionId, state: TurnState) -> AppEvent {
    AppEvent::TurnFinished { session_id, state }
}

fn tool_call_id(update: &Value) -> String {
    update
        .get("toolCallId")
        .or_else(|| update.get("tool_call_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string()
}

fn map_tool_status(status: &str) -> ToolCallStatus {
    match status {
        "pending" => ToolCallStatus::Pending,
        "in_progress" | "running" => ToolCallStatus::Running,
        "completed" | "success" => ToolCallStatus::Completed,
        "failed" | "error" => ToolCallStatus::Failed,
        "cancelled" | "canceled" => ToolCallStatus::Cancelled,
        _ => ToolCallStatus::Running,
    }
}

fn extract_text(update: &Value) -> Option<String> {
    update
        .get("content")
        .and_then(|c| {
            if let Some(s) = c.as_str() {
                Some(s.to_string())
            } else {
                c.get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            }
        })
        .or_else(|| {
            update
                .get("text")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
        })
}

fn extract_tool_output(update: &Value) -> Option<String> {
    update
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| {
            item.get("content")
                .and_then(|c| c.get("text"))
                .or_else(|| item.get("text"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            update
                .get("rawOutput")
                .map(|v| v.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_message_chunk() {
        let sid = SessionId::new();
        let events = map_session_update(
            sid,
            &json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "hello" }
            }),
            None,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            AppEvent::MessageDelta { text, .. } => assert_eq!(text, "hello"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn maps_context_usage_from_meta() {
        let sid = SessionId::new();
        let events = map_session_update(
            sid,
            &json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "hi" },
                "_meta": { "totalTokens": 1234u64 }
            }),
            None,
        );
        assert!(events.iter().any(|e| matches!(
            e,
            AppEvent::ContextUsage {
                used_tokens: 1234,
                ..
            }
        )));
    }

    #[test]
    fn maps_tool_call_update() {
        let sid = SessionId::new();
        let events = map_session_update(
            sid,
            &json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "title": "read_file"
            }),
            None,
        );
        assert!(!events.is_empty());
        match &events[0] {
            AppEvent::ToolUpdated { tool, .. } => {
                assert_eq!(tool.status, ToolCallStatus::Completed);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn maps_goal_updated() {
        let sid = SessionId::new();
        let events = map_session_update(
            sid,
            &json!({
                "sessionUpdate": "goal_updated",
                "goal_id": "g1",
                "objective": "migrate auth",
                "status": "active",
                "phase": "executing"
            }),
            None,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            AppEvent::GoalUpdated {
                goal_id,
                objective,
                status,
                phase,
                ..
            } => {
                assert_eq!(goal_id, "g1");
                assert_eq!(objective, "migrate auth");
                assert_eq!(status, "active");
                assert_eq!(phase, "executing");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
