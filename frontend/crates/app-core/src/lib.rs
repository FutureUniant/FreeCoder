//! Application orchestration: process supervision, ACP session, turns.
//!
//! Multiple tasks can each keep a live agent process so switching tasks does
//! not cancel work in progress on another session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use acp_bridge::{AcpClient, AcpClientHandle, BridgeError, ConnectOptions};
use agent_process::{resolve_engine, spawn_agent_stdio, ResolvedEngine, SpawnOptions};
use app_config::{
    AppPaths, ModelEndpointSettings, PublicEndpointSettings, PublicUserSettings, SettingsUpdate,
    UserSettings,
};
use chrono::Utc;
use domain::{
    AgentConnectionStatus, AppEvent, ModelInfo, PermissionDecision, Project, ProjectId,
    PromptRequest, ReasoningEffort, SessionId, SessionMeta, TurnState,
};
use llm_runtime::{
    host_supports_local_bonsai, is_local_bonsai_target, tune_bonsai_for_host, HardwareTune,
    LlmRuntimeError, LlmRuntimeManager, LocalRuntimeStatus, BONSAI_LOCAL_ID,
};
use permissions::{PermissionBroker, Policy};
use session_store::{ProjectListItem, SessionListItem, SessionStore};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{mpsc, Mutex, RwLock};
use tracing::{info, warn};

#[derive(Debug, Error)]
pub enum CoreError {
    #[error(transparent)]
    Resolve(#[from] agent_process::ResolveError),
    #[error(transparent)]
    Config(#[from] app_config::ConfigError),
    #[error(transparent)]
    Spawn(#[from] agent_process::SpawnError),
    #[error(transparent)]
    Bridge(#[from] BridgeError),
    #[error(transparent)]
    LlmRuntime(#[from] LlmRuntimeError),
    #[error("agent is not connected")]
    NotConnected,
    #[error("a turn is already in progress")]
    TurnInProgress,
    #[error("project root does not exist: {0}")]
    InvalidProject(String),
    #[error("{0}")]
    Message(String),
}

struct LiveAgent {
    /// Dropping this aborts the reader task and kills the child.
    client: AcpClient,
    handle: AcpClientHandle,
    /// Fixed project path (user-chosen).
    project_root: PathBuf,
    /// App-owned task metadata dir (`<project>/.grokx/tasks/<id>`): chat history etc.
    /// Agent process cwd is `project_root`, not this path.
    work_path: PathBuf,
    /// App-level session id this agent belongs to (same as map key).
    #[allow(dead_code)]
    app_session_id: SessionId,
    /// OS pid of the `grok agent stdio` process (parent of tool shells).
    agent_pid: u32,
    /// True while a prompt/turn is in flight for this agent only.
    turn_busy: AtomicBool,
    /// Auto "continue/append" prompts already sent after max_tokens truncation.
    truncation_auto_retries: AtomicU8,
    /// Processes we restarted (re-parented under the app, not the agent).
    /// Entries: (pid, command).
    managed_extra: Mutex<Vec<(u32, String)>>,
    /// After `session/new` on an existing task, engine memory is empty while the
    /// UI transcript still lives on disk. Next outbound prompt should prepend
    /// a compacted history preamble (then clear this flag).
    needs_history_rehydration: AtomicBool,
    /// Identifies this spawn so a stale ACP event loop cannot drop a replacement agent.
    generation: u64,
}

/// A process started under the session agent (tool shells, servers, etc.).
#[derive(Debug, Clone, Serialize)]
pub struct SessionProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub command: String,
    pub etime: String,
    pub state: String,
    pub cpu: String,
    pub mem: String,
    /// Depth under the agent (1 = direct child).
    pub depth: u32,
    /// Working directory when available (macOS `lsof` / Linux `/proc`).
    pub cwd: Option<String>,
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestartedProcessInfo {
    pub pid: u32,
    pub command: String,
    pub cwd: Option<String>,
}

pub struct AppCore {
    pub paths: AppPaths,
    pub settings: RwLock<UserSettings>,
    pub store: Mutex<SessionStore>,
    pub permissions: Mutex<PermissionBroker>,
    pub policy: RwLock<Policy>,
    pub engine: RwLock<Option<ResolvedEngine>>,
    pub status: RwLock<AgentConnectionStatus>,
    /// Local llama-server (Bonsai) lifecycle — separate from the agent process.
    llm: Mutex<LlmRuntimeManager>,
    /// Selected project root before connect (UI).
    selected_project: RwLock<Option<PathBuf>>,
    /// All live agents keyed by app session id (parallel tasks).
    live: Mutex<HashMap<SessionId, LiveAgent>>,
    /// Session the UI is currently focused on (prompt/cancel target).
    active_session: RwLock<Option<SessionId>>,
    /// Monotonic id for each grok spawn (guards stale event-loop cleanup).
    next_agent_generation: AtomicU64,
    event_tx: mpsc::UnboundedSender<AppEvent>,
    event_rx: Mutex<Option<mpsc::UnboundedReceiver<AppEvent>>>,
}

fn is_bonsai_endpoint(ep: &ModelEndpointSettings) -> bool {
    ep.vendor_id.as_deref() == Some("vendor-bonsai")
        || is_local_bonsai_target(Some(ep.model_id.as_str()), ep.base_url.as_deref())
}

fn is_bonsai_public_endpoint(ep: &PublicEndpointSettings) -> bool {
    ep.vendor_id.as_deref() == Some("vendor-bonsai")
        || is_local_bonsai_target(Some(ep.model_id.as_str()), ep.base_url.as_deref())
}

fn patch_bonsai_tokens(
    settings: &mut UserSettings,
    context_window: u64,
    max_completion_tokens: u64,
) -> bool {
    let mut dirty = false;
    let mut patch = |ep: &mut ModelEndpointSettings| {
        if !is_bonsai_endpoint(ep) {
            return;
        }
        if ep.context_window != Some(context_window)
            || ep.max_completion_tokens != Some(max_completion_tokens)
        {
            ep.context_window = Some(context_window);
            ep.max_completion_tokens = Some(max_completion_tokens);
            dirty = true;
        }
    };
    patch(&mut settings.endpoint);
    for ep in &mut settings.model_profiles {
        patch(ep);
    }
    dirty
}

fn apply_host_bonsai_tune(settings: &mut UserSettings) -> bool {
    let tune = tune_bonsai_for_host();
    if tune.blocked {
        return false;
    }
    patch_bonsai_tokens(
        settings,
        u64::from(tune.ctx_size),
        tune.max_completion_tokens,
    )
}

fn overlay_bonsai_tune_on_public(public: &mut PublicUserSettings) {
    let tune = tune_bonsai_for_host();
    if tune.blocked {
        return;
    }
    let ctx = u64::from(tune.ctx_size);
    let max_out = tune.max_completion_tokens;
    let patch = |ep: &mut PublicEndpointSettings| {
        if is_bonsai_public_endpoint(ep) {
            ep.context_window = Some(ctx);
            ep.max_completion_tokens = Some(max_out);
        }
    };
    patch(&mut public.endpoint);
    for ep in &mut public.model_profiles {
        patch(ep);
    }
}

impl AppCore {
    pub fn bootstrap() -> Result<Arc<Self>, CoreError> {
        let paths = AppPaths::discover()?;
        paths.ensure_dirs()?;
        let mut settings = UserSettings::load(&paths.config_file).unwrap_or_else(|_| {
            UserSettings::product_defaults()
        });
        // Replace the historical 12GB (96k/16k) Bonsai defaults with this host's GPU tune
        // so Settings / composer meters match llama-server `-c`.
        if apply_host_bonsai_tune(&mut settings) {
            if let Err(err) = settings.save(&paths.config_file) {
                warn!(error = %err, "failed to persist Bonsai hardware token limits");
            }
            if let Err(err) = settings.sync_endpoint_to_grok_toml() {
                warn!(error = %err, "failed to sync Bonsai hardware token limits to grok config");
            }
        }

        // Restore task/project list from disk so restarts keep history.
        let mut store = SessionStore::load_from_file(&paths.sessions_index_file())
            .unwrap_or_else(|e| {
                warn!(error = %e, "failed to load sessions index; starting empty");
                SessionStore::new()
            });
        let mut imported = store.import_from_tasks_root(&AppPaths::tasks_root());
        // Also recover tasks stored under each known project's `.grokx/tasks/`.
        let project_roots: Vec<PathBuf> = store
            .list_projects()
            .into_iter()
            .map(|p| PathBuf::from(&p.root_path))
            .collect();
        for root in project_roots {
            imported += store.import_from_tasks_root(&AppPaths::project_tasks_root(&root));
        }
        if imported > 0 {
            warn!(imported, "recovered tasks from .grokx/tasks directories");
            let _ = store.save_to_file(&paths.sessions_index_file());
        }

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Ok(Arc::new(Self {
            paths,
            settings: RwLock::new(settings),
            store: Mutex::new(store),
            permissions: Mutex::new(PermissionBroker::new()),
            policy: RwLock::new(Policy::default()),
            engine: RwLock::new(None),
            status: RwLock::new(AgentConnectionStatus::MissingBinary),
            llm: Mutex::new(LlmRuntimeManager::new()),
            selected_project: RwLock::new(None),
            live: Mutex::new(HashMap::new()),
            active_session: RwLock::new(None),
            next_agent_generation: AtomicU64::new(0),
            event_tx,
            event_rx: Mutex::new(Some(event_rx)),
        }))
    }

    /// Bind + start local Bonsai when the active endpoint targets it.
    ///
    /// `search_roots` should include the repo root and/or Tauri resource dir.
    pub async fn ensure_local_llm(
        &self,
        search_roots: &[PathBuf],
    ) -> Result<LocalRuntimeStatus, CoreError> {
        let settings = self.settings.read().await.clone();
        let wants_local = is_local_bonsai_target(
            settings.model.as_deref().or(Some(settings.endpoint.model_id.as_str())),
            settings.endpoint.base_url.as_deref(),
        );
        if !wants_local {
            return Ok(self.llm.lock().await.status());
        }
        if !host_supports_local_bonsai() {
            let tune = tune_bonsai_for_host();
            return Err(LlmRuntimeError::UnsupportedGpu {
                detail: tune.label,
            }
            .into());
        }

        let mut llm = self.llm.lock().await;
        if llm.spec().is_none() {
            llm.bind_default_bonsai(search_roots)?;
        }
        let spec = llm.ensure_running().await?;
        // Keep app settings + ~/.grok/config.toml aligned with the live server.
        let fields = spec.endpoint_fields();
        drop(llm);

        {
            let mut settings = self.settings.write().await;
            settings.model = Some(fields.model_id.clone());
            settings.endpoint.model_id = fields.model_id.clone();
            settings.endpoint.name = Some(fields.name.clone());
            settings.endpoint.base_url = Some(fields.base_url.clone());
            if settings
                .endpoint
                .api_key
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                settings.endpoint.api_key = Some(fields.api_key.clone());
            }
            settings.endpoint.api_backend = Some(fields.api_backend.clone());
            settings.endpoint.context_window = Some(fields.context_window);
            settings.endpoint.max_completion_tokens = Some(fields.max_completion_tokens);
            patch_bonsai_tokens(
                &mut settings,
                fields.context_window,
                fields.max_completion_tokens,
            );
            let _ = settings.save(&self.paths.config_file);
            if let Err(err) = settings.sync_endpoint_to_grok_toml() {
                warn!(error = %err, "failed to sync local LLM endpoint to ~/.grok/config.toml");
            }
        }
        info!(provider = BONSAI_LOCAL_ID, "local LLM ready");
        Ok(LocalRuntimeStatus::Ready)
    }

    pub async fn local_llm_status(&self) -> LocalRuntimeStatus {
        self.llm.lock().await.status()
    }

    /// Whether the active settings endpoint targets the local llama-server.
    pub async fn wants_local_llm(&self) -> bool {
        let settings = self.settings.read().await;
        is_local_bonsai_target(
            settings.model.as_deref().or(Some(settings.endpoint.model_id.as_str())),
            settings.endpoint.base_url.as_deref(),
        )
    }

    pub async fn stop_local_llm(&self) {
        self.llm.lock().await.stop().await;
    }

    async fn persist_session_meta(&self, session_id: &SessionId) {
        let store = self.store.lock().await;
        if let Err(e) = store.write_task_dir_meta(session_id) {
            warn!(error = %e, "failed to write task meta.json");
        }
        if let Err(e) = store.save_to_file(&self.paths.sessions_index_file()) {
            warn!(error = %e, "failed to save sessions index");
        }
    }

    pub async fn public_settings(&self) -> PublicUserSettings {
        let mut public = self.settings.read().await.public_view();
        overlay_bonsai_tune_on_public(&mut public);
        public
    }

    /// GPU/CPU launch profile for local Bonsai (does not start llama-server).
    pub fn bonsai_hardware_tune(&self) -> HardwareTune {
        tune_bonsai_for_host()
    }

    pub async fn update_settings(&self, update: SettingsUpdate) -> Result<PublicUserSettings, CoreError> {
        let public = {
            let mut settings = self.settings.write().await;
            settings.apply_update(update);
            apply_host_bonsai_tune(&mut settings);
            settings
                .save(&self.paths.config_file)
                .map_err(CoreError::Config)?;
            if let Err(err) = settings.sync_endpoint_to_grok_toml() {
                warn!(error = %err, "failed to sync endpoint to ~/.grok/config.toml");
            }
            if let Err(err) = settings.sync_grok_engine_form_to_grok_toml() {
                warn!(error = %err, "failed to sync engine form to ~/.grok/config.toml");
            }
            let mut public = settings.public_view();
            overlay_bonsai_tune_on_public(&mut public);
            public
        };

        // Auto-start / stop local runtime based on the new endpoint.
        let roots = default_llm_search_roots();
        if self.wants_local_llm().await {
            if let Err(err) = self.ensure_local_llm(&roots).await {
                warn!(error = %err, "failed to auto-start local LLM after settings update");
            }
        } else {
            self.stop_local_llm().await;
        }

        Ok(public)
    }

    /// Take the primary event receiver (call once from the shell).
    pub async fn take_event_receiver(&self) -> Option<mpsc::UnboundedReceiver<AppEvent>> {
        self.event_rx.lock().await.take()
    }

    pub fn emit(&self, event: AppEvent) {
        let _ = self.event_tx.send(event);
    }

    pub async fn resolve_runtime(
        &self,
        resource_dir: Option<&Path>,
        allow_path_fallback: bool,
    ) -> Result<ResolvedEngine, CoreError> {
        let settings = self.settings.read().await.clone();
        let resolved = resolve_engine(&settings, resource_dir, allow_path_fallback)?;
        *self.engine.write().await = Some(resolved.clone());
        if matches!(
            *self.status.read().await,
            AgentConnectionStatus::MissingBinary | AgentConnectionStatus::Failed
        ) {
            *self.status.write().await = AgentConnectionStatus::Ready;
        }
        Ok(resolved)
    }

    /// Start `grok.exe` as soon as the desktop app opens (not lazily on first click).
    ///
    /// The agent runtime is **model-independent**: this must not wait on local
    /// llama-server / GGUF load. Reconnects the most recently updated task when
    /// one exists; otherwise connects the default sandbox workspace.
    pub async fn warm_start_agent(
        self: &Arc<Self>,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
    ) -> Result<SessionId, CoreError> {
        // Resolve binary path early (also updates MissingBinary → Ready when found).
        self.resolve_runtime(resource_dir.as_deref(), allow_path_fallback)
            .await?;

        if !self.live.lock().await.is_empty() {
            if let Some(id) = self.active_session.read().await.clone() {
                return Ok(id);
            }
            if let Some(id) = self.live.lock().await.keys().next().cloned() {
                *self.active_session.write().await = Some(id.clone());
                return Ok(id);
            }
        }

        let auto_approve = self.settings.read().await.is_full_trust();

        let sessions = self.list_sessions().await;
        if let Some(best) = sessions.into_iter().max_by_key(|s| s.updated_at) {
            info!(
                session_id = %best.session_id.0,
                "warm-starting grok agent for most recent task"
            );
            return self
                .reconnect_session(
                    &best.session_id,
                    resource_dir,
                    allow_path_fallback,
                    auto_approve,
                )
                .await;
        }

        info!("warm-starting grok agent on default workspace (no prior tasks)");
        let root = self.ensure_default_project().await?;
        self.connect_workspace(root, resource_dir, allow_path_fallback, auto_approve)
            .await
    }

    pub async fn connection_status(&self) -> AgentConnectionStatus {
        *self.status.read().await
    }

    pub async fn current_session_id(&self) -> Option<SessionId> {
        if let Some(id) = self.active_session.read().await.clone() {
            return Some(id);
        }
        // Fallback: any live agent (single-session UX).
        self.live.lock().await.keys().next().cloned()
    }

    pub async fn current_project_root(&self) -> Option<PathBuf> {
        if let Some(id) = self.active_session.read().await.clone() {
            let live = self.live.lock().await;
            if let Some(agent) = live.get(&id) {
                return Some(agent.project_root.clone());
            }
        }
        self.selected_project.read().await.clone()
    }

    /// Temporary task workspace of the active session, if any.
    pub async fn current_work_path(&self) -> Option<PathBuf> {
        if let Some(id) = self.active_session.read().await.clone() {
            let live = self.live.lock().await;
            if let Some(agent) = live.get(&id) {
                return Some(agent.work_path.clone());
            }
        }
        None
    }

    /// Whether a given session currently has a live agent process.
    pub async fn is_session_live(&self, session_id: &SessionId) -> bool {
        self.live.lock().await.contains_key(session_id)
    }

    /// Whether a given session has a turn in progress.
    pub async fn is_session_busy(&self, session_id: &SessionId) -> bool {
        self.live
            .lock()
            .await
            .get(session_id)
            .map(|a| a.turn_busy.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    /// Session ids with a live agent (for UI multi-task indicators).
    pub async fn live_session_ids(&self) -> Vec<SessionId> {
        self.live.lock().await.keys().cloned().collect()
    }

    /// List processes related to this task:
    /// 1) descendants of the live agent (tool shells still attached)
    /// 2) managed extras we restarted from Outputs
    /// 3) "orphan" servers whose cwd/command match the task workspace or project
    ///    (common after app restart when PPID reparents to launchd)
    pub async fn list_session_processes(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<SessionProcessInfo>, CoreError> {
        let (agent_pid, extras, work_path, project_root) = {
            let live = self.live.lock().await;
            if let Some(agent) = live.get(session_id) {
                let extras = agent.managed_extra.lock().await.clone();
                (
                    Some(agent.agent_pid),
                    extras,
                    agent.work_path.clone(),
                    agent.project_root.clone(),
                )
            } else {
                // Agent not live — still surface orphans from stored meta paths.
                let store = self.store.lock().await;
                let meta = store
                    .get_session(session_id)
                    .map_err(|e| CoreError::Message(e.to_string()))?;
                let work = if meta.work_path.is_empty() {
                    let project = store
                        .get_project(&meta.project_id)
                        .ok()
                        .map(|p| PathBuf::from(&p.root_path));
                    if let Some(root) = project {
                        AppPaths::project_task_dir(&root, &session_id.0.to_string())
                    } else {
                        AppPaths::tasks_root().join(session_id.0.to_string())
                    }
                } else {
                    PathBuf::from(&meta.work_path)
                };
                let project = store
                    .get_project(&meta.project_id)
                    .ok()
                    .map(|p| PathBuf::from(&p.root_path))
                    .unwrap_or_else(|| work.clone());
                (None, Vec::new(), work, project)
            }
        };

        let mut out: Vec<SessionProcessInfo> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        if let Some(pid) = agent_pid.filter(|p| *p != 0) {
            for p in list_descendant_processes(pid) {
                if seen.insert(p.pid) {
                    out.push(p);
                }
            }
        }

        // Managed extras (restarted processes re-parented under the app).
        let mut still = Vec::new();
        for (pid, cmd) in extras {
            if !process_exists(pid) {
                continue;
            }
            still.push((pid, cmd.clone()));
            if seen.contains(&pid) {
                continue;
            }
            if let Some(info) = snap_to_info(pid, Some(cmd), 1) {
                seen.insert(pid);
                out.push(info);
            }
        }
        if let Some(agent) = self.live.lock().await.get(session_id) {
            *agent.managed_extra.lock().await = still;
        }

        // Orphans: match work_path / project_root (cwd or command line).
        // Skip the agent binary itself and our desktop shell.
        let skip_pids: std::collections::HashSet<u32> = agent_pid.into_iter().collect();
        for p in find_related_orphans(&work_path, &project_root, &skip_pids) {
            if seen.insert(p.pid) {
                out.push(p);
            }
        }

        out.sort_by(|a, b| a.depth.cmp(&b.depth).then(a.pid.cmp(&b.pid)));
        Ok(out)
    }

    /// Stop a process that belongs to the session agent tree (SIGTERM, then SIGKILL).
    pub async fn stop_session_process(
        &self,
        session_id: &SessionId,
        pid: u32,
    ) -> Result<(), CoreError> {
        self.ensure_pid_under_session(session_id, pid).await?;
        signal_process_tree(pid, "term")?;
        // Brief grace, then force-kill leftovers.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        if process_exists(pid) {
            let _ = signal_process_tree(pid, "kill");
        }
        // Drop from managed extras if present.
        if let Some(agent) = self.live.lock().await.get(session_id) {
            agent
                .managed_extra
                .lock()
                .await
                .retain(|(p, _)| *p != pid);
        }
        Ok(())
    }

    /// Pause (SIGSTOP) a process under the session agent.
    pub async fn pause_session_process(
        &self,
        session_id: &SessionId,
        pid: u32,
    ) -> Result<(), CoreError> {
        self.ensure_pid_under_session(session_id, pid).await?;
        signal_process(pid, "stop")
    }

    /// Resume (SIGCONT) a paused process under the session agent.
    pub async fn resume_session_process(
        &self,
        session_id: &SessionId,
        pid: u32,
    ) -> Result<(), CoreError> {
        self.ensure_pid_under_session(session_id, pid).await?;
        signal_process(pid, "cont")
    }

    /// Restart a process: stop it, then re-run the same command in its cwd.
    pub async fn restart_session_process(
        &self,
        session_id: &SessionId,
        pid: u32,
    ) -> Result<RestartedProcessInfo, CoreError> {
        self.ensure_pid_under_session(session_id, pid).await?;
        let snap = process_snapshot(pid).ok_or_else(|| {
            CoreError::Message(format!("process {pid} not found"))
        })?;
        let cwd_hint = process_cwd(pid);
        let work_fallback = {
            let live = self.live.lock().await;
            live.get(session_id)
                .map(|a| a.work_path.clone())
                .ok_or(CoreError::NotConnected)?
        };
        let run_cwd = cwd_hint
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or(work_fallback);

        signal_process_tree(pid, "term")?;
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        if process_exists(pid) {
            let _ = signal_process_tree(pid, "kill");
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }

        let child = std::process::Command::new("sh")
            .arg("-c")
            .arg(&snap.command)
            .current_dir(&run_cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| {
                CoreError::Message(format!("restart failed: {e}"))
            })?;
        let new_pid = child.id();
        // Detach: don't wait; leave running in background.
        std::mem::forget(child);

        // Track under session so it still appears in Outputs after re-parent.
        if let Some(agent) = self.live.lock().await.get(session_id) {
            let mut extra = agent.managed_extra.lock().await;
            extra.retain(|(p, _)| *p != pid);
            extra.push((new_pid, snap.command.clone()));
        }

        Ok(RestartedProcessInfo {
            pid: new_pid,
            command: snap.command,
            cwd: Some(run_cwd.display().to_string()),
        })
    }

    async fn ensure_pid_under_session(
        &self,
        session_id: &SessionId,
        pid: u32,
    ) -> Result<(), CoreError> {
        // Reuse list logic: if it would appear in Outputs, we may control it.
        let listed = self.list_session_processes(session_id).await?;
        if listed.iter().any(|p| p.pid == pid) {
            // Never allow killing something that is the agent itself.
            if let Some(agent) = self.live.lock().await.get(session_id) {
                if pid == agent.agent_pid {
                    return Err(CoreError::Message(
                        "refusing to control the agent process itself".into(),
                    ));
                }
            }
            return Ok(());
        }
        Err(CoreError::Message(format!(
            "pid {pid} is not a process related to this task"
        )))
    }

    /// Remember the project directory chosen in the UI (before connect).
    pub async fn set_project_root(&self, root: impl Into<PathBuf>) -> Result<PathBuf, CoreError> {
        let root = root.into();
        if !root.is_dir() {
            return Err(CoreError::InvalidProject(root.display().to_string()));
        }
        // Recover any project-local task dirs that are not yet in the index.
        {
            let mut store = self.store.lock().await;
            let imported =
                store.import_from_tasks_root(&AppPaths::project_tasks_root(&root));
            if imported > 0 {
                warn!(
                    imported,
                    project = %root.display(),
                    "recovered tasks from project .grokx/tasks"
                );
                let _ = store.save_to_file(&self.paths.sessions_index_file());
            }
        }
        *self.selected_project.write().await = Some(root.clone());
        Ok(root)
    }

    pub async fn selected_project_root(&self) -> Option<PathBuf> {
        self.selected_project.read().await.clone()
    }

    /// Ensure the default sandbox dir exists (`~/.grokx/workspace`) for tasks
    /// that are not attached to a user-opened project.
    ///
    /// This path is **not** shown in the Projects sidebar — only Tasks +.
    pub async fn ensure_default_project(&self) -> Result<PathBuf, CoreError> {
        let root = AppPaths::default_project_root();
        std::fs::create_dir_all(&root).map_err(|e| {
            CoreError::Message(format!(
                "failed to create default workspace {}: {e}",
                root.display()
            ))
        })?;
        // Internal store row only (FK for tasks). Hidden from Projects list.
        {
            let mut store = self.store.lock().await;
            let root_str = root.display().to_string();
            if store.find_project_by_root(&root_str).is_none() {
                store.upsert_project(Project {
                    id: ProjectId::new(),
                    root_path: root_str,
                    name: "Default".into(),
                    created_at: Utc::now(),
                });
            }
        }
        self.set_project_root(root).await
    }

    /// True if this path is the internal default sandbox (not a user Project).
    pub fn is_default_project_path(path: &Path) -> bool {
        let default = AppPaths::default_project_root();
        // Compare canonical when possible so /Users/x vs /Users/x/ are equal.
        let a = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let b = std::fs::canonicalize(&default).unwrap_or(default);
        a == b
    }

    pub async fn list_sessions(&self) -> Vec<SessionListItem> {
        self.store.lock().await.list_sessions()
    }

    /// User-visible projects only (excludes the internal default sandbox).
    pub async fn list_projects(&self) -> Vec<ProjectListItem> {
        self.store
            .lock()
            .await
            .list_project_items()
            .into_iter()
            .filter(|p| !Self::is_default_project_path(Path::new(&p.root_path)))
            .collect()
    }

    pub async fn list_sessions_for_project(&self, project_id: &ProjectId) -> Vec<SessionListItem> {
        self.store
            .lock()
            .await
            .list_session_items_for_project(project_id)
    }

    pub async fn rename_session(
        &self,
        session_id: &SessionId,
        title: impl Into<String>,
    ) -> Result<(), CoreError> {
        self.store
            .lock()
            .await
            .rename_session(session_id, title)
            .map_err(|e| CoreError::Message(e.to_string()))?;
        self.persist_session_meta(session_id).await;
        Ok(())
    }

    /// Delete a task/session: drop from index and remove its work directory.
    /// If it has a live agent, disconnect that agent only (others keep running).
    pub async fn delete_session(
        self: &Arc<Self>,
        session_id: &SessionId,
    ) -> Result<(), CoreError> {
        // Tear down only this session's agent; parallel tasks stay alive.
        {
            let mut live = self.live.lock().await;
            if let Some(prev) = live.remove(session_id) {
                prev.client.shutdown().await;
            }
            let mut active = self.active_session.write().await;
            if active.as_ref() == Some(session_id) {
                *active = live.keys().next().cloned();
            }
            let still_live = !live.is_empty();
            *self.status.write().await = if still_live {
                AgentConnectionStatus::Ready
            } else {
                AgentConnectionStatus::Failed
            };
            if !still_live {
                self.emit(AppEvent::AgentStatus {
                    status: AgentConnectionStatus::Failed,
                    detail: Some("task deleted".into()),
                });
            }
        }

        let meta = self
            .store
            .lock()
            .await
            .delete_session(session_id)
            .map_err(|e| CoreError::Message(e.to_string()))?;

        // Persist updated index (without this session).
        {
            let store = self.store.lock().await;
            if let Err(e) = store.save_to_file(&self.paths.sessions_index_file()) {
                warn!(error = %e, "failed to save sessions index after delete");
            }
        }

        // Remove task workspace on disk (chat history, meta, etc.).
        if !meta.work_path.is_empty() {
            let work = PathBuf::from(&meta.work_path);
            Self::remove_task_dir_if_safe(&work);
        }

        Ok(())
    }

    /// Remove a user project from the sidebar and delete all of its tasks.
    /// Does not delete the on-disk source folder — only Grokx index + task workspaces.
    pub async fn delete_project(
        self: &Arc<Self>,
        project_id: &ProjectId,
    ) -> Result<(), CoreError> {
        // Shut down any live agents that belong to this project (others keep running).
        {
            let sids: Vec<SessionId> = self.live.lock().await.keys().cloned().collect();
            let mut to_kill = Vec::new();
            {
                let store = self.store.lock().await;
                for sid in sids {
                    if store
                        .get_session(&sid)
                        .ok()
                        .map(|m| &m.project_id == project_id)
                        .unwrap_or(false)
                    {
                        to_kill.push(sid);
                    }
                }
            }
            if !to_kill.is_empty() {
                let mut live = self.live.lock().await;
                for sid in &to_kill {
                    if let Some(prev) = live.remove(sid) {
                        prev.client.shutdown().await;
                    }
                }
                let mut active = self.active_session.write().await;
                if active
                    .as_ref()
                    .map(|id| to_kill.contains(id))
                    .unwrap_or(false)
                {
                    *active = live.keys().next().cloned();
                }
                let still_live = !live.is_empty();
                *self.status.write().await = if still_live {
                    AgentConnectionStatus::Ready
                } else {
                    AgentConnectionStatus::Failed
                };
                if !still_live {
                    self.emit(AppEvent::AgentStatus {
                        status: AgentConnectionStatus::Failed,
                        detail: Some("project deleted".into()),
                    });
                }
            }
        }

        let (_project, sessions) = self
            .store
            .lock()
            .await
            .delete_project(project_id)
            .map_err(|e| CoreError::Message(e.to_string()))?;

        {
            let store = self.store.lock().await;
            if let Err(e) = store.save_to_file(&self.paths.sessions_index_file()) {
                warn!(error = %e, "failed to save sessions index after project delete");
            }
        }

        for meta in sessions {
            if meta.work_path.is_empty() {
                continue;
            }
            Self::remove_task_dir_if_safe(&PathBuf::from(&meta.work_path));
        }

        Ok(())
    }

    /// Delete a task metadata directory only when it matches a managed layout
    /// (`~/.grokx/tasks/<id>` or `<project>/.grokx/tasks/<id>`).
    fn remove_task_dir_if_safe(work: &Path) {
        if !AppPaths::is_managed_task_dir(work) || !work.is_dir() {
            return;
        }
        if let Err(e) = std::fs::remove_dir_all(work) {
            warn!(error = %e, path = %work.display(), "failed to remove task dir");
        }
    }

    fn chat_history_path(work_path: &Path) -> PathBuf {
        work_path.join("chat-history.json")
    }

    /// Read chat-history bytes and recover a usable JSON array string.
    ///
    /// Handles: invalid UTF-8 mid-file, trailing garbage after a complete
    /// array (partial second write). Returns `None` only when nothing
    /// parseable remains.
    fn recover_chat_history_json(path: &Path, bytes: &[u8]) -> Option<String> {
        let try_parse = |s: &str| -> Option<String> {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return None;
            }
            // Full clean document.
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                return serde_json::to_string(&v).ok();
            }
            // Trailing garbage after a complete first value (e.g. partial rewrite).
            let mut de = serde_json::Deserializer::from_str(trimmed);
            match serde_json::Value::deserialize(&mut de) {
                Ok(v) => serde_json::to_string(&v).ok(),
                Err(_) => None,
            }
        };

        if let Ok(s) = std::str::from_utf8(bytes) {
            if let Some(clean) = try_parse(s) {
                return Some(clean);
            }
        }

        // Lossy UTF-8 then first JSON value (illegal mid-file bytes).
        let lossy = String::from_utf8_lossy(bytes);
        match try_parse(&lossy) {
            Some(clean) => {
                warn!(
                    path = %path.display(),
                    "recovered chat history after corrupt/invalid bytes"
                );
                Some(clean)
            }
            None => {
                warn!(path = %path.display(), "chat history unrecoverable");
                None
            }
        }
    }

    fn read_chat_history_file(path: &Path) -> Result<Option<String>, CoreError> {
        if !path.is_file() {
            return Ok(None);
        }
        let bytes = std::fs::read(path).map_err(|e| {
            CoreError::Message(format!("read chat history {}: {e}", path.display()))
        })?;
        if bytes.is_empty() {
            return Ok(None);
        }
        match Self::recover_chat_history_json(path, &bytes) {
            Some(clean) => {
                // If we had to repair, rewrite so future loads are clean.
                let original_ok = std::str::from_utf8(&bytes)
                    .ok()
                    .and_then(|s| {
                        let t = s.trim();
                        serde_json::from_str::<serde_json::Value>(t)
                            .ok()
                            .map(|_| t == clean || s == clean)
                    })
                    .unwrap_or(false);
                if !original_ok {
                    let tmp = path.with_extension("json.repair-tmp");
                    if std::fs::write(&tmp, clean.as_bytes()).is_ok() {
                        let _ = std::fs::rename(&tmp, path);
                    }
                }
                Ok(Some(clean))
            }
            None => Ok(None),
        }
    }

    /// Persist UI chat transcript for a task (JSON array of chat lines).
    /// Prefer `work_path` when known so history is not lost if store is mid-update.
    pub async fn save_chat_history(
        &self,
        session_id: &SessionId,
        json: impl AsRef<str>,
        work_path: Option<String>,
    ) -> Result<(), CoreError> {
        let raw = json.as_ref();
        // Refuse to write non-array / invalid JSON (would brick the transcript).
        let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
            CoreError::Message(format!("chat history is not valid JSON: {e}"))
        })?;
        if !value.is_array() {
            return Err(CoreError::Message(
                "chat history must be a JSON array".into(),
            ));
        }
        // Canonical UTF-8 (no lone surrogates / odd escapes from the webview).
        let canonical = serde_json::to_string(&value)
            .map_err(|e| CoreError::Message(format!("serialize chat history: {e}")))?;

        let work = if let Some(w) = work_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            PathBuf::from(w)
        } else {
            let store = self.store.lock().await;
            let meta = store
                .get_session(session_id)
                .map_err(|e| CoreError::Message(e.to_string()))?;
            if meta.work_path.is_empty() {
                return Err(CoreError::Message(
                    "session has no work_path for chat history".into(),
                ));
            }
            PathBuf::from(&meta.work_path)
        };
        std::fs::create_dir_all(&work).map_err(|e| {
            CoreError::Message(format!("chat history dir {}: {e}", work.display()))
        })?;
        let path = Self::chat_history_path(&work);
        // Atomic-ish write: write temp then rename.
        let tmp = work.join("chat-history.json.tmp");
        std::fs::write(&tmp, canonical.as_bytes()).map_err(|e| {
            CoreError::Message(format!("write chat history {}: {e}", tmp.display()))
        })?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            CoreError::Message(format!("rename chat history {}: {e}", path.display()))
        })?;
        // Do not touch_session here: saving history on activate would reshuffle
        // the list if anything still sorted by updated_at. Title/meta refresh
        // can still rewrite meta.json without changing list order.
        let _ = self.store.lock().await.write_task_dir_meta(session_id);
        Ok(())
    }

    /// Load UI chat transcript for a task, if present.
    pub async fn load_chat_history(
        &self,
        session_id: &SessionId,
        work_path: Option<String>,
    ) -> Result<Option<String>, CoreError> {
        let (work, project_root) = if let Some(w) = work_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            (PathBuf::from(w), None)
        } else {
            let store = self.store.lock().await;
            match store.get_session(session_id) {
                Ok(meta) => {
                    let project_root = store
                        .get_project(&meta.project_id)
                        .ok()
                        .map(|p| PathBuf::from(&p.root_path));
                    let work = if !meta.work_path.is_empty() {
                        PathBuf::from(&meta.work_path)
                    } else if let Some(ref root) = project_root {
                        AppPaths::project_task_dir(root, &session_id.0.to_string())
                    } else {
                        AppPaths::tasks_root().join(session_id.0.to_string())
                    };
                    (work, project_root)
                }
                Err(_) => (
                    AppPaths::tasks_root().join(session_id.0.to_string()),
                    None,
                ),
            }
        };
        let path = Self::chat_history_path(&work);
        if let Some(raw) = Self::read_chat_history_file(&path)? {
            return Ok(Some(raw));
        }
        // Legacy home location (pre project-local layout).
        let legacy = AppPaths::tasks_root()
            .join(session_id.0.to_string())
            .join("chat-history.json");
        if legacy != path {
            if let Some(raw) = Self::read_chat_history_file(&legacy)? {
                return Ok(Some(raw));
            }
        }
        // Preferred project-local path if the stored work_path was stale.
        if let Some(root) = project_root {
            let preferred = AppPaths::project_task_dir(&root, &session_id.0.to_string())
                .join("chat-history.json");
            if preferred != path && preferred != legacy {
                if let Some(raw) = Self::read_chat_history_file(&preferred)? {
                    return Ok(Some(raw));
                }
            }
        }
        Ok(None)
    }

    /// Start a **new** task under a project.
    ///
    /// - Project path is fixed (user-chosen directory) and is the **agent cwd**.
    /// - Task metadata lives under `<project>/.grokx/tasks/<id>/` (chat history only).
    pub async fn connect_workspace(
        self: &Arc<Self>,
        project_root: impl Into<PathBuf>,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
        auto_approve: bool,
    ) -> Result<SessionId, CoreError> {
        // Prefer saved permission_mode; `auto_approve` still means full trust when true.
        let mode = if auto_approve {
            app_config::permission_modes::ALWAYS_APPROVE.to_string()
        } else {
            self.settings.read().await.permission_mode_normalized().to_string()
        };
        self.spawn_agent_for_project(
            project_root.into(),
            resource_dir,
            allow_path_fallback,
            &mode,
            None,
        )
        .await
    }

    /// Activate an **existing** task: reuse its id/title/work_path, restart engine only.
    /// Does **not** create a new session row in the list.
    pub async fn reconnect_session(
        self: &Arc<Self>,
        session_id: &SessionId,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
        auto_approve: bool,
    ) -> Result<SessionId, CoreError> {
        // Already live on this session — just focus it (do not restart).
        if self.live.lock().await.contains_key(session_id) {
            *self.active_session.write().await = Some(session_id.clone());
            *self.status.write().await = AgentConnectionStatus::Ready;
            self.emit(AppEvent::AgentStatus {
                status: AgentConnectionStatus::Ready,
                detail: Some("focused live session".into()),
            });
            let engine_session_id = self
                .live
                .lock()
                .await
                .get(session_id)
                .map(|a| a.handle.clone());
            let engine_session_id = if let Some(handle) = engine_session_id {
                handle.engine_session_id().await
            } else {
                None
            };
            self.emit(AppEvent::SessionReady {
                session_id: session_id.clone(),
                engine_session_id,
            });
            return Ok(session_id.clone());
        }

        let root = {
            let store = self.store.lock().await;
            let meta = store
                .get_session(session_id)
                .map_err(|e| CoreError::Message(e.to_string()))?;
            let project = store
                .get_project(&meta.project_id)
                .map_err(|e| CoreError::Message(e.to_string()))?;
            PathBuf::from(&project.root_path)
        };
        let mode = if auto_approve {
            app_config::permission_modes::ALWAYS_APPROVE.to_string()
        } else {
            self.settings.read().await.permission_mode_normalized().to_string()
        };
        self.spawn_agent_for_project(
            root,
            resource_dir,
            allow_path_fallback,
            &mode,
            Some(session_id.clone()),
        )
        .await
    }

    /// Ensure `<project>/.grokx/tasks/<id>` exists for chat history / session metadata.
    /// Agent cwd is the project root (not this directory).
    ///
    /// Legacy dirs under `~/.grokx/tasks/<id>` are migrated into the project on reuse.
    fn ensure_task_workspace(
        session_id: &SessionId,
        project_root: &Path,
        existing_work_path: Option<&str>,
    ) -> Result<PathBuf, CoreError> {
        let preferred =
            AppPaths::project_task_dir(project_root, &session_id.0.to_string());

        let work = if let Some(p) = existing_work_path.filter(|s| !s.is_empty()) {
            let existing = PathBuf::from(p);
            if Self::should_migrate_task_dir(&existing, &preferred) {
                Self::migrate_task_dir(&existing, &preferred)?;
                preferred
            } else {
                existing
            }
        } else {
            preferred
        };

        std::fs::create_dir_all(&work).map_err(|e| {
            CoreError::Message(format!(
                "failed to create task workspace {}: {e}",
                work.display()
            ))
        })?;

        // Optional pointer for humans / older tooling (not used as agent cwd).
        let link = work.join("project");
        if link.symlink_metadata().is_ok() || link.exists() {
            let _ = std::fs::remove_file(&link);
            let _ = std::fs::remove_dir_all(&link);
        }
        let _ = std::fs::write(&link, project_root.display().to_string());

        let readme = work.join("README.grokx.txt");
        if !readme.exists() {
            let _ = std::fs::write(
                &readme,
                format!(
                    "Grokx task directory\n\
                     Path: <project>/.grokx/tasks/<id>/\n\
                     - chat-history.json / meta — conversation metadata\n\
                     - images/ — generate_image outputs\n\
                     - videos/ — generate_video outputs\n\
                     Agent cwd (code edits) is the project root:\n\
                     {}\n",
                    project_root.display()
                ),
            );
        }

        // Always ensure media output folders exist for this task.
        for sub in ["images", "videos"] {
            let _ = std::fs::create_dir_all(work.join(sub));
        }

        Ok(work)
    }

    /// Migrate when the stored path is the legacy home tasks root and the
    /// preferred project-local path differs.
    fn should_migrate_task_dir(existing: &Path, preferred: &Path) -> bool {
        if existing == preferred {
            return false;
        }
        let global = AppPaths::tasks_root();
        let under_global = existing.starts_with(&global)
            || std::fs::canonicalize(existing)
                .ok()
                .zip(std::fs::canonicalize(&global).ok())
                .map(|(e, g)| e.starts_with(g))
                .unwrap_or(false);
        under_global && AppPaths::is_managed_task_dir(existing)
    }

    fn migrate_task_dir(from: &Path, to: &Path) -> Result<(), CoreError> {
        if from == to {
            return Ok(());
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CoreError::Message(format!(
                    "failed to create project task dir {}: {e}",
                    parent.display()
                ))
            })?;
        }
        if to.exists() {
            // Prefer keeping the destination if somehow already present.
            warn!(
                from = %from.display(),
                to = %to.display(),
                "project task dir already exists; leaving legacy dir in place"
            );
            return Ok(());
        }
        match std::fs::rename(from, to) {
            Ok(()) => {
                warn!(
                    from = %from.display(),
                    to = %to.display(),
                    "migrated task metadata into project .grokx/tasks"
                );
                Ok(())
            }
            Err(rename_err) => {
                // Cross-device rename can fail; fall back to copy then remove.
                Self::copy_dir_recursive(from, to).map_err(|e| {
                    CoreError::Message(format!(
                        "failed to migrate task dir {} → {}: rename={rename_err}; copy={e}",
                        from.display(),
                        to.display()
                    ))
                })?;
                let _ = std::fs::remove_dir_all(from);
                warn!(
                    from = %from.display(),
                    to = %to.display(),
                    "migrated task metadata into project .grokx/tasks (copy)"
                );
                Ok(())
            }
        }
    }

    fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            let src = entry.path();
            let dst = to.join(entry.file_name());
            if ty.is_dir() {
                Self::copy_dir_recursive(&src, &dst)?;
            } else {
                std::fs::copy(&src, &dst)?;
            }
        }
        Ok(())
    }

    /// Shared spawn path.
    /// - `reuse_session = None` → create a new SessionId + list row + task dir
    /// - `reuse_session = Some(id)` → keep that id/title/work_path, only refresh engine
    async fn spawn_agent_for_project(
        self: &Arc<Self>,
        project_root: PathBuf,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
        permission_mode: &str,
        reuse_session: Option<SessionId>,
    ) -> Result<SessionId, CoreError> {
        if !project_root.as_os_str().is_empty() && !project_root.is_dir() {
            if project_root != Path::new(".") {
                return Err(CoreError::InvalidProject(
                    project_root.display().to_string(),
                ));
            }
        }
        *self.selected_project.write().await = Some(project_root.clone());

        let engine = match self.engine.read().await.clone() {
            Some(e) => e,
            None => {
                self.resolve_runtime(resource_dir.as_deref(), allow_path_fallback)
                    .await?
            }
        };

        // Multi-agent: keep other sessions running. Only replace an agent for
        // the same session id if we are reusing/restarting that task.
        if let Some(ref sid) = reuse_session {
            if let Some(prev) = self.live.lock().await.remove(sid) {
                prev.client.shutdown().await;
            }
        }

        *self.status.write().await = AgentConnectionStatus::Starting;
        self.emit(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Starting,
            detail: Some(format!("spawning {}", engine.path.display())),
        });

        let settings = self.settings.read().await.clone();
        // Refresh default Bailian media MCP + built-in npx MCPs.
        if let Err(err) =
            app_config::ensure_default_media_mcp_in_grok_toml(resource_dir.as_deref())
        {
            warn!(error = %err, "failed to ensure default media MCP in ~/.grok/config.toml");
        }
        if let Err(err) =
            app_config::ensure_default_builtin_mcps_in_grok_toml(Some(&settings.cn_acceleration))
        {
            warn!(error = %err, "failed to ensure built-in MCP servers in ~/.grok/config.toml");
        }
        let now = Utc::now();
        let root_str = project_root.display().to_string();
        let project_id = {
            let mut store = self.store.lock().await;
            if let Some(existing) = store.find_project_by_root(&root_str) {
                existing.id.clone()
            } else {
                let id = ProjectId::new();
                store.upsert_project(Project {
                    id: id.clone(),
                    root_path: root_str.clone(),
                    name: project_root
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| root_str.clone()),
                    created_at: now,
                });
                id
            }
        };

        // Resolve task id + on-disk task dir BEFORE spawning grok so media MCP
        // inherits GROKX_TASK_DIR → <project>/.grokx/tasks/<id>/{images,videos}.
        let was_reuse = reuse_session.is_some();
        let (app_session_id, work_path) = if let Some(existing_id) = reuse_session {
            // Reuse list row — never invent a new session id on activate.
            // Do NOT bump updated_at / created_at: clicking a task must not
            // reorder the sidebar (order is by created_at).
            let mut store = self.store.lock().await;
            let meta = store
                .get_session(&existing_id)
                .map_err(|e| CoreError::Message(e.to_string()))?
                .clone();
            let work = Self::ensure_task_workspace(
                &existing_id,
                &project_root,
                Some(meta.work_path.as_str()).filter(|s| !s.is_empty()),
            )?;
            let mut meta = meta;
            meta.engine_session_id = None;
            meta.work_path = work.display().to_string();
            if meta.project_id != project_id {
                meta.project_id = project_id.clone();
            }
            store.upsert_session(meta);
            (existing_id, work)
        } else {
            let app_session_id = SessionId::new();
            let work = Self::ensure_task_workspace(&app_session_id, &project_root, None)?;
            let mut store = self.store.lock().await;
            store.upsert_session(SessionMeta {
                id: app_session_id.clone(),
                project_id: project_id.clone(),
                engine_session_id: None,
                title: "New task".into(),
                model: settings.model.clone(),
                work_path: work.display().to_string(),
                created_at: now,
                updated_at: now,
            });
            (app_session_id, work)
        };

        for sub in ["images", "videos"] {
            let _ = std::fs::create_dir_all(work_path.join(sub));
        }

        let mut env = settings.engine_env();
        env.push((
            "GROKX_TASK_DIR".into(),
            work_path.display().to_string(),
        ));
        env.push((
            "GROKX_PROJECT_ROOT".into(),
            project_root.display().to_string(),
        ));

        let model = settings
            .model
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let id = settings.endpoint.model_id.trim();
                if id.is_empty() {
                    None
                } else {
                    Some(id.to_string())
                }
            });

        let mode = app_config::permission_modes::normalize(permission_mode);
        // Bundled `grok agent` has no --permission-mode flag; write config.toml
        // and pass --always-approve only for full trust.
        if let Err(e) = settings.apply_engine_permission_mode(mode) {
            warn!(error = %e, mode, "failed to set engine permission_mode");
        }

        let child = spawn_agent_stdio(
            engine,
            SpawnOptions {
                model,
                env,
                agent_args: if mode == app_config::permission_modes::ALWAYS_APPROVE {
                    vec!["--always-approve".into()]
                } else {
                    vec![]
                },
                // MCP inherits this cwd; without it, tauri-dev often leaves
                // media-mcp in frontend/apps/desktop/src-tauri.
                cwd: Some(project_root.clone()),
            },
        )?;
        let agent_pid = child.child.id().unwrap_or(0);

        let needs_history_rehydration = was_reuse
            && Self::read_chat_history_file(&Self::chat_history_path(&work_path))
                .ok()
                .flatten()
                .as_deref()
                .is_some_and(chat_history_has_rehydratable_content);

        // Persist index + task meta so restarts restore the task list.
        self.persist_session_meta(&app_session_id).await;

        // Agent cwd = user-selected project root (files are written there).
        // `work_path` is task metadata + media outputs (images/, videos/).
        // `auto_approve` here means full trust (skip ACP permission gate).
        let options = ConnectOptions {
            cwd: project_root.display().to_string(),
            model: settings.model.clone(),
            auto_approve: mode == app_config::permission_modes::ALWAYS_APPROVE,
            ..ConnectOptions::default()
        };

        self.emit(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Starting,
            detail: Some(format!(
                "agent cwd {} (metadata {})",
                project_root.display(),
                work_path.display()
            )),
        });

        let mut client =
            AcpClient::connect(child.child, app_session_id.clone(), options).await?;
        let handle = client.handle.clone();
        let engine_session_id = handle.engine_session_id().await;

        if let Some(ref eid) = engine_session_id {
            let mut store = self.store.lock().await;
            if let Ok(meta) = store.get_session(&app_session_id).cloned() {
                let mut meta = meta;
                meta.engine_session_id = Some(eid.clone());
                // Keep updated_at unchanged on reconnect so list order stays stable.
                store.upsert_session(meta);
            }
            drop(store);
            self.persist_session_meta(&app_session_id).await;
        }

        // Drain handshake-buffered bridge events BEFORE marking Ready.
        // Otherwise a stale Starting can race past Ready and the Tauri
        // command returns status "Starting" while SessionReady already fired —
        // the UI then overwrites ready with Starting and stays grey forever.
        let mut bridge_events = client.take_events();
        while let Ok(event) = bridge_events.try_recv() {
            match event {
                AppEvent::AgentStatus {
                    status: AgentConnectionStatus::Starting,
                    ..
                } => {
                    // Handshake noise — connect() already finished.
                }
                AppEvent::AgentStatus { status, detail } => {
                    *self.status.write().await = status;
                    self.emit(AppEvent::AgentStatus { status, detail });
                }
                other => self.emit(other),
            }
        }

        // Forward later bridge events onto the app bus while this client lives.
        let bus = self.event_tx.clone();
        let status_slot = Arc::clone(self);
        let sid_for_loop = app_session_id.clone();
        let generation = self
            .next_agent_generation
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        let gen_for_loop = generation;
        tokio::spawn(async move {
            while let Some(event) = bridge_events.recv().await {
                // Track per-session turn busy from turn lifecycle events.
                match &event {
                    AppEvent::TurnState {
                        session_id, state, ..
                    } => {
                        let busy = matches!(
                            state,
                            TurnState::Streaming
                                | TurnState::RunningTools
                                | TurnState::WaitingPermission
                        );
                        if let Some(agent) =
                            status_slot.live.lock().await.get(session_id)
                        {
                            agent.turn_busy.store(busy, Ordering::SeqCst);
                        }
                    }
                    AppEvent::TurnFinished { session_id, state } => {
                        if let Some(agent) =
                            status_slot.live.lock().await.get(session_id)
                        {
                            agent.turn_busy.store(false, Ordering::SeqCst);
                            // Successful turn clears auto-continue retry budget.
                            if matches!(state, TurnState::Completed) {
                                agent
                                    .truncation_auto_retries
                                    .store(0, Ordering::SeqCst);
                            }
                        }
                    }
                    AppEvent::AgentStatus { status, .. } => {
                        // Only update global status if this is the focused session.
                        let focused = status_slot
                            .active_session
                            .read()
                            .await
                            .as_ref()
                            .map(|id| id == &sid_for_loop)
                            .unwrap_or(true);
                        if focused {
                            let mut slot = status_slot.status.write().await;
                            // Never regress Ready → Starting (late handshake replay).
                            if matches!(*slot, AgentConnectionStatus::Ready)
                                && matches!(status, AgentConnectionStatus::Starting)
                            {
                                // Keep Ready; still skip forwarding below.
                            } else {
                                *slot = *status;
                            }
                        }
                    }
                    AppEvent::PermissionNeeded { request, .. } => {
                        let mut broker = status_slot.permissions.lock().await;
                        broker.enqueue(request.clone());
                    }
                    _ => {}
                }
                // Drop stale Starting once this session is already Ready.
                if let AppEvent::AgentStatus {
                    status: AgentConnectionStatus::Starting,
                    ..
                } = &event
                {
                    let focused = status_slot
                        .active_session
                        .read()
                        .await
                        .as_ref()
                        .map(|id| id == &sid_for_loop)
                        .unwrap_or(true);
                    if focused
                        && matches!(
                            *status_slot.status.read().await,
                            AgentConnectionStatus::Ready
                        )
                    {
                        continue;
                    }
                }
                if bus.send(event).is_err() {
                    break;
                }
            }
            // Agent process ended — drop from live map only if this loop still
            // owns the session. Stop+restart reuses the same session id; a stale
            // loop must not delete the replacement grok (that yields
            // "agent is not connected" on the next prompt). Local Bonsai makes
            // this race easy to hit because shutdown waits on llama HTTP.
            let mut live = status_slot.live.lock().await;
            match live.get(&sid_for_loop) {
                Some(agent) if agent.generation == gen_for_loop => {
                    info!(
                        session = %sid_for_loop.0,
                        generation = gen_for_loop,
                        "agent process ended; dropping live agent"
                    );
                    live.remove(&sid_for_loop);
                }
                Some(_) => {
                    info!(
                        session = %sid_for_loop.0,
                        generation = gen_for_loop,
                        "stale agent event loop exiting; keeping replacement"
                    );
                }
                None => {}
            }
        });

        *self.status.write().await = AgentConnectionStatus::Ready;
        self.emit(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Ready,
            detail: Some("session ready".into()),
        });
        self.emit(AppEvent::SessionReady {
            session_id: app_session_id.clone(),
            engine_session_id,
        });

        if needs_history_rehydration {
            info!(
                ?app_session_id,
                "existing task reopened — will rehydrate chat history into next engine prompt"
            );
        }

        self.live.lock().await.insert(
            app_session_id.clone(),
            LiveAgent {
                client,
                handle,
                project_root,
                work_path,
                app_session_id: app_session_id.clone(),
                agent_pid,
                turn_busy: AtomicBool::new(false),
                truncation_auto_retries: AtomicU8::new(0),
                managed_extra: Mutex::new(Vec::new()),
                needs_history_rehydration: AtomicBool::new(needs_history_rehydration),
                generation,
            },
        );
        *self.active_session.write().await = Some(app_session_id.clone());

        Ok(app_session_id)
    }

    /// If this live agent needs history restore, clear the flag and return a
    /// compacted preamble built from `chat-history.json` (UI-only transcript).
    async fn take_rehydration_preamble(&self, session_id: &SessionId) -> Option<String> {
        let work_path = {
            let live = self.live.lock().await;
            let agent = live.get(session_id)?;
            if !agent
                .needs_history_rehydration
                .swap(false, Ordering::SeqCst)
            {
                return None;
            }
            agent.work_path.clone()
        };
        let raw = match Self::read_chat_history_file(&Self::chat_history_path(&work_path)) {
            Ok(Some(s)) => s,
            Ok(None) => return None,
            Err(e) => {
                warn!(error = %e, ?session_id, "failed to read chat history for rehydration");
                return None;
            }
        };
        let preamble = build_history_rehydration_preamble(&raw, REHYDRATE_MAX_CHARS)?;
        info!(
            ?session_id,
            preamble_chars = preamble.len(),
            "rehydrating prior chat history into engine prompt"
        );
        Some(preamble)
    }

    /// Side question (`/btw` / `x.ai/btw`) on the active session.
    ///
    /// Does not set `turn_busy`, does not emit main-chat UserMessage/deltas,
    /// and may run while a main turn is in progress.
    /// Returns `(answer, optional thinking text)`.
    pub async fn send_btw(
        self: &Arc<Self>,
        question: String,
    ) -> Result<(String, Option<String>), CoreError> {
        let mut question = question.trim().to_string();
        if question.is_empty() {
            return Err(CoreError::Message("empty side question".into()));
        }
        if self.wants_local_llm().await && !host_supports_local_bonsai() {
            let tune = tune_bonsai_for_host();
            return Err(LlmRuntimeError::UnsupportedGpu {
                detail: tune.label,
            }
            .into());
        }
        self.ensure_live_agent().await?;
        let (handle, session_id) = {
            let live = self.live.lock().await;
            let sid = self
                .active_session
                .read()
                .await
                .clone()
                .ok_or(CoreError::NotConnected)?;
            let agent = live.get(&sid).ok_or(CoreError::NotConnected)?;
            (agent.handle.clone(), sid)
        };
        if let Some(preamble) = self.take_rehydration_preamble(&session_id).await {
            question = format!("{preamble}\n\n## Current side question\n{question}");
        }
        handle
            .send_btw(&question)
            .await
            .map_err(CoreError::from)
    }

    /// Send a user prompt on the active session.
    pub async fn send_prompt(self: &Arc<Self>, text: String) -> Result<(), CoreError> {
        self.send_prompt_request(PromptRequest {
            text,
            attachments: vec![],
            model: None,
            effort: None,
        })
        .await
    }

    pub async fn send_prompt_request(
        self: &Arc<Self>,
        mut req: PromptRequest,
    ) -> Result<(), CoreError> {
        req.text = sanitize_prompt_text(&req.text);
        if req.text.is_empty() && req.attachments.is_empty() {
            return Err(CoreError::Message("empty prompt".into()));
        }
        if self.wants_local_llm().await && !host_supports_local_bonsai() {
            let tune = tune_bonsai_for_host();
            return Err(LlmRuntimeError::UnsupportedGpu {
                detail: tune.label,
            }
            .into());
        }

        self.ensure_live_agent().await?;

        let (handle, session_id) = {
            let live = self.live.lock().await;
            let sid = self
                .active_session
                .read()
                .await
                .clone()
                .ok_or(CoreError::NotConnected)?;
            let agent = live.get(&sid).ok_or(CoreError::NotConnected)?;
            if agent.turn_busy.load(Ordering::SeqCst) {
                return Err(CoreError::TurnInProgress);
            }
            agent.turn_busy.store(true, Ordering::SeqCst);
            (agent.handle.clone(), sid)
        };

        // Persist preferred model in settings.
        if let Some(model) = req.model.clone() {
            let mut settings = self.settings.write().await;
            settings.model = Some(model);
        }

        // UI bubble stays the user's words only; engine may get a history preamble.
        let mut display = req.text.clone();
        if !req.attachments.is_empty() {
            let names: Vec<_> = req.attachments.iter().map(|a| a.name.as_str()).collect();
            if display.is_empty() {
                display = format!("(attachments: {})", names.join(", "));
            } else {
                display = format!("{display}\n\n📎 {}", names.join(", "));
            }
        }

        if let Some(preamble) = self.take_rehydration_preamble(&session_id).await {
            // Engine slash parsers (`/goal`, `/compact`, …) require `/command`
            // at the start of the *first* text block. Prepending restored
            // history would bury the slash and silently disable builtins.
            if is_leading_slash_command(&req.text) {
                info!(
                    ?session_id,
                    command = req.text.lines().next().unwrap_or(""),
                    "skipping history rehydration preamble for leading slash command"
                );
            } else if req.text.is_empty() {
                req.text = format!(
                    "{preamble}\n\n## Current user message\n(See attachments.)"
                );
            } else {
                req.text = format!("{preamble}\n\n## Current user message\n{}", req.text);
            }
        }

        self.emit(AppEvent::UserMessage {
            session_id: session_id.clone(),
            text: display,
        });
        self.emit(AppEvent::TurnState {
            session_id: session_id.clone(),
            state: TurnState::Streaming,
        });

        let core = Arc::clone(self);
        tokio::spawn(async move {
            let result = handle.prompt_request(req).await;
            match result {
                Ok(()) => {
                    // Bridge already emitted TurnFinished (or left turn open
                    // if still waiting on permissions).
                    if let Some(agent) = core.live.lock().await.get(&session_id) {
                        // Only clear if bridge did not leave waiting/running.
                        // TurnFinished handler also clears; this is a safety net.
                        let _ = agent;
                    }
                }
                Err(err) => {
                    let (msg, app_code) = bridge_error_parts(&err);
                    let is_timeout = msg.to_ascii_lowercase().contains("timeout");
                    warn!(error = %err, "prompt failed");
                    // Timeout / long-run: bridge keeps turn open; do not mark finished.
                    if !is_timeout {
                        let truncated = looks_like_max_tokens_truncation(&msg)
                            || recent_grok_log_max_tokens_truncation();

                        let mut should_auto_recover = false;
                        let mut recover_attempt: u8 = 1;
                        if truncated {
                            if let Some(agent) = core.live.lock().await.get(&session_id) {
                                agent.turn_busy.store(false, Ordering::SeqCst);
                                let prev = agent
                                    .truncation_auto_retries
                                    .fetch_add(1, Ordering::SeqCst);
                                should_auto_recover = prev < MAX_TRUNCATION_AUTO_RETRIES;
                                recover_attempt = prev.saturating_add(1);
                                if !should_auto_recover {
                                    agent.truncation_auto_retries.store(
                                        MAX_TRUNCATION_AUTO_RETRIES,
                                        Ordering::SeqCst,
                                    );
                                }
                            }
                        } else if let Some(agent) = core.live.lock().await.get(&session_id) {
                            agent.turn_busy.store(false, Ordering::SeqCst);
                        }

                        // Soft notice while auto-continuing — no TurnFinished(Error),
                        // no raw -32603 spam. Hard-fail UX only when giving up.
                        if truncated && should_auto_recover {
                            core.emit(AppEvent::AgentError {
                                message: format!(
                                    "输出超长被截断，将自动接着未完成处继续写（{recover_attempt}/{MAX_TRUNCATION_AUTO_RETRIES}）…"
                                ),
                                app_code: None,
                            });
                            core.emit(AppEvent::TurnState {
                                session_id: session_id.clone(),
                                state: TurnState::Streaming,
                            });
                        } else {
                            let display = if truncated {
                                format!(
                                    "已连续 {MAX_TRUNCATION_AUTO_RETRIES} 次因单次输出超长失败。\
你可以在同一任务里手动发「继续」接着写；或开新任务并把目标拆更小。"
                                )
                            } else {
                                msg
                            };
                            core.emit(AppEvent::AgentError {
                                message: display,
                                app_code: if truncated { None } else { app_code },
                            });
                            core.emit(AppEvent::TurnFinished {
                                session_id: session_id.clone(),
                                state: TurnState::Error,
                            });
                        }

                        // Same engine session (model still sees prior turns).
                        // UI shows a short continue bubble, not the full brief.
                        if should_auto_recover {
                            let mut attempt = recover_attempt;
                            loop {
                                let continue_prompt = truncation_continue_prompt(attempt);
                                let ui_label = format!(
                                    "（自动续跑 #{attempt}/{MAX_TRUNCATION_AUTO_RETRIES}）继续追加未完成部分 — 同一任务接着写，不是重新提问"
                                );
                                info!(
                                    ?session_id,
                                    attempt,
                                    "auto-continue after max_tokens_truncation"
                                );
                                core.emit(AppEvent::AgentError {
                                    message: format!(
                                        "自动续跑 #{attempt}/{MAX_TRUNCATION_AUTO_RETRIES}：接着未完成处继续写（小块追加）。"
                                    ),
                                    app_code: None,
                                });
                                if let Some(agent) = core.live.lock().await.get(&session_id) {
                                    agent.turn_busy.store(true, Ordering::SeqCst);
                                }
                                core.emit(AppEvent::UserMessage {
                                    session_id: session_id.clone(),
                                    text: ui_label,
                                });
                                core.emit(AppEvent::TurnState {
                                    session_id: session_id.clone(),
                                    state: TurnState::Streaming,
                                });
                                let continue_started_at = Utc::now().timestamp();
                                let recover = handle
                                    .prompt_request(PromptRequest {
                                        text: continue_prompt,
                                        attachments: vec![],
                                        model: None,
                                        effort: None,
                                    })
                                    .await;
                                match recover {
                                    Ok(()) => break,
                                    Err(recover_err) => {
                                        let recover_msg = recover_err.to_string();
                                        let recover_timeout = recover_msg
                                            .to_ascii_lowercase()
                                            .contains("timeout");
                                        warn!(
                                            error = %recover_err,
                                            attempt,
                                            "truncation continue prompt failed"
                                        );
                                        if recover_timeout {
                                            break;
                                        }
                                        let truncated_again =
                                            looks_like_max_tokens_truncation(&recover_msg)
                                                || grok_log_max_tokens_truncation_since(
                                                    continue_started_at,
                                                );
                                        if !truncated_again {
                                            core.emit(AppEvent::AgentError {
                                                message: recover_msg,
                                                app_code: None,
                                            });
                                            core.emit(AppEvent::TurnFinished {
                                                session_id: session_id.clone(),
                                                state: TurnState::Error,
                                            });
                                            if let Some(agent) =
                                                core.live.lock().await.get(&session_id)
                                            {
                                                agent.turn_busy.store(false, Ordering::SeqCst);
                                            }
                                            break;
                                        }

                                        let can_retry = if let Some(agent) =
                                            core.live.lock().await.get(&session_id)
                                        {
                                            agent.turn_busy.store(false, Ordering::SeqCst);
                                            let n = agent
                                                .truncation_auto_retries
                                                .fetch_add(1, Ordering::SeqCst);
                                            n < MAX_TRUNCATION_AUTO_RETRIES
                                        } else {
                                            false
                                        };
                                        if !can_retry {
                                            core.emit(AppEvent::AgentError {
                                                message: format!(
                                                    "已连续 {MAX_TRUNCATION_AUTO_RETRIES} 次因单次输出超长失败。\
你可以在同一任务里手动发「继续」接着写；或开新任务并把目标拆更小。"
                                                ),
                                                app_code: None,
                                            });
                                            core.emit(AppEvent::TurnFinished {
                                                session_id: session_id.clone(),
                                                state: TurnState::Error,
                                            });
                                            break;
                                        }
                                        attempt = attempt.saturating_add(1);
                                    }
                                }
                            }
                        }
                    }
                    // On timeout leave turn_busy true until a later TurnFinished.
                }
            }
            let _ = core.store.lock().await.touch_session(&session_id);
        });

        Ok(())
    }

    pub async fn configured_models(&self) -> Vec<ModelInfo> {
        let settings = self.settings.read().await;
        if !settings.model_profiles.is_empty() {
            return settings
                .model_profiles
                .iter()
                .filter(|p| !p.model_id.starts_with("__vendor__") && p.enabled)
                .map(|p| ModelInfo {
                    id: p.model_id.clone(),
                    name: p
                        .name
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| p.model_id.clone()),
                })
                .collect();
        }
        default_models()
    }

    pub async fn available_models(&self) -> Vec<ModelInfo> {
        let live = self.live.lock().await;
        if let Some(id) = self.active_session.read().await.as_ref() {
            if let Some(l) = live.get(id) {
                return l.handle.available_models().await;
            }
        }
        if let Some((_, l)) = live.iter().next() {
            return l.handle.available_models().await;
        }
        default_models()
    }

    pub async fn current_model(&self) -> Option<String> {
        if let Some(id) = self.active_session.read().await.clone() {
            let live = self.live.lock().await;
            if let Some(agent) = live.get(&id) {
                if let Some(m) = agent.handle.current_model().await {
                    return Some(m);
                }
            }
        }
        self.settings.read().await.model.clone()
    }

    pub async fn set_model(&self, model_id: String) -> Result<(), CoreError> {
        {
            let mut settings = self.settings.write().await;
            settings.model = Some(model_id.clone());
            if let Some(profile) = settings.find_profile(&model_id).cloned() {
                settings.apply_profile_to_endpoint(&profile);
            } else {
                settings.endpoint.model_id = model_id.clone();
                if model_id == BONSAI_LOCAL_ID {
                    settings.endpoint.name = Some("Bonsai 27B (1Bit)".into());
                    settings.endpoint.base_url = Some("http://127.0.0.1:8080/v1".into());
                    settings.endpoint.api_backend = Some("chat_completions".into());
                    if settings
                        .endpoint
                        .api_key
                        .as_ref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true)
                    {
                        settings.endpoint.api_key = Some("local".into());
                    }
                    // ctx / ngl are applied when llama-server starts (VRAM-aware).
                }
            }
            let _ = settings.save(&self.paths.config_file);
            let _ = settings.sync_endpoint_to_grok_toml();
        }

        let settings = self.settings.read().await.clone();
        if is_local_bonsai_target(
            settings.model.as_deref().or(Some(settings.endpoint.model_id.as_str())),
            settings.endpoint.base_url.as_deref(),
        ) {
            let roots = default_llm_search_roots();
            if let Err(err) = self.ensure_local_llm(&roots).await {
                warn!(error = %err, "failed to auto-start local LLM after model switch");
            }
        } else {
            self.stop_local_llm().await;
        }

        // Apply to active agent; others pick it up on next prompt via settings.
        if let Some(id) = self.active_session.read().await.clone() {
            let live = self.live.lock().await;
            if let Some(l) = live.get(&id) {
                l.handle.set_model(&model_id).await?;
            }
        }
        Ok(())
    }

    /// Effort levels shown in the desktop UI (matches Grok Build menu:
    /// Low / Medium / High / Extra high).
    pub fn effort_options() -> Vec<ReasoningEffort> {
        ReasoningEffort::menu().to_vec()
    }

    /// If the focused session has no grok process, respawn it (same task id).
    ///
    /// Stop+restart can drop the live agent via a stale ACP event loop; the next
    /// prompt must reconnect instead of returning `agent is not connected`.
    async fn ensure_live_agent(self: &Arc<Self>) -> Result<SessionId, CoreError> {
        let sid = self
            .active_session
            .read()
            .await
            .clone()
            .ok_or(CoreError::NotConnected)?;
        if self.live.lock().await.contains_key(&sid) {
            return Ok(sid);
        }
        warn!(
            session = %sid.0,
            "live agent missing; reconnecting before prompt"
        );
        let auto_approve = self.settings.read().await.is_full_trust();
        self.reconnect_session(&sid, None, true, auto_approve)
            .await
    }

    /// Cancel the active session's in-flight turn (Stop button).
    ///
    /// Soft-cancels first (deny parked permissions + `session/cancel`), then
    /// **force-restarts** the agent process so a wedged engine
    /// (`task_already_running`) cannot block the next prompt.
    pub async fn cancel_turn(
        self: &Arc<Self>,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
    ) -> Result<(), CoreError> {
        let (handle, sid, project_root) = {
            let live = self.live.lock().await;
            let sid = self
                .active_session
                .read()
                .await
                .clone()
                .ok_or(CoreError::NotConnected)?;
            let agent = live.get(&sid).ok_or(CoreError::NotConnected)?;
            // Optimistic: UI must leave Working even if cancel races.
            agent.turn_busy.store(false, Ordering::SeqCst);
            (agent.handle.clone(), sid, agent.project_root.clone())
        };

        // Stop local Bonsai generation so grok is not stuck on llama HTTP while
        // we kill/restart the agent. The llama-server process itself stays up.
        if self.wants_local_llm().await {
            self.llm.lock().await.interrupt_generation().await;
        }

        // Soft cancel: unblock RPCs, deny permissions with ACP replies, session/cancel.
        if let Err(e) = handle.cancel().await {
            warn!(error = %e, session = %sid.0, "cancel_turn: engine cancel failed");
            self.emit(AppEvent::TurnFinished {
                session_id: sid.clone(),
                state: TurnState::Cancelled,
            });
        }
        // Drop the cloned handle so the old ACP event channel can close before
        // we insert the replacement agent.
        drop(handle);

        // Hard restart: kill the (possibly wedged) grok and respawn the same task.
        if let Some(prev) = self.live.lock().await.remove(&sid) {
            prev.client.shutdown().await;
        }
        // Brief pause so Windows releases stdio pipes after kill.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let mode = self.settings.read().await.permission_mode_normalized().to_string();
        match self
            .spawn_agent_for_project(
                project_root,
                resource_dir,
                allow_path_fallback,
                &mode,
                Some(sid.clone()),
            )
            .await
        {
            Ok(_) => {
                info!(session = %sid.0, "cancel_turn: agent force-restarted");
                if let Some(agent) = self.live.lock().await.get(&sid) {
                    agent.turn_busy.store(false, Ordering::SeqCst);
                }
                self.emit(AppEvent::AgentStatus {
                    status: AgentConnectionStatus::Ready,
                    detail: Some("agent restarted after stop".into()),
                });
                Ok(())
            }
            Err(e) => {
                warn!(
                    error = %e,
                    session = %sid.0,
                    "cancel_turn: soft-cancel ok but agent restart failed"
                );
                Err(e)
            }
        }
    }

    /// Resolve a parked permission request on any live ACP session.
    pub async fn resolve_permission(
        &self,
        request_id: String,
        decision: PermissionDecision,
    ) -> Result<(), CoreError> {
        // Find which live agent owns this pending permission.
        let handle = {
            let live = self.live.lock().await;
            let mut found = None;
            for agent in live.values() {
                if agent.handle.permission_is_pending(&request_id).await {
                    found = Some(agent.handle.clone());
                    break;
                }
            }
            found
        };

        let Some(handle) = handle else {
            let mut broker = self.permissions.lock().await;
            let _ = broker.resolve(&request_id, decision);
            return Err(CoreError::Message(format!(
                "permission request not pending: {request_id}"
            )));
        };

        handle.resolve_permission(&request_id, decision).await?;
        let mut broker = self.permissions.lock().await;
        let _ = broker.resolve(&request_id, decision);

        self.emit(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Ready,
            detail: Some(format!(
                "permission {request_id} → {decision:?}"
            )),
        });
        Ok(())
    }

    pub async fn permission_is_pending(&self, request_id: &str) -> bool {
        let live = self.live.lock().await;
        for agent in live.values() {
            if agent.handle.permission_is_pending(request_id).await {
                return true;
            }
        }
        false
    }

    /// Disconnect only the active session's agent (others keep running).
    pub async fn disconnect(&self) {
        let sid = self.active_session.write().await.take();
        if let Some(sid) = sid {
            if let Some(prev) = self.live.lock().await.remove(&sid) {
                prev.client.shutdown().await;
            }
        }
        let still_live = !self.live.lock().await.is_empty();
        *self.status.write().await = if still_live {
            AgentConnectionStatus::Ready
        } else {
            AgentConnectionStatus::MissingBinary
        };
        self.emit(AppEvent::AgentStatus {
            status: *self.status.read().await,
            detail: Some("disconnected active session".into()),
        });
    }

    /// Shut down a specific session's agent (e.g. on task delete).
    pub async fn disconnect_session(&self, session_id: &SessionId) {
        if let Some(prev) = self.live.lock().await.remove(session_id) {
            prev.client.shutdown().await;
        }
        let mut active = self.active_session.write().await;
        if active.as_ref() == Some(session_id) {
            *active = self.live.lock().await.keys().next().cloned();
        }
    }
}

fn default_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: BONSAI_LOCAL_ID.into(),
            name: "Bonsai 27B (1Bit)".into(),
        },
        ModelInfo {
            id: "grok-4.5".into(),
            name: "Grok 4.5".into(),
        },
        ModelInfo {
            id: "grok-code".into(),
            name: "Grok Code".into(),
        },
        ModelInfo {
            id: "grok-build".into(),
            name: "Grok Build".into(),
        },
    ]
}

/// Soft cap for history preamble chars injected into the next engine prompt.
/// Keeps room for the new user turn + model reply inside typical context windows.
const REHYDRATE_MAX_CHARS: usize = 48_000;

fn chat_history_has_rehydratable_content(json: &str) -> bool {
    let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        return false;
    };
    arr.iter().any(|v| {
        matches!(
            v.get("kind").and_then(|k| k.as_str()),
            Some("user" | "assistant")
        )
    })
}

/// Strip BOM / zero-width junk that contenteditable sometimes leaves in front
/// of `/goal` and other slash commands (would break engine slash parsing).
fn sanitize_prompt_text(text: &str) -> String {
    text.trim()
        .trim_start_matches([
            '\u{feff}', // BOM
            '\u{200b}', // ZWSP
            '\u{200c}', // ZWNJ
            '\u{200d}', // ZWJ
            '\u{2060}', // WJ
        ])
        .trim()
        .to_string()
}

/// True when the prompt starts with a slash builtin/skill (`/goal …`).
fn is_leading_slash_command(text: &str) -> bool {
    let t = text.trim_start();
    let Some(rest) = t.strip_prefix('/') else {
        return false;
    };
    let name = rest.split_whitespace().next().unwrap_or("");
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Build a compact prior-conversation block from UI `chat-history.json`.
///
/// Prefers user/assistant turns; briefly notes tools/errors. Drops oldest
/// content first when over `max_chars`.
fn build_history_rehydration_preamble(json: &str, max_chars: usize) -> Option<String> {
    let arr: Vec<serde_json::Value> = serde_json::from_str(json).ok()?;
    let mut segments: Vec<String> = Vec::new();

    for v in &arr {
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        match kind {
            "user" => {
                let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                if !text.is_empty() {
                    segments.push(format!("### User\n{text}"));
                }
            }
            "assistant" => {
                let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                if !text.is_empty() {
                    segments.push(format!("### Assistant\n{text}"));
                }
            }
            "error" => {
                let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                if !text.is_empty() {
                    let clipped = clip_chars(text, 500);
                    segments.push(format!("### Error\n{clipped}"));
                }
            }
            "trace" => {
                let Some(items) = v.get("items").and_then(|i| i.as_array()) else {
                    continue;
                };
                let tools: Vec<&str> = items
                    .iter()
                    .filter_map(|it| {
                        let k = it.get("kind").and_then(|x| x.as_str())?;
                        let t = it.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
                        if k == "tool" && !t.is_empty() {
                            Some(t)
                        } else {
                            None
                        }
                    })
                    .take(12)
                    .collect();
                if !tools.is_empty() {
                    segments.push(format!("### Tools\n{}", tools.join("; ")));
                }
            }
            _ => {}
        }
    }

    if segments.is_empty() {
        return None;
    }

    let header = "\
## Prior conversation (restored after session reconnect)\n\
The engine session was restarted. The UI transcript below is the prior work on \
this same task — continue from it. Do not restart the task from scratch or claim \
you lack prior context unless the transcript itself is empty.\n";

    let footer_note = "\n\n(End of restored transcript.)";
    let budget = max_chars
        .saturating_sub(header.len())
        .saturating_sub(footer_note.len());
    if budget < 64 {
        return None;
    }

    // Keep the newest turns when over budget.
    let total_segments = segments.len();
    let mut chosen: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut dropped_older = false;
    for seg in segments.into_iter().rev() {
        let cost = seg.len() + if chosen.is_empty() { 0 } else { 2 };
        if used + cost > budget {
            dropped_older = true;
            if chosen.is_empty() {
                // Single oversized turn: clip it so we still restore something.
                chosen.push(clip_chars(&seg, budget));
            }
            break;
        }
        used += cost;
        chosen.push(seg);
    }
    chosen.reverse();
    if chosen.len() < total_segments {
        dropped_older = true;
    }

    let mut body = String::with_capacity(header.len() + used + footer_note.len() + 80);
    body.push_str(header);
    if dropped_older {
        body.push_str("(Older turns omitted to fit context.)\n\n");
    }
    body.push_str(&chosen.join("\n\n"));
    body.push_str(footer_note);
    Some(body)
}

fn clip_chars(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.saturating_sub(20);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… [truncated]", &s[..end])
}

/// Roots used to locate `models/llama-prism-win-cuda12` or `llama-prism-win-cpu`.
fn default_llm_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(AppPaths::product_install_root());
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    // Workspace root when developing from frontend/crates/app-core.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for ancestor in manifest.ancestors().take(6) {
        roots.push(ancestor.to_path_buf());
    }
    roots.push(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use acp_bridge::{decision_blocks_tool, PermissionGate, ParkedPermission};
    use domain::PermissionDecision;
    use serde_json::json;

    #[test]
    fn rehydration_detects_user_assistant_turns() {
        let json = r#"[
            {"id":"1","kind":"system","text":"ready"},
            {"id":"2","kind":"user","text":"make a ppt"},
            {"id":"3","kind":"assistant","text":"working on it"}
        ]"#;
        assert!(chat_history_has_rehydratable_content(json));
        assert!(!chat_history_has_rehydratable_content(r#"[{"kind":"system","text":"ready"}]"#));
        assert!(!chat_history_has_rehydratable_content("not-json"));
    }

    #[test]
    fn sanitize_prompt_text_strips_zwsp_before_slash() {
        assert_eq!(sanitize_prompt_text("\u{200b}/goal do x"), "/goal do x");
        assert_eq!(sanitize_prompt_text("  /goal status  "), "/goal status");
    }

    #[test]
    fn leading_slash_command_detected() {
        assert!(is_leading_slash_command("/goal migrate auth"));
        assert!(is_leading_slash_command("/goal status"));
        assert!(is_leading_slash_command("  /compact"));
        assert!(!is_leading_slash_command("please /goal later"));
        assert!(!is_leading_slash_command("/Users/foo/bar"));
        assert!(!is_leading_slash_command("hello"));
    }

    #[test]
    fn rehydration_preamble_keeps_recent_user_turns() {
        let json = serde_json::to_string(&json!([
            {"id":"1","kind":"user","text":"old task"},
            {"id":"2","kind":"assistant","text":"old reply"},
            {"id":"3","kind":"user","text":"请帮我做一个关于Python学习的PPT"},
            {"id":"4","kind":"trace","items":[
                {"id":"t1","kind":"tool","text":"where python"},
                {"id":"t2","kind":"tool","text":"curl installer"}
            ]},
            {"id":"5","kind":"assistant","text":"started installing python"}
        ]))
        .unwrap();
        let preamble = build_history_rehydration_preamble(&json, REHYDRATE_MAX_CHARS).unwrap();
        assert!(preamble.contains("Prior conversation"));
        assert!(preamble.contains("Python学习的PPT"));
        assert!(preamble.contains("started installing python"));
        assert!(preamble.contains("where python"));
        assert!(preamble.contains("Current user message") == false);
    }

    #[test]
    fn rehydration_preamble_drops_oldest_when_over_budget() {
        let mut lines = Vec::new();
        for i in 0..20 {
            lines.push(json!({"id": format!("u{i}"), "kind": "user", "text": format!("USER_MSG_{i}_{}", "x".repeat(200))}));
            lines.push(json!({"id": format!("a{i}"), "kind": "assistant", "text": format!("ASST_MSG_{i}_{}", "y".repeat(200))}));
        }
        let json = serde_json::to_string(&lines).unwrap();
        let preamble = build_history_rehydration_preamble(&json, 2_500).unwrap();
        assert!(preamble.contains("Older turns omitted") || preamble.contains("USER_MSG_19"));
        assert!(preamble.contains("USER_MSG_19"));
        assert!(!preamble.contains("USER_MSG_0_"));
    }

    /// Drive the same gate used by the bridge: pending until resolve; deny blocks.
    #[tokio::test]
    async fn permission_pending_until_resolved_via_gate() {
        let mut gate = PermissionGate::new();
        assert!(PermissionGate::should_park(false));
        gate.park(ParkedPermission {
            request_id: "ui-req".into(),
            rpc_id: json!(7),
            tool_name: "Bash".into(),
            summary: "echo hi".into(),
            similarity_key: "bash:echo".into(),
            options: vec![],
        });
        assert!(gate.is_pending("ui-req"));

        // Deny path
        let (_rpc, outcome) = gate.resolve("ui-req", PermissionDecision::Deny).unwrap();
        assert_eq!(outcome["outcome"]["optionId"], "reject-once");
        assert!(decision_blocks_tool(PermissionDecision::Deny));
        assert!(!gate.is_pending("ui-req"));
    }

    #[tokio::test]
    async fn set_project_and_list_sessions_after_store() {
        let core = AppCore::bootstrap().unwrap();
        // Use crate dir as a real directory
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let set = core.set_project_root(root.clone()).await.unwrap();
        assert_eq!(set, root);
        assert_eq!(core.selected_project_root().await, Some(root.clone()));

        // Simulate session metadata as connect would
        let mut store = core.store.lock().await;
        let pid = ProjectId::new();
        let sid = SessionId::new();
        let now = Utc::now();
        store.upsert_project(Project {
            id: pid.clone(),
            root_path: root.display().to_string(),
            name: "app-core".into(),
            created_at: now,
        });
        store.upsert_session(SessionMeta {
            id: sid.clone(),
            project_id: pid,
            engine_session_id: Some("eng-1".into()),
            title: "test".into(),
            model: None,
            work_path: "/tmp/tasks/test".into(),
            created_at: now,
            updated_at: now,
        });
        drop(store);

        let list = core.list_sessions().await;
        let ours = list
            .iter()
            .find(|s| s.session_id == sid)
            .expect("inserted session should be listed");
        assert_eq!(ours.project_root, root.display().to_string());
        assert_eq!(ours.work_path, "/tmp/tasks/test");
        assert!(ours.updated_at <= Utc::now());
    }

    #[test]
    fn ensure_task_workspace_creates_dir_and_project_pointer() {
        let sid = SessionId::new();
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let work = AppCore::ensure_task_workspace(&sid, &project, None).unwrap();
        assert!(work.is_dir());
        assert_eq!(
            work,
            AppPaths::project_task_dir(&project, &sid.0.to_string())
        );
        assert!(AppPaths::is_managed_task_dir(&work));
        let pointer = work.join("project");
        let contents = std::fs::read_to_string(&pointer).unwrap();
        assert_eq!(contents, project.display().to_string());
        // Cleanup this test task dir (and empty parents if we created them).
        let _ = std::fs::remove_dir_all(&work);
        let tasks = AppPaths::project_tasks_root(&project);
        let _ = std::fs::remove_dir(&tasks);
        let grokx = project.join(".grokx");
        let _ = std::fs::remove_dir(&grokx);
    }
}

// ─── Session process tree (agent tool children) ─────────────────────────────

#[derive(Debug, Clone)]
struct ProcSnap {
    pid: u32,
    ppid: u32,
    etime: String,
    cpu: String,
    mem: String,
    state: String,
    command: String,
}

fn process_exists(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
        || std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
}

fn process_snapshot(pid: u32) -> Option<ProcSnap> {
    let out = std::process::Command::new("ps")
        .args([
            "-p",
            &pid.to_string(),
            "-o",
            "pid=,ppid=,etime=,pcpu=,pmem=,state=,command=",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ps_line(&String::from_utf8_lossy(&out.stdout))
}

fn parse_ps_line(line: &str) -> Option<ProcSnap> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.split_whitespace();
    let pid: u32 = parts.next()?.parse().ok()?;
    let ppid: u32 = parts.next()?.parse().ok()?;
    let etime = parts.next()?.to_string();
    let cpu = parts.next()?.to_string();
    let mem = parts.next()?.to_string();
    let state = parts.next()?.to_string();
    let command = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }
    Some(ProcSnap {
        pid,
        ppid,
        etime,
        cpu,
        mem,
        state,
        command,
    })
}

fn process_cwd(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .map(|p| p.display().to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(rest) = line.strip_prefix('n') {
                if !rest.is_empty() {
                    return Some(rest.to_string());
                }
            }
        }
        None
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

fn list_all_processes() -> Vec<ProcSnap> {
    let out = match std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,etime=,pcpu=,pmem=,state=,command="])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_ps_line)
        .collect()
}

fn snap_to_info(pid: u32, command_fallback: Option<String>, depth: u32) -> Option<SessionProcessInfo> {
    let snap = process_snapshot(pid);
    let command = snap
        .as_ref()
        .map(|s| s.command.clone())
        .or(command_fallback)?;
    let paused = snap
        .as_ref()
        .map(|s| s.state.starts_with('T'))
        .unwrap_or(false);
    Some(SessionProcessInfo {
        pid,
        ppid: snap.as_ref().map(|s| s.ppid).unwrap_or(0),
        command,
        etime: snap
            .as_ref()
            .map(|s| s.etime.clone())
            .unwrap_or_else(|| "—".into()),
        state: snap
            .as_ref()
            .map(|s| s.state.clone())
            .unwrap_or_else(|| "?".into()),
        cpu: snap
            .as_ref()
            .map(|s| s.cpu.clone())
            .unwrap_or_else(|| "0".into()),
        mem: snap
            .as_ref()
            .map(|s| s.mem.clone())
            .unwrap_or_else(|| "0".into()),
        depth,
        cwd: process_cwd(pid),
        paused,
    })
}

fn list_descendant_processes(agent_pid: u32) -> Vec<SessionProcessInfo> {
    if agent_pid == 0 {
        return Vec::new();
    }
    let all = list_all_processes();
    let mut by_ppid: std::collections::HashMap<u32, Vec<&ProcSnap>> =
        std::collections::HashMap::new();
    for p in &all {
        by_ppid.entry(p.ppid).or_default().push(p);
    }
    let mut out = Vec::new();
    let mut stack: Vec<(u32, u32)> = vec![(agent_pid, 0)];
    while let Some((parent, depth)) = stack.pop() {
        if let Some(children) = by_ppid.get(&parent) {
            for c in children {
                // depth 0 is the agent itself — only collect descendants.
                let d = depth + 1;
                let paused = c.state.starts_with('T');
                out.push(SessionProcessInfo {
                    pid: c.pid,
                    ppid: c.ppid,
                    command: c.command.clone(),
                    etime: c.etime.clone(),
                    state: c.state.clone(),
                    cpu: c.cpu.clone(),
                    mem: c.mem.clone(),
                    depth: d,
                    cwd: process_cwd(c.pid),
                    paused,
                });
                stack.push((c.pid, d));
            }
        }
    }
    // Stable-ish: shallower first, then pid.
    out.sort_by(|a, b| a.depth.cmp(&b.depth).then(a.pid.cmp(&b.pid)));
    out
}

/// Find long-lived processes that look like they belong to this task/project
/// even when no longer parented under the agent (PPID=1 after agent restart).
fn find_related_orphans(
    work_path: &Path,
    project_root: &Path,
    skip_pids: &std::collections::HashSet<u32>,
) -> Vec<SessionProcessInfo> {
    let work_s = work_path.display().to_string();
    let proj_s = project_root.display().to_string();
    // Avoid matching everything when paths are empty / too short.
    if work_s.len() < 8 && proj_s.len() < 8 {
        return Vec::new();
    }
    let work_norm = work_s.trim_end_matches('/').to_string();
    let proj_norm = proj_s.trim_end_matches('/').to_string();
    let self_pid = std::process::id();

    let mut out = Vec::new();
    for p in list_all_processes() {
        if skip_pids.contains(&p.pid) || p.pid == self_pid {
            continue;
        }
        // Never list our own shell / UI tooling as "task processes".
        let cmd = &p.command;
        if cmd.contains("grokx-desktop")
            || cmd.contains("tauri.js")
            || cmd.contains("vite")
            || cmd.contains("/grok agent")
            || cmd.contains("runtime/grok")
        {
            continue;
        }
        // Skip system / unrelated noise.
        if cmd.starts_with("/System/")
            || cmd.starts_with("/usr/libexec/")
            || cmd.starts_with("/sbin/")
            || cmd.contains("cloudflared")
            || cmd.contains("Cursor Helper")
            || cmd.contains("Google Chrome")
        {
            continue;
        }

        let cwd = process_cwd(p.pid);
        let cwd_match = cwd
            .as_deref()
            .map(|c| {
                let c = c.trim_end_matches('/');
                (!work_norm.is_empty()
                    && (c == work_norm || c.starts_with(&format!("{work_norm}/"))))
                    || (!proj_norm.is_empty()
                        && (c == proj_norm || c.starts_with(&format!("{proj_norm}/"))))
            })
            .unwrap_or(false);

        let cmd_match = (!work_norm.is_empty() && cmd.contains(&work_norm))
            || (!proj_norm.is_empty() && cmd.contains(&proj_norm));

        // Also catch `uv run mykg …` when project leaf name is distinctive and
        // cwd is under project (already covered) OR command includes project venv.
        if !cwd_match && !cmd_match {
            continue;
        }

        // Prefer root-ish processes (not every python helper under the server).
        // Include if: listening-style long runners OR direct match on work/project.
        let looks_like_server = cmd.contains(" web ")
            || cmd.contains(" serve")
            || cmd.contains("uvicorn")
            || cmd.contains("flask")
            || cmd.contains("django")
            || cmd.contains("next ")
            || cmd.contains("vite")
            || cmd.contains("--port")
            || cmd.contains("0.0.0.0")
            || cmd.contains("127.0.0.1")
            || cmd.contains("mykg web")
            || cmd.contains("npm run")
            || cmd.contains("pnpm ")
            || cmd.contains("yarn ");

        // Include parent shells (`uv run …`) and actual servers.
        if !looks_like_server && !cmd_match {
            // cwd-only match: only keep if it still looks like a user tool.
            if !(cmd.contains("python")
                || cmd.contains("node")
                || cmd.contains("uv ")
                || cmd.contains("cargo ")
                || cmd.contains("ruby")
                || cmd.contains("java"))
            {
                continue;
            }
        }

        out.push(SessionProcessInfo {
            pid: p.pid,
            ppid: p.ppid,
            command: p.command.clone(),
            etime: p.etime.clone(),
            state: p.state.clone(),
            cpu: p.cpu.clone(),
            mem: p.mem.clone(),
            // depth 1 for orphans so they show as top-level task processes.
            depth: 1,
            cwd,
            paused: p.state.starts_with('T'),
        });
    }
    out
}

fn signal_process(pid: u32, kind: &str) -> Result<(), CoreError> {
    let flag = match kind {
        "term" => "-TERM",
        "kill" => "-KILL",
        "stop" => "-STOP",
        "cont" => "-CONT",
        other => {
            return Err(CoreError::Message(format!("unknown signal {other}")));
        }
    };
    let status = std::process::Command::new("kill")
        .args([flag, &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| CoreError::Message(format!("kill {pid}: {e}")))?;
    if status.success() || kind == "kill" {
        Ok(())
    } else {
        // ESRCH / already gone is fine for stop/kill paths.
        if !process_exists(pid) {
            return Ok(());
        }
        Err(CoreError::Message(format!(
            "kill {flag} {pid} failed ({status})"
        )))
    }
}

/// Signal a process and its descendants (deepest first for TERM/KILL).
fn signal_process_tree(root: u32, kind: &str) -> Result<(), CoreError> {
    let mut pids: Vec<u32> = list_descendant_processes(root)
        .into_iter()
        .map(|p| p.pid)
        .collect();
    pids.push(root);
    // Deepest first so children die before parents when terminating.
    pids.reverse();
    let mut last_err: Option<CoreError> = None;
    for pid in pids {
        if let Err(e) = signal_process(pid, kind) {
            last_err = Some(e);
        }
    }
    if process_exists(root) {
        if let Some(e) = last_err {
            return Err(e);
        }
    }
    Ok(())
}

/// Max auto-continue turns after max_tokens truncation (same task).
const MAX_TRUNCATION_AUTO_RETRIES: u8 = 6;

/// Build a continue prompt. Later attempts get stricter size limits.
/// Sent to the engine only; UI shows a short “续跑” label instead.
fn truncation_continue_prompt(attempt: u8) -> String {
    let max_lines = match attempt {
        1 => 80,
        2 => 50,
        3 => 35,
        _ => 25,
    };
    format!(
        "【自动续跑·接着写 #{attempt}】上一轮工具调用因单次输出长度限制被截断。\
这是同一任务的继续，不是新需求。\n\
\n\
硬性要求：\n\
1. 从已经完成的部分接着做，不要从头重做已成功步骤，也不要重新理解整题。\n\
2. 若目标文件已存在且不完整：用 search_replace / ApplyPatch / 追加写入补全。\n\
3. 若文件还不存在：先写开头一小段并保存，下一轮再追加。\n\
4. 本轮每个 Write/补丁最多约 {max_lines} 行；禁止一次输出整个大文件。\n\
5. 本轮只做下一步（一个小补丁），成功即可停。\n\
\n\
先看工作区已有文件与末尾内容，再继续。"
    )
}

fn looks_like_max_tokens_truncation(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("max_tokens_truncation")
        || lower.contains("truncated by max_tokens")
        || lower.contains("response truncated by max_tokens")
}

fn bridge_error_parts(err: &BridgeError) -> (String, Option<String>) {
    match err {
        BridgeError::Rpc {
            message, app_code, ..
        } => (message.clone(), app_code.clone()),
        other => (other.to_string(), None),
    }
}

/// Grok surfaces truncation as generic ACP `-32603 Internal error`; the real
/// reason is in `~/.grok/logs/unified.jsonl`.
fn recent_grok_log_max_tokens_truncation() -> bool {
    recent_grok_log_max_tokens_truncation_within(45)
}

fn recent_grok_log_max_tokens_truncation_within(max_age_secs: i64) -> bool {
    grok_log_max_tokens_truncation_since(Utc::now().timestamp() - max_age_secs)
}

/// True if a truncation log row exists with `ts >= since_unix` (inclusive).
fn grok_log_max_tokens_truncation_since(since_unix: i64) -> bool {
    let path = AppPaths::grok_cli_config()
        .parent()
        .map(|p| p.join("logs").join("unified.jsonl"))
        .unwrap_or_else(|| PathBuf::from(".grok/logs/unified.jsonl"));
    let Ok(raw) = std::fs::read(&path) else {
        return false;
    };
    // Tail ~64KiB to avoid scanning huge logs.
    let start = raw.len().saturating_sub(64 * 1024);
    let tail = String::from_utf8_lossy(&raw[start..]);
    for line in tail.lines().rev().take(80) {
        if !(line.contains("max_tokens_truncation")
            || line.contains("response truncated by max_tokens"))
        {
            continue;
        }
        // Prefer recent rows: `"ts":"2026-07-26T04:30:51.179Z"`
        if let Some(ts) = line
            .split("\"ts\":\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
        {
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(ts) {
                if parsed.timestamp() >= since_unix {
                    return true;
                }
                continue;
            }
        }
        // No/invalid ts but keyword present near end of file — accept once.
        return true;
    }
    false
}

#[cfg(test)]
mod session_process_tests {
    use super::*;

    #[test]
    fn parse_ps_line_basic() {
        let s = parse_ps_line(" 123  1 01:02 0.1 0.2 S /bin/sleep 10").unwrap();
        assert_eq!(s.pid, 123);
        assert_eq!(s.ppid, 1);
        assert_eq!(s.command, "/bin/sleep 10");
    }
}

