import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useI18n, type TFunction } from "../i18n";

type DepState =
  | "missing"
  | "downloading"
  | "paused"
  | "ready"
  | "error"
  | "unavailable";

type DepItem = {
  id: string;
  title: string;
  description: string;
  state: DepState;
  bytes_done: number;
  bytes_total: number | null;
  percent: number | null;
  message: string;
  local_path: string;
  resolved_url: string;
  size_on_disk: number | null;
};

type ActiveUrl = {
  id: string;
  title: string;
  url: string;
  from_cn: boolean;
  dep_id: string;
};

type Catalog = {
  prefer_cn: boolean;
  auto_download_on_startup: boolean;
  items: DepItem[];
  active_urls: ActiveUrl[];
  local_llm_blocked?: boolean;
};

type ProgressEvent = {
  id: string;
  state: DepState;
  bytes_done: number;
  bytes_total: number | null;
  percent: number | null;
  message: string;
};

type PublicSettings = {
  [key: string]: unknown;
};

type Props = {
  onSettingsPatched?: (s: PublicSettings) => void;
};

function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function stateLabel(state: DepState, t: TFunction): string {
  switch (state) {
    case "ready":
      return t("settings.depStateReady");
    case "downloading":
      return t("settings.depStateDownloading");
    case "paused":
      return t("settings.depStatePaused");
    case "error":
      return t("settings.depStateError");
    case "unavailable":
      return t("settings.depStateUnavailable");
    default:
      return t("settings.depStateMissing");
  }
}

export function DependenciesPanel({ onSettingsPatched }: Props) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoDownload, setAutoDownload] = useState(true);
  const [showUrls, setShowUrls] = useState(false);
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, ProgressEvent>>(
    {},
  );

  const refresh = useCallback(async () => {
    try {
      const c = await invoke<Catalog>("get_dependencies_catalog");
      setCatalog(c);
      setAutoDownload(c.auto_download_on_startup);
      const drafts: Record<string, string> = {};
      for (const row of c.active_urls || []) {
        drafts[row.id] = row.url;
      }
      setUrlDrafts(drafts);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<ProgressEvent>("dependency-progress", (ev) => {
        const p = ev.payload;
        setProgress((prev) => ({ ...prev, [p.id]: p }));
        if (p.state === "ready" || p.state === "error" || p.state === "paused") {
          void refresh();
        }
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  const saveAutoDownload = async (enabled: boolean) => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const s = await invoke<PublicSettings>("save_settings", {
        update: {
          dependency_auto_download_on_startup: enabled,
        },
      });
      onSettingsPatched?.(s);
      setAutoDownload(enabled);
      setMsg(t("settings.depSaved"));
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveActiveUrl = async (id: string) => {
    const next = (urlDrafts[id] ?? "").trim();
    const prev = catalog?.active_urls.find((u) => u.id === id)?.url ?? "";
    if (next === prev.trim()) return;
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const c = await invoke<Catalog>("set_dependency_download_url", {
        id,
        url: next,
      });
      setCatalog(c);
      setAutoDownload(c.auto_download_on_startup);
      const drafts: Record<string, string> = {};
      for (const row of c.active_urls || []) {
        drafts[row.id] = row.url;
      }
      setUrlDrafts(drafts);
      setMsg(t("settings.depUrlSaved"));
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDownload = async (id: string) => {
    setBusyId(id);
    setErr(null);
    setMsg(null);
    try {
      await invoke("start_dependency_download", { id });
      setMsg(t("settings.depDownloadStarted"));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onPause = async (id: string) => {
    setErr(null);
    setMsg(null);
    try {
      await invoke("pause_dependency_download", { id });
      setMsg(t("settings.depPaused"));
    } catch (e) {
      setErr(String(e));
    }
  };

  const onRedownload = async (id: string) => {
    setBusyId(id);
    setErr(null);
    setMsg(null);
    try {
      await invoke("redownload_dependency", { id });
      setMsg(t("settings.depDownloadStarted"));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (id: string) => {
    setBusyId(id);
    setErr(null);
    setMsg(null);
    try {
      await invoke("delete_dependency", { id });
      setProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setMsg(t("settings.depDeleted"));
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onDownloadAll = async () => {
    setBusyId("__all__");
    setErr(null);
    setMsg(null);
    try {
      const ids = await invoke<string[]>("download_all_missing_dependencies");
      setMsg(
        ids.length
          ? t("settings.depDownloadAllStarted").replace("{n}", String(ids.length))
          : t("settings.depNothingMissing"),
      );
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const items = catalog?.items ?? [];
  const activeUrls = catalog?.active_urls ?? [];

  return (
    <>
      <h1 className="settings-page-title">{t("settings.dependencies")}</h1>
      <p className="settings-page-lead">{t("settings.dependenciesLead")}</p>
      {catalog?.local_llm_blocked ? (
        <p className="settings-page-lead">{t("settings.depBonsaiSkipped")}</p>
      ) : null}

      <h2 className="settings-group-title">{t("settings.depPolicy")}</h2>
      <div className="settings-group-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t("settings.depAutoDownload")}</div>
            <div className="settings-row-desc">
              {t("settings.depAutoDownloadDesc")}
            </div>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={autoDownload}
              disabled={saving}
              onChange={(e) => void saveAutoDownload(e.target.checked)}
            />
            <span className="settings-toggle-ui" />
          </label>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t("settings.depDownloadMissing")}</div>
            <div className="settings-row-desc">{t("settings.depDownloadMissingDesc")}</div>
          </div>
          <div className="ext-item-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busyId !== null}
              onClick={() => void onDownloadAll()}
            >
              {busyId === "__all__"
                ? t("settings.depWorking")
                : t("settings.depDownloadMissing")}
            </button>
          </div>
        </div>
      </div>

      <h2 className="settings-group-title">{t("settings.depFiles")}</h2>
      <div className="settings-group-card ext-list">
        {items.map((item) => {
          const live = progress[item.id];
          const state = live?.state ?? item.state;
          const pct =
            live?.percent ??
            item.percent ??
            (state === "ready" ? 100 : null);
          const bytesDone = live?.bytes_done ?? item.bytes_done;
          const bytesTotal = live?.bytes_total ?? item.bytes_total;
          const message = live?.message || item.message;
          const downloading = state === "downloading";
          const paused = state === "paused";
          return (
            <div key={item.id} className="ext-item dep-item">
              <div className="ext-item-main">
                <div className="ext-item-title-row">
                  <span className="ext-item-title">{item.title}</span>
                  <span
                    className={`ext-badge${
                      state === "ready"
                        ? " ext-badge-on"
                        : state === "error"
                          ? " ext-badge-err"
                          : ""
                    }`}
                  >
                    {stateLabel(state, t)}
                  </span>
                </div>
                <div className="ext-item-desc">{item.description}</div>
                {(downloading || paused || message) && (
                  <div className="dep-progress-block">
                    <div className="dep-progress-track" aria-hidden>
                      <div
                        className={`dep-progress-fill${
                          downloading && pct == null ? " indeterminate" : ""
                        }`}
                        style={{
                          width:
                            pct != null
                              ? `${Math.min(100, Math.max(0, pct))}%`
                              : downloading
                                ? "30%"
                                : "0%",
                        }}
                      />
                    </div>
                    <div className="dep-progress-meta">
                      <span>
                        {pct != null ? `${pct.toFixed(0)}%` : "…"}
                        {bytesTotal
                          ? ` · ${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}`
                          : bytesDone
                            ? ` · ${formatBytes(bytesDone)}`
                            : ""}
                      </span>
                      {message ? (
                        <span className="dep-progress-msg">{message}</span>
                      ) : null}
                    </div>
                  </div>
                )}
                {state === "ready" && item.size_on_disk != null ? (
                  <div className="ext-item-meta">
                    <span>
                      {t("settings.depSize")}: {formatBytes(item.size_on_disk)}
                    </span>
                  </div>
                ) : null}
                <div className="ext-item-path">{item.local_path}</div>
              </div>
              <div className="ext-item-actions">
                {state === "missing" || state === "error" ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busyId !== null || downloading}
                    onClick={() => void onDownload(item.id)}
                  >
                    {t("settings.depDownload")}
                  </button>
                ) : null}
                {downloading ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId !== null}
                    onClick={() => void onPause(item.id)}
                  >
                    {t("settings.depPause")}
                  </button>
                ) : null}
                {paused ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busyId !== null}
                    onClick={() => void onDownload(item.id)}
                  >
                    {t("settings.depResume")}
                  </button>
                ) : null}
                {state === "ready" ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId !== null || downloading}
                    onClick={() => void onRedownload(item.id)}
                  >
                    {t("settings.depRedownload")}
                  </button>
                ) : null}
                {state === "ready" || state === "error" || paused ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId !== null || downloading}
                    onClick={() => void onDelete(item.id)}
                  >
                    {t("settings.depDelete")}
                  </button>
                ) : null}
                {state === "unavailable" ? (
                  <span className="ext-item-key-hint">
                    {t("settings.depNeedUrl")}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <h2 className="settings-group-title">
        <button
          type="button"
          className="settings-group-title-btn"
          onClick={() => setShowUrls((v) => !v)}
        >
          {t("settings.depUrls")} {showUrls ? "▾" : "▸"}
        </button>
      </h2>
      {showUrls ? (
        <div className="settings-group-card">
          {activeUrls.map((row) => (
            <div key={row.id} className="settings-row settings-row-stack">
              <div className="settings-row-text">
                <div className="settings-row-label">{row.title}</div>
              </div>
              <div className="ext-install-row">
                <input
                  className="settings-row-input ext-install-input"
                  value={urlDrafts[row.id] ?? row.url}
                  disabled={saving}
                  onChange={(e) =>
                    setUrlDrafts((prev) => ({
                      ...prev,
                      [row.id]: e.target.value,
                    }))
                  }
                  onBlur={() => void saveActiveUrl(row.id)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {(msg || err) && (
        <p className={err ? "settings-msg error" : "settings-msg"}>
          {err || msg}
        </p>
      )}
    </>
  );
}
