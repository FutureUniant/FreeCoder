import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";

export type CnAcceleration = {
  enabled: boolean;
  npm_registry: string;
  pypi_index: string;
  github_proxy: string;
  modelscope_skills_base: string;
};

type BuiltinMcp = {
  name: string;
  title: string;
  description: string;
  source: string;
  configured: boolean;
  requires_api_key: boolean;
  api_key_hint?: string | null;
};

type InstalledSkill = {
  name: string;
  description: string;
  path: string;
  source?: string | null;
};

type ExtensionsState = {
  cn_acceleration: CnAcceleration;
  builtin_mcp: BuiltinMcp[];
  installed_skills: InstalledSkill[];
};

type InstallResult = {
  id: string;
  message: string;
  install_path?: string | null;
};

type PublicSettings = {
  cn_acceleration?: CnAcceleration | null;
  [key: string]: unknown;
};

type Props = {
  onSettingsPatched?: (s: PublicSettings) => void;
};

export function ExtensionsPanel({ onSettingsPatched }: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<ExtensionsState | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cnEnabled, setCnEnabled] = useState(true);
  const [npmRegistry, setNpmRegistry] = useState(
    "https://registry.npmmirror.com",
  );
  const [pypiIndex, setPypiIndex] = useState(
    "https://pypi.tuna.tsinghua.edu.cn/simple",
  );
  const [githubProxy, setGithubProxy] = useState("https://ghproxy.net/");
  const [msBase, setMsBase] = useState("https://modelscope.cn/skills");
  const [savingCn, setSavingCn] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<ExtensionsState>("get_extensions_catalog");
      setState(s);
      const cn = s.cn_acceleration;
      setCnEnabled(cn.enabled);
      setNpmRegistry(cn.npm_registry);
      setPypiIndex(cn.pypi_index);
      setGithubProxy(cn.github_proxy);
      setMsBase(cn.modelscope_skills_base);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveCn = async (patch: {
    enabled?: boolean;
    npm?: string;
    pypi?: string;
    github?: string;
    ms?: string;
  }) => {
    setSavingCn(true);
    setMsg(null);
    setErr(null);
    try {
      const s = await invoke<PublicSettings>("save_settings", {
        update: {
          cn_acceleration_enabled: patch.enabled,
          cn_npm_registry: patch.npm,
          cn_pypi_index: patch.pypi,
          cn_github_proxy: patch.github,
          cn_modelscope_skills_base: patch.ms,
        },
      });
      onSettingsPatched?.(s);
      if (typeof patch.enabled === "boolean") setCnEnabled(patch.enabled);
      if (patch.npm) setNpmRegistry(patch.npm);
      if (patch.pypi) setPypiIndex(patch.pypi);
      if (patch.github !== undefined) setGithubProxy(patch.github);
      if (patch.ms) setMsBase(patch.ms);
      setMsg(t("settings.extCnSaved"));
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSavingCn(false);
    }
  };

  const onInstallSkill = async () => {
    const q = skillQuery.trim();
    if (!q || busy) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await invoke<InstallResult>("install_skill", { query: q });
      setMsg(r.message);
      setSkillQuery("");
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUninstallSkill = async (name: string) => {
    setBusyName(name);
    setMsg(null);
    setErr(null);
    try {
      const r = await invoke<InstallResult>("uninstall_skill", { name });
      setMsg(r.message);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyName(null);
    }
  };

  return (
    <>
      <h1 className="settings-page-title">{t("settings.extensions")}</h1>
      <p className="settings-page-lead">{t("settings.extensionsLead")}</p>

      <h2 className="settings-group-title">{t("settings.extCnTitle")}</h2>
      <div className="settings-group-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t("settings.extCnEnable")}</div>
            <div className="settings-row-desc">{t("settings.extCnEnableDesc")}</div>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={cnEnabled}
              disabled={savingCn}
              onChange={(e) => void saveCn({ enabled: e.target.checked })}
            />
            <span className="settings-toggle-ui" />
          </label>
        </div>
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <div className="settings-row-label">{t("settings.extCnNpm")}</div>
            <div className="settings-row-desc">{t("settings.extCnNpmDesc")}</div>
          </div>
          <input
            className="settings-row-input"
            value={npmRegistry}
            disabled={!cnEnabled || savingCn}
            onChange={(e) => setNpmRegistry(e.target.value)}
            onBlur={() => void saveCn({ npm: npmRegistry })}
          />
        </div>
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <div className="settings-row-label">{t("settings.extCnPypi")}</div>
            <div className="settings-row-desc">{t("settings.extCnPypiDesc")}</div>
          </div>
          <input
            className="settings-row-input"
            value={pypiIndex}
            disabled={!cnEnabled || savingCn}
            onChange={(e) => setPypiIndex(e.target.value)}
            onBlur={() => void saveCn({ pypi: pypiIndex })}
          />
        </div>
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <div className="settings-row-label">{t("settings.extCnGithub")}</div>
            <div className="settings-row-desc">
              {t("settings.extCnGithubDesc")}
            </div>
          </div>
          <input
            className="settings-row-input"
            value={githubProxy}
            disabled={!cnEnabled || savingCn}
            onChange={(e) => setGithubProxy(e.target.value)}
            onBlur={() => void saveCn({ github: githubProxy })}
          />
        </div>
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <div className="settings-row-label">{t("settings.extCnModelScope")}</div>
            <div className="settings-row-desc">
              {t("settings.extCnModelScopeDesc")}
            </div>
          </div>
          <input
            className="settings-row-input"
            value={msBase}
            disabled={!cnEnabled || savingCn}
            onChange={(e) => setMsBase(e.target.value)}
            onBlur={() => void saveCn({ ms: msBase })}
          />
        </div>
      </div>

      <h2 className="settings-group-title">{t("settings.mcp")}</h2>
      <p className="settings-page-lead">{t("settings.mcpBuiltinDesc")}</p>
      <div className="settings-group-card ext-list">
        {(state?.builtin_mcp || []).map((item) => (
          <div key={item.name} className="ext-item">
            <div className="ext-item-main">
              <div className="ext-item-title-row">
                <span className="ext-item-title">{item.title}</span>
                <span className="ext-badge ext-badge-on">
                  {t("settings.extSystem")}
                </span>
                {item.configured ? (
                  <span className="ext-badge ext-badge-on">
                    {t("settings.extMounted")}
                  </span>
                ) : (
                  <span className="ext-badge">{t("settings.extMountPending")}</span>
                )}
              </div>
              <div className="ext-item-desc">{item.description}</div>
              <div className="ext-item-meta">
                <span>{item.source}</span>
                {item.requires_api_key ? (
                  <span className="ext-item-key-hint">
                    {t("settings.extNeedsKey")}
                    {item.api_key_hint ? ` · ${item.api_key_hint}` : ""}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      <h2 className="settings-group-title">{t("settings.skills")}</h2>
      <p className="settings-page-lead">{t("settings.skillsInstallDesc")}</p>
      <div className="settings-group-card">
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <div className="settings-row-label">{t("settings.skillsInstallLabel")}</div>
            <div className="settings-row-desc">
              {t("settings.skillsInstallHint")}
            </div>
          </div>
          <div className="ext-install-row">
            <input
              className="settings-row-input ext-install-input"
              value={skillQuery}
              disabled={busy}
              placeholder={t("settings.skillsInstallPlaceholder")}
              onChange={(e) => setSkillQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onInstallSkill();
                }
              }}
            />
            <button
              type="button"
              className="btn primary"
              disabled={busy || !skillQuery.trim()}
              onClick={() => void onInstallSkill()}
            >
              {busy ? t("settings.extInstalling") : t("settings.extInstall")}
            </button>
          </div>
        </div>
      </div>

      {(msg || err) && (
        <p className={err ? "settings-msg error" : "settings-msg"}>
          {err || msg}
        </p>
      )}

      <h2 className="settings-group-title">{t("settings.skillsInstalled")}</h2>
      <div className="settings-group-card ext-list">
        {(state?.installed_skills || []).length === 0 ? (
          <div className="ext-item">
            <div className="ext-item-desc">{t("settings.skillsInstalledEmpty")}</div>
          </div>
        ) : (
          (state?.installed_skills || []).map((item) => (
            <div key={item.path} className="ext-item">
              <div className="ext-item-main">
                <div className="ext-item-title-row">
                  <span className="ext-item-title">{item.name}</span>
                  <span className="ext-badge ext-badge-on">
                    {t("settings.extInstalled")}
                  </span>
                </div>
                {item.description ? (
                  <div className="ext-item-desc">{item.description}</div>
                ) : null}
                <div className="ext-item-meta">
                  {item.source ? <span>{item.source}</span> : null}
                </div>
                <div className="ext-item-path">{item.path}</div>
              </div>
              <div className="ext-item-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || busyName === item.name}
                  onClick={() => void onUninstallSkill(item.name)}
                >
                  {busyName === item.name
                    ? t("settings.extUninstalling")
                    : t("settings.extUninstall")}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
