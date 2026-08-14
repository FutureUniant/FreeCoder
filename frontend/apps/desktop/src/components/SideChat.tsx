/**
 * Side chat — Grok Build `/btw` (x.ai/btw).
 * Local Q&A only; does not write to the main session transcript.
 * Message layout + composer dock mirror the main chat where possible.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n";
import { IconSend, IconStop, IconTrash } from "../icons";
import {
  ComposerInput,
  type ComposerInputHandle,
} from "./ComposerInput";

export type SideChatMessage = {
  id: string;
  role: "user" | "assistant" | "thought";
  text: string;
  at: string;
  /** Waiting for engine (assistant placeholder). */
  pending?: boolean;
  error?: boolean;
  /** Thought row expanded (default true when just received). */
  thoughtOpen?: boolean;
};

type Props = {
  sessionId: string | null;
  connected: boolean;
  messages: SideChatMessage[];
  onMessagesChange: (
    updater: (prev: SideChatMessage[]) => SideChatMessage[],
  ) => void;
  active?: boolean;
};

type BtwResult = {
  answer: string;
  thinking?: string | null;
};

let sideSeq = 0;
function nextId(prefix: string): string {
  sideSeq += 1;
  return `${prefix}-${Date.now()}-${sideSeq}`;
}

function openExternal(url: string): void {
  const trimmed = url.trim();
  if (!trimmed || !/^(https?:|mailto:)/i.test(trimmed)) return;
  void openUrl(trimmed).catch(() => {
    /* ignore */
  });
}

const SideMarkdown = memo(function SideMarkdown({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="md-body side-chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, node: _node, ...props }) {
            return (
              <a
                {...props}
                href={href}
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (href) openExternal(href);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

const NEAR_BOTTOM_PX = 48;

function isNearBottom(el: HTMLElement, threshold = NEAR_BOTTOM_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export const SideChat = memo(function SideChat({
  sessionId,
  connected,
  messages,
  onMessagesChange,
  active = true,
}: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ComposerInputHandle | null>(null);
  const genRef = useRef(0);
  /** Follow new content only while the user stays near the bottom. */
  const autoScrollRef = useRef(true);
  const lastProgrammaticScrollRef = useRef(0);

  useEffect(() => {
    genRef.current += 1;
    setBusy(false);
    setHasDraft(false);
    composerRef.current?.clear();
    autoScrollRef.current = true;
  }, [sessionId]);

  /** Smooth follow to bottom when side-chat content grows. */
  const sideScrollRaf = useRef<number | null>(null);

  const cancelScrollAnim = useCallback(() => {
    if (sideScrollRaf.current != null) {
      cancelAnimationFrame(sideScrollRaf.current);
      sideScrollRaf.current = null;
    }
  }, []);

  const disableAutoScroll = useCallback(() => {
    autoScrollRef.current = false;
    cancelScrollAnim();
  }, [cancelScrollAnim]);

  const enableAutoScroll = useCallback(() => {
    autoScrollRef.current = true;
  }, []);

  useEffect(() => {
    return () => cancelScrollAnim();
  }, [cancelScrollAnim]);

  /** Wheel / scrollbar = user owns the viewport; stop fighting them. */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const markUserScroll = () => disableAutoScroll();

    const onScroll = () => {
      if (performance.now() - lastProgrammaticScrollRef.current < 48) return;
      if (!autoScrollRef.current && isNearBottom(el)) {
        autoScrollRef.current = true;
        return;
      }
      if (!isNearBottom(el, 80)) {
        disableAutoScroll();
      }
    };

    el.addEventListener("wheel", markUserScroll, { passive: true });
    el.addEventListener("touchstart", markUserScroll, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", markUserScroll);
      el.removeEventListener("touchstart", markUserScroll);
      el.removeEventListener("scroll", onScroll);
    };
  }, [disableAutoScroll]);

  /** Panel/tab becomes visible — one-shot scroll to bottom unless user already scrolled. */
  useEffect(() => {
    if (!active) return;
    autoScrollRef.current = true;
    const el = listRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      lastProgrammaticScrollRef.current = performance.now() + 120;
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    });
  }, [active, sessionId]);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = listRef.current;
    if (!el) return;
    if (sideScrollRaf.current != null) return;

    const step = () => {
      const root = listRef.current;
      if (!root || !autoScrollRef.current) {
        sideScrollRaf.current = null;
        return;
      }
      const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
      const remaining = maxTop - root.scrollTop;
      if (remaining <= 0.5) {
        if (remaining > 0) {
          lastProgrammaticScrollRef.current = performance.now() + 80;
          root.scrollTop = maxTop;
        }
        if (busy && autoScrollRef.current) {
          sideScrollRaf.current = requestAnimationFrame(step);
        } else {
          sideScrollRaf.current = null;
        }
        return;
      }
      const ease =
        remaining > 200 ? 0.26 : remaining > 80 ? 0.18 : 0.13;
      let delta = remaining * ease;
      if (delta < 1) delta = Math.min(1, remaining);
      if (delta > 72) delta = 72;
      lastProgrammaticScrollRef.current = performance.now() + 80;
      root.scrollTop = Math.min(maxTop, root.scrollTop + delta);
      sideScrollRaf.current = requestAnimationFrame(step);
    };
    sideScrollRaf.current = requestAnimationFrame(step);
  }, [messages, busy]);

  useEffect(() => {
    if (active && connected) {
      composerRef.current?.focus();
    }
  }, [active, connected, sessionId]);

  const canSend =
    Boolean(sessionId) && connected && !busy && hasDraft;

  const clearLocal = useCallback(() => {
    genRef.current += 1;
    setBusy(false);
    onMessagesChange(() => []);
  }, [onMessagesChange]);

  const toggleThought = useCallback(
    (id: string) => {
      onMessagesChange((prev) =>
        prev.map((m) =>
          m.id === id && m.role === "thought"
            ? { ...m, thoughtOpen: !(m.thoughtOpen ?? true) }
            : m,
        ),
      );
    },
    [onMessagesChange],
  );

  const send = useCallback(async () => {
    const question = (composerRef.current?.getValue() ?? "").trim();
    if (!question || !sessionId || !connected || busy) return;

    const gen = ++genRef.current;
    const userMsg: SideChatMessage = {
      id: nextId("side-user"),
      role: "user",
      text: question,
      at: new Date().toISOString(),
    };
    const pendingId = nextId("side-asst");
    const pendingMsg: SideChatMessage = {
      id: pendingId,
      role: "assistant",
      text: "",
      at: new Date().toISOString(),
      pending: true,
    };

    composerRef.current?.clear();
    setHasDraft(false);
    enableAutoScroll();
    setBusy(true);
    onMessagesChange((prev) => [...prev, userMsg, pendingMsg]);

    try {
      const raw = await invoke<BtwResult | string>("send_btw", { question });
      if (genRef.current !== gen) return;

      // Compat: older bridge returned plain string.
      const answer =
        typeof raw === "string"
          ? raw.trim()
          : (raw?.answer ?? "").trim() || t("sideChat.noResponse");
      const thinking =
        typeof raw === "string"
          ? null
          : (raw?.thinking ?? "").trim() || null;

      onMessagesChange((prev) => {
        const withoutPending = prev.filter((m) => m.id !== pendingId);
        const next: SideChatMessage[] = [...withoutPending];
        if (thinking) {
          next.push({
            id: nextId("side-thought"),
            role: "thought",
            text: thinking,
            at: new Date().toISOString(),
            thoughtOpen: true,
          });
        }
        next.push({
          id: pendingId,
          role: "assistant",
          text: answer,
          at: new Date().toISOString(),
        });
        return next;
      });
    } catch (e) {
      if (genRef.current !== gen) return;
      onMessagesChange((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                id: pendingId,
                role: "assistant",
                text: String(e),
                at: new Date().toISOString(),
                error: true,
              }
            : m,
        ),
      );
    } finally {
      if (genRef.current === gen) {
        setBusy(false);
        composerRef.current?.focus();
      }
    }
  }, [sessionId, connected, busy, onMessagesChange, t, enableAutoScroll]);

  return (
    <div className="side-chat side-chat-embedded" aria-label={t("sideChat.aria")}>
      <div className="side-chat-toolbar">
        <span className="side-chat-toolbar-hint">
          {t("sideChat.hint")}
        </span>
        <button
          type="button"
          className="icon-btn"
          title={t("sideChat.clear")}
          aria-label={t("sideChat.clear")}
          onClick={clearLocal}
          disabled={messages.length === 0 && !hasDraft}
        >
          <IconTrash size={14} />
        </button>
      </div>

      <div className="side-chat-body" ref={listRef}>
        <div className="side-chat-body-inner">
        {messages.length === 0 ? (
          <div className="side-chat-empty">
            <p>{t("sideChat.empty")}</p>
          </div>
        ) : (
          messages.map((m) => {
            if (m.role === "user") {
              return (
                <div key={m.id} className="msg msg-user side-chat-line">
                  <div className="msg-user-stack">
                    <div className="msg-body">
                      <div className="msg-user-text">{m.text}</div>
                    </div>
                  </div>
                </div>
              );
            }
            if (m.role === "thought") {
              const open = m.thoughtOpen ?? true;
              return (
                <div key={m.id} className="msg msg-thought side-chat-line">
                  <button
                    type="button"
                    className="side-chat-thought-toggle"
                    onClick={() => toggleThought(m.id)}
                    aria-expanded={open}
                  >
                    <span className="side-chat-thought-chevron" aria-hidden>
                      {open ? "▾" : "▸"}
                    </span>
                    {t("sideChat.thinking")}
                  </button>
                  {open && (
                    <div className="msg-body md-body thought-md">
                      <SideMarkdown text={m.text} />
                    </div>
                  )}
                </div>
              );
            }
            // assistant
            return (
              <div
                key={m.id}
                className={`msg msg-assistant side-chat-line${
                  m.pending ? " is-pending" : ""
                }${m.error ? " is-error" : ""}`}
              >
                <div className="msg-body md-body">
                  {m.pending && !m.text ? (
                    <div className="waiting-body">
                      <span className="waiting-dots" aria-hidden>
                        <span />
                        <span />
                        <span />
                      </span>
                      <span>{t("sideChat.thinkingDots")}</span>
                    </div>
                  ) : m.error ? (
                    m.text
                  ) : (
                    <SideMarkdown text={m.text} />
                  )}
                </div>
              </div>
            );
          })
        )}
        </div>
      </div>

      <div className="side-chat-composer-dock">
        {!sessionId || !connected ? (
          <p className="side-chat-composer-hint">
            {t("sideChat.connectHint")}
          </p>
        ) : null}
        <ComposerInput
          ref={composerRef}
          disabled={!sessionId || !connected || busy}
          placeholder={
            sessionId && connected
              ? t("sideChat.placeholder")
              : t("sideChat.placeholderDisconnected")
          }
          onSubmit={() => {
            void send();
          }}
          onDraftChange={(text) => setHasDraft(text.trim().length > 0)}
        />
        <div className="composer-bar side-chat-composer-bar">
          <div className="composer-left">
            <span className="side-chat-composer-meta">
              {busy ? t("sideChat.asking") : t("sideChat.notInContext")}
            </span>
          </div>
          <div className="composer-right">
            {busy ? (
              <button
                type="button"
                className="send-btn stop"
                title={t("sideChat.stopTitle")}
                aria-label={t("sideChat.stopTitle")}
                onClick={() => {
                  genRef.current += 1;
                  setBusy(false);
                  onMessagesChange((prev) =>
                    prev.filter((m) => !(m.role === "assistant" && m.pending)),
                  );
                }}
              >
                <IconStop size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                title={t("sideChat.sendTitle")}
                disabled={!canSend}
                onClick={() => void send()}
              >
                <IconSend size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
