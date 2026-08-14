import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "../i18n";
import {
  pickKeyFromText,
  readKeyFromClipboard,
  type GetKeyPlatformId,
} from "../lib/getApiKeyUtil";

type WizardPhase = "intro" | "running" | "done" | "failed";

interface SidecarEvent {
  type: string;
  step?: string;
  message?: string;
  key?: string;
  recoverable?: boolean;
  cancelled?: boolean;
  failed?: boolean;
  level?: string;
  runId?: number;
}

interface Props {
  platform: GetKeyPlatformId;
  platformLabel: string;
  onSuccess: (apiKey: string) => void | Promise<void>;
  onClose: () => void;
}

function looksLikeBrowserMissing(msg: string): boolean {
  return /playwright install|Executable doesn't exist|未找到可用的 Chromium|无法启动浏览器|setup:api-key|getkey:browsers/i.test(
    msg,
  );
}

export function GetApiKeyWizard({
  platform,
  platformLabel,
  onSuccess,
  onClose,
}: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<WizardPhase>("intro");
  const [status, setStatus] = useState(t("getApiKey.introStatus"));
  const [waitingLogin, setWaitingLogin] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [manualKey, setManualKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [runNonce, setRunNonce] = useState(0);
  const runActiveRef = useRef(false);
  const appliedRef = useRef(false);

  const pushLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg].slice(-40));
  }, []);

  const normalizeError = useCallback(
    (raw: string) => {
      if (looksLikeBrowserMissing(raw)) {
        return t("getApiKey.browserMissing");
      }
      return raw;
    },
    [t],
  );

  const applyKey = useCallback(
    async (key: string) => {
      const k = key.trim();
      if (!k.startsWith("sk-") || k.length < 16) {
        pushLog(t("getApiKey.ignoreInvalid", { n: k.length }));
        return;
      }
      if (appliedRef.current) return;
      appliedRef.current = true;
      runActiveRef.current = false;
      setManualKey(k);
      setPhase("done");
      setWaitingLogin(false);
      setError(null);
      setStatus(t("getApiKey.done"));
      pushLog(t("getApiKey.filled", { n: k.length }));
      setSaving(true);
      try {
        await onSuccess(k);
      } catch (e) {
        setError(String(e));
        setPhase("failed");
      } finally {
        setSaving(false);
      }
    },
    [onSuccess, pushLog, t],
  );

  // Start / restart agent only after user confirms the intro.
  useEffect(() => {
    if (phase !== "running") return;

    runActiveRef.current = true;
    appliedRef.current = false;
    void (async () => {
      try {
        await invoke("cancel_get_key");
      } catch {
        /* ignore */
      }
      try {
        await invoke("start_get_key", { platform });
      } catch (e) {
        runActiveRef.current = false;
        setError(normalizeError(String(e)));
        setPhase("failed");
      }
    })();
    return () => {
      runActiveRef.current = false;
      void invoke("cancel_get_key").catch(() => {});
    };
  }, [phase, platform, runNonce, normalizeError]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<SidecarEvent>("sidecar-event", async (ev) => {
      const data = ev.payload;
      if (data.message) {
        pushLog(
          data.level === "stderr"
            ? `[stderr] ${data.message}`
            : data.message,
        );
      }

      const keyFromPayload =
        data.key && String(data.key).trim()
          ? String(data.key).trim()
          : data.type === "key_extracted" || data.type === "done"
            ? pickKeyFromText(data.message || "")
            : null;
      if (
        keyFromPayload &&
        keyFromPayload.startsWith("sk-") &&
        keyFromPayload.length >= 16 &&
        (data.type === "key_extracted" || data.type === "done" || !!data.key)
      ) {
        await applyKey(keyFromPayload);
      }

      switch (data.type) {
        case "waiting_login":
        case "need_user_action":
          setWaitingLogin(true);
          setStatus(data.message || t("getApiKey.pleaseLoginAuto"));
          break;
        case "status": {
          setStatus(data.message || data.step || "");
          const msg = data.message || "";
          if (data.step === "wait_login" || data.step === "user_action") {
            if (/已检测|已手动确认|开始自动创建/.test(msg)) {
              setWaitingLogin(false);
            } else {
              setWaitingLogin(true);
            }
            break;
          }
          if (
            data.step === "extract" ||
            data.step === "auto_click" ||
            data.step === "modal_confirm" ||
            data.step === "dismiss_modal" ||
            data.step === "auto_fill" ||
            data.step === "sleep" ||
            (data.step === "navigate" &&
              /正在进入|进入 API|管理页/.test(msg))
          ) {
            setWaitingLogin(false);
          }
          break;
        }
        case "done":
          if (data.failed || data.cancelled) {
            if (!appliedRef.current) {
              runActiveRef.current = false;
              const clipKey = await readKeyFromClipboard();
              if (clipKey) {
                await applyKey(clipKey);
                pushLog(t("getApiKey.fromClipboard"));
                break;
              }
              setError(
                normalizeError(
                  data.message ||
                    (data.cancelled
                      ? t("getApiKey.cancelled")
                      : t("getApiKey.failed")),
                ),
              );
              setPhase("failed");
            }
          }
          break;
        case "error":
          setError(normalizeError(data.message || t("getApiKey.unknownError")));
          setStatus(data.message || t("getApiKey.error"));
          break;
        case "browser_closed":
        case "sidecar_exited":
          if (runActiveRef.current && !appliedRef.current) {
            runActiveRef.current = false;
            const clipKey = await readKeyFromClipboard();
            if (clipKey) {
              await applyKey(clipKey);
              pushLog(t("getApiKey.fromClipboard"));
              break;
            }
            setError((prev) =>
              prev && looksLikeBrowserMissing(prev)
                ? prev
                : normalizeError(prev || t("getApiKey.extractFailed")),
            );
            setPhase("failed");
          }
          break;
        default:
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [applyKey, normalizeError, pushLog, t]);

  useEffect(() => {
    if (phase !== "running" && phase !== "failed") return;
    if (manualKey.trim().startsWith("sk-") && manualKey.trim().length >= 16) {
      return;
    }
    let stopped = false;
    const tick = async () => {
      if (stopped || appliedRef.current) return;
      try {
        const key = await invoke<string | null>("poll_extracted_key");
        if (key && key.startsWith("sk-") && key.length >= 16) {
          await applyKey(key);
        }
      } catch {
        /* ignore */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 400);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [phase, manualKey, applyKey]);

  const onContinue = async () => {
    setWaitingLogin(false);
    setStatus(t("getApiKey.continuing"));
    pushLog(t("getApiKey.continueClicked"));
    try {
      const clipKey = await readKeyFromClipboard();
      if (clipKey) {
        setManualKey(clipKey);
        pushLog(t("getApiKey.prefillClipboard"));
      }
    } catch {
      /* ignore */
    }
    try {
      await invoke("continue_get_key");
    } catch (e) {
      setError(normalizeError(String(e)));
      setPhase("failed");
      return;
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (appliedRef.current) break;
      try {
        const key = await invoke<string | null>("poll_extracted_key");
        if (key && key.startsWith("sk-") && key.length >= 16) {
          await applyKey(key);
          break;
        }
      } catch {
        /* ignore */
      }
    }
  };

  const onStart = () => {
    appliedRef.current = false;
    runActiveRef.current = true;
    setError(null);
    setManualKey("");
    setLogs([]);
    setWaitingLogin(false);
    setSaving(false);
    setStatus(t("getApiKey.starting"));
    setPhase("running");
    setRunNonce((n) => n + 1);
  };

  const onCancel = async () => {
    runActiveRef.current = false;
    try {
      await invoke("cancel_get_key");
    } catch {
      /* ignore */
    }
    onClose();
  };

  const onRetry = () => {
    appliedRef.current = false;
    runActiveRef.current = false;
    setWaitingLogin(false);
    setError(null);
    setManualKey("");
    setLogs([]);
    setSaving(false);
    setStatus(t("getApiKey.introStatus"));
    setPhase("intro");
  };

  const onSaveManual = async () => {
    const key = manualKey.trim();
    if (!key.startsWith("sk-") || key.length < 16) {
      setError(t("getApiKey.manualInvalid"));
      return;
    }
    appliedRef.current = false;
    await applyKey(key);
  };

  const onPasteClipboard = async () => {
    const clipKey = await readKeyFromClipboard();
    if (clipKey) {
      setManualKey(clipKey);
      setError(null);
    } else {
      setError(t("getApiKey.clipboardEmpty"));
    }
  };

  const browserMissing = Boolean(error && looksLikeBrowserMissing(error));

  return (
    <div className="getkey-overlay" role="dialog" aria-modal="true">
      <div className="getkey-modal">
        <header className="getkey-modal-header">
          <div>
            <h3 className="getkey-modal-title">
              {t("getApiKey.title", { name: platformLabel })}
            </h3>
            {phase !== "intro" && (
              <p className="getkey-modal-sub">{status}</p>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost getkey-close"
            onClick={() => void onCancel()}
            aria-label={t("getApiKey.close")}
          >
            ×
          </button>
        </header>

        {phase === "intro" && (
          <div className="getkey-body getkey-intro">
            <p className="getkey-intro-lead">
              {t("getApiKey.introLead", { name: platformLabel })}
            </p>
            <ol className="getkey-intro-steps">
              <li>{t("getApiKey.introStep1", { name: platformLabel })}</li>
              <li>{t("getApiKey.introStep2")}</li>
              <li>{t("getApiKey.introStep3")}</li>
            </ol>
            <p className="getkey-login-hint">{t("getApiKey.introNote")}</p>
            <div className="getkey-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onStart}
              >
                {t("getApiKey.introStart")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void onCancel()}
              >
                {t("getApiKey.cancel")}
              </button>
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="getkey-body">
            {waitingLogin ? (
              <div className="getkey-login-prompt">
                <p>{status || t("getApiKey.pleaseLoginAuto")}</p>
                <p className="getkey-login-hint">{t("getApiKey.autoDetectHint")}</p>
                <p className="getkey-login-hint">{t("getApiKey.permissionHint")}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void onContinue()}
                >
                  {t("getApiKey.alreadyLoggedIn")}
                </button>
              </div>
            ) : (
              <div className="getkey-spinner-block">
                <div className="getkey-spinner" aria-hidden />
                <p>{t("getApiKey.automating")}</p>
              </div>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="getkey-body getkey-success">
            <p>
              {saving
                ? t("getApiKey.saving")
                : t("getApiKey.savedHint", {
                    hint: manualKey
                      ? `${manualKey.slice(0, 7)}…${manualKey.slice(-4)}`
                      : "••••",
                  })}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onClose}
              disabled={saving}
            >
              {t("getApiKey.doneClose")}
            </button>
          </div>
        )}

        {phase === "failed" && (
          <div className="getkey-body">
            {error && <p className="getkey-error">{error}</p>}
            {browserMissing && (
              <p className="getkey-manual-lead">{t("getApiKey.browserMissingCmd")}</p>
            )}
            <p className="getkey-manual-lead">{t("getApiKey.manualLead")}</p>
            <div className="getkey-manual-row">
              <input
                className="settings-row-input getkey-manual-input"
                value={manualKey}
                onChange={(e) => setManualKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void onPasteClipboard()}
              >
                {t("getApiKey.pasteClipboard")}
              </button>
            </div>
            <div className="getkey-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void onSaveManual()}
                disabled={saving}
              >
                {t("getApiKey.saveManual")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onRetry}
              >
                {t("getApiKey.retry")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void onCancel()}
              >
                {t("getApiKey.close")}
              </button>
            </div>
          </div>
        )}

        {phase !== "intro" && (
          <div className="getkey-log-panel" aria-live="polite">
            {logs.slice(-8).map((l, i) => (
              <div key={`${i}-${l.slice(0, 12)}`} className="getkey-log-line">
                {l}
              </div>
            ))}
          </div>
        )}

        {phase === "running" && (
          <div className="getkey-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void onCancel()}
            >
              {t("getApiKey.cancel")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
