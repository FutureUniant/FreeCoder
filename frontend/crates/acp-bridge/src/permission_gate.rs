//! Permission request parking: when auto-approve is off, ACP permission
//! JSON-RPC requests stay pending until the UI resolves them.
//!
//! Also tracks session-scoped "allow similar" keys so matching follow-up
//! requests can be answered without another prompt.

use std::collections::{HashMap, HashSet};

use domain::{PermissionDecision, PermissionOption};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GateError {
    #[error("unknown permission request id: {0}")]
    Unknown(String),
    #[error("permission already resolved: {0}")]
    AlreadyResolved(String),
}

#[derive(Debug, Clone)]
pub struct ParkedPermission {
    /// App-facing request id (also used by UI).
    pub request_id: String,
    /// JSON-RPC id from the agent (may be number or string).
    pub rpc_id: Value,
    pub tool_name: String,
    pub summary: String,
    pub similarity_key: String,
    pub options: Vec<PermissionOption>,
}

/// Tracks in-flight permission RPCs that must not be answered until the user decides.
#[derive(Debug, Default)]
pub struct PermissionGate {
    parked: HashMap<String, ParkedPermission>,
    resolved: HashMap<String, PermissionDecision>,
    /// Keys remembered via AllowSession for the life of this agent connection.
    session_allows: HashSet<String>,
}

impl PermissionGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Park a permission request. Returns false if auto_approve should answer immediately.
    pub fn should_park(auto_approve: bool) -> bool {
        !auto_approve
    }

    pub fn park(&mut self, entry: ParkedPermission) {
        self.parked.insert(entry.request_id.clone(), entry);
    }

    pub fn is_pending(&self, request_id: &str) -> bool {
        self.parked.contains_key(request_id)
    }

    pub fn pending_ids(&self) -> Vec<String> {
        self.parked.keys().cloned().collect()
    }

    pub fn session_allowed(&self, similarity_key: &str) -> bool {
        let key = similarity_key.trim();
        !key.is_empty() && self.session_allows.contains(key)
    }

    pub fn remember_session_allow(&mut self, similarity_key: &str) {
        let key = similarity_key.trim();
        if !key.is_empty() {
            self.session_allows.insert(key.to_string());
        }
    }

    /// Resolve a parked request into an ACP outcome payload + the original rpc id.
    pub fn resolve(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(Value, Value), GateError> {
        let entry = self.parked.remove(request_id).ok_or_else(|| {
            if self.resolved.contains_key(request_id) {
                GateError::AlreadyResolved(request_id.to_string())
            } else {
                GateError::Unknown(request_id.to_string())
            }
        })?;
        if decision == PermissionDecision::AllowSession {
            self.remember_session_allow(&entry.similarity_key);
        }
        self.resolved.insert(request_id.to_string(), decision);
        Ok((
            entry.rpc_id,
            permission_outcome_value_with_options(decision, &entry.options),
        ))
    }

    pub fn last_decision(&self, request_id: &str) -> Option<PermissionDecision> {
        self.resolved.get(request_id).copied()
    }
}

pub fn permission_outcome_value(decision: PermissionDecision) -> Value {
    permission_outcome_value_with_options(decision, &[])
}

pub fn permission_outcome_value_with_options(
    decision: PermissionDecision,
    options: &[PermissionOption],
) -> Value {
    // IMPORTANT: optionId MUST be one of the ids the agent offered.
    // Generic clients get `always-allow`; Desktop MCP gets `allow-always-mcp`.
    // Never invent `allow-always` — that id is often absent and the agent
    // replies with "unknown permission option", which looks like a tool failure
    // right after the user clicked Allow.
    let option_id = match decision {
        PermissionDecision::AllowOnce => {
            pick_option_id(options, &["allow-once", "allow_once"]).unwrap_or("allow-once")
        }
        PermissionDecision::AllowSession => pick_option_id(
            options,
            &[
                // Prefer the most specific always-* ids first (exact match).
                "allow-always-mcp",
                "allow-always-command",
                "allow-always-domain",
                "allow-edits-session",
                "always-allow",
                "allow-always",
                "allow_always",
            ],
        )
        // Safe universal fallback: every access kind offers allow-once.
        // Better to allow once than to send an unknown id and fail the tool.
        .unwrap_or("allow-once"),
        PermissionDecision::Deny => {
            pick_option_id(options, &["reject-once", "reject_once", "deny"]).unwrap_or("reject-once")
        }
    };
    json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id
        }
    })
}

fn normalize_option_token(s: &str) -> String {
    s.replace('_', "-").to_ascii_lowercase()
}

fn pick_option_id<'a>(options: &'a [PermissionOption], preferred: &[&str]) -> Option<&'a str> {
    if options.is_empty() {
        return None;
    }
    // 1) Exact option_id match (normalized). Avoid `contains` — it can pick
    // `allow-always-mcp` when wanting a bare `allow-always`, or worse, the
    // yolo "enable always-approve" row when that id substring-matches.
    for want in preferred {
        let want_norm = normalize_option_token(want);
        for opt in options {
            if normalize_option_token(&opt.option_id) == want_norm {
                return Some(opt.option_id.as_str());
            }
        }
    }
    // 2) Exact kind match (allow_always / allow_once / …).
    for want in preferred {
        let want_norm = normalize_option_token(want);
        for opt in options {
            if normalize_option_token(&opt.kind) == want_norm {
                return Some(opt.option_id.as_str());
            }
        }
    }
    // 3) Family fallback by kind only.
    let family = preferred
        .first()
        .map(|s| {
            let n = normalize_option_token(s);
            if n.contains("always") {
                "always"
            } else if n.contains("allow") {
                "allow"
            } else {
                "reject"
            }
        })
        .unwrap_or("allow");
    for opt in options {
        let kind = normalize_option_token(&opt.kind);
        if family == "always" && kind.contains("always") {
            return Some(opt.option_id.as_str());
        }
        if family == "allow" && kind.contains("allow") && !kind.contains("always") {
            return Some(opt.option_id.as_str());
        }
        if family == "reject" && (kind.contains("reject") || kind.contains("deny")) {
            return Some(opt.option_id.as_str());
        }
    }
    None
}

/// Whether a deny decision should block the tool path (always true for Deny).
pub fn decision_blocks_tool(decision: PermissionDecision) -> bool {
    matches!(decision, PermissionDecision::Deny)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parks_until_allow() {
        assert!(PermissionGate::should_park(false));
        assert!(!PermissionGate::should_park(true));

        let mut gate = PermissionGate::new();
        gate.park(ParkedPermission {
            request_id: "req-1".into(),
            rpc_id: json!(42),
            tool_name: "Bash".into(),
            summary: "run ls".into(),
            similarity_key: "bash:ls".into(),
            options: vec![],
        });
        assert!(gate.is_pending("req-1"));
        assert!(gate.pending_ids().contains(&"req-1".to_string()));

        let (rpc_id, outcome) = gate
            .resolve("req-1", PermissionDecision::AllowOnce)
            .unwrap();
        assert_eq!(rpc_id, json!(42));
        assert_eq!(outcome["outcome"]["optionId"], "allow-once");
        assert!(!gate.is_pending("req-1"));
        assert!(!decision_blocks_tool(PermissionDecision::AllowOnce));
    }

    #[test]
    fn allow_session_remembers_similarity_key() {
        let mut gate = PermissionGate::new();
        gate.park(ParkedPermission {
            request_id: "req-a".into(),
            rpc_id: json!(1),
            tool_name: "Edit".into(),
            summary: "edit file".into(),
            similarity_key: "edit:src/main.rs".into(),
            options: vec![PermissionOption {
                option_id: "allow-always".into(),
                name: "Always".into(),
                kind: "allow_always".into(),
            }],
        });
        let (_id, outcome) = gate
            .resolve("req-a", PermissionDecision::AllowSession)
            .unwrap();
        assert_eq!(outcome["outcome"]["optionId"], "allow-always");
        assert!(gate.session_allowed("edit:src/main.rs"));
        assert!(!gate.session_allowed("edit:other.rs"));
    }

    #[test]
    fn deny_blocks_and_stays_resolved() {
        let mut gate = PermissionGate::new();
        gate.park(ParkedPermission {
            request_id: "req-deny".into(),
            rpc_id: json!("rpc-9"),
            tool_name: "Write".into(),
            summary: "write file".into(),
            similarity_key: "edit:a.txt".into(),
            options: vec![],
        });
        let (_id, outcome) = gate.resolve("req-deny", PermissionDecision::Deny).unwrap();
        assert_eq!(outcome["outcome"]["optionId"], "reject-once");
        assert!(decision_blocks_tool(PermissionDecision::Deny));
        assert_eq!(
            gate.last_decision("req-deny"),
            Some(PermissionDecision::Deny)
        );
        assert_eq!(
            gate.resolve("req-deny", PermissionDecision::AllowOnce),
            Err(GateError::AlreadyResolved("req-deny".into()))
        );
    }

    #[test]
    fn allow_session_empty_options_falls_back_to_allow_once() {
        // Empty options used to emit "allow-always", which agents reject as
        // "unknown permission option" for Generic / MCP prompts.
        let outcome =
            permission_outcome_value_with_options(PermissionDecision::AllowSession, &[]);
        assert_eq!(outcome["outcome"]["optionId"], "allow-once");
    }

    #[test]
    fn allow_session_picks_always_allow_for_generic_mcp() {
        let options = vec![
            PermissionOption {
                option_id: "always-allow".into(),
                name: "Always".into(),
                kind: "allow_always".into(),
            },
            PermissionOption {
                option_id: "allow-once".into(),
                name: "Once".into(),
                kind: "allow_once".into(),
            },
        ];
        let outcome =
            permission_outcome_value_with_options(PermissionDecision::AllowSession, &options);
        assert_eq!(outcome["outcome"]["optionId"], "always-allow");
    }

    #[test]
    fn allow_session_prefers_allow_always_mcp() {
        let options = vec![
            PermissionOption {
                option_id: "allow-always-mcp".into(),
                name: "Always MCP".into(),
                kind: "allow_always".into(),
            },
            PermissionOption {
                option_id: "allow-once".into(),
                name: "Once".into(),
                kind: "allow_once".into(),
            },
        ];
        let outcome =
            permission_outcome_value_with_options(PermissionDecision::AllowSession, &options);
        assert_eq!(outcome["outcome"]["optionId"], "allow-always-mcp");
    }
}
