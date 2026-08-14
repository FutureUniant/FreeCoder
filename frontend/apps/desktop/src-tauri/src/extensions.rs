//! Extensions: built-in MCP status + flexible Skills install.
//!
//! Built-in MCP (bailian-media / filesystem / memory / fetch) are product
//! defaults — mounted at startup, not user-installable from this UI.
//! Skills accept free-form install strings (npx / ModelScope / bash / id).

use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use app_config::{
    mcp_server_configured, AppPaths, CnAccelerationSettings, UserSettings,
    BUILTIN_NPX_MCP, DEFAULT_MEDIA_MCP_SERVER_NAME,
};
use serde::{Deserialize, Serialize};

const MODELSCOPE_API: &str = "https://www.modelscope.cn/openapi/v1/skills";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltinMcpStatus {
    pub name: String,
    pub title: String,
    pub description: String,
    pub source: String,
    pub configured: bool,
    pub requires_api_key: bool,
    pub api_key_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledSkill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionsState {
    pub cn_acceleration: CnAccelerationSettings,
    pub builtin_mcp: Vec<BuiltinMcpStatus>,
    pub installed_skills: Vec<InstalledSkill>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Manifest {
    items: Vec<ManifestItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestItem {
    id: String,
    name: String,
    source: String,
    install_path: Option<String>,
    installed_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub id: String,
    pub message: String,
    pub install_path: Option<String>,
}

fn load_settings() -> UserSettings {
    let paths = AppPaths::discover().ok();
    if let Some(p) = paths {
        UserSettings::load(&p.config_file).unwrap_or_default()
    } else {
        UserSettings::default()
    }
}

fn manifest_path() -> Result<PathBuf, String> {
    let paths = AppPaths::discover().map_err(|e| e.to_string())?;
    paths.ensure_dirs().map_err(|e| e.to_string())?;
    Ok(paths.extensions_manifest_file())
}

fn load_manifest() -> Manifest {
    let Ok(path) = manifest_path() else {
        return Manifest::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Manifest::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_manifest(m: &Manifest) -> Result<(), String> {
    let path = manifest_path()?;
    let raw = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn now_iso() -> String {
    format!("{:?}", std::time::SystemTime::now())
}

fn builtin_mcp_status() -> Vec<BuiltinMcpStatus> {
    let mut out = vec![BuiltinMcpStatus {
        name: DEFAULT_MEDIA_MCP_SERVER_NAME.into(),
        title: "百炼媒体 (生图/生视频)".into(),
        description: "产品内置媒体 MCP，使用阿里云百炼 API Key。".into(),
        source: "bundled".into(),
        configured: mcp_server_configured(DEFAULT_MEDIA_MCP_SERVER_NAME),
        requires_api_key: true,
        api_key_hint: Some("设置 → 模型 → 阿里百炼".into()),
    }];
    for &(name, package, desc) in BUILTIN_NPX_MCP {
        out.push(BuiltinMcpStatus {
            name: name.into(),
            title: match name {
                "filesystem" => "Filesystem".into(),
                "memory" => "Memory".into(),
                "fetch" => "Fetch".into(),
                other => other.to_string(),
            },
            description: desc.into(),
            source: format!("npm:{package}"),
            configured: mcp_server_configured(name),
            requires_api_key: false,
            api_key_hint: None,
        });
    }
    out
}

fn parse_skill_frontmatter(md: &str) -> (Option<String>, Option<String>) {
    let trimmed = md.trim_start();
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    let rest = &trimmed[3..];
    let Some(end) = rest.find("\n---") else {
        return (None, None);
    };
    let yaml = &rest[..end];
    let mut name = None;
    let mut description = None;
    for line in yaml.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    (name, description)
}

fn list_installed_skills() -> Vec<InstalledSkill> {
    let root = AppPaths::grok_skills_dir();
    let manifest = load_manifest();
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&root) else {
        return out;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let raw = fs::read_to_string(&skill_md).unwrap_or_default();
        let (fm_name, fm_desc) = parse_skill_frontmatter(&raw);
        let folder = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("skill")
            .to_string();
        let name = fm_name.unwrap_or(folder);
        let description = fm_desc.unwrap_or_default();
        let source = manifest
            .items
            .iter()
            .find(|m| m.name == name || m.install_path.as_deref() == Some(path.to_string_lossy().as_ref()))
            .map(|m| m.source.clone());
        out.push(InstalledSkill {
            name,
            description,
            path: path.display().to_string(),
            source,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn get_state() -> Result<ExtensionsState, String> {
    let settings = load_settings();
    // Keep built-ins mounted when opening the panel (idempotent).
    let _ = app_config::ensure_default_builtin_mcps_in_grok_toml(Some(&settings.cn_acceleration));
    Ok(ExtensionsState {
        cn_acceleration: settings.cn_acceleration,
        builtin_mcp: builtin_mcp_status(),
        installed_skills: list_installed_skills(),
    })
}

/// What the free-form Skills install box resolved to.
#[derive(Debug, Clone)]
enum SkillSpec {
    /// ModelScope id like `@anthropics/skill-creator` or `owner/name`.
    ModelScopeId(String),
    /// Full ModelScope skills URL.
    ModelScopeUrl(String),
    /// GitHub tree / repo URL.
    GithubUrl(String),
    /// Arbitrary target for `npx skills add <target>`.
    NpxTarget(String),
}

fn strip_wrapping_quotes(s: &str) -> &str {
    let t = s.trim();
    if (t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\'')) {
        &t[1..t.len() - 1]
    } else {
        t
    }
}

/// Parse user input: full command, URL, or bare skill id.
fn parse_skill_input(raw: &str) -> Result<SkillSpec, String> {
    let input = raw.trim();
    if input.is_empty() {
        return Err("请输入 Skill 名称、URL 或安装命令".into());
    }

    // curl ... | bash -s -- <id>
    if let Some(idx) = input.find("bash -s --") {
        let after = input[idx + "bash -s --".len()..].trim();
        let id = after
            .split_whitespace()
            .next()
            .map(strip_wrapping_quotes)
            .filter(|s| !s.is_empty());
        if let Some(id) = id {
            return Ok(SkillSpec::ModelScopeId(id.to_string()));
        }
    }
    if input.contains("install.sh") {
        // trailing token often the skill id
        if let Some(id) = input
            .split_whitespace()
            .rev()
            .find(|t| t.contains('/') || t.starts_with('@'))
            .map(strip_wrapping_quotes)
        {
            return Ok(SkillSpec::ModelScopeId(id.to_string()));
        }
    }

    // modelscope skills add <id>
    if let Some(rest) = input
        .find("skills add")
        .map(|i| input[i + "skills add".len()..].trim())
    {
        // Could be `npx skills add` or `modelscope skills add`
        let target = rest
            .split_whitespace()
            .find(|t| !t.starts_with('-'))
            .map(strip_wrapping_quotes)
            .ok_or_else(|| "未能从命令中解析 Skill 目标".to_string())?;
        if target.contains("modelscope.cn/skills") {
            return Ok(SkillSpec::ModelScopeUrl(target.to_string()));
        }
        if target.contains("github.com") {
            return Ok(SkillSpec::GithubUrl(target.to_string()));
        }
        if input.contains("npx") {
            return Ok(SkillSpec::NpxTarget(target.to_string()));
        }
        // modelscope CLI → treat as ModelScope id
        return Ok(SkillSpec::ModelScopeId(target.to_string()));
    }

    // Bare URL
    if input.starts_with("http://") || input.starts_with("https://") {
        if input.contains("modelscope.cn/skills") {
            return Ok(SkillSpec::ModelScopeUrl(input.to_string()));
        }
        if input.contains("github.com") {
            return Ok(SkillSpec::GithubUrl(input.to_string()));
        }
        return Ok(SkillSpec::NpxTarget(input.to_string()));
    }

    // Bare id: @owner/name or owner/name (optionally with spaces stripped)
    let id = strip_wrapping_quotes(input);
    if id.contains('/') || id.starts_with('@') {
        return Ok(SkillSpec::ModelScopeId(id.to_string()));
    }

    Err(
        "无法识别输入。支持：Skill 名称、ModelScope/GitHub URL，或 npx / modelscope / bash 安装命令"
            .into(),
    )
}

fn modelscope_id_from_url(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if let Some(rest) = u.split("/skills/").nth(1) {
        return rest.trim_start_matches('/').to_string();
    }
    u.to_string()
}

fn skill_folder_name(id_or_name: &str) -> String {
    id_or_name
        .trim()
        .trim_start_matches('@')
        .rsplit('/')
        .next()
        .unwrap_or(id_or_name)
        .trim()
        .replace(['\\', ':', '*', '?', '"', '<', '>', '|'], "-")
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("grokx-desktop/extensions")
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct MsSkillDetailResp {
    #[allow(dead_code)]
    success: Option<bool>,
    data: Option<MsSkillDetail>,
}

#[derive(Debug, Deserialize)]
struct MsSkillDetail {
    #[allow(dead_code)]
    id: Option<String>,
    #[allow(dead_code)]
    display_name: Option<String>,
    source_url: Option<String>,
    #[allow(dead_code)]
    install_command: Option<Vec<String>>,
}

fn fetch_modelscope_detail(skill_id: &str) -> Result<MsSkillDetail, String> {
    let client = http_client()?;
    let url = format!(
        "{MODELSCOPE_API}/{}",
        skill_id.trim().trim_start_matches('/')
    );
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("ModelScope API HTTP {}", resp.status()));
    }
    let body: MsSkillDetailResp = resp.json().map_err(|e| e.to_string())?;
    body.data
        .ok_or_else(|| "ModelScope skill detail missing".into())
}

fn parse_github_tree_url(url: &str) -> Option<(String, String, String, String)> {
    let u = url.trim().trim_end_matches('/');
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("http://github.com/"))?;
    let mut parts = rest.split('/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if parts.next() != Some("tree") {
        return Some((owner, repo, "main".into(), String::new()));
    }
    let git_ref = parts.next().unwrap_or("main").to_string();
    let sub: Vec<&str> = parts.collect();
    Some((owner, repo, git_ref, sub.join("/")))
}

fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = http_client()?;
    let resp = client.get(url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {} for {url}", resp.status()));
    }
    resp.bytes()
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string())
}

fn extract_zip_subdir(zip_bytes: &[u8], subpath: &str, dest: &Path) -> Result<(), String> {
    let reader = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    let sub = subpath.trim_matches('/');
    let mut matched_prefix: Option<String> = None;

    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        if !sub.is_empty() {
            if name.contains(&format!("/{sub}/")) || name.ends_with(&format!("/{sub}")) {
                if let Some(idx) = name.find(&format!("/{sub}")) {
                    matched_prefix = Some(format!("{}/{sub}", &name[..idx]));
                    break;
                }
            }
            if name.contains(sub) && name.ends_with("SKILL.md") {
                if let Some(parent) = Path::new(&name).parent() {
                    matched_prefix = Some(parent.to_string_lossy().replace('\\', "/"));
                    break;
                }
            }
        }
    }

    let reader = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;

    let prefix = if let Some(p) = matched_prefix {
        p.trim_matches('/').to_string()
    } else if sub.is_empty() {
        let mut root = String::new();
        for i in 0..archive.len() {
            let file = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = file.name().replace('\\', "/");
            if let Some((first, _)) = name.split_once('/') {
                root = first.to_string();
                break;
            }
        }
        root
    } else {
        return Err(format!(
            "SKILL path '{sub}' not found inside GitHub archive"
        ));
    };

    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        let Some(rel) = name.strip_prefix(&prefix).map(|s| s.trim_start_matches('/')) else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let out_path = dest.join(rel);
        if file.is_dir() || name.ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        outfile.write_all(&buf).map_err(|e| e.to_string())?;
    }

    if !dest.join("SKILL.md").is_file() {
        if let Ok(rd) = fs::read_dir(dest) {
            for ent in rd.flatten() {
                let p = ent.path();
                if p.join("SKILL.md").is_file() {
                    let tmp = dest.with_extension("hoist-tmp");
                    if tmp.exists() {
                        let _ = fs::remove_dir_all(&tmp);
                    }
                    fs::rename(&p, &tmp).map_err(|e| e.to_string())?;
                    for leftover in fs::read_dir(dest).map_err(|e| e.to_string())?.flatten() {
                        let lp = leftover.path();
                        if lp.is_dir() {
                            let _ = fs::remove_dir_all(&lp);
                        } else {
                            let _ = fs::remove_file(&lp);
                        }
                    }
                    for ent in fs::read_dir(&tmp).map_err(|e| e.to_string())?.flatten() {
                        let from = ent.path();
                        let to = dest.join(ent.file_name());
                        fs::rename(&from, &to).map_err(|e| e.to_string())?;
                    }
                    let _ = fs::remove_dir_all(&tmp);
                    break;
                }
            }
        }
    }

    if !dest.join("SKILL.md").is_file() {
        return Err("extracted skill is missing SKILL.md".into());
    }
    Ok(())
}

fn install_skill_from_github(
    source_url: &str,
    dest: &Path,
    cn: &CnAccelerationSettings,
) -> Result<(), String> {
    let (owner, repo, git_ref, subpath) = parse_github_tree_url(source_url)
        .ok_or_else(|| format!("unsupported GitHub URL: {source_url}"))?;
    let zip_url = format!("https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{git_ref}");
    let proxied = cn.proxied_github_url(&zip_url);
    let bytes = download_bytes(&proxied).or_else(|_| download_bytes(&zip_url))?;
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| e.to_string())?;
    }
    extract_zip_subdir(&bytes, &subpath, dest)
}

fn apply_cn_env(cmd: &mut Command, cn: &CnAccelerationSettings) {
    for (k, v) in cn.install_env_vars() {
        cmd.env(k, v);
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for ent in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = ent.path();
        let to = dest.join(ent.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_recent_skill_dir(want: &str) -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let candidates = [
        home.join(".cursor").join("skills"),
        home.join(".agents").join("skills"),
        home.join(".claude").join("skills"),
        home.join(".grok").join("skills"),
    ];
    for root in candidates {
        if !root.is_dir() {
            continue;
        }
        if let Ok(rd) = fs::read_dir(&root) {
            for ent in rd.flatten() {
                let p = ent.path();
                if !p.join("SKILL.md").is_file() {
                    continue;
                }
                let name = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if name == want || name.contains(want) || want.ends_with(&name) {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn run_npx_skills_add(target: &str, cn: &CnAccelerationSettings) -> Result<(), String> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npx");
        c
    } else {
        Command::new("npx")
    };
    apply_cn_env(&mut cmd, cn);
    cmd.args([
        "-y",
        "skills",
        "add",
        target,
        "--yes",
        "--copy",
        "--global",
        "--agent",
        "cursor",
    ]);
    let output = cmd.output().map_err(|e| {
        format!("failed to run npx skills (is Node.js installed?): {e}")
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "npx skills add failed: {}\n{stdout}\n{stderr}",
            output.status
        ));
    }
    Ok(())
}

fn try_modelscope_cli_add(skill_id: &str, cn: &CnAccelerationSettings) -> Result<(), String> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("modelscope");
        c
    } else {
        Command::new("modelscope")
    };
    apply_cn_env(&mut cmd, cn);
    cmd.args(["skills", "add", skill_id]);
    let output = cmd
        .output()
        .map_err(|e| format!("modelscope CLI unavailable: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("modelscope skills add failed: {stderr}"));
    }
    Ok(())
}

fn relocate_to_grok_skills(want_name: &str, dest: &Path) -> Result<(), String> {
    let src = find_recent_skill_dir(want_name)
        .ok_or_else(|| "安装完成但未在 ~/.cursor/skills 等目录找到 Skill".to_string())?;
    if src == dest {
        return Ok(());
    }
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(&src, dest)?;
    Ok(())
}

fn install_modelscope_skill(
    skill_id: &str,
    dest: &Path,
    cn: &CnAccelerationSettings,
) -> Result<String, String> {
    let folder = skill_folder_name(skill_id);
    let dest = if dest.file_name().and_then(|s| s.to_str()) == Some(folder.as_str()) {
        dest.to_path_buf()
    } else {
        AppPaths::grok_skills_dir().join(&folder)
    };
    fs::create_dir_all(AppPaths::grok_skills_dir()).map_err(|e| e.to_string())?;

    let detail = fetch_modelscope_detail(skill_id).ok();
    let mut last_err = String::new();

    if let Some(ref d) = detail {
        if let Some(ref src) = d.source_url {
            if src.contains("github.com") {
                match install_skill_from_github(src, &dest, cn) {
                    Ok(()) => return Ok(dest.display().to_string()),
                    Err(e) => last_err = e,
                }
            }
        }
    }

    // Prefer ModelScope SDK when present.
    match try_modelscope_cli_add(skill_id, cn) {
        Ok(()) => {
            relocate_to_grok_skills(&folder, &dest)?;
            return Ok(dest.display().to_string());
        }
        Err(e) => {
            if last_err.is_empty() {
                last_err = e;
            } else {
                last_err = format!("{last_err}; {e}");
            }
        }
    }

    let url = cn.modelscope_skill_url(skill_id);
    match run_npx_skills_add(&url, cn) {
        Ok(()) => {
            relocate_to_grok_skills(&folder, &dest)?;
            Ok(dest.display().to_string())
        }
        Err(e) => Err(format!(
            "安装 '{skill_id}' 失败。{last_err}; npx: {e}"
        )),
    }
}

pub fn install_skill_from_input(raw: &str) -> Result<InstallResult, String> {
    let settings = load_settings();
    let cn = settings.cn_acceleration.clone();
    let spec = parse_skill_input(raw)?;
    let skills_root = AppPaths::grok_skills_dir();
    fs::create_dir_all(&skills_root).map_err(|e| e.to_string())?;

    let (id, source_label, path) = match spec {
        SkillSpec::ModelScopeId(id) => {
            let dest = skills_root.join(skill_folder_name(&id));
            let path = install_modelscope_skill(&id, &dest, &cn)?;
            (id.clone(), format!("modelscope:{id}"), path)
        }
        SkillSpec::ModelScopeUrl(url) => {
            let id = modelscope_id_from_url(&url);
            let dest = skills_root.join(skill_folder_name(&id));
            let path = install_modelscope_skill(&id, &dest, &cn)?;
            (id.clone(), url, path)
        }
        SkillSpec::GithubUrl(url) => {
            let folder = parse_github_tree_url(&url)
                .map(|(_, _, _, sub)| {
                    if sub.is_empty() {
                        "skill".into()
                    } else {
                        skill_folder_name(&sub)
                    }
                })
                .unwrap_or_else(|| "skill".into());
            let dest = skills_root.join(&folder);
            install_skill_from_github(&url, &dest, &cn)?;
            (folder.clone(), url, dest.display().to_string())
        }
        SkillSpec::NpxTarget(target) => {
            let folder = if target.contains("modelscope.cn/skills") {
                skill_folder_name(&modelscope_id_from_url(&target))
            } else {
                skill_folder_name(
                    target
                        .trim_end_matches('/')
                        .rsplit('/')
                        .next()
                        .unwrap_or("skill"),
                )
            };
            let dest = skills_root.join(&folder);
            run_npx_skills_add(&target, &cn)?;
            relocate_to_grok_skills(&folder, &dest)?;
            (folder.clone(), format!("npx:{target}"), dest.display().to_string())
        }
    };

    let mut manifest = load_manifest();
    let mid = format!("skill:{id}");
    manifest.items.retain(|m| m.id != mid && m.name != id);
    manifest.items.push(ManifestItem {
        id: mid.clone(),
        name: id.clone(),
        source: source_label,
        install_path: Some(path.clone()),
        installed_at: now_iso(),
    });
    save_manifest(&manifest)?;

    Ok(InstallResult {
        id: mid,
        message: format!("已安装到 {path}"),
        install_path: Some(path),
    })
}

pub fn uninstall_skill_impl(name: &str) -> Result<InstallResult, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("skill name required".into());
    }
    let skills = list_installed_skills();
    let item = skills
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("未找到已安装 Skill: {name}"))?;
    let path = PathBuf::from(&item.path);
    let root = AppPaths::grok_skills_dir();
    if !path.starts_with(&root) {
        return Err("拒绝删除非 ~/.grok/skills 下的路径".into());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    let mut manifest = load_manifest();
    manifest
        .items
        .retain(|m| m.name != name && m.install_path.as_deref() != Some(item.path.as_str()));
    save_manifest(&manifest)?;
    Ok(InstallResult {
        id: format!("skill:{name}"),
        message: format!("已卸载 '{name}'"),
        install_path: None,
    })
}

#[tauri::command]
pub fn get_extensions_catalog() -> Result<ExtensionsState, String> {
    get_state()
}

#[tauri::command]
pub async fn install_skill(query: String) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || install_skill_from_input(&query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn uninstall_skill(name: String) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || uninstall_skill_impl(&name))
        .await
        .map_err(|e| e.to_string())?
}

// Keep old command names as thin aliases so a partial frontend reload won't hard-crash.
#[tauri::command]
pub async fn install_extension(id: String) -> Result<InstallResult, String> {
    install_skill(id).await
}

#[tauri::command]
pub async fn uninstall_extension(id: String) -> Result<InstallResult, String> {
    let name = id
        .strip_prefix("skill:")
        .unwrap_or(&id)
        .trim()
        .to_string();
    uninstall_skill(name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bare_id() {
        match parse_skill_input("@anthropics/skill-creator").unwrap() {
            SkillSpec::ModelScopeId(id) => assert_eq!(id, "@anthropics/skill-creator"),
            _ => panic!("expected ModelScopeId"),
        }
    }

    #[test]
    fn parse_npx_command() {
        match parse_skill_input(
            "npx skills add https://modelscope.cn/skills/@anthropics/skill-creator",
        )
        .unwrap()
        {
            SkillSpec::NpxTarget(t) | SkillSpec::ModelScopeUrl(t) => {
                assert!(t.contains("modelscope.cn/skills"));
            }
            SkillSpec::ModelScopeId(id) => assert!(id.contains("skill-creator")),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parse_bash_install() {
        match parse_skill_input(
            "curl -fsSL https://modelscope.cn/skills/install.sh | bash -s -- @Alipay/alipay-payment-integration",
        )
        .unwrap()
        {
            SkillSpec::ModelScopeId(id) => {
                assert_eq!(id, "@Alipay/alipay-payment-integration");
            }
            _ => panic!("expected ModelScopeId"),
        }
    }

    #[test]
    fn parse_modelscope_cli() {
        match parse_skill_input("modelscope skills add PantherAng/alipay-payment-integration")
            .unwrap()
        {
            SkillSpec::ModelScopeId(id) => {
                assert_eq!(id, "PantherAng/alipay-payment-integration");
            }
            _ => panic!("expected ModelScopeId"),
        }
    }

    #[test]
    fn parse_github_tree() {
        let (o, r, rf, sub) = parse_github_tree_url(
            "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator/skills/skill-creator",
        )
        .unwrap();
        assert_eq!(o, "anthropics");
        assert_eq!(r, "claude-plugins-official");
        assert_eq!(rf, "main");
        assert!(sub.ends_with("skill-creator"));
    }
}
