import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconFile,
  IconFolder,
  IconGoal,
  IconInfo,
  IconPaperclip,
  IconPen,
  IconPlus,
  IconPuzzle,
  IconSend,
  IconSettings,
  IconStop,
  IconTask,
  IconTool,
  IconTrash,
} from "./icons";
import {
  onTitlebarDoubleClick,
  onTitlebarMouseDown,
} from "./windowDrag";
import brandIcon from "./assets/brand-icon.svg";
import {
  detectVerbalOnlyCompletion,
  VERBAL_COMPLETION_NUDGE,
} from "./lib/verbalCompletion";
import { classifyAgentError } from "./lib/classifyAgentError";
import {
  ComposerInput,
  type ComposerInputHandle,
  type PathChipData,
  CLIPBOARD_CHIPS_MIME,
  selectionCopyPayload,
} from "./components/ComposerInput";
import {
  VirtualChatList,
  type VirtualChatListHandle,
} from "./components/VirtualChatList";
import { SessionOutline } from "./components/SessionOutline";
import {
  SideChat,
  type SideChatMessage,
} from "./components/SideChat";
import { ModelBrandIcon } from "./components/ModelBrandIcon";
import { GetApiKeyWizard } from "./components/GetApiKeyWizard";
import { ExtensionsPanel } from "./components/ExtensionsPanel";
import { DependenciesPanel } from "./components/DependenciesPanel";
import { useI18n, normalizeLocale, type UiLocale } from "./i18n";
import type { TFunction } from "./i18n";
import {
  vendorKindToGetKeyPlatform,
  type GetKeyPlatformId,
} from "./lib/getApiKeyUtil";
import {
  BONSAI_MODEL_ID,
  displayNameForModel,
  endpointToProfileRow,
  filterFetchedModels,
  grokEngineFromPublic,
  IMAGE_FILE_EXT_RE,
  isVendorPlaceholderModel,
  listVisionCapableModels,
  looksLikeMediaGenIntent,
  looksLikeVisionIntent,
  maskApiKeyHint,
  newVendorPreset,
  parseKInputToTokens,
  profilesToVendors,
  profileToSavePayload,
  isAgentChatCapability,
  isMediaToolCapability,
  CUSTOM_MODEL_CAPABILITIES,
  PERFORMANCE_TIERS,
  displayNameForPerformanceTier,
  resolveModelCapability,
  resolvePerformanceTier,
  resolveModelForPerformanceTier,
  resolveAutoDefaultModel,
  resolveComposerModelId,
  findEnabledChatModelId,
  readDefaultModelPinned,
  writeDefaultModelPinned,
  readModelSelectionMode,
  writeModelSelectionMode,
  readPerformanceTier,
  writePerformanceTier,
  supportsVisionInput,
  tokensToK,
  tokensToKInput,
  applyBonsaiHardwareTune,
  setBonsaiHardwareTune,
  VENDOR_TOKEN_DEFAULTS,
  vendorsToProfiles,
  type BonsaiHardwareTune,
  type GrokEngineForm,
  type ModelCapability,
  type ModelSelectionMode,
  type PerformanceTier,
  type VendorKind,
  type VendorRow,
} from "./lib/modelProfiles";

/** Public open-source repository (opens in the system browser). */
/** Debounce identical opens — prevents shell open + webview target=_blank double fire. */
let lastExternalOpen: { url: string; at: number } | null = null;

/** Open http(s) / mailto links with the OS default app (browser, mail, …). */
function openExternalUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  // Allow only schemes that should leave the app shell.
  if (!/^(https?:|mailto:)/i.test(trimmed)) return;
  const now = Date.now();
  if (
    lastExternalOpen &&
    lastExternalOpen.url === trimmed &&
    now - lastExternalOpen.at < 800
  ) {
    return;
  }
  lastExternalOpen = { url: trimmed, at: now };
  void openUrl(trimmed).catch((err) => {
    console.error("Failed to open URL:", err);
  });
}

/**
 * Bailian console — Model Square detail for one model code.
 * Free-quota remaining is shown on that page (官方「模型广场 → 详情 → 免费额度」).
 * @see https://help.aliyun.com/zh/model-studio/new-free-quota
 */
function bailianModelFreeQuotaUrl(modelId: string): string {
  const id = encodeURIComponent(modelId.trim());
  return `https://bailian.console.aliyun.com/cn-beijing?tab=model#/model-market/detail/${id}`;
}

/** Official top-up / recharge page for a vendor. */
function vendorTopUpUrl(kind: "deepseek" | "bailian"): string {
  if (kind === "deepseek") {
    // DeepSeek API platform billing top-up
    return "https://platform.deepseek.com/top_up";
  }
  // Aliyun expense console — account recharge (Bailian bills against this balance)
  return "https://usercenter2.aliyun.com/finance/fund-management";
}

/**
 * Resolve markdown image src to a webview-loadable URL.
 * Agents often emit relative paths (e.g. `rdfs-owl-diagrams/01.png`) against
 * the task cwd — those must become `asset://` URLs via convertFileSrc.
 */
function normalizeFsPathForUi(raw: string): string {
  let p = raw.trim().replace(/^<|>$/g, "");
  // Strip Windows extended / mangled prefixes from canonicalize + markdown.
  p = p
    .replace(/^\\\\\?\\/, "")
    .replace(/^\/\/\?\//, "")
    .replace(/^\\\?\\/, "")
    .replace(/^\\\?/, "")
    .replace(/^\/\?\//, "");
  // Markdown often eats `\.` → `.`, turning `ZCY\.grokx` into `ZCY.grokx`.
  p = p.replace(/([A-Za-z0-9])\.(grokx)(?=\/|\\|\.|$)/gi, "$1/.$2");
  return p.replace(/\\/g, "/");
}

function isMediaFilePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov)(?:\?.*)?$/i.test(path);
}

function isVideoFilePath(path: string): boolean {
  return /\.(mp4|webm|mov)(?:\?.*)?$/i.test(path);
}

/**
 * Make assistant text show media inline even when the model only printed a path.
 * Also normalize `\\?\` / backslash paths so they survive markdown + copy-paste.
 */
function enrichAssistantMediaMarkdown(text: string): string {
  if (!text.trim()) return text;
  let t = text;
  // Strip Windows extended / mangled prefixes: \\?\C: or \?\C:
  t = t.replace(/\\\\\?\\/g, "").replace(/\\\?([A-Za-z]:)/g, "$1");
  // Restore eaten `\.grokx` segments in absolute-looking paths; use `/`.
  t = t.replace(
    /([A-Za-z]:[\\/][^\s`*'\"<>|]*)/g,
    (chunk) =>
      chunk
        .replace(/([A-Za-z0-9])\.(grokx)(?=\/|\\|\.|$)/gi, "$1/.$2")
        .replace(/\\/g, "/"),
  );

  const found: string[] = [];
  const re =
    /(?:`)?((?:[A-Za-z]:\/|\/)[^\s`*'\"<>|]+\.(?:png|jpe?g|webp|gif|bmp|mp4|webm|mov))(?:`)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const p = normalizeFsPathForUi(m[1]);
    if (isMediaFilePath(p) && !found.includes(p)) found.push(p);
  }
  if (found.length === 0) return t;

  const missingEmbeds = found.filter((p) => {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`!\\[[^\\]]*\\]\\(${esc}\\)`, "i").test(t);
  });
  if (missingEmbeds.length === 0) return t;
  const embeds = missingEmbeds.map((p) => `![](${p})`).join("\n\n");
  return `${t.trimEnd()}\n\n${embeds}\n`;
}

function resolveLocalMediaSrc(
  src: string | undefined,
  bases: Array<string | null | undefined>,
): string | undefined {
  if (!src) return undefined;
  const raw = src.trim().replace(/^<|>$/g, "");
  if (!raw) return undefined;
  // Remote / data / already asset protocol
  if (
    /^(https?:|data:|asset:|blob:)/i.test(raw) ||
    raw.startsWith("//")
  ) {
    return raw;
  }
  let path = raw;
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.replace(/^file:\/\//i, ""));
    // file:///C:/Users/... → C:/Users/...
    path = path.replace(/^\/([A-Za-z]:)/, "$1");
  }
  path = normalizeFsPathForUi(path);
  // Absolute filesystem path
  const isAbs =
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  if (!isAbs) {
    // Relative → try task cwd, then project root
    const rel = path.replace(/^\.\//, "");
    let joined: string | null = null;
    for (const base of bases) {
      if (!base) continue;
      const b = normalizeFsPathForUi(base).replace(/[/\\]+$/, "");
      joined = `${b}/${rel}`.replace(/\\/g, "/");
      break;
    }
    if (!joined) return raw;
    path = joined;
  }
  try {
    return convertFileSrc(path);
  } catch {
    return raw;
  }
}

/**
 * Shared markdown rendering for chat: links open in the system browser;
 * local images resolve against the active task workspace.
 * When `streaming`, newly added block-level nodes fade in (DOM MutationObserver)
 * and a soft caret is shown — no per-character effects.
 */
function ChatMarkdown({
  children,
  mediaBases = [],
  streaming = false,
}: {
  children: string;
  /** Candidate roots for relative media (task cwd, project root). */
  mediaBases?: Array<string | null | undefined>;
  /** Soft block fade-in + caret while assistant is generating. */
  streaming?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const knownBlocksRef = useRef<WeakSet<Element>>(new WeakSet());

  useEffect(() => {
    if (!streaming) {
      knownBlocksRef.current = new WeakSet();
      return;
    }
    const root = rootRef.current;
    if (!root || typeof MutationObserver === "undefined") return;

    const markEnter = (el: Element) => {
      if (knownBlocksRef.current.has(el)) return;
      knownBlocksRef.current.add(el);
      el.classList.add("md-block-enter");
      window.setTimeout(() => el.classList.remove("md-block-enter"), 260);
    };

    // Seed existing blocks without animating (first paint of this stream).
    root
      .querySelectorAll(
        ":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > ul, :scope > ol, :scope > pre, :scope > blockquote, :scope > table, :scope > hr, :scope > li",
      )
      .forEach((el) => knownBlocksRef.current.add(el));

    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as Element;
          if (
            /^(P|H1|H2|H3|H4|UL|OL|LI|PRE|BLOCKQUOTE|TABLE|HR)$/.test(
              el.tagName,
            )
          ) {
            markEnter(el);
          }
          // Nested blocks (e.g. li inside newly added ul)
          el.querySelectorAll?.(
            "p, h1, h2, h3, h4, ul, ol, li, pre, blockquote, table, hr",
          ).forEach((child) => markEnter(child));
        });
      }
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [streaming]);

  return (
    <div
      ref={rootRef}
      className={`md-stream-root${streaming ? " is-streaming" : ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => {
          // Allow local paths / asset URLs through (default sanitizer may strip).
          if (!url) return url;
          if (/^(https?:|data:|asset:|blob:|file:)/i.test(url)) return url;
          if (
            url.startsWith("/") ||
            url.startsWith("./") ||
            /^[A-Za-z]:[\\/]/.test(url) ||
            !url.includes(":")
          ) {
            return url;
          }
          return url;
        }}
        components={{
          a({ href, children: linkChildren, node: _node, ...props }) {
            return (
              <a
                {...props}
                href={href}
                // No target=_blank: WKWebView would also open the system browser,
                // doubling with our shell open().
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (href) openExternalUrl(href);
                }}
              >
                {linkChildren}
              </a>
            );
          },
          code({ className, children: codeChildren, node: _node, ...props }) {
            const text = String(codeChildren ?? "").replace(/\n$/, "");
            const looksPath =
              /^[A-Za-z]:[\\/]/.test(text) ||
              (text.startsWith("/") && text.includes("/"));
            if (looksPath && !className) {
              const norm = normalizeFsPathForUi(text);
              return (
                <code
                  {...props}
                  className="chat-path-code"
                  title="Click to open"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void invoke("open_path", { path: norm }).catch(() => {});
                  }}
                >
                  {norm}
                </code>
              );
            }
            return (
              <code {...props} className={className}>
                {codeChildren}
              </code>
            );
          },
          img({ src, alt, node: _node, ...props }) {
            const orig = normalizeFsPathForUi((src || "").trim());
            const resolved = resolveLocalMediaSrc(src, mediaBases);
            if (!resolved) return null;
            const openOrig = () => {
              if (orig && !/^(https?:|data:)/i.test(orig)) {
                const abs =
                  orig.startsWith("/") || /^[A-Za-z]:[\\/]/.test(orig)
                    ? orig
                    : mediaBases.find(Boolean)
                      ? `${normalizeFsPathForUi(
                          String(mediaBases.find(Boolean)),
                        ).replace(/[/\\]+$/, "")}/${orig.replace(/^\.\//, "")}`
                      : null;
                if (abs) {
                  void invoke("open_path", { path: abs }).catch(() => {});
                  return;
                }
              }
              if (resolved.startsWith("http")) openExternalUrl(resolved);
            };
            if (isVideoFilePath(orig) || isVideoFilePath(resolved)) {
              return (
                <video
                  className="chat-md-video"
                  src={resolved}
                  controls
                  preload="metadata"
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    openOrig();
                  }}
                />
              );
            }
            return (
              <img
                {...props}
                src={resolved}
                alt={alt ?? ""}
                className="chat-md-img"
                loading="lazy"
                onClick={(e) => {
                  e.preventDefault();
                  openOrig();
                }}
              />
            );
          },
        }}
      >
        {enrichAssistantMediaMarkdown(children)}
      </ReactMarkdown>
      {streaming ? <span className="stream-caret" aria-hidden /> : null}
    </div>
  );
}

type SessionInfo = {
  session_id: string;
  project_root?: string | null;
  /** Task metadata dir under <project>/.grokx/tasks/<id> (not agent cwd). */
  work_path?: string | null;
  status: string;
};

type SessionListRow = {
  session_id: string;
  project_id: string;
  project_root: string;
  project_name: string;
  work_path: string;
  title: string;
  engine_session_id?: string | null;
  /** Stable list order key (newest-created first). */
  created_at: string;
  updated_at: string;
};

/**
 * Product model:
 * - Project = concrete workspace path (stable, user-chosen folder) = agent cwd
 * - Task (API: session) = metadata + chat history under <project>/.grokx/tasks/<id>
 */
type ProjectListRow = {
  project_id: string;
  name: string;
  root_path: string;
  session_count: number;
  updated_at: string;
};

type PendingPermission = {
  id: string;
  /** Owning task; used so multi-agent perms do not clobber each other. */
  session_id?: string;
  summary: string;
  tool_name: string;
  detail?: string | null;
};

type Attachment = {
  path: string;
  name: string;
  mime?: string | null;
  size?: number | null;
  /** Optional object URL for image preview in the composer. */
  previewUrl?: string | null;
  /** Folder path chip (Cursor-style) — agent gets the path, not file bytes. */
  isDir?: boolean;
};

type ModelOption = { id: string; name: string };

type PermissionMode = "ask" | "auto" | "always-approve";

type PublicSettings = {
  custom_engine_path?: string | null;
  prefer_bundled_engine: boolean;
  model?: string | null;
  effort?: string | null;
  sync_to_grok_config: boolean;
  /** `ask` | `auto` | `always-approve` (full trust) */
  permission_mode?: string | null;
  /** Legacy mirror of full trust */
  auto_approve?: boolean;
  ui_language?: string | null;
  endpoint: {
    model_id: string;
    name?: string | null;
    base_url?: string | null;
    has_api_key: boolean;
    api_key_hint?: string | null;
    env_key?: string | null;
    api_backend?: string | null;
    context_window?: number | null;
    max_completion_tokens?: number | null;
    default_effort?: string | null;
    enabled?: boolean | null;
    vendor_id?: string | null;
    capability?: string | null;
  };
  grok_config_path: string;
  grok_default_model?: string | null;
  /** Default Bailian image model (MCP). */
  default_image_model?: string | null;
  /** Default Bailian video model (MCP). */
  default_video_model?: string | null;
  grok_engine?: GrokEngineForm | null;
  model_profiles?: PublicSettings["endpoint"][];
  cn_acceleration?: {
    enabled: boolean;
    npm_registry: string;
    pypi_index: string;
    github_proxy: string;
    modelscope_skills_base: string;
  } | null;
};

function normalizePermissionMode(raw?: string | null, legacyAuto?: boolean): PermissionMode {
  const v = (raw || "").trim().toLowerCase();
  if (v === "auto") return "auto";
  if (
    v === "always-approve" ||
    v === "always_approve" ||
    v === "yolo" ||
    v === "full-trust" ||
    v === "full_trust" ||
    v === "trusted"
  ) {
    return "always-approve";
  }
  if (!v && legacyAuto) return "always-approve";
  return "ask";
}

/**
 * Display-only localization for default session titles. Storage/comparison
 * must keep using the English literals "New task" / "Restored task".
 */
function displayTaskTitle(
  title: string | null | undefined,
  t: (key: any, vars?: any) => string,
): string {
  const raw = (title || "").trim();
  if (!raw || raw === "New task") return t("common.newTask");
  if (raw === "Restored task") return t("common.restoredTask");
  return raw;
}

type ChatAttachment = {
  path: string;
  name: string;
  mime?: string | null;
  size?: number | null;
  /** asset:// URL for image preview in chat history */
  previewSrc?: string | null;
  /** Folder path reference chip */
  isDir?: boolean;
};

function formatBytes(n?: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** True for image attachments (mime or extension). Folders never count. */
function isImageAttachment(a: {
  name?: string | null;
  mime?: string | null;
  isDir?: boolean;
}): boolean {
  if (a.isDir) return false;
  if (a.mime?.startsWith("image/")) return true;
  const n = (a.name || "").toLowerCase();
  return IMAGE_FILE_EXT_RE.test(n);
}

/**
 * Prefer the original human filename. Never show a temp uuid-prefixed path
 * leaf when a real name is available.
 */
function attachmentDisplayName(a: {
  name?: string | null;
  path?: string | null;
}): string {
  const fromName = (a.name || "").trim();
  if (fromName && !/^[0-9a-f]{8}-/i.test(fromName)) {
    // Strip any accidental path prefix; keep basename.
    const leaf = fromName.split(/[/\\]/).pop() || fromName;
    if (leaf) return leaf;
  }
  const fromPath = (a.path || "").split(/[/\\]/).pop() || "";
  // Temp paste files look like `a1b2c3d4-报告.docx` — strip uuid prefix if present.
  const stripped = fromPath.replace(/^[0-9a-f]{8}-/i, "");
  return stripped || fromName || fromPath || "file";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Compact clock for user bubbles, e.g. 14:32 or 昨天 09:05. */
function formatMessageTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * Rough token estimate for display (not API-reported usage).
 * CJK ideographs ≈ 1 token; other non-space chars ≈ 4 chars / token.
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else if (/\s/u.test(ch)) {
      // ignore whitespace
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.round(cjk + other / 4));
}

function formatTokensPerSec(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "—";
  if (tps >= 100) return `${Math.round(tps)}`;
  if (tps >= 10) return tps.toFixed(0);
  return tps.toFixed(1);
}

/** Compact token count for the context meter (e.g. 1.2k, 128k). */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Estimate session context from visible chat (fallback when engine omits totalTokens). */
function estimateSessionTokens(chat: ChatLine[], draftText: string): number {
  let total = 0;
  for (const line of chat) {
    if (
      line.kind === "user" ||
      line.kind === "assistant" ||
      line.kind === "thought" ||
      line.kind === "system" ||
      line.kind === "error"
    ) {
      total += estimateTokens(line.text);
    } else if (line.kind === "tool") {
      total += estimateTokens(line.text);
    } else if (line.kind === "trace") {
      for (const item of line.items) {
        total += estimateTokens(item.text);
      }
    }
  }
  if (draftText.trim()) total += estimateTokens(draftText);
  return total;
}

/** Short sidebar title from first user message + optional first assistant reply. */
function summarizeChatTitle(userText: string, assistantText?: string): string {
  const firstLine = (t: string) =>
    t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";

  let user = firstLine(userText)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!user) {
    user = firstLine(userText).replace(/\s+/g, " ").trim();
  }

  const asst = firstLine(assistantText ?? "")
    .replace(/\s+/g, " ")
    .trim();

  let title = user;
  if (asst && asst.length <= 28 && user) {
    title = `${user} · ${asst}`;
  } else if (!user && asst) {
    title = asst;
  }

  const chars = [...title];
  if (chars.length > 40) {
    return `${chars.slice(0, 40).join("")}…`;
  }
  return title || "New task";
}

type TraceItem = {
  id: string;
  kind: "thought" | "tool" | "system" | "waiting";
  text: string;
  /** Merged consecutive identical tool lines (for × N display). */
  count?: number;
};

type ChatLine =
  | {
      id: string;
      kind: "user";
      text: string;
      /** ISO timestamp when the user sent this message. */
      at?: string;
      /** Optional image/file attachments shown as thumbnails in the bubble. */
      attachments?: ChatAttachment[];
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      /** Estimated output tokens (not API usage). */
      tokens?: number;
      /** Wall-clock stream duration for this reply (ms). */
      streamMs?: number;
      /** Estimated tokens / second over the stream window. */
      tokensPerSec?: number;
    }
  | { id: string; kind: "thought"; text: string }
  | {
      id: string;
      kind: "tool";
      text: string;
      /** Consecutive identical tool status lines merged into one chip. */
      count?: number;
    }
  | { id: string; kind: "system"; text: string }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "waiting"; text: string }
  /** Collapsed process (thinking / tools / status) after a turn finishes. */
  | {
      id: string;
      kind: "trace";
      items: TraceItem[];
      durationMs: number;
      expanded: boolean;
    };

let chatLineSeq = 0;
function nextLineId(kind: string): string {
  chatLineSeq += 1;
  return `${kind}-${Date.now()}-${chatLineSeq}`;
}

/**
 * Rough row height for windowing (px). Prefer slight over-estimate so
 * scrollHeight is never shorter than reality (under-estimate blocks bottom).
 * VirtualChatList corrects with ResizeObserver once rows mount.
 */
function estimateChatLineHeight(line: ChatLine): number {
  switch (line.kind) {
    case "tool":
    case "system":
      return 40;
    case "waiting":
      return 44;
    case "error":
      return 64;
    case "trace": {
      const base = 48;
      if (!line.expanded) return base;
      return base + Math.min(800, line.items.length * 40);
    }
    case "thought": {
      const lines = Math.ceil((line.text?.length ?? 0) / 70);
      return Math.min(600, 56 + lines * 22);
    }
    case "assistant": {
      // Markdown + spacing is taller than plain char estimates.
      const lines = Math.ceil((line.text?.length ?? 0) / 55);
      return Math.max(80, Math.min(6000, 72 + lines * 24));
    }
    case "user": {
      const textLines = Math.ceil((line.text?.length ?? 0) / 48);
      const atts = line.attachments?.length ?? 0;
      return Math.min(800, 56 + textLines * 22 + (atts > 0 ? 88 : 0));
    }
    default:
      return 72;
  }
}

/** Normalize tool chip text for merge comparison (trim + collapse spaces). */
function normalizeToolChipText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Append a tool status line, merging consecutive identical texts into
 * `tool → running × N` instead of spamming the chat.
 */
function appendOrMergeToolLine(prev: ChatLine[], text: string): ChatLine[] {
  const label = normalizeToolChipText(text) || "Tool";
  let base = prev;
  if (base.length && base[base.length - 1].kind === "waiting") {
    base = base.slice(0, -1);
  }
  const last = base[base.length - 1];
  if (
    last &&
    last.kind === "tool" &&
    normalizeToolChipText(last.text) === label
  ) {
    const copy = base.slice(0, -1);
    copy.push({
      ...last,
      count: (last.count ?? 1) + 1,
    });
    return copy;
  }
  return [
    ...base,
    { id: nextLineId("tool"), kind: "tool", text: label, count: 1 },
  ];
}

/** Display label for a tool chip, with ×N when merged. */
function formatToolChipLabel(line: {
  text: string;
  count?: number;
}): string {
  const n = line.count ?? 1;
  if (n <= 1) return line.text;
  return `${line.text} × ${n}`;
}

/** Process kinds that fold into the collapsible "Worked" strip. */
function isProcessLine(
  line: ChatLine,
): line is Extract<ChatLine, { kind: "thought" | "tool" | "system" }> {
  return (
    line.kind === "thought" || line.kind === "tool" || line.kind === "system"
  );
}

/**
 * After a turn ends: fold thought/tool/system into one collapsible trace
 * above the answer(s). Safe to call again if late tool events arrived after
 * a previous collapse (merges into existing trace).
 */
function collapseTurnProcess(
  lines: ChatLine[],
  durationMs: number,
): ChatLine[] {
  let lastUser = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return lines;

  const head = lines.slice(0, lastUser + 1);
  const tail = lines.slice(lastUser + 1);

  const items: TraceItem[] = [];
  const answers: ChatLine[] = [];
  const rest: ChatLine[] = [];
  let existingTrace: Extract<ChatLine, { kind: "trace" }> | null = null;

  for (const line of tail) {
    if (line.kind === "waiting") continue;
    if (line.kind === "trace") {
      // Keep first trace; fold any later process lines into it.
      if (!existingTrace) {
        existingTrace = line;
        items.push(...line.items);
      } else {
        items.push(...line.items);
      }
      continue;
    }
    if (isProcessLine(line)) {
      if (line.kind === "tool") {
        items.push({
          id: line.id,
          kind: "tool",
          text: line.text,
          count: line.count,
        });
      } else {
        items.push({ id: line.id, kind: line.kind, text: line.text });
      }
    } else if (line.kind === "assistant") {
      answers.push(line);
    } else {
      rest.push(line);
    }
  }

  if (items.length === 0) return lines;

  // Prefer measured duration; keep prior trace duration if new measure is 0.
  const priorDur = existingTrace?.durationMs ?? 0;
  const dur =
    durationMs > 0 ? durationMs : priorDur > 0 ? priorDur : 0;

  const trace: ChatLine = {
    id: existingTrace?.id ?? nextLineId("trace"),
    kind: "trace",
    items,
    durationMs: Math.max(0, dur),
    expanded: false,
  };

  return [...head, trace, ...answers, ...rest];
}

/**
 * Collapse every turn in a transcript that still has raw thought/tool lines.
 * Used when loading history that was saved before collapse ran.
 */
function collapseAllTurnsInHistory(lines: ChatLine[]): ChatLine[] {
  const userIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "user") userIdx.push(i);
  }
  if (userIdx.length === 0) return lines;

  const out: ChatLine[] = [];
  // Preserve any prefix before the first user message.
  if (userIdx[0] > 0) {
    out.push(...lines.slice(0, userIdx[0]));
  }

  for (let u = 0; u < userIdx.length; u++) {
    const start = userIdx[u];
    const end = u + 1 < userIdx.length ? userIdx[u + 1] : lines.length;
    const turnSlice = lines.slice(start, end);
    if (turnSlice.some(isProcessLine)) {
      // collapseTurnProcess folds from the last user in its input — pass only this turn.
      const collapsed = collapseTurnProcess(turnSlice, 0);
      out.push(...collapsed);
    } else {
      out.push(...turnSlice);
    }
  }
  return out;
}

function summarizeTrace(items: TraceItem[], t: TFunction): string {
  const thoughts = items.filter((i) => i.kind === "thought").length;
  // Count merged tool chips by their × N (so 50× running = 50 tools, not 1).
  const tools = items
    .filter((i) => i.kind === "tool")
    .reduce((sum, i) => sum + (i.count ?? 1), 0);
  const systems = items.filter((i) => i.kind === "system").length;
  const parts: string[] = [];
  if (thoughts) {
    parts.push(
      thoughts === 1
        ? t("trace.thinking")
        : t("trace.thoughts", { n: thoughts }),
    );
  }
  if (tools) {
    parts.push(
      tools === 1 ? t("trace.oneTool") : t("trace.tools", { n: tools }),
    );
  }
  if (systems && !thoughts && !tools) parts.push(t("trace.activity"));
  if (parts.length === 0) parts.push(t("trace.steps", { n: items.length }));
  return parts.join(" · ");
}


type AgentEvent = {
  type: string;
  status?: string;
  detail?: string | null;
  session_id?: { "0"?: string } | string;
  text?: string;
  message?: string;
  state?: string;
  steps?: string[];
  /** Engine `_meta.totalTokens` when present (context_usage events). */
  used_tokens?: number;
  /** `/goal` GoalUpdated fields */
  goal_id?: string;
  objective?: string;
  phase?: string;
  pause_message?: string | null;
  tool?: {
    title?: string;
    kind?: string;
    status?: string;
    output_preview?: string | null;
  };
  /** Stable product error code from the engine (agent_error). */
  app_code?: string | null;
  request?: {
    id?: string;
    summary?: string;
    tool_name?: string;
    detail?: string | null;
  };
  engine_session_id?: string | null;
};

type GoalUiState = {
  goalId: string;
  objective: string;
  status: string;
  phase: string;
  pauseMessage: string | null;
};

function sessionIdOf(ev: AgentEvent): string {
  const s = ev.session_id;
  if (!s) return "";
  if (typeof s === "string") return s;
  return s["0"] ?? "";
}

/** Normalize backend status tokens (Debug "Ready" or snake_case "ready"). */
function normalizeAgentStatus(raw: string | null | undefined): string {
  return (raw ?? "unknown").trim().toLowerCase().replace(/\s+/g, "_");
}

function isAgentReadyStatus(raw: string | null | undefined): boolean {
  return normalizeAgentStatus(raw).includes("ready");
}

function isAgentStartingStatus(raw: string | null | undefined): boolean {
  const s = normalizeAgentStatus(raw);
  return (
    s.includes("starting") ||
    s === "connecting" ||
    s === "reconnecting"
  );
}

/** Localized status pill text — never leak raw English backend tokens. */
function formatAgentStatusLabel(status: string, t: TFunction): string {
  const s = normalizeAgentStatus(status);
  if (s.includes("ready")) return t("status.ready");
  if (s === "reconnecting") return t("status.reconnecting");
  if (s.includes("starting") || s === "connecting") return t("status.starting");
  if (s.includes("fail") || s.includes("error")) return t("status.failed");
  if (
    s.includes("disconnect") ||
    s.includes("missing") ||
    s === "missing_binary"
  ) {
    return t("status.disconnected");
  }
  return t("status.unknown");
}

function shortPath(
  p: string | null | undefined,
  noPathLabel = "No project",
): string {
  if (!p) return noPathLabel;
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

const SIDEBAR_W_MIN = 180;
const SIDEBAR_W_MAX = 440;
const RIGHT_W_MIN = 220;
const RIGHT_W_MAX = 560;

function clampWidth(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readStoredWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return clampWidth(n, min, max);
  } catch {
    return fallback;
  }
}

function writeStoredWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore quota / private mode */
  }
}

function ChipIcon({ kind }: { kind: ChatLine["kind"] | TraceItem["kind"] }) {
  switch (kind) {
    case "tool":
      return <IconTool size={14} />;
    case "system":
      return <IconInfo size={14} />;
    case "error":
      return <IconAlert size={14} />;
    case "thought":
      return <IconPen size={14} />;
    case "waiting":
      return <IconInfo size={14} />;
    default:
      return <IconInfo size={14} />;
  }
}

export default function App() {
  const { t, locale, setLocale } = useI18n();
  const displayShortPath = useCallback(
    (p: string | null | undefined) => shortPath(p, t("topbar.noProject")),
    [t],
  );
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [projects, setProjects] = useState<ProjectListRow[]>([]);
  /** Project used for “new task under project” / highlight context. */
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  /**
   * Projects whose nested task lists are open. Independent of selection so
   * switching to another project/session does not collapse an open project.
   */
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  /** Sidebar section fold: Projects / Tasks lists (label click). */
  const [projectsSectionOpen, setProjectsSectionOpen] = useState(() => {
    try {
      return localStorage.getItem("grokx.sidebar.projectsOpen") !== "0";
    } catch {
      return true;
    }
  });
  const [tasksSectionOpen, setTasksSectionOpen] = useState(() => {
    try {
      return localStorage.getItem("grokx.sidebar.tasksOpen") !== "0";
    } catch {
      return true;
    }
  });
  const [sessions, setSessions] = useState<SessionListRow[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [projectRoot, setProjectRoot] = useState("");
  const [, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  /**
   * Composer draft lives in ComposerInput (local state) so typing does not
   * re-render the full chat. These are cheap parent mirrors only:
   * - draftForMeter: debounced, for context token estimate
   * - composerHasText: boolean for Send button enablement
   */
  const [draftForMeter, setDraftForMeter] = useState("");
  const [composerHasText, setComposerHasText] = useState(false);
  /** Composer Goal menu (Grok Build `/goal` slash command). */
  const [goalMenuOpen, setGoalMenuOpen] = useState(false);
  const goalMenuRef = useRef<HTMLDivElement | null>(null);
  /** Live `/goal` orchestration from engine GoalUpdated notifications. */
  const [goalState, setGoalState] = useState<GoalUiState | null>(null);
  const goalStatusRef = useRef<string | null>(null);
  /** Composer draft currently starts with `/goal` (keeps flag button selected while typing). */
  const [goalDraftArmed, setGoalDraftArmed] = useState(false);
  /** Edit a past user bubble, then re-send from that point. */
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Busy for the *focused* task (composer / status pill). */
  const [busy, setBusy] = useState(false);
  /**
   * Shown when Working lasts a long time (often a foreground server / hang).
   * Cleared when the turn ends or the user dismisses / stops.
   */
  const [longRunNotice, setLongRunNotice] = useState<{
    elapsedSec: number;
    toolHint: string | null;
  } | null>(null);
  /** User hid the long-run banner for the current turn. */
  const longRunDismissedRef = useRef(false);
  /**
   * Per-task busy map so sidebar shows Working on background agents.
   * Multiple tasks can stream in parallel; only the active one's chat is shown.
   */
  const [sessionBusyMap, setSessionBusyMap] = useState<Record<string, boolean>>(
    {},
  );
  /**
   * Sessions that produced activity while not focused — show a dot next to
   * the task title until the user opens that task.
   */
  const [sessionUnreadMap, setSessionUnreadMap] = useState<
    Record<string, boolean>
  >({});
  const sessionUnreadMapRef = useRef<Map<string, boolean>>(new Map());
  const [connecting, setConnecting] = useState(false);
  /** Generation so a newer connect attempt supersedes a hung one. */
  const connectingGenRef = useRef(0);
  const connectingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [agentStatus, setAgentStatus] = useState<string>("disconnected");
  const agentStatusRef = useRef(agentStatus);
  agentStatusRef.current = agentStatus;
  /** Local llama-server status when active model is bonsai-local / :8080. */
  const [localLlmStatus, setLocalLlmStatus] = useState<string>("stopped");
  /** Dependency readiness for bonsai / grok (Settings → Dependencies). */
  const [depReadiness, setDepReadiness] = useState<{
    ok: boolean;
    message: string;
    local_llm_ready: boolean;
    local_llm_blocked: boolean;
    grok_ready: boolean;
    downloading_ids: string[];
    missing_ids: string[];
    paused_ids: string[];
  } | null>(null);
  /** Tool permission: ask | auto | always-approve (full trust). */
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("ask");
  /** Engine-reported session tokens (`_meta.totalTokens`); null → estimate from chat. */
  const [engineContextTokens, setEngineContextTokens] = useState<number | null>(
    null,
  );
  /** Per-task engine token totals so switching restores correctly; new tasks start empty. */
  const sessionContextTokensRef = useRef<Map<string, number>>(new Map());
  /** In-memory transcript for background tasks still receiving events. */
  const sessionLinesCacheRef = useRef<Map<string, ChatLine[]>>(new Map());
  const busyRef = useRef(false);
  const sessionBusyMapRef = useRef<Map<string, boolean>>(new Map());
  const [pendingPerms, setPendingPerms] = useState<PendingPermission[]>([]);
  /** Only the active task may show an approve/deny card (avoids cross-task confusion). */
  const activePendingPerms = useMemo(() => {
    const sid = session?.session_id;
    if (!sid) return [];
    return pendingPerms.filter((p) => p.session_id === sid);
  }, [pendingPerms, session?.session_id]);
  const pendingPerm = activePendingPerms[0] ?? null;
  /** Other tasks waiting for approval — hint only, never approve from here. */
  const elsewhereApprovalHints = useMemo(() => {
    const sid = session?.session_id;
    const bySession = new Map<string, number>();
    for (const p of pendingPerms) {
      if (!p.session_id || p.session_id === sid) continue;
      bySession.set(p.session_id, (bySession.get(p.session_id) ?? 0) + 1);
    }
    if (bySession.size === 0) return [];
    return [...bySession.entries()].map(([sessionId, count]) => {
      const row = sessions.find((s) => s.session_id === sessionId);
      const title = row
        ? displayTaskTitle(row.title, t) || row.session_id.slice(0, 8)
        : sessionId.slice(0, 8);
      const projectName = row?.project_name?.trim() || "";
      return { sessionId, count, title, projectName, row: row ?? null };
    });
  }, [pendingPerms, session?.session_id, sessions, t]);
  const sessionsNeedingApproval = useMemo(() => {
    const set = new Set<string>();
    for (const p of pendingPerms) {
      if (p.session_id) set.add(p.session_id);
    }
    return set;
  }, [pendingPerms]);
  const pendingPermsRef = useRef<PendingPermission[]>([]);
  pendingPermsRef.current = pendingPerms;

  const enqueuePermission = useCallback((p: PendingPermission) => {
    setPendingPerms((prev) => {
      if (prev.some((x) => x.id === p.id)) return prev;
      return [...prev, p];
    });
  }, []);

  const removePermission = useCallback((id: string) => {
    setPendingPerms((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const clearPermissionsForSession = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      setPendingPerms([]);
      return;
    }
    setPendingPerms((prev) =>
      prev.filter((x) => x.session_id && x.session_id !== sessionId),
    );
  }, []);

  const clearAllPermissions = useCallback(() => {
    setPendingPerms([]);
  }, []);
  /** Main view: workspace chat vs full settings page. */
  const [view, setView] = useState<"workspace" | "settings">("workspace");
  /** Right rail — collapsible; holds Chat (btw) + Outputs tabs. */
  const [outputsOpen, setOutputsOpen] = useState(true);
  /** Side chat messages per session (not main transcript). */
  const [sideChatBySession, setSideChatBySession] = useState<
    Record<string, SideChatMessage[]>
  >({});
  /**
   * Chat-area session outline (user prompts list).
   * Default collapsed (dots only, centered); expanded = short text list.
   */
  const [sessionOutlineCollapsed, setSessionOutlineCollapsed] = useState(() => {
    try {
      // Default collapsed; only expand when user explicitly set "0".
      return localStorage.getItem("grokx.sessionOutlineCollapsed") !== "0";
    } catch {
      return true;
    }
  });
  /** Left Projects/Tasks rail — collapsible (persisted). */
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("grokx.sidebarOpen") !== "0";
    } catch {
      return true;
    }
  });
  /** Draggable column widths (px); persisted across restarts. */
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredWidth("grokx.sidebarWidth", 248, SIDEBAR_W_MIN, SIDEBAR_W_MAX),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredWidth("grokx.rightWidth", 300, RIGHT_W_MIN, RIGHT_W_MAX),
  );
  const sidebarWidthRef = useRef(sidebarWidth);
  const rightWidthRef = useRef(rightWidth);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);
  useEffect(() => {
    rightWidthRef.current = rightWidth;
  }, [rightWidth]);
  const panelDragRef = useRef<{
    kind: "sidebar" | "right";
    startX: number;
    startW: number;
  } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** True while OS files/folders are dragged over the chat drop zone. */
  const [composerDropActive, setComposerDropActive] = useState(false);
  /** Full-screen preview for a pending composer image attachment. */
  const [attachmentPreview, setAttachmentPreview] = useState<{
    src: string;
    name: string;
  } | null>(null);
  const [modelId, setModelId] = useState<string>(BONSAI_MODEL_ID);
  /** Composer: tier auto-pick vs concrete model (mutually exclusive). */
  const [modelSelectionMode, setModelSelectionMode] = useState<ModelSelectionMode>(
    () => readModelSelectionMode(),
  );
  const [performanceTier, setPerformanceTier] = useState<PerformanceTier>(() =>
    readPerformanceTier("medium"),
  );
  /** Sticky user prompt while reading replies (id of last scrolled-past user msg). */
  const [stickyUserId, setStickyUserId] = useState<string | null>(null);
  const [highlightUserId, setHighlightUserId] = useState<string | null>(null);
  /** Floating control when chat is scrolled up and more content is below. */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  /** Assistant message just copied: which id + format (brief "Copied" feedback). */
  const [copiedMsg, setCopiedMsg] = useState<{
    id: string;
    format: "md" | "plain";
  } | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [settingsMsgIsError, setSettingsMsgIsError] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  /** Settings → Models: vendor list (each vendor owns shared credentials + model ids). */
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [editingVendorId, setEditingVendorId] = useState<string>("");
  const [bonsaiTune, setBonsaiTune] = useState<BonsaiHardwareTune | null>(null);
  const bonsaiTuneRef = useRef<BonsaiHardwareTune | null>(null);
  const [addVendorMenuOpen, setAddVendorMenuOpen] = useState(false);
  const addVendorMenuRef = useRef<HTMLDivElement | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);
  const [apiKeyFocused, setApiKeyFocused] = useState(false);
  const [getKeyWizardPlatform, setGetKeyWizardPlatform] =
    useState<GetKeyPlatformId | null>(null);
  const [getKeyWizardVendorId, setGetKeyWizardVendorId] = useState<string | null>(
    null,
  );
  const [customModelDraft, setCustomModelDraft] = useState("");
  const [customModelDraftCap, setCustomModelDraftCap] =
    useState<Exclude<ModelCapability, "local">>("llm");
  const [customModelDraftTier, setCustomModelDraftTier] =
    useState<PerformanceTier>("strong");
  const [cfgSyncGrok, setCfgSyncGrok] = useState(true);
  const [grokDefaultModel, setGrokDefaultModel] = useState(BONSAI_MODEL_ID);
  const [defaultImageModel, setDefaultImageModel] = useState("qwen-image-3.0-pro");
  const [defaultVideoModel, setDefaultVideoModel] = useState("happyhorse-1.1-t2v");
  const [grokDefaultTier, setGrokDefaultTier] = useState<PerformanceTier>(() =>
    readPerformanceTier("medium"),
  );
  const [grokEngineForm, setGrokEngineForm] = useState<GrokEngineForm>(
    grokEngineFromPublic(),
  );
  const [endpointProbeBusy, setEndpointProbeBusy] = useState(false);
  const [balanceQueryBusy, setBalanceQueryBusy] = useState(false);
  const [vendorBalanceSummary, setVendorBalanceSummary] = useState<string | null>(null);
  const [bailianBalanceModalOpen, setBailianBalanceModalOpen] = useState(false);
  const [vlmRequiredModalOpen, setVlmRequiredModalOpen] = useState(false);
  const [fetchModelsBusy, setFetchModelsBusy] = useState(false);
  const autoBalanceVendorRef = useRef<string>("");
  const balanceQueryGenRef = useRef(0);
  /** Skip debounced auto-save when vendors come from the server or explicit persist. */
  const suppressModelAutoSaveRef = useRef(false);
  const autoFetchKeyRef = useRef<string>("");
  const settingsMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Settings left-nav section (directory → detail). */
  const [settingsSection, setSettingsSection] = useState<
    "general" | "model" | "extensions" | "dependencies" | "about"
  >("general");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ComposerInputHandle | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const chatPaneRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const virtualChatRef = useRef<VirtualChatListHandle | null>(null);
  const userMsgEls = useRef<Map<string, HTMLDivElement>>(new Map());
  /** Cancel multi-pass jump alignment when a newer jump starts. */
  const jumpAlignGenRef = useRef(0);
  /** Wall-clock start of the in-flight agent turn (for duration on collapse). */
  const turnStartedAtRef = useRef<number | null>(null);
  /**
   * Auto-continue when the model ends a turn with only verbal progress.
   * Resets when the user sends a new prompt; max 1 auto-nudge per user turn.
   */
  const verbalNudgeUsedRef = useRef(false);
  const autoNudgeInFlightRef = useRef(false);
  /** After Stop, ignore late busy events for this session until a new send. */
  const userStoppedSessionRef = useRef<string | null>(null);
  /** First assistant delta for the in-flight reply (for tok/s). */
  const assistantStreamStartedAtRef = useRef<number | null>(null);
  /** Last assistant delta timestamp for the in-flight reply. */
  const assistantStreamLastAtRef = useRef<number | null>(null);
  /** Keep latest lines for flush-to-disk without stale closures. */
  const linesRef = useRef<ChatLine[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const workPathRef = useRef<string | null>(null);
  const historySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bump when switching tasks so stale reconnect logs don't overwrite history. */
  const historyEpochRef = useRef(0);
  /** Auto-title only once per task after the first successful assistant reply. */
  const autoTitledSessionRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef<SessionListRow[]>([]);
  /**
   * Chat auto-follow: content can stream fast, but viewport eases toward the
   * bottom slowly. Once the user scrolls manually, stop until they send again
   * or return near the bottom.
   */
  const autoScrollEnabledRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const scrollAnimRef = useRef<number | null>(null);
  const lastProgrammaticScrollRef = useRef(0);
  /** Coalesce sticky visibility checks to one layout read per frame. */
  const stickyRafRef = useRef<number | null>(null);
  const stickyUserIdRef = useRef<string | null>(null);
  /** Last trackpad/wheel activity — don't fight inertia by re-enabling auto-scroll too soon. */
  const lastUserScrollAtRef = useRef(0);
  /**
   * Per-task scroll resume: when switching Tasks, restore the viewport
   * position the user left (not always jump to bottom).
   */
  const sessionScrollRef = useRef<
    Map<
      string,
      {
        scrollTop: number;
        /** True if user was near the live edge — resume bottom + auto-follow. */
        pinBottom: boolean;
        autoScroll: boolean;
      }
    >
  >(new Map());

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    sessionIdRef.current = session?.session_id ?? null;
    workPathRef.current = session?.work_path ?? null;
  }, [session?.session_id, session?.work_path]);

  useEffect(() => {
    // Goal orchestration is per engine session — reset when switching tasks.
    goalStatusRef.current = null;
    setGoalState(null);
    setGoalDraftArmed(false);
    setGoalMenuOpen(false);
  }, [session?.session_id]);

  /**
   * After ~10 min of continuous Working, surface a sticky hint: the agent may be
   * blocked on a long-lived shell (e.g. `mykg web`, dev servers) rather than
   * looping in the UI. Offers one-click Stop.
   */
  useEffect(() => {
    if (!busy) {
      setLongRunNotice(null);
      longRunDismissedRef.current = false;
      return;
    }
    const LONG_RUN_MS = 600_000;
    const tick = () => {
      if (!busyRef.current || longRunDismissedRef.current) {
        setLongRunNotice(null);
        return;
      }
      const started = turnStartedAtRef.current;
      if (started == null) return;
      const elapsedMs = Date.now() - started;
      if (elapsedMs < LONG_RUN_MS) {
        setLongRunNotice(null);
        return;
      }
      // Prefer the latest tool line that looks like a foreground shell.
      let toolHint: string | null = null;
      const chat = linesRef.current;
      for (let i = chat.length - 1; i >= 0; i--) {
        const l = chat[i];
        if (l.kind !== "tool" && l.kind !== "system") continue;
        const t = l.text || "";
        if (
          /run_terminal|terminal_command|Execute `|uv run|npm (run|start)|pnpm |yarn |python |mykg web|uvicorn|flask|django|next dev|vite|webpack|serve |--port |0\.0\.0\.0|127\.0\.0\.1/i.test(
            t,
          )
        ) {
          toolHint = t.length > 140 ? `${t.slice(0, 137)}…` : t;
          break;
        }
        if (l.kind === "tool" && /running/i.test(t) && (l.count ?? 1) >= 8) {
          toolHint = t;
          break;
        }
      }
      setLongRunNotice({
        elapsedSec: Math.floor(elapsedMs / 1000),
        toolHint,
      });
    };
    tick();
    const id = window.setInterval(tick, 4000);
    return () => window.clearInterval(id);
  }, [busy]);

  /** Update busy for one task; sync focused `busy` when that task is active. */
  const setSessionBusyState = useCallback((sid: string, nextBusy: boolean) => {
    if (!sid) return;
    const wasBusy = sessionBusyMapRef.current.get(sid) === true;
    sessionBusyMapRef.current.set(sid, nextBusy);
    setSessionBusyMap((prev) => {
      if (prev[sid] === nextBusy) return prev;
      return { ...prev, [sid]: nextBusy };
    });
    if (sessionIdRef.current === sid) {
      busyRef.current = nextBusy;
      setBusy(nextBusy);
    }
    // Working → idle while user is not looking at this task → unread (green).
    if (wasBusy && !nextBusy) {
      const viewingThis =
        sessionIdRef.current === sid &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible";
      if (!viewingThis) {
        // Defer so markSessionUnread is defined; call via ref pattern below.
        queueMicrotask(() => {
          if (sessionUnreadMapRef.current.get(sid)) return;
          if (
            sessionIdRef.current === sid &&
            document.visibilityState === "visible"
          ) {
            return;
          }
          sessionUnreadMapRef.current.set(sid, true);
          setSessionUnreadMap((prev) =>
            prev[sid] ? prev : { ...prev, [sid]: true },
          );
        });
      }
    }
  }, []);

  /** Mark a task as having unread activity (finished or updated while not viewed). */
  const markSessionUnread = useCallback((sid: string | null | undefined) => {
    if (!sid) return;
    // Actively viewing this task in a visible window → not unread.
    if (
      sessionIdRef.current === sid &&
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    ) {
      return;
    }
    if (sessionUnreadMapRef.current.get(sid)) return;
    sessionUnreadMapRef.current.set(sid, true);
    setSessionUnreadMap((prev) =>
      prev[sid] ? prev : { ...prev, [sid]: true },
    );
  }, []);

  const clearSessionUnread = useCallback((sid: string | null | undefined) => {
    if (!sid) return;
    if (!sessionUnreadMapRef.current.get(sid)) return;
    sessionUnreadMapRef.current.delete(sid);
    setSessionUnreadMap((prev) => {
      if (!prev[sid]) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
  }, []);

  /**
   * Dock badge (macOS Dock / taskbar):
   * - Working tasks → red count (system badge; priority)
   * - Else unread finished tasks → green-style count (label with 🟢 when possible)
   * - Viewed / idle → clear
   *
   * Note: macOS dock badge chrome is system-red for numeric badges; we use
   * setBadgeCount for working, and setBadgeLabel("🟢N") for unread-only so
   * the two states stay distinguishable.
   */
  const syncDockBadge = useCallback(() => {
    let working = 0;
    for (const v of sessionBusyMapRef.current.values()) {
      if (v) working += 1;
    }
    if (busyRef.current && sessionIdRef.current) {
      if (!sessionBusyMapRef.current.get(sessionIdRef.current)) working += 1;
    }
    let unread = 0;
    for (const [sid, v] of sessionUnreadMapRef.current.entries()) {
      if (!v) continue;
      // Don't count unread for a task that is still working (working badge wins).
      if (sessionBusyMapRef.current.get(sid)) continue;
      if (busyRef.current && sessionIdRef.current === sid) continue;
      unread += 1;
    }

    const win = getCurrentWindow();
    void (async () => {
      try {
        if (working > 0) {
          // Red system badge = tasks currently working.
          await win.setBadgeLabel(undefined);
          await win.setBadgeCount(working);
        } else if (unread > 0) {
          // Finished but not viewed: green-tinted label (macOS still uses
          // badge chrome, but 🟢 distinguishes from working count).
          await win.setBadgeCount(undefined);
          await win.setBadgeLabel(`🟢${unread}`);
        } else {
          await win.setBadgeCount(undefined);
          await win.setBadgeLabel(undefined);
        }
      } catch {
        /* badge unsupported on some platforms */
      }
    })();
  }, []);

  useEffect(() => {
    syncDockBadge();
  }, [sessionBusyMap, sessionUnreadMap, busy, syncDockBadge]);

  // When the window becomes visible again, clear unread for the focused task
  // and refresh the dock badge.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && sessionIdRef.current) {
        clearSessionUnread(sessionIdRef.current);
      }
      syncDockBadge();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [clearSessionUnread, syncDockBadge]);

  /** Work path for a task id (active or from list). */
  const workPathForSession = useCallback((sid: string): string | null => {
    if (sessionIdRef.current === sid) return workPathRef.current;
    return (
      sessionsRef.current.find((s) => s.session_id === sid)?.work_path || null
    );
  }, []);

  /** Connection / reconnect noise — never persist or restore these alone. */
  const isConnectionNoise = useCallback((line: ChatLine): boolean => {
    if (line.kind === "waiting") return true;
    if (line.kind !== "system") return false;
    const t = line.text.toLowerCase();
    return (
      t.startsWith("starting:") ||
      t.startsWith("ready:") ||
      t.startsWith("task ready") ||
      t.startsWith("switched task") ||
      t.startsWith("new task") ||
      t.startsWith("opened project") ||
      t.startsWith("using default") ||
      t.startsWith("connected") ||
      t.includes("acp handshake") ||
      t.includes("acp session ready") ||
      t.includes("spawning ") ||
      t.includes("agent cwd ") ||
      t.includes("task cwd ")
    );
  }, []);

  const hasRealChatContent = useCallback((chatLines: ChatLine[]) => {
    return chatLines.some(
      (l) =>
        l.kind === "user" ||
        l.kind === "assistant" ||
        l.kind === "trace" ||
        l.kind === "thought" ||
        l.kind === "tool" ||
        l.kind === "error",
    );
  }, []);

  const persistChatHistory = useCallback(
    async (
      sessionId: string,
      chatLines: ChatLine[],
      workPath?: string | null,
    ) => {
      // Never wipe a good history file with only reconnect noise.
      if (!hasRealChatContent(chatLines)) return;
      const toSave = chatLines.filter(
        (l) => l.kind !== "waiting" && !isConnectionNoise(l),
      );
      if (toSave.length === 0) return;
      try {
        await invoke("save_chat_history", {
          sessionId,
          json: JSON.stringify(toSave),
          workPath: workPath || workPathRef.current || null,
        });
      } catch (e) {
        console.warn("save_chat_history failed", e);
      }
    },
    [hasRealChatContent, isConnectionNoise],
  );

  const schedulePersistHistory = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    // Don't schedule saves of pure noise after reconnect.
    if (!hasRealChatContent(linesRef.current)) return;
    if (historySaveTimer.current) clearTimeout(historySaveTimer.current);
    const epoch = historyEpochRef.current;
    const work = workPathRef.current;
    historySaveTimer.current = setTimeout(() => {
      // Drop if user switched tasks since schedule.
      if (historyEpochRef.current !== epoch) return;
      if (sessionIdRef.current !== sid) return;
      void persistChatHistory(sid, linesRef.current, work);
    }, 500);
  }, [persistChatHistory, hasRealChatContent]);

  const flushPersistHistory = useCallback(async () => {
    if (historySaveTimer.current) {
      clearTimeout(historySaveTimer.current);
      historySaveTimer.current = null;
    }
    const sid = sessionIdRef.current;
    const work = workPathRef.current;
    if (!sid) return;
    await persistChatHistory(sid, linesRef.current, work);
  }, [persistChatHistory]);

  /**
   * Mutate transcript for a session that is not currently focused.
   * Keeps background tasks streaming while the user looks at another chat.
   */
  const mutateBackgroundLines = useCallback(
    (sid: string, mutator: (prev: ChatLine[]) => ChatLine[]) => {
      if (!sid) return;
      const prev = sessionLinesCacheRef.current.get(sid) ?? [];
      const next = mutator(prev);
      sessionLinesCacheRef.current.set(sid, next);
      const wp = workPathForSession(sid);
      if (hasRealChatContent(next)) {
        void persistChatHistory(sid, next, wp);
      }
    },
    [workPathForSession, persistChatHistory, hasRealChatContent],
  );

  const loadChatHistory = useCallback(
    async (sessionId: string, workPath?: string | null) => {
      try {
        const raw = await invoke<string | null>("load_chat_history", {
          sessionId,
          workPath: workPath || null,
        });
        if (!raw) return [] as ChatLine[];
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          console.warn("load_chat_history: invalid JSON", sessionId, e);
          return [] as ChatLine[];
        }
        if (!Array.isArray(parsed)) return [] as ChatLine[];
        const filtered = (parsed as ChatLine[]).filter(
          (l) => l && l.kind && l.kind !== "waiting" && !isConnectionNoise(l),
        );
        // Older histories may still have expanded thought/tool rows — fold them.
        return collapseAllTurnsInHistory(filtered);
      } catch (e) {
        console.warn("load_chat_history failed", sessionId, e);
        return [] as ChatLine[];
      }
    },
    [isConnectionNoise],
  );

  const refreshProjects = useCallback(async () => {
    try {
      const rows = await invoke<ProjectListRow[]>("list_projects");
      setProjects(rows);
      return rows;
    } catch {
      return [] as ProjectListRow[];
    }
  }, []);

  /**
   * Always load the full task list. UI splits them:
   * - under Projects → tasks whose project_id is a user project
   * - under Tasks → temporary / default-sandbox only
   */
  const refreshSessions = useCallback(async () => {
    try {
      let rows = await invoke<SessionListRow[]>("list_sessions");
      // Stable UI order: newest-created first. Clicking a task must not reorder.
      rows = [...rows].sort((a, b) => {
        const ca = Date.parse(a.created_at || a.updated_at);
        const cb = Date.parse(b.created_at || b.updated_at);
        return (Number.isFinite(cb) ? cb : 0) - (Number.isFinite(ca) ? ca : 0);
      });
      setSessions(rows);
      return rows;
    } catch {
      return [] as SessionListRow[];
    }
  }, []);

  /** After connect / activate: sync projects + tasks. */
  const refreshHierarchy = useCallback(
    async (opts?: {
      projectId?: string | null;
      projectRoot?: string | null;
      /** When true, keep Tasks unbound to Projects list (temporary task). */
      standaloneTask?: boolean;
    }) => {
      const projRows = await refreshProjects();
      // Only match against user-visible projects (default sandbox is filtered out).
      let pid: string | null =
        opts?.standaloneTask
          ? null
          : (opts?.projectId ?? selectedProjectId);
      if (pid && !projRows.some((p) => p.project_id === pid)) {
        pid = null;
      }
      if (!pid && opts?.projectRoot && !opts.standaloneTask) {
        const match = projRows.find((p) => p.root_path === opts.projectRoot);
        pid = match?.project_id ?? null;
      }
      if (pid) {
        setSelectedProjectId(pid);
        const hit = projRows.find((p) => p.project_id === pid);
        if (hit?.root_path) setProjectRoot(hit.root_path);
      } else if (opts?.standaloneTask) {
        setSelectedProjectId(null);
      }
      await refreshSessions();
      return pid;
    },
    [refreshProjects, refreshSessions, selectedProjectId],
  );

  type PushLine =
    | {
        kind: "user";
        text: string;
        id?: string;
        at?: string;
        attachments?: ChatAttachment[];
      }
    | { kind: "assistant"; text: string; id?: string }
    | { kind: "thought"; text: string; id?: string }
    | { kind: "tool"; text: string; id?: string }
    | { kind: "system"; text: string; id?: string }
    | { kind: "error"; text: string; id?: string }
    | { kind: "waiting"; text: string; id?: string };

  const push = useCallback(
    (line: PushLine) => {
      const full = {
        ...line,
        id: line.id ?? nextLineId(line.kind),
        ...(line.kind === "user" && !line.at
          ? { at: new Date().toISOString() }
          : {}),
      } as ChatLine;
      setLines((prev) => {
        const next = [...prev, full];
        linesRef.current = next;
        return next;
      });
      schedulePersistHistory();
      return full.id;
    },
    [schedulePersistHistory],
  );

  const appendAssistant = useCallback(
    (text: string) => {
      const now = Date.now();
      setLines((prev) => {
        // Drop waiting placeholder once real content starts.
        let base = prev;
        if (base.length && base[base.length - 1].kind === "waiting") {
          base = base.slice(0, -1);
        }
        const last = base[base.length - 1];
        let next: ChatLine[];
        if (last && last.kind === "assistant") {
          const copy = base.slice(0, -1);
          copy.push({ ...last, text: last.text + text });
          next = copy;
          if (assistantStreamStartedAtRef.current == null) {
            assistantStreamStartedAtRef.current = now;
          }
        } else {
          next = [
            ...base,
            { id: nextLineId("assistant"), kind: "assistant", text },
          ];
          assistantStreamStartedAtRef.current = now;
        }
        assistantStreamLastAtRef.current = now;
        linesRef.current = next;
        return next;
      });
      schedulePersistHistory();
    },
    [schedulePersistHistory],
  );

  const maybeAutoTitleFromChat = useCallback(async (chat: ChatLine[]) => {
    const sid = sessionIdRef.current;
    if (!sid || autoTitledSessionRef.current.has(sid)) return;

    const currentTitle =
      sessionsRef.current.find((s) => s.session_id === sid)?.title?.trim() ||
      "";
    const isPlaceholder =
      !currentTitle ||
      currentTitle === "New task" ||
      currentTitle === "Restored task";
    if (!isPlaceholder) {
      autoTitledSessionRef.current.add(sid);
      return;
    }

    const firstUser = chat.find(
      (l): l is Extract<ChatLine, { kind: "user" }> =>
        l.kind === "user" && Boolean(l.text.trim()),
    );
    const firstAssistant = chat.find(
      (l): l is Extract<ChatLine, { kind: "assistant" }> =>
        l.kind === "assistant" && Boolean(l.text.trim()),
    );
    if (!firstUser || !firstAssistant) return;

    const title = summarizeChatTitle(firstUser.text, firstAssistant.text);
    if (!title) return;

    autoTitledSessionRef.current.add(sid);
    try {
      await invoke("rename_session", { sessionId: sid, title });
      // Patch local list in place so order is unchanged (created_at sort on server).
      setSessions((prev) =>
        prev.map((s) => (s.session_id === sid ? { ...s, title } : s)),
      );
    } catch {
      autoTitledSessionRef.current.delete(sid);
    }
  }, []);

  /**
   * If the model ended with talk-only progress, warn in chat and auto-send a
   * one-shot follow-up that forces tool use + delivery confirmation.
   */
  const maybeHandleVerbalOnlyCompletion = useCallback(
    (chat: ChatLine[]) => {
      if (autoNudgeInFlightRef.current) return;
      const hit = detectVerbalOnlyCompletion(
        chat as Parameters<typeof detectVerbalOnlyCompletion>[0],
      );
      if (!hit) return;

      // Always surface a clear system note; auto-continue only once per user send.
      const canAutoNudge = hit.shouldNudge && !verbalNudgeUsedRef.current;
      const warnText = canAutoNudge
        ? hit.warning
        : hit.warning.replace(
            /将自动续跑一次[^\n]*/g,
            "请手动再发一条明确指令（要求执行工具并确认文件存在）。",
          );
      if (canAutoNudge) verbalNudgeUsedRef.current = true;

      const warnLine: ChatLine = {
        id: nextLineId("system"),
        kind: "system",
        text: warnText,
      };
      const withWarn = [...chat, warnLine];
      setLines(withWarn);
      linesRef.current = withWarn;
      void flushPersistHistory();

      if (!canAutoNudge) return;
      if (!sessionIdRef.current) return;

      autoNudgeInFlightRef.current = true;
      // Brief delay so UI paints the warning before the next turn starts.
      window.setTimeout(() => {
        void (async () => {
          const sid = sessionIdRef.current;
          if (!sid) {
            autoNudgeInFlightRef.current = false;
            return;
          }
          // User bubble for the auto-continue (visible, so history is honest).
          const userId = nextLineId("user");
          const waitingId = nextLineId("waiting");
          const nudged: ChatLine[] = [
            ...linesRef.current,
            {
              id: userId,
              kind: "user",
              text: "（自动续跑）请用工具完成交付并确认文件存在",
              at: new Date().toISOString(),
            },
            {
              id: waitingId,
              kind: "waiting",
              text: t("chat.thinking"),
            },
          ];
          setLines(nudged);
          linesRef.current = nudged;
          turnStartedAtRef.current = Date.now();
          setSessionBusyState(sid, true);
          // Resume bottom follow for the auto-continue turn.
          autoScrollEnabledRef.current = true;
          userScrollIntentRef.current = false;
          try {
            await invoke("send_prompt_rich", {
              payload: {
                text: VERBAL_COMPLETION_NUDGE,
                attachments: [],
                model: modelId || null,
                effort: null,
              },
            });
          } catch (e) {
            setSessionBusyState(sid, false);
            // Drop waiting placeholder on send failure.
            setLines((prev) => {
              if (prev.length && prev[prev.length - 1].kind === "waiting") {
                const next = prev.slice(0, -1);
                linesRef.current = next;
                return next;
              }
              return prev;
            });
            push({ kind: "error", text: String(e) });
          } finally {
            autoNudgeInFlightRef.current = false;
          }
        })();
      }, 350);
    },
    [flushPersistHistory, setSessionBusyState, push, modelId],
  );

  const finishTurnCollapse = useCallback(
    (error?: boolean) => {
      const started = turnStartedAtRef.current;
      turnStartedAtRef.current = null;
      const durationMs = started != null ? Date.now() - started : 0;

      // Stamp generation speed on the last assistant reply in this turn.
      const streamStart = assistantStreamStartedAtRef.current;
      const streamEnd = assistantStreamLastAtRef.current ?? Date.now();
      assistantStreamStartedAtRef.current = null;
      assistantStreamLastAtRef.current = null;

      let finalChat: ChatLine[] | null = null;

      setLines((prev) => {
        let next = collapseTurnProcess(prev, durationMs);

        // Attach ~tokens / tok/s to the latest assistant message (after last user).
        let lastUser = -1;
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].kind === "user") {
            lastUser = i;
            break;
          }
        }
        let lastAsst = -1;
        for (let i = next.length - 1; i > lastUser; i--) {
          if (next[i].kind === "assistant") {
            lastAsst = i;
            break;
          }
        }
        if (lastAsst >= 0) {
          const asst = next[lastAsst];
          if (asst.kind === "assistant" && asst.text.trim()) {
            const tokens = estimateTokens(asst.text);
            const streamMs =
              streamStart != null
                ? Math.max(1, streamEnd - streamStart)
                : undefined;
            const tokensPerSec =
              streamMs != null && streamMs >= 50
                ? tokens / (streamMs / 1000)
                : undefined;
            next = next.slice();
            next[lastAsst] = {
              ...asst,
              tokens,
              streamMs,
              tokensPerSec,
            };
          }
        }

        if (error) {
          const hasError = next.some((l) => l.kind === "error");
          if (!hasError) {
            next = [
              ...next,
              {
                id: nextLineId("error"),
                kind: "error",
                text: t("chat.turnError"),
              },
            ];
          }
        }
        linesRef.current = next;
        finalChat = next;
        // After first successful assistant reply, summarize and rename the task.
        if (!error) {
          void maybeAutoTitleFromChat(next);
        }
        return next;
      });

      // Late tool/thought events can race turn_finished — collapse once more
      // from the latest ref after React state has been scheduled.
      window.setTimeout(() => {
        const stillRaw = linesRef.current.some(
          (l, i, arr) => {
            if (!isProcessLine(l)) return false;
            // Only care about process lines after the last user.
            let lastUser = -1;
            for (let j = arr.length - 1; j >= 0; j--) {
              if (arr[j].kind === "user") {
                lastUser = j;
                break;
              }
            }
            return i > lastUser;
          },
        );
        if (!stillRaw) return;
        const repaired = collapseTurnProcess(linesRef.current, durationMs);
        linesRef.current = repaired;
        setLines(repaired);
        void flushPersistHistory();
      }, 80);

      // Persist immediately after a turn settles.
      void flushPersistHistory();

      // Premature verbal-only completion → warn + one auto-continue.
      if (!error && finalChat) {
        maybeHandleVerbalOnlyCompletion(finalChat);
      }
    },
    [
      flushPersistHistory,
      maybeAutoTitleFromChat,
      maybeHandleVerbalOnlyCompletion,
    ],
  );

  const toggleTrace = useCallback(
    (id: string) => {
      setLines((prev) => {
        const next = prev.map((line) =>
          line.kind === "trace" && line.id === id
            ? { ...line, expanded: !line.expanded }
            : line,
        );
        linesRef.current = next;
        return next;
      });
      schedulePersistHistory();
    },
    [schedulePersistHistory],
  );

  const appendThought = useCallback(
    (text: string) => {
      setLines((prev) => {
        let base = prev;
        if (base.length && base[base.length - 1].kind === "waiting") {
          base = base.slice(0, -1);
        }
        const last = base[base.length - 1];
        let next: ChatLine[];
        if (last && last.kind === "thought") {
          const copy = base.slice(0, -1);
          copy.push({ ...last, text: last.text + text });
          next = copy;
        } else {
          next = [
            ...base,
            { id: nextLineId("thought"), kind: "thought", text },
          ];
        }
        linesRef.current = next;
        return next;
      });
      schedulePersistHistory();
    },
    [schedulePersistHistory],
  );

  const clearWaiting = useCallback(() => {
    setLines((prev) => {
      if (prev.length && prev[prev.length - 1].kind === "waiting") {
        const next = prev.slice(0, -1);
        linesRef.current = next;
        return next;
      }
      return prev;
    });
  }, []);

  /**
   * Stuck-Working watchdog: UI may stay Working after a missed turn_finished
   * (soft timeout / reconnect race). If chat is idle and backend reports not
   * busy, clear Working so the user is not stuck.
   */
  const lastChatFingerprintRef = useRef("");
  const lastChatChangeAtRef = useRef(Date.now());
  useEffect(() => {
    if (!busy) return;
    const sid = session?.session_id;
    if (!sid) return;

    const fingerprint = () => {
      const chat = linesRef.current;
      const last = chat[chat.length - 1];
      return `${chat.length}:${last?.id ?? ""}:${last?.kind ?? ""}:${
        last && "text" in last ? String(last.text ?? "").length : 0
      }`;
    };
    lastChatFingerprintRef.current = fingerprint();
    lastChatChangeAtRef.current = Date.now();

    const id = window.setInterval(() => {
      if (!busyRef.current) return;
      if (sessionIdRef.current !== sid) return;
      if (pendingPermsRef.current.some((p) => p.session_id === sid)) return;

      const fp = fingerprint();
      if (fp !== lastChatFingerprintRef.current) {
        lastChatFingerprintRef.current = fp;
        lastChatChangeAtRef.current = Date.now();
        return;
      }

      const idleMs = Date.now() - lastChatChangeAtRef.current;
      // Short streaming pauses are normal; only probe after real idle.
      if (idleMs < 12_000) return;

      void invoke<boolean>("is_session_busy", { sessionId: sid })
        .then((stillBusy) => {
          if (sessionIdRef.current !== sid) return;
          if (!busyRef.current) return;
          if (stillBusy) return;
          console.warn(
            "busy watchdog: backend idle, clearing stuck Working",
            sid,
          );
          setSessionBusyState(sid, false);
          setLongRunNotice(null);
          clearWaiting();
          finishTurnCollapse(false);
        })
        .catch(() => {
          /* ignore */
        });
    }, 5000);

    return () => window.clearInterval(id);
  }, [
    busy,
    session?.session_id,
    pendingPerms.length,
    setSessionBusyState,
    finishTurnCollapse,
    clearWaiting,
  ]);

  const lastUserMessage = useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].kind === "user") return lines[i] as Extract<ChatLine, { kind: "user" }>;
    }
    return null;
  }, [lines]);

  /** Every user prompt in this session — for the right-edge outline rail. */
  const sessionOutlineEntries = useMemo(
    () =>
      lines
        .filter(
          (l): l is Extract<ChatLine, { kind: "user" }> => l.kind === "user",
        )
        .map((l) => ({ id: l.id, text: l.text, at: l.at })),
    [lines],
  );

  const toggleSessionOutline = useCallback(() => {
    setSessionOutlineCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(
          "grokx.sessionOutlineCollapsed",
          next ? "1" : "0",
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const distanceFromBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const isNearBottom = useCallback(
    (el: HTMLElement, threshold = 96) => distanceFromBottom(el) <= threshold,
    [distanceFromBottom],
  );

  /** Snapshot current chat viewport for the active task (call before switching away). */
  const saveSessionScroll = useCallback(
    (sessionId: string | null | undefined) => {
      if (!sessionId) return;
      const el = chatScrollRef.current;
      if (!el) return;
      const pinBottom = distanceFromBottom(el) <= 80;
      sessionScrollRef.current.set(sessionId, {
        scrollTop: el.scrollTop,
        pinBottom,
        autoScroll: autoScrollEnabledRef.current || pinBottom,
      });
    },
    [distanceFromBottom],
  );

  /**
   * Restore a task's saved scroll after its transcript is in the DOM.
   * Double rAF waits for layout after setLines (scrollTop assignment fires
   * the existing scroll listener for sticky updates).
   */
  const restoreSessionScroll = useCallback((sessionId: string) => {
    const apply = () => {
      const el = chatScrollRef.current;
      if (!el) return;
      const saved = sessionScrollRef.current.get(sessionId);
      lastProgrammaticScrollRef.current = performance.now() + 160;

      if (!saved || saved.pinBottom) {
        el.scrollTop = el.scrollHeight;
        autoScrollEnabledRef.current = true;
        userScrollIntentRef.current = false;
      } else {
        const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(Math.max(0, saved.scrollTop), maxTop);
        // Stay where the user left off — do not auto-follow until they send
        // or intentionally return to the bottom.
        autoScrollEnabledRef.current = false;
        userScrollIntentRef.current = true;
      }
    };

    // First frame: React commit; second: layout with restored lines.
    requestAnimationFrame(() => {
      requestAnimationFrame(apply);
    });
  }, []);

  /**
   * Silky follow to bottom while auto-scroll is on.
   * Exponential ease each frame (no hard 14px cap) so stream growth doesn't
   * feel like stop-start steps. Keeps looping while still away from bottom
   * or while the turn is busy (content may keep growing).
   */
  const ensureSmoothAutoScroll = useCallback(() => {
    if (!autoScrollEnabledRef.current) return;
    if (scrollAnimRef.current != null) return;

    const step = () => {
      scrollAnimRef.current = null;
      if (!autoScrollEnabledRef.current) return;
      const el = chatScrollRef.current;
      if (!el) return;

      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const remaining = maxTop - el.scrollTop;

      if (remaining <= 0.5) {
        if (remaining > 0) {
          lastProgrammaticScrollRef.current = performance.now();
          el.scrollTop = maxTop;
        }
        // While Working, keep a cheap poll so new stream height is chased
        // without waiting for the next React commit (smoother than restart).
        if (busyRef.current) {
          scrollAnimRef.current = requestAnimationFrame(step);
        }
        return;
      }

      // Distance-adaptive ease: catch up when far, soft land when close.
      // Higher than the old 0.08 so we don't lag in visible "jumps".
      const ease =
        remaining > 320 ? 0.28 : remaining > 120 ? 0.2 : remaining > 40 ? 0.15 : 0.12;
      let delta = remaining * ease;
      // Gentle floor so we never stall on sub-pixel leftovers.
      if (delta < 1.2) delta = Math.min(1.2, remaining);
      // Soft ceiling only for huge reflows (virtual list remount) — still smooth.
      if (delta > 96) delta = 96;

      lastProgrammaticScrollRef.current = performance.now();
      el.scrollTop = Math.min(maxTop, el.scrollTop + delta);
      scrollAnimRef.current = requestAnimationFrame(step);
    };

    scrollAnimRef.current = requestAnimationFrame(step);
  }, []);

  const enableAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    ensureSmoothAutoScroll();
  }, [ensureSmoothAutoScroll]);

  const disableAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = false;
    if (scrollAnimRef.current != null) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
  }, []);

  const updateScrollToBottomVisible = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) {
      setShowScrollToBottom(false);
      return;
    }
    // Enough content below the fold that a jump-to-bottom control is useful.
    const overflow = el.scrollHeight - el.clientHeight > 80;
    const away = distanceFromBottom(el) > 96;
    setShowScrollToBottom(overflow && away);
  }, [distanceFromBottom]);

  const applyStickyUserId = useCallback((next: string | null) => {
    if (stickyUserIdRef.current === next) return;
    stickyUserIdRef.current = next;
    setStickyUserId(next);
  }, []);

  const updateStickyUser = useCallback(() => {
    const scroller = chatScrollRef.current;
    if (!scroller || !lastUserMessage) {
      applyStickyUserId(null);
      return;
    }
    const el = userMsgEls.current.get(lastUserMessage.id);
    if (!el) {
      // Message just added — keep sticky once there's content after it.
      const idx = lines.findIndex((l) => l.id === lastUserMessage.id);
      const hasAfter = idx >= 0 && idx < lines.length - 1;
      applyStickyUserId(hasAfter ? lastUserMessage.id : null);
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const msgRect = el.getBoundingClientRect();
    // Sticky when the user bubble has scrolled above the visible chat area.
    // Hysteresis avoids flicker at the threshold while trackpad-scrolling.
    const currentlySticky = stickyUserIdRef.current === lastUserMessage.id;
    const scrolledPast = currentlySticky
      ? msgRect.bottom < scrollerRect.top + 28
      : msgRect.bottom < scrollerRect.top + 4;
    const idx = lines.findIndex((l) => l.id === lastUserMessage.id);
    const hasAfter = idx >= 0 && idx < lines.length - 1;
    applyStickyUserId(scrolledPast && hasAfter ? lastUserMessage.id : null);
  }, [lastUserMessage, lines, applyStickyUserId]);

  /** Schedule sticky check once per frame — never every raw scroll event. */
  const scheduleStickyUser = useCallback(() => {
    if (stickyRafRef.current != null) return;
    stickyRafRef.current = requestAnimationFrame(() => {
      stickyRafRef.current = null;
      updateStickyUser();
    });
  }, [updateStickyUser]);

  const jumpToBottom = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    // Resume live follow; keep programmatic guard long enough for measure passes.
    lastProgrammaticScrollRef.current = performance.now() + 900;
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    setShowScrollToBottom(false);
    // Expand virtual window with a few snaps, then ease the rest (less jarring).
    const snap = () => {
      const root = chatScrollRef.current;
      if (!root) return;
      root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
    };
    const far = distanceFromBottom(el) > 400;
    if (far) {
      // One quick jump most of the way, then silky finish.
      el.scrollTop = Math.max(
        0,
        el.scrollHeight - el.clientHeight - 120,
      );
    }
    requestAnimationFrame(() => {
      ensureSmoothAutoScroll();
      requestAnimationFrame(() => ensureSmoothAutoScroll());
    });
    window.setTimeout(() => {
      if (autoScrollEnabledRef.current) ensureSmoothAutoScroll();
    }, 40);
    window.setTimeout(() => {
      if (autoScrollEnabledRef.current) ensureSmoothAutoScroll();
      updateScrollToBottomVisible();
      scheduleStickyUser();
    }, 160);
    window.setTimeout(() => {
      // Final alignment after RO measures.
      if (autoScrollEnabledRef.current) {
        snap();
        ensureSmoothAutoScroll();
      }
      updateScrollToBottomVisible();
    }, 320);
  }, [
    scheduleStickyUser,
    updateScrollToBottomVisible,
    distanceFromBottom,
    ensureSmoothAutoScroll,
  ]);

  // When chat content grows, ease toward bottom only if auto-follow is on.
  // If the user is already at the live edge, keep / restore follow.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el && isNearBottom(el, 120) && !userScrollIntentRef.current) {
      autoScrollEnabledRef.current = true;
    }
    if (!autoScrollEnabledRef.current) {
      scheduleStickyUser();
      updateScrollToBottomVisible();
      return;
    }
    ensureSmoothAutoScroll();
    scheduleStickyUser();
    requestAnimationFrame(() => updateScrollToBottomVisible());
  }, [
    lines,
    busy,
    pendingPerms.length,
    ensureSmoothAutoScroll,
    scheduleStickyUser,
    updateScrollToBottomVisible,
    isNearBottom,
  ]);

  // Detect user-driven scroll vs programmatic ease.
  useEffect(() => {
    const scroller = chatScrollRef.current;
    if (!scroller) return;

    const markUserIntent = () => {
      userScrollIntentRef.current = true;
      lastUserScrollAtRef.current = performance.now();
      // Any deliberate scroll away from the live edge — stop following.
      disableAutoScroll();
    };

    const onWheel = (e: WheelEvent) => {
      // Scroll up → leave the latest line, stop auto-follow.
      if (e.deltaY < 0) {
        markUserIntent();
        return;
      }
      // Scroll down while already away from bottom → stay in manual mode.
      if (!isNearBottom(scroller, 120)) {
        markUserIntent();
      }
      // Scroll down near bottom → keep pinned (do not disable).
    };
    const onTouchStart = () => {
      // Touch may be a flick either way; decide on scroll end via near-bottom.
      lastUserScrollAtRef.current = performance.now();
    };
    const onPointerDown = (e: PointerEvent) => {
      // Only scrollbar / content drag — not every click (avoids fighting Jump, etc.).
      const t = e.target as HTMLElement | null;
      if (t?.closest("button, a, input, textarea, select, label")) return;
      if (e.pointerType === "mouse" || e.pointerType === "pen" || e.pointerType === "touch") {
        // Likely scrollbar drag starts with pointerdown on the scroller chrome.
        if (e.offsetX >= scroller.clientWidth) {
          markUserIntent();
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "Home" ||
        e.key === "End" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === " "
      ) {
        // Only if chat is focused / event not from input.
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable))
          return;
        if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") {
          markUserIntent();
        } else if (!isNearBottom(scroller, 120)) {
          markUserIntent();
        }
      }
    };

    const onScroll = () => {
      scheduleStickyUser();
      updateScrollToBottomVisible();
      // Ignore scroll events we just caused programmatically.
      if (performance.now() < lastProgrammaticScrollRef.current) {
        return;
      }
      if (performance.now() - lastProgrammaticScrollRef.current < 48) {
        return;
      }
      // Native scrollbar drag often only fires scroll, not pointer on content.
      if (userScrollIntentRef.current) {
        // If they scrolled back to the live edge, allow re-pin on scroll-end.
        if (!isNearBottom(scroller, 120)) {
          disableAutoScroll();
        }
        return;
      }
      // If user dragged scrollbar without prior intent flag, treat large jumps
      // away from bottom as manual.
      if (!isNearBottom(scroller, 120)) {
        disableAutoScroll();
      }
    };

    // Re-enable when user scrolls back to the live edge — after inertia settles.
    const onScrollEndCheck = () => {
      // Trackpad inertia can keep scrolling 200–400ms after last wheel event.
      if (performance.now() - lastUserScrollAtRef.current < 280) return;
      if (isNearBottom(scroller, 96)) {
        // At latest content — resume gentle follow.
        userScrollIntentRef.current = false;
        if (!autoScrollEnabledRef.current) {
          enableAutoScroll();
        }
      }
    };

    let endTimer: ReturnType<typeof setTimeout> | null = null;
    const onScrollWithEnd = () => {
      onScroll();
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(onScrollEndCheck, 220);
    };

    const onResize = () => {
      scheduleStickyUser();
      updateScrollToBottomVisible();
      if (autoScrollEnabledRef.current) ensureSmoothAutoScroll();
    };

    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroller.addEventListener("scroll", onScrollWithEnd, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    scheduleStickyUser();
    updateScrollToBottomVisible();

    return () => {
      if (endTimer) clearTimeout(endTimer);
      if (scrollAnimRef.current != null) {
        cancelAnimationFrame(scrollAnimRef.current);
        scrollAnimRef.current = null;
      }
      if (stickyRafRef.current != null) {
        cancelAnimationFrame(stickyRafRef.current);
        stickyRafRef.current = null;
      }
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("scroll", onScrollWithEnd);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [
    scheduleStickyUser,
    updateScrollToBottomVisible,
    view,
    disableAutoScroll,
    enableAutoScroll,
    isNearBottom,
    ensureSmoothAutoScroll,
  ]);

  const jumpToUserMessage = useCallback(
    (id: string) => {
      const scroller = chatScrollRef.current;
      if (!scroller) return;

      // Manual navigation — pause auto-follow so we don't race back to bottom.
      disableAutoScroll();
      // Sticky is an absolute overlay (not in scroll flow). Hide it and scroll
      // immediately — waiting for reflow made the first click feel like a no-op.
      stickyUserIdRef.current = null;
      setStickyUserId(null);
      setHighlightUserId(id);

      // Small inset so the user bubble isn't flush against the top edge.
      const topPad = 16;
      const gen = ++jumpAlignGenRef.current;

      /**
       * Prefer measured prefix from VirtualChatList (accounts for real markdown
       * heights). Fall back to estimateChatLineHeight only if the list handle
       * is missing or the id is unknown.
       */
      const scrollByOffset = () => {
        const root = chatScrollRef.current;
        if (!root || jumpAlignGenRef.current !== gen) return;
        const fromList = virtualChatRef.current?.offsetOf(id);
        let offset: number;
        if (fromList != null) {
          offset = fromList;
        } else {
          let approx = 0;
          for (const line of linesRef.current) {
            if (line.id === id) break;
            approx += estimateChatLineHeight(line);
          }
          offset = approx;
        }
        lastProgrammaticScrollRef.current = performance.now() + 800;
        root.scrollTop = Math.max(0, offset - topPad);
      };

      /** Once the row is mounted, pin by getBoundingClientRect (true layout). */
      const alignToUser = (): boolean => {
        if (jumpAlignGenRef.current !== gen) return true;
        const target = userMsgEls.current.get(id);
        const root = chatScrollRef.current;
        if (!target || !root) return false;
        const rootRect = root.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop =
          root.scrollTop + (targetRect.top - rootRect.top) - topPad;
        // Only nudge when meaningfully off — avoids jitter from subpixel noise.
        if (Math.abs(root.scrollTop - nextTop) > 1) {
          lastProgrammaticScrollRef.current = performance.now() + 800;
          root.scrollTop = Math.max(0, nextTop);
        }
        return true;
      };

      // If the row is already mounted, pin by layout immediately — do not
      // first apply a coarse offset (estimates can yank away from the truth).
      const alreadyMounted = Boolean(userMsgEls.current.get(id));
      if (alreadyMounted) {
        alignToUser();
      } else {
        // Coarse jump so the virtual window mounts the target row.
        scrollByOffset();
      }

      // Multi-pass fine alignment while virtual topPad / RO measurements settle.
      const delays = alreadyMounted
        ? [0, 16, 48, 120]
        : [0, 16, 32, 64, 120, 220, 400];
      for (const ms of delays) {
        window.setTimeout(() => {
          if (jumpAlignGenRef.current !== gen) return;
          if (!alignToUser()) {
            // Still not mounted — re-apply measured offset (may have updated).
            scrollByOffset();
            requestAnimationFrame(() => {
              if (jumpAlignGenRef.current !== gen) return;
              if (!alignToUser()) scrollByOffset();
            });
          }
        }, ms);
      }

      window.setTimeout(() => {
        if (jumpAlignGenRef.current !== gen) return;
        setHighlightUserId((cur) => (cur === id ? null : cur));
      }, 1600);
      window.setTimeout(() => {
        if (jumpAlignGenRef.current !== gen) return;
        updateStickyUser();
        updateScrollToBottomVisible();
      }, 240);
    },
    [updateStickyUser, updateScrollToBottomVisible, disableAutoScroll],
  );

  const stickyUserText = useMemo(() => {
    if (!stickyUserId) return null;
    const line = lines.find((l) => l.id === stickyUserId && l.kind === "user");
    return line && line.kind === "user" ? line.text : null;
  }, [stickyUserId, lines]);

  const selectableModels = useMemo(() => {
    const out: {
      id: string;
      name: string;
      vendorKind: VendorKind;
    }[] = [];
    for (const v of vendors) {
      for (const m of v.models) {
        if (!m.enabled || isVendorPlaceholderModel(m.id)) continue;
        // Media backends (Qwen Image / HappyHorse) are MCP tools, not chat models.
        const cap = resolveModelCapability(m.id, m.capability);
        if (!isAgentChatCapability(cap)) continue;
        out.push({
          id: m.id,
          name: displayNameForModel(m.id, v.kind),
          vendorKind: v.kind,
        });
      }
    }
    return out;
  }, [vendors]);

  const modelProfiles = useMemo(
    () =>
      vendorsToProfiles(vendors).filter(
        (p) => !isVendorPlaceholderModel(p.model_id) && p.enabled !== false,
      ),
    [vendors],
  );

  const chatDefaultProfiles = useMemo(
    () =>
      modelProfiles.filter((p) =>
        isAgentChatCapability(
          resolveModelCapability(p.model_id, p.capability ?? null),
        ),
      ),
    [modelProfiles],
  );

  const imageDefaultProfiles = useMemo(
    () =>
      modelProfiles.filter(
        (p) =>
          resolveModelCapability(p.model_id, p.capability ?? null) === "image",
      ),
    [modelProfiles],
  );

  const videoDefaultProfiles = useMemo(
    () =>
      modelProfiles.filter(
        (p) =>
          resolveModelCapability(p.model_id, p.capability ?? null) === "video",
      ),
    [modelProfiles],
  );

  const pendingHasImages = useMemo(
    () => attachments.some((a) => !a.isDir && isImageAttachment(a)),
    [attachments],
  );

  /** Draft path chips / text for folder+识图 banner (updated on settle). */
  const [draftPathMeta, setDraftPathMeta] = useState<{
    hasFolderChip: boolean;
    hasImagePathChip: boolean;
    text: string;
  }>({ hasFolderChip: false, hasImagePathChip: false, text: "" });

  /** Concrete chat model for the next turn (tier mode auto-resolves). */
  const effectiveChatModelId = useMemo(() => {
    if (modelSelectionMode !== "tier") return modelId;
    const needVision =
      pendingHasImages ||
      draftPathMeta.hasImagePathChip ||
      looksLikeMediaGenIntent(draftPathMeta.text) ||
      (draftPathMeta.hasFolderChip &&
        looksLikeVisionIntent(draftPathMeta.text));
    const resolved = resolveModelForPerformanceTier(
      vendors,
      performanceTier,
      needVision ? "vision" : "chat",
    );
    return resolved?.modelId || modelId;
  }, [
    modelSelectionMode,
    modelId,
    vendors,
    performanceTier,
    pendingHasImages,
    draftPathMeta,
  ]);

  const currentModelSupportsVision = useMemo(() => {
    const fromVendor = vendors
      .flatMap((v) => v.models.map((m) => ({ ...m, vendorKind: v.kind })))
      .find((m) => m.id === effectiveChatModelId);
    return supportsVisionInput(
      effectiveChatModelId,
      resolveModelCapability(effectiveChatModelId, fromVendor?.capability ?? null),
    );
  }, [vendors, effectiveChatModelId]);

  const availableVisionModels = useMemo(
    () =>
      listVisionCapableModels(
        vendors.flatMap((v) =>
          v.models.map((m) => ({
            id: m.id,
            name: displayNameForModel(m.id, v.kind),
            capability: resolveModelCapability(m.id, m.capability),
            enabled: m.enabled !== false,
          })),
        ),
      ).filter((m) => m.id !== effectiveChatModelId),
    [vendors, effectiveChatModelId],
  );

  const folderVisionIntent =
    !currentModelSupportsVision &&
    (draftPathMeta.hasImagePathChip ||
      (draftPathMeta.hasFolderChip &&
        looksLikeVisionIntent(draftPathMeta.text)));

  const mediaGenIntent =
    !currentModelSupportsVision && looksLikeMediaGenIntent(draftPathMeta.text);

  const visionMismatch =
    (!currentModelSupportsVision && pendingHasImages) ||
    folderVisionIntent ||
    mediaGenIntent;

  const formatVisionSuggestions = useCallback(() => {
    return availableVisionModels
      .slice(0, 4)
      .map((m) => m.name)
      .join(", ");
  }, [availableVisionModels]);

  const openVlmRequiredModal = useCallback(() => {
    setVlmRequiredModalOpen(true);
  }, []);

  const visionGuardMessage = useCallback(
    (opts: {
      text?: string;
      atts?: Array<{
        mime?: string | null;
        name?: string;
        path?: string;
        isDir?: boolean;
      }>;
    }) => {
      if (currentModelSupportsVision) return null;
      const text = opts.text ?? "";
      const atts = opts.atts ?? [];
      const hasImageAtt = atts.some((a) => !a.isDir && isImageAttachment(a));
      const hasFolder = atts.some((a) => Boolean(a.isDir));
      const hasImagePath = atts.some(
        (a) =>
          !a.isDir &&
          isImageAttachment({ name: a.name || a.path, mime: a.mime }),
      );
      // Image path chip alone is enough; folder + vision-ish text (incl. exts).
      const folderAsk =
        hasImagePath || (hasFolder && looksLikeVisionIntent(text));
      const mediaGenAsk = looksLikeMediaGenIntent(text);

      if (!hasImageAtt && !folderAsk && !mediaGenAsk) return null;

      const modelLabel = displayNameForModel(effectiveChatModelId);
      const suggestions = formatVisionSuggestions();
      if (mediaGenAsk) {
        if (availableVisionModels.length > 0) {
          return t("err.needVlmMediaGen", { model: modelLabel, suggestions });
        }
        return t("err.needVlmMediaGenNone", { model: modelLabel });
      }
      if (hasImageAtt) {
        if (availableVisionModels.length > 0) {
          return t("err.needVlm", { model: modelLabel, suggestions });
        }
        return t("err.needVlmNone", { model: modelLabel });
      }
      if (availableVisionModels.length > 0) {
        return t("err.needVlmFolder", { model: modelLabel, suggestions });
      }
      return t("err.needVlmFolderNone", { model: modelLabel });
    },
    [
      availableVisionModels.length,
      currentModelSupportsVision,
      formatVisionSuggestions,
      effectiveChatModelId,
      t,
    ],
  );

  /** Map engine/product error codes to localized UI text (no blind -32603→vision). */
  const formatAgentErrorMessage = useCallback(
    (raw: string, explicitCode?: string | null): string => {
      const { code, displaySource } = classifyAgentError(raw, explicitCode);
      const modelLabel = displayNameForModel(modelId);
      const suggestions = formatVisionSuggestions();
      switch (code) {
        case "NETWORK":
          return t("err.app.NETWORK");
        case "CONTEXT_OVERFLOW":
          return t("err.app.CONTEXT_OVERFLOW");
        case "WEB_SEARCH_UNAVAILABLE":
          return t("err.app.WEB_SEARCH_UNAVAILABLE");
        case "RATE_LIMIT":
          return t("err.app.RATE_LIMIT");
        case "AUTH":
          return t("err.app.AUTH");
        case "VISION_REQUIRED":
          openVlmRequiredModal();
          if (availableVisionModels.length > 0) {
            return t("err.app.VISION_REQUIRED", {
              model: modelLabel,
              suggestions,
            });
          }
          return t("err.app.VISION_REQUIRED_NONE", { model: modelLabel });
        case "INTERNAL":
        default: {
          // Soft / known non-errors: keep original text.
          if (
            /timed out|still be working|still working|自动续跑|接着写|继续追加|输出超长|max_tokens_truncation|分段策略|Plan B/i.test(
              displaySource,
            )
          ) {
            return displaySource;
          }
          const detail =
            displaySource.trim() ||
            raw.replace(/agent RPC error\s*-?\d+:\s*/i, "").trim() ||
            raw;
          return t("err.app.INTERNAL", { detail });
        }
      }
    },
    [
      availableVisionModels.length,
      formatVisionSuggestions,
      modelId,
      openVlmRequiredModal,
      t,
    ],
  );
  const formatAgentErrorMessageRef = useRef(formatAgentErrorMessage);
  formatAgentErrorMessageRef.current = formatAgentErrorMessage;

  const contextWindow = useMemo(() => {
    const active =
      modelProfiles.find((p) => p.model_id === modelId) ?? modelProfiles[0];
    const n = Number(active?.context_window ?? 500_000);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return 500_000;
  }, [modelProfiles, modelId]);

  const estimatedContextTokens = useMemo(
    () => estimateSessionTokens(lines, draftForMeter),
    [lines, draftForMeter],
  );

  const clearComposer = useCallback(() => {
    composerRef.current?.clear();
    setDraftForMeter("");
    setComposerHasText(false);
    setGoalDraftArmed(false);
    setDraftPathMeta({
      hasFolderChip: false,
      hasImagePathChip: false,
      text: "",
    });
  }, []);

  const onComposerDraftChange = useCallback((text: string) => {
    setComposerHasText(Boolean(text.trim()));
    setGoalDraftArmed(/^\/goal(\s|$)/i.test(text.trim()));
    const payload = composerRef.current?.getPayload();
    const chips = payload?.pathChips ?? [];
    setDraftPathMeta({
      hasFolderChip: chips.some((c) => c.isDir),
      hasImagePathChip: chips.some(
        (c) => !c.isDir && isImageAttachment({ name: c.name || c.path }),
      ),
      text: payload?.text ?? text,
    });
  }, []);

  const onComposerDraftSettled = useCallback((text: string) => {
    setDraftForMeter(text);
    const payload = composerRef.current?.getPayload();
    const chips = payload?.pathChips ?? [];
    setDraftPathMeta({
      hasFolderChip: chips.some((c) => c.isDir),
      hasImagePathChip: chips.some(
        (c) => !c.isDir && isImageAttachment({ name: c.name || c.path }),
      ),
      text: payload?.text ?? text,
    });
  }, []);

  const resolveComposerPath = useCallback(
    async (raw: string): Promise<PathChipData | null> => {
      const trimmed = raw.trim().replace(/^["']|["']$/g, "");
      if (!trimmed) return null;
      try {
        const resolved = await invoke<
          Array<{
            path: string;
            name?: string | null;
            is_dir?: boolean | null;
          }>
        >("resolve_drop_paths", { paths: [trimmed] });
        const hit = resolved?.[0];
        if (!hit?.path) return null;
        return {
          path: hit.path,
          name:
            hit.name ||
            hit.path.replace(/[\\/]+$/, "").split(/[/\\]/).pop() ||
            hit.path,
          isDir: Boolean(hit.is_dir),
        };
      } catch {
        return null;
      }
    },
    [],
  );

  // Prefer engine total only when it is for the active non-empty context;
  // empty new tasks should show ~0, not a stale process total.
  const contextUsed =
    engineContextTokens != null &&
    (estimatedContextTokens > 0 || engineContextTokens < 200)
      ? engineContextTokens
      : estimatedContextTokens;
  const contextFromEngine =
    engineContextTokens != null &&
    (estimatedContextTokens > 0 || engineContextTokens < 200);
  const contextPct = Math.min(
    100,
    Math.max(0, (contextUsed / contextWindow) * 100),
  );
  const contextMeterClass =
    contextPct >= 90
      ? "context-meter high"
      : contextPct >= 70
        ? "context-meter mid"
        : "context-meter";

  /**
   * Strip common Markdown so clipboard plain-text is readable outside MD editors.
   * Keeps link URLs and code content; drops fences / emphasis / headings markup.
   */
  const markdownToPlainText = useCallback((md: string): string => {
    let s = md.replace(/\r\n/g, "\n");
    // Fenced code blocks → inner code only
    s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) =>
      String(code).replace(/\n$/, ""),
    );
    // Inline code
    s = s.replace(/`([^`]+)`/g, "$1");
    // Images ![alt](url) → alt (url)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) =>
      alt ? `${alt} (${url})` : url,
    );
    // Links [text](url) → text (url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    );
    // Autolinks <https://...>
    s = s.replace(/<(https?:\/\/[^>]+)>/g, "$1");
    // Headings
    s = s.replace(/^#{1,6}\s+/gm, "");
    // Blockquotes
    s = s.replace(/^>\s?/gm, "");
    // List markers
    s = s.replace(/^\s*[-*+]\s+/gm, "• ");
    s = s.replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/^\s*/, ""));
    // Bold / italic / strike (order matters: longer delimiters first)
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
    s = s.replace(/___([^_]+)___/g, "$1");
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
    s = s.replace(/__([^_]+)__/g, "$1");
    s = s.replace(/\*([^*\n]+)\*/g, "$1");
    s = s.replace(/_([^_\n]+)_/g, "$1");
    s = s.replace(/~~([^~]+)~~/g, "$1");
    // Horizontal rules
    s = s.replace(/^\s*([-*_]){3,}\s*$/gm, "");
    // Collapse 3+ blank lines
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
  }, []);

  const writeClipboardText = useCallback(async (body: string) => {
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      // Fallback for environments where Clipboard API is blocked.
      const ta = document.createElement("textarea");
      ta.value = body;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, []);

  const copyAssistantText = useCallback(
    async (id: string, text: string, format: "md" | "plain") => {
      const raw = text.trim();
      if (!raw) return;
      const body = format === "plain" ? markdownToPlainText(raw) : raw;
      if (!body) return;
      await writeClipboardText(body);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      setCopiedMsg({ id, format });
      copiedTimerRef.current = setTimeout(() => {
        setCopiedMsg((cur) =>
          cur && cur.id === id && cur.format === format ? null : cur,
        );
        copiedTimerRef.current = null;
      }, 1600);
    },
    [markdownToPlainText, writeClipboardText],
  );

  const refreshModels = useCallback(
    async (opts?: { preferModelId?: string | null }) => {
      try {
        const list = await invoke<ModelOption[]>("list_models");
        const ids = new Set(list.map((m) => m.id));
        const prefer = (opts?.preferModelId || "").trim();
        const cur = await invoke<string | null>("current_model");
        if (prefer && ids.has(prefer)) {
          setModelId(prefer);
        } else if (cur && ids.has(cur)) {
          setModelId(cur);
        } else if (prefer) {
          // Settings already moved off a removed model; keep the resolved id
          // even if list_models briefly lags.
          setModelId(prefer);
        } else if (list[0]) {
          setModelId(list[0].id);
        }
      } catch {
        /* keep current modelId */
      }
    },
    [],
  );

  const applyPublicSettings = useCallback((s: PublicSettings) => {
    const source =
      s.model_profiles && s.model_profiles.length > 0
        ? s.model_profiles
        : [s.endpoint];
    const profiles = source.map((ep) => endpointToProfileRow(ep));
    let nextVendors = profilesToVendors(profiles);
    const tune = bonsaiTuneRef.current;
    if (tune) {
      setBonsaiHardwareTune(tune);
      nextVendors = nextVendors.map((v) => applyBonsaiHardwareTune(v, tune));
    }
    suppressModelAutoSaveRef.current = true;
    setVendors(nextVendors);
    const active =
      s.model ||
      s.grok_default_model ||
      profiles[0]?.model_id ||
      BONSAI_MODEL_ID;
    setEditingVendorId((prev) =>
      nextVendors.some((v) => v.id === prev)
        ? prev
        : nextVendors.find((v) => v.models.some((m) => m.id === active))?.id ||
          nextVendors[0]?.id ||
          "",
    );
    setGrokDefaultModel(s.grok_default_model || active);
    setDefaultImageModel(
      (s.default_image_model || "").trim() || "qwen-image-3.0-pro",
    );
    setDefaultVideoModel(
      (s.default_video_model || "").trim() || "happyhorse-1.1-t2v",
    );
    setGrokEngineForm(grokEngineFromPublic(s.grok_engine));
    setCfgSyncGrok(s.sync_to_grok_config);
    setPermissionMode(
      normalizePermissionMode(s.permission_mode, s.auto_approve),
    );
    // Prefer explicit active model; don't force-sync composer to default.
    if (s.model) setModelId(s.model);
    else if (s.grok_default_model) setModelId(s.grok_default_model);
    if (s.ui_language) setLocale(normalizeLocale(s.ui_language));
  }, [setLocale]);

  const editingVendor = useMemo(
    () =>
      vendors.find((v) => v.id === editingVendorId) ?? vendors[0] ?? null,
    [vendors, editingVendorId],
  );

  useEffect(() => {
    setVendorBalanceSummary(null);
    setBailianBalanceModalOpen(false);
    // Invalidate in-flight balance requests and allow a fresh auto-query.
    balanceQueryGenRef.current += 1;
    autoBalanceVendorRef.current = "";
  }, [editingVendorId]);

  const updateEditingVendor = useCallback(
    (patch: Partial<VendorRow>) => {
      if (!editingVendorId) return;
      setVendors((prev) =>
        prev.map((v) => {
          if (v.id !== editingVendorId) return v;
          const next = { ...v, ...patch };
          // First time a key appears for this vendor → enable every model.
          const hadKey = Boolean(v.api_key.trim()) || v.has_api_key;
          const nextKey = (patch.api_key ?? v.api_key).trim();
          const hasKeyNow = Boolean(nextKey) || Boolean(patch.has_api_key) || next.has_api_key;
          if (!hadKey && hasKeyNow && !patch.models) {
            next.models = next.models.map((m) => ({ ...m, enabled: true }));
          }
          return next;
        }),
      );
    },
    [editingVendorId],
  );

  /** Persist permission mode and sync engine ~/.grok/config.toml. */
  const setPermissionModeAndSave = useCallback(
    async (next: PermissionMode) => {
      setPermissionMode(next);
      try {
        const s = await invoke<PublicSettings>("save_settings", {
          update: {
            permission_mode: next,
            // Keep legacy field for older code paths.
            auto_approve: next === "always-approve",
          },
        });
        applyPublicSettings(s);
      } catch (e) {
        console.warn("save permission_mode failed", e);
      }
    },
    [applyPublicSettings],
  );

  /** Persist default model. Manual change pins — auto priority won't override afterward. */
  const setDefaultModelAndSave = useCallback(
    async (next: string, opts?: { userPinned?: boolean }) => {
      const id = next.trim();
      if (!id) return;
      if (opts?.userPinned) writeDefaultModelPinned(true);
      setGrokDefaultModel(id);
      setModelSelectionMode("model");
      writeModelSelectionMode("model");
      setModelId(id);
      try {
        const s = await invoke<PublicSettings>("save_settings", {
          update: {
            active_model_id: id,
            grok_default_model: id,
            sync_to_grok_config: true,
          },
        });
        applyPublicSettings(s);
      } catch (e) {
        console.warn("save default model failed", e);
      }
    },
    [applyPublicSettings],
  );

  const setDefaultImageModelAndSave = useCallback(
    async (next: string) => {
      const id = next.trim();
      if (!id) return;
      setDefaultImageModel(id);
      try {
        const s = await invoke<PublicSettings>("save_settings", {
          update: { default_image_model: id, sync_to_grok_config: true },
        });
        applyPublicSettings(s);
      } catch (e) {
        console.warn("save default image model failed", e);
      }
    },
    [applyPublicSettings],
  );

  const setDefaultVideoModelAndSave = useCallback(
    async (next: string) => {
      const id = next.trim();
      if (!id) return;
      setDefaultVideoModel(id);
      try {
        const s = await invoke<PublicSettings>("save_settings", {
          update: { default_video_model: id, sync_to_grok_config: true },
        });
        applyPublicSettings(s);
      } catch (e) {
        console.warn("save default video model failed", e);
      }
    },
    [applyPublicSettings],
  );

  const clearSettingsMsg = useCallback(() => {
    if (settingsMsgTimerRef.current != null) {
      clearTimeout(settingsMsgTimerRef.current);
      settingsMsgTimerRef.current = null;
    }
    setSettingsMsg(null);
    setSettingsMsgIsError(false);
  }, []);

  const showSettingsMsg = useCallback(
    (msg: string, isError: boolean) => {
      if (settingsMsgTimerRef.current != null) {
        clearTimeout(settingsMsgTimerRef.current);
        settingsMsgTimerRef.current = null;
      }
      setSettingsMsg(msg);
      setSettingsMsgIsError(isError);
      settingsMsgTimerRef.current = setTimeout(() => {
        setSettingsMsg(null);
        setSettingsMsgIsError(false);
        settingsMsgTimerRef.current = null;
      }, 5000);
    },
    [],
  );

  const persistModelProfiles = useCallback(
    async (opts?: { quiet?: boolean; vendors?: VendorRow[] }) => {
      const nextVendors = opts?.vendors ?? vendors;
      const profiles = vendorsToProfiles(nextVendors);
      if (profiles.length === 0) return;
      setSavingSettings(true);
      try {
        // If the pinned default was deleted/unchecked, clear the pin so
        // priority auto-pick can recover.
        if (
          readDefaultModelPinned() &&
          !findEnabledChatModelId(nextVendors, grokDefaultModel)
        ) {
          writeDefaultModelPinned(false);
        }

        const nextDefault = resolveAutoDefaultModel(nextVendors, {
          current: grokDefaultModel,
          fallback: modelId,
        });
        // Composer/dialog model: keep if still enabled, else follow default.
        // In tier mode, re-resolve from the active performance tier.
        const nextComposer =
          modelSelectionMode === "tier"
            ? resolveModelForPerformanceTier(
                nextVendors,
                performanceTier,
                "chat",
              )?.modelId ||
              resolveComposerModelId(nextVendors, {
                current: modelId,
                fallbackDefault: nextDefault,
              })
            : resolveComposerModelId(nextVendors, {
                current: modelId,
                fallbackDefault: nextDefault,
              });

        const s = await invoke<PublicSettings>("save_settings", {
          update: {
            prefer_bundled_engine: true,
            custom_engine_path: "",
            sync_to_grok_config: cfgSyncGrok,
            model_profiles: profiles.map((p) => profileToSavePayload(p)),
            active_model_id: nextComposer,
            grok_default_model: nextDefault,
          },
        });
        suppressModelAutoSaveRef.current = true;
        applyPublicSettings(s);
        setGrokDefaultModel(nextDefault);
        setModelId(nextComposer);
        // Keep the live engine session on the composer model after delete/uncheck.
        if (nextComposer !== modelId) {
          try {
            await invoke("set_model", { modelId: nextComposer });
          } catch {
            /* next prompt still uses active_model_id from settings */
          }
        }
        if (!opts?.quiet) {
          showSettingsMsg(
            cfgSyncGrok ? t("settings.savedSync") : t("settings.saved"),
            false,
          );
        }
        await refreshModels({ preferModelId: nextComposer });
      } catch (e) {
        showSettingsMsg(String(e), true);
      } finally {
        setSavingSettings(false);
      }
    },
    [
      vendors,
      grokDefaultModel,
      modelId,
      cfgSyncGrok,
      applyPublicSettings,
      showSettingsMsg,
      refreshModels,
      t,
      modelSelectionMode,
      performanceTier,
    ],
  );

  const deleteVendor = useCallback(
    (id: string) => {
      const target = vendors.find((v) => v.id === id);
      if (!target || target.locked) return;
      if (vendors.length <= 1) return;
      const next = vendors.filter((v) => v.id !== id);
      if (next.length === 0) return;
      if (editingVendorId === id) {
        setEditingVendorId(next[0].id);
      }
      suppressModelAutoSaveRef.current = true;
      setVendors(next);
      void persistModelProfiles({ vendors: next, quiet: true });
    },
    [vendors, editingVendorId, persistModelProfiles],
  );

  const addVendor = useCallback(
    (kind: Exclude<VendorKind, "bonsai">) => {
      const v = newVendorPreset(kind);
      // Allow renaming the generic "Custom" label so multiple customs are distinguishable.
      const customCount =
        kind === "custom"
          ? vendors.filter((x) => x.kind === "custom").length + 1
          : 0;
      const vendor =
        kind === "custom" && customCount > 1
          ? { ...v, name: `Custom ${customCount}` }
          : v;
      const next = [...vendors, vendor];
      suppressModelAutoSaveRef.current = true;
      setVendors(next);
      setEditingVendorId(vendor.id);
      setAddVendorMenuOpen(false);
      void persistModelProfiles({ vendors: next, quiet: true });
    },
    [vendors, persistModelProfiles],
  );

  const loadSettings = useCallback(async () => {
    try {
      const [tune, s] = await Promise.all([
        invoke<BonsaiHardwareTune>("local_llm_hardware_tune").catch(
          () => null,
        ),
        invoke<PublicSettings>("get_settings"),
      ]);
      if (tune) {
        bonsaiTuneRef.current = tune;
        setBonsaiHardwareTune(tune);
        setBonsaiTune(tune);
      }
      applyPublicSettings(s);
    } catch (e) {
      showSettingsMsg(String(e), true);
    }
  }, [applyPublicSettings, showSettingsMsg]);

  const onSaveEngineConfig = async () => {
    setSavingSettings(true);
    clearSettingsMsg();
    try {
      const s = await invoke<PublicSettings>("save_settings", {
        update: {
          sync_to_grok_config: true,
          grok_max_thoughts_width: grokEngineForm.max_thoughts_width,
          grok_fork_secondary_model: grokEngineForm.fork_secondary_model.trim() || null,
          grok_compact_mode: grokEngineForm.compact_mode,
        },
      });
      applyPublicSettings(s);
      showSettingsMsg(t("settings.engineConfigSaved"), false);
    } catch (e) {
      showSettingsMsg(String(e), true);
    } finally {
      setSavingSettings(false);
    }
  };

  const onClearApiKey = async () => {
    if (!editingVendor) return;
    setSavingSettings(true);
    clearSettingsMsg();
    try {
      const profiles = vendorsToProfiles(vendors);
      const vendorModelIds = new Set(
        editingVendor.models.map((m) => m.id),
      );
      // If no models yet, match by base_url via expanded empty → use a sentinel profile.
      const profilesPayload = (
        profiles.length > 0
          ? profiles
          : vendorsToProfiles([
              {
                ...editingVendor,
                models: [{ id: `__vendor-${editingVendor.id}`, enabled: true }],
              },
            ])
      ).map((p) =>
        vendorModelIds.has(p.model_id) ||
        (editingVendor.models.length === 0 &&
          p.base_url === editingVendor.base_url)
          ? { ...profileToSavePayload(p), clear_api_key: true }
          : profileToSavePayload(p),
      );
      const s = await invoke<PublicSettings>("save_settings", {
        update: { model_profiles: profilesPayload },
      });
      suppressModelAutoSaveRef.current = true;
      applyPublicSettings(s);
      showSettingsMsg(t("settings.apiKeyCleared"), false);
    } catch (e) {
      showSettingsMsg(String(e), true);
    } finally {
      setSavingSettings(false);
    }
  };

  const probeArgs = useCallback(
    () => ({
      baseUrl: editingVendor?.base_url.trim() || "",
      apiKey: editingVendor?.api_key.trim() || null,
      envKey: null,
      useSavedKey: true,
    }),
    [editingVendor],
  );

  /** GET {base}/models — validates URL + key. */
  const onTestEndpoint = async () => {
    if (!editingVendor?.base_url.trim()) {
      showSettingsMsg(t("settings.baseUrlRequiredTest"), true);
      return;
    }
    setEndpointProbeBusy(true);
    clearSettingsMsg();
    try {
      const r = await invoke<{
        ok: boolean;
        status: number;
        message: string;
        models_url: string;
        latency_ms: number;
        model_count?: number | null;
        sample_ids: string[];
      }>("test_endpoint", { args: probeArgs() });
      const sample =
        r.sample_ids?.length > 0
          ? ` · e.g. ${r.sample_ids.slice(0, 4).join(", ")}`
          : "";
      showSettingsMsg(
        r.ok
          ? `${r.message}${sample}`
          : t("settings.testFailed", { err: r.message }),
        !r.ok,
      );
    } catch (e) {
      showSettingsMsg(t("settings.testFailed", { err: String(e) }), true);
    } finally {
      setEndpointProbeBusy(false);
    }
  };

  /** GET DeepSeek /user/balance (Bailian uses console modal — no API). */
  const onQueryDeepseekBalance = useCallback(
    async (opts?: { quiet?: boolean }) => {
      if (!editingVendor || editingVendor.kind !== "deepseek") return;
      if (!editingVendor.base_url.trim()) {
        if (!opts?.quiet) {
          showSettingsMsg(t("settings.baseUrlRequiredTest"), true);
        }
        return;
      }
      if (!editingVendor.api_key.trim() && !editingVendor.has_api_key) {
        setVendorBalanceSummary(null);
        if (!opts?.quiet) {
          showSettingsMsg(t("settings.apiKeyRequiredBalance"), true);
        }
        return;
      }
      const gen = balanceQueryGenRef.current;
      setBalanceQueryBusy(true);
      if (!opts?.quiet) clearSettingsMsg();
      try {
        const r = await invoke<{
          ok: boolean;
          provider: string;
          mode: string;
          message: string;
          is_available?: boolean | null;
          balance_infos: {
            currency: string;
            total_balance: string;
            granted_balance: string;
            topped_up_balance: string;
          }[];
          open_urls: { label: string; url: string }[];
          latency_ms: number;
          status: number;
        }>("query_vendor_balance", {
          args: {
            vendor: "deepseek",
            baseUrl:
              editingVendor.base_url.trim() || "https://api.deepseek.com/v1",
            apiKey: editingVendor.api_key.trim() || null,
            envKey: null,
            useSavedKey: true,
          },
        });

        if (gen !== balanceQueryGenRef.current) return;

        if (!r.ok) {
          if (!opts?.quiet) {
            setVendorBalanceSummary(null);
            showSettingsMsg(r.message || t("settings.balanceQueryFailed"), true);
          } else {
            setVendorBalanceSummary(
              r.message || t("settings.balanceQueryFailed"),
            );
          }
          return;
        }

        const first = (r.balance_infos || [])[0];
        const summary = first
          ? t("settings.balanceDeepseekAmount", {
              currency: first.currency || "CNY",
              total: first.total_balance || "0",
            })
          : t("settings.balanceNoInfos");
        setVendorBalanceSummary(summary);
      } catch (e) {
        if (gen !== balanceQueryGenRef.current) return;
        if (!opts?.quiet) {
          setVendorBalanceSummary(null);
          showSettingsMsg(String(e), true);
        } else {
          setVendorBalanceSummary(String(e));
        }
      } finally {
        if (gen === balanceQueryGenRef.current) {
          setBalanceQueryBusy(false);
        }
      }
    },
    [editingVendor, clearSettingsMsg, showSettingsMsg, t],
  );

  /**
   * Entering DeepSeek settings → query balance once.
   * Mark the visit key only when the timer fires (not when scheduling), so that
   * early cleanup from vendors/re-render churn does not skip the first query.
   * Keep the query fn in a ref so callback identity churn does not reset the timer.
   */
  const onQueryDeepseekBalanceRef = useRef(onQueryDeepseekBalance);
  onQueryDeepseekBalanceRef.current = onQueryDeepseekBalance;

  useEffect(() => {
    if (view !== "settings" || settingsSection !== "model") return;
    if (!editingVendor || editingVendor.kind !== "deepseek") return;
    const hasKey =
      Boolean(editingVendor.api_key.trim()) || editingVendor.has_api_key;
    if (!hasKey || !editingVendor.base_url.trim()) return;

    const visitKey = `${editingVendor.id}|${editingVendor.base_url.trim()}|${
      editingVendor.api_key.trim() ? "draft" : "saved"
    }`;
    if (autoBalanceVendorRef.current === visitKey) return;

    const timer = window.setTimeout(() => {
      if (autoBalanceVendorRef.current === visitKey) return;
      autoBalanceVendorRef.current = visitKey;
      void onQueryDeepseekBalanceRef.current({ quiet: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    view,
    settingsSection,
    editingVendor?.id,
    editingVendor?.kind,
    editingVendor?.base_url,
    editingVendor?.api_key,
    editingVendor?.has_api_key,
  ]);

  /** GET {base}/models — list remote model ids; filter per vendor allowlist. */
  const onFetchRemoteModels = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!editingVendor || editingVendor.locked || editingVendor.kind === "custom") {
      return;
    }
    if (!editingVendor.base_url.trim()) {
      if (!opts?.quiet) {
        showSettingsMsg(t("settings.baseUrlRequiredFetch"), true);
      }
      return;
    }
    if (!editingVendor.api_key.trim() && !editingVendor.has_api_key) {
      if (!opts?.quiet) {
        showSettingsMsg(t("settings.apiKeyRequiredFetch"), true);
      }
      return;
    }
    setFetchModelsBusy(true);
    if (!opts?.quiet) clearSettingsMsg();
    try {
      const r = await invoke<{
        ok: boolean;
        status: number;
        message: string;
        models: { id: string; name: string }[];
      }>("fetch_remote_models", {
        args: {
          baseUrl: editingVendor.base_url.trim(),
          apiKey: editingVendor.api_key.trim() || null,
          envKey: null,
          useSavedKey: true,
        },
      });
      if (r.ok) {
        const filtered = filterFetchedModels(editingVendor.kind, r.models || []);
        const prevEnabled = new Map(
          editingVendor.models.map((m) => [m.id, m.enabled]),
        );
        const hadAnyEnabled = editingVendor.models.some((m) => m.enabled);
        const nextModels = filtered.map((m) => ({
          ...m,
          // After key is ready: prefer enabling all if nothing was checked yet;
          // otherwise keep the user's prior checkbox state.
          enabled: hadAnyEnabled
            ? prevEnabled.has(m.id)
              ? Boolean(prevEnabled.get(m.id))
              : true
            : true,
        }));
        setVendors((prev) =>
          prev.map((v) =>
            v.id === editingVendor.id ? { ...v, models: nextModels } : v,
          ),
        );
        if (!opts?.quiet) {
          showSettingsMsg(
            t("settings.fetchModelsHint", {
              msg: t("settings.fetchModelsFiltered", {
                n: nextModels.length,
                total: Math.max(r.models?.length ?? 0, nextModels.length),
              }),
            }),
            false,
          );
        }
      } else if (!opts?.quiet) {
        showSettingsMsg(
          t("settings.fetchFailed", { err: r.message }),
          true,
        );
      }
    } catch (e) {
      if (!opts?.quiet) {
        showSettingsMsg(t("settings.fetchFailed", { err: String(e) }), true);
      }
    } finally {
      setFetchModelsBusy(false);
    }
  }, [editingVendor, clearSettingsMsg, showSettingsMsg, t]);

  /** Transient banners (test/fetch/save feedback) — clear when leaving a settings tab. */
  useEffect(() => {
    clearSettingsMsg();
  }, [settingsSection, clearSettingsMsg]);

  useEffect(() => {
    if (view !== "settings") {
      clearSettingsMsg();
    }
  }, [view, clearSettingsMsg]);

  /** Auto-fetch models when base URL + API key are ready (curated remote vendors only). */
  useEffect(() => {
    if (view !== "settings" || settingsSection !== "model") return;
    if (!editingVendor || editingVendor.locked) return;
    // Custom vendors: user types model names manually — never auto-fetch.
    if (editingVendor.kind === "custom") return;
    const base = editingVendor.base_url.trim();
    const hasKey =
      Boolean(editingVendor.api_key.trim()) || editingVendor.has_api_key;
    if (!base || !hasKey) return;
    const key = `${editingVendor.id}|${base}|${
      editingVendor.api_key.trim() ? "draft" : "saved"
    }`;
    if (autoFetchKeyRef.current === key) return;
    const prev = autoFetchKeyRef.current;
    autoFetchKeyRef.current = key;
    const credChanged =
      prev.startsWith(`${editingVendor.id}|`) && prev !== key;
    // Curated catalogs are pre-seeded; still fetch once credentials land / change
    // so connection is validated and ids can be normalized from the API.
    if (!credChanged && prev.startsWith(`${editingVendor.id}|`)) return;
    const timer = window.setTimeout(() => {
      void onFetchRemoteModels({ quiet: true });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [view, settingsSection, editingVendor, onFetchRemoteModels]);

  useEffect(() => {
    setApiKeyFocused(false);
    setCustomModelDraft("");
  }, [editingVendorId]);

  useEffect(() => {
    if (!addVendorMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (
        addVendorMenuRef.current &&
        !addVendorMenuRef.current.contains(e.target as Node)
      ) {
        setAddVendorMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddVendorMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [addVendorMenuOpen]);

  /** Debounced auto-save for vendor edits. */
  useEffect(() => {
    if (suppressModelAutoSaveRef.current) {
      suppressModelAutoSaveRef.current = false;
      return;
    }
    if (view !== "settings" || settingsSection !== "model") return;
    if (vendors.length === 0) return;

    const timer = window.setTimeout(() => {
      void persistModelProfiles({ quiet: true });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    vendors,
    view,
    settingsSection,
    persistModelProfiles,
  ]);

  useEffect(() => {
    return () => {
      if (settingsMsgTimerRef.current != null) {
        clearTimeout(settingsMsgTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(e.target as Node)
      ) {
        setModelPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelPickerOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [modelPickerOpen]);

  useEffect(() => {
    void refreshHierarchy();
    void refreshModels();
    void loadSettings();
  }, [refreshHierarchy, refreshModels, loadSettings]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<AgentEvent>("agent-event", (event) => {
        const ev = event.payload;
        const evSid = sessionIdOf(ev);
        const activeSid = sessionIdRef.current;
        // Events with a session id that is not focused go to background cache.
        // agent_status / agent_error may lack session id — treat as focused.
        const isBackground =
          Boolean(evSid) && Boolean(activeSid) && evSid !== activeSid;

        const markBusy = (sid: string | null | undefined, next: boolean) => {
          // After user hits Stop, ignore late tool/stream events that would
          // flip Working back on until the next send.
          if (
            next &&
            sid &&
            userStoppedSessionRef.current &&
            userStoppedSessionRef.current === sid
          ) {
            return;
          }
          if (sid) setSessionBusyState(sid, next);
          else if (!isBackground) {
            busyRef.current = next;
            setBusy(next);
          }
        };

        /** Background activity while user looks at another task → unread dot. */
        const markBgUnread = () => {
          if (isBackground && evSid) markSessionUnread(evSid);
        };

        /** Append a simple line to background transcript. */
        const bgPush = (
          sid: string,
          kind: ChatLine["kind"],
          text: string,
        ) => {
          mutateBackgroundLines(sid, (prev) => {
            if (kind === "tool") {
              return appendOrMergeToolLine(prev, text);
            }
            let base = prev;
            if (base.length && base[base.length - 1].kind === "waiting") {
              base = base.slice(0, -1);
            }
            return [
              ...base,
              { id: nextLineId(kind), kind, text } as ChatLine,
            ];
          });
        };

        const bgAppendStream = (
          sid: string,
          kind: "assistant" | "thought",
          text: string,
        ) => {
          if (!text) return;
          mutateBackgroundLines(sid, (prev) => {
            let base = prev;
            if (base.length && base[base.length - 1].kind === "waiting") {
              base = base.slice(0, -1);
            }
            const last = base[base.length - 1];
            if (last && last.kind === kind) {
              const copy = base.slice(0, -1);
              copy.push({ ...last, text: last.text + text } as ChatLine);
              return copy;
            }
            return [
              ...base,
              { id: nextLineId(kind), kind, text } as ChatLine,
            ];
          });
        };

        switch (ev.type) {
          case "agent_status":
            // Global connection pill only for the focused agent lifecycle.
            if (!isBackground) {
              const next = normalizeAgentStatus(ev.status);
              // Ignore stale handshake "starting" after we already marked ready
              // (events can arrive out of order relative to invoke return).
              if (
                next.includes("starting") &&
                isAgentReadyStatus(agentStatusRef.current)
              ) {
                break;
              }
              setAgentStatus(next);
            }
            break;
          case "session_ready":
            if (!isBackground) {
              setAgentStatus("ready");
              void refreshHierarchy();
              void refreshModels();
            } else {
              void refreshSessions();
            }
            break;
          case "user_message":
            break;
          case "message_delta":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            if (isBackground && evSid) {
              if (ev.text) bgAppendStream(evSid, "assistant", ev.text);
            } else if (ev.text) {
              appendAssistant(ev.text);
            }
            break;
          case "thought_delta":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            if (isBackground && evSid) {
              if (ev.text) bgAppendStream(evSid, "thought", ev.text);
            } else if (ev.text) {
              appendThought(ev.text);
            }
            break;
          case "tool_started":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            {
              const label = ev.tool?.title ?? t("chat.runningTool");
              if (isBackground && evSid) {
                bgPush(evSid, "tool", label);
              } else {
                clearWaiting();
                setLines((prev) => {
                  const next = appendOrMergeToolLine(prev, label);
                  linesRef.current = next;
                  return next;
                });
                schedulePersistHistory();
              }
            }
            break;
          case "tool_updated":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            {
              const status = String(ev.tool?.status ?? "updated");
              const preview = String(ev.tool?.output_preview ?? "");
              const needsBailianKey =
                status.toLowerCase().includes("fail") &&
                (preview.includes("BAILIAN_API_KEY_REQUIRED") ||
                  preview.includes("百炼") ||
                  preview.includes("DashScope"));
              const label = needsBailianKey
                ? `${ev.tool?.title ?? "web_search"} → failed · ${t("chat.bailianApiKeyRequired")}`
                : `${ev.tool?.title ?? "Tool"} → ${status}`;
              if (isBackground && evSid) {
                bgPush(evSid, "tool", label);
              } else {
                clearWaiting();
                setLines((prev) => {
                  const next = appendOrMergeToolLine(prev, label);
                  linesRef.current = next;
                  return next;
                });
                schedulePersistHistory();
              }
            }
            break;
          case "permission_needed":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            if (isBackground && evSid) {
              bgPush(
                evSid,
                "system",
                t("chat.waitingApproval", {
                  summary: ev.request?.summary ?? ev.request?.tool_name ?? "tool",
                }),
              );
              // Permission for background task: still surface so user can act.
              if (ev.request?.id) {
                enqueuePermission({
                  id: ev.request.id,
                  session_id: evSid,
                  summary: ev.request.summary ?? t("chat.permissionRequired"),
                  tool_name: ev.request.tool_name ?? "tool",
                  detail: ev.request.detail,
                });
              }
            } else {
              clearWaiting();
              if (ev.request?.id) {
                enqueuePermission({
                  id: ev.request.id,
                  session_id: evSid || activeSid || undefined,
                  summary: ev.request.summary ?? t("chat.permissionRequired"),
                  tool_name: ev.request.tool_name ?? "tool",
                  detail: ev.request.detail,
                });
              }
              push({
                kind: "system",
                text: t("chat.waitingApproval", {
                  summary: ev.request?.summary ?? ev.request?.tool_name ?? "tool",
                }),
              });
            }
            break;
          case "plan_updated":
            if (ev.steps?.length) {
              if (isBackground && evSid) {
                bgPush(evSid, "system", t("chat.plan", { steps: ev.steps.join(" → ") }));
              } else {
                push({
                  kind: "system",
                  text: t("chat.plan", { steps: ev.steps.join(" → ") }),
                });
              }
            }
            break;
          case "goal_updated": {
            if (isBackground) break;
            const status = String(ev.status ?? "").toLowerCase();
            if (status === "cleared") {
              goalStatusRef.current = null;
              setGoalState(null);
              push({ kind: "system", text: t("composer.goalClearedNotice") });
              break;
            }
            const objective = String(ev.objective ?? "").trim();
            const prev = goalStatusRef.current;
            goalStatusRef.current = status;
            setGoalState({
              goalId: String(ev.goal_id ?? ""),
              objective,
              status,
              phase: String(ev.phase ?? ""),
              pauseMessage: ev.pause_message ? String(ev.pause_message) : null,
            });
            // Only announce lifecycle transitions (avoid spam on token ticks).
            if (status !== prev) {
              if (
                status === "active" &&
                (prev == null ||
                  prev === "complete" ||
                  prev === "cleared" ||
                  prev.includes("paused") ||
                  prev === "blocked" ||
                  prev === "budget_limited")
              ) {
                push({
                  kind: "system",
                  text: t("composer.goalActive", {
                    objective: objective || "—",
                  }),
                });
              } else if (status === "complete") {
                push({
                  kind: "system",
                  text: t("composer.goalCompleted", {
                    objective: objective || "—",
                  }),
                });
              } else if (
                status.includes("paused") ||
                status === "blocked" ||
                status === "budget_limited"
              ) {
                const extra = ev.pause_message
                  ? ` — ${String(ev.pause_message)}`
                  : "";
                push({
                  kind: "system",
                  text: t("composer.goalPaused", {
                    objective: objective || "—",
                    detail: extra,
                  }),
                });
              }
            }
            break;
          }
          case "turn_state": {
            const nextBusy =
              ev.state === "streaming" ||
              ev.state === "running_tools" ||
              ev.state === "waiting_permission";
            markBusy(evSid || activeSid, nextBusy);
            break;
          }
          case "turn_finished":
            markBusy(evSid || activeSid, false);
            // Always clear focused Working even if session id was missing on the event.
            if (!isBackground) {
              busyRef.current = false;
              setBusy(false);
              setLongRunNotice(null);
            }
            // Turn completed off-screen / other task → unread (green dock badge).
            {
              const finishedSid = evSid || activeSid;
              const notViewing =
                Boolean(finishedSid) &&
                (finishedSid !== sessionIdRef.current ||
                  (typeof document !== "undefined" &&
                    document.visibilityState !== "visible"));
              if (finishedSid && notViewing) {
                markSessionUnread(finishedSid);
              }
            }
            if (isBackground && evSid) {
              mutateBackgroundLines(evSid, (prev) => {
                let next = prev;
                if (next.length && next[next.length - 1].kind === "waiting") {
                  next = next.slice(0, -1);
                }
                if (ev.state === "error") {
                  next = [
                    ...next,
                    {
                      id: nextLineId("error"),
                      kind: "error",
                      text: t("chat.turnError"),
                    },
                  ];
                } else if (ev.state === "cancelled") {
                  next = [
                    ...next,
                    {
                      id: nextLineId("system"),
                      kind: "system",
                      text: t("chat.turnCancelled"),
                    },
                  ];
                }
                // Collapse thinking/tools for background transcript too.
                return collapseTurnProcess(next, 0);
              });
              void refreshSessions();
              clearPermissionsForSession(evSid || null);
            } else {
              clearPermissionsForSession(evSid || activeSid || null);
              clearWaiting();
              if (ev.state === "error") {
                const last = linesRef.current[linesRef.current.length - 1];
                const softTrunc =
                  last &&
                  (last.kind === "system" || last.kind === "error") &&
                  /输出超长|自动续跑|max_tokens_truncation|继续追加/i.test(
                    last.text,
                  );
                if (!softTrunc) {
                  if (!(last && last.kind === "error")) {
                    push({ kind: "error", text: t("chat.turnError") });
                  }
                  finishTurnCollapse(true);
                } else {
                  // Truncation auto-continue in progress — don't flash hard error.
                  clearWaiting();
                }
              } else if (ev.state === "cancelled") {
                push({ kind: "system", text: t("chat.turnCancelled") });
                finishTurnCollapse(false);
              } else {
                finishTurnCollapse(false);
              }
              void refreshSessions();
            }
            break;
          case "context_usage": {
            if (
              typeof ev.used_tokens !== "number" ||
              !Number.isFinite(ev.used_tokens)
            ) {
              break;
            }
            const usageSid = evSid || activeSid;
            if (!usageSid) break;
            // Empty new task: ignore large engine totals (process residue).
            const chatForCheck =
              usageSid === activeSid
                ? linesRef.current
                : (sessionLinesCacheRef.current.get(usageSid) ?? []);
            if (!hasRealChatContent(chatForCheck) && ev.used_tokens > 200) {
              break;
            }
            sessionContextTokensRef.current.set(usageSid, ev.used_tokens);
            if (usageSid === activeSid) {
              setEngineContextTokens(ev.used_tokens);
            }
            break;
          }
          case "agent_error": {
            const raw = ev.message ?? t("chat.agentError");
            const msg = formatAgentErrorMessageRef.current(
              raw,
              ev.app_code ?? null,
            );
            const soft =
              /timed out|still be working|still working|自动续跑|接着写|继续追加|输出超长|max_tokens_truncation|分段策略|Plan B/i.test(
                msg,
              );
            if (isBackground && evSid) {
              bgPush(evSid, soft ? "system" : "error", msg);
              if (!soft) markBusy(evSid, false);
            } else {
              push({ kind: soft ? "system" : "error", text: msg });
              if (!soft) {
                markBusy(activeSid, false);
                clearWaiting();
                finishTurnCollapse(true);
              }
            }
            break;
          }
          default:
            break;
        }
      });
      if (cancelled) unlisten?.();
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [
    appendAssistant,
    appendThought,
    clearWaiting,
    push,
    refreshHierarchy,
    refreshModels,
    refreshSessions,
    finishTurnCollapse,
    setSessionBusyState,
    mutateBackgroundLines,
    hasRealChatContent,
    markSessionUnread,
    enqueuePermission,
    clearPermissionsForSession,
  ]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.project_id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  /** User project ids — tasks under these nest in Projects; others are temporary. */
  const userProjectIds = useMemo(
    () => new Set(projects.map((p) => p.project_id)),
    [projects],
  );

  const temporarySessions = useMemo(
    () => sessions.filter((s) => !userProjectIds.has(s.project_id)),
    [sessions, userProjectIds],
  );

  const sessionsByProjectId = useMemo(() => {
    const map = new Map<string, SessionListRow[]>();
    for (const s of sessions) {
      if (!userProjectIds.has(s.project_id)) continue;
      const list = map.get(s.project_id);
      if (list) list.push(s);
      else map.set(s.project_id, [s]);
    }
    return map;
  }, [sessions, userProjectIds]);

  /** Expand a project in the sidebar (keeps other projects open). */
  const expandProject = useCallback((projectId: string) => {
    setExpandedProjectIds((prev) => {
      if (prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.add(projectId);
      return next;
    });
  }, []);

  /**
   * Click a project row: toggle its expanded task list (multi-open).
   * Also marks it as the selected project for “new task under…” context.
   */
  const onSelectProject = async (p: ProjectListRow) => {
    setView("workspace");
    const wasExpanded = expandedProjectIds.has(p.project_id);
    if (wasExpanded) {
      // Collapse only this project; leave others expanded.
      setExpandedProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(p.project_id);
        return next;
      });
      // Keep selection if this was selected, or clear if collapsing selected.
      if (selectedProjectId === p.project_id) {
        setSelectedProjectId(null);
      }
      return;
    }
    expandProject(p.project_id);
    setSelectedProjectId(p.project_id);
    setProjectRoot(p.root_path);
    try {
      await invoke<string>("set_project_root", { projectRoot: p.root_path });
    } catch {
      /* ignore path errors; still show tasks */
    }
  };

  /** Remove project from sidebar (+ all its tasks). Source folder is kept. */
  const onDeleteProject = async (p: ProjectListRow, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (connecting) return;
    const n = p.session_count;
    const ok = window.confirm(
      t("confirm.deleteProject", { name: p.name, n, path: p.root_path }),
    );
    if (!ok) return;

    const wasSelected = selectedProjectId === p.project_id;
    const activeBelongs =
      Boolean(session?.session_id) &&
      sessions.some(
        (s) =>
          s.session_id === session?.session_id && s.project_id === p.project_id,
      );

    if (activeBelongs) {
      await flushPersistHistory();
      historyEpochRef.current += 1;
    }

    try {
      await invoke("delete_project", { projectId: p.project_id });
      setProjects((prev) => prev.filter((row) => row.project_id !== p.project_id));
      // Drop task rows that belonged to this project.
      setSessions((prev) => {
        const kept = prev.filter((row) => row.project_id !== p.project_id);
        for (const gone of prev) {
          if (gone.project_id === p.project_id) {
            autoTitledSessionRef.current.delete(gone.session_id);
            sessionScrollRef.current.delete(gone.session_id);
            sessionContextTokensRef.current.delete(gone.session_id);
            sessionLinesCacheRef.current.delete(gone.session_id);
            sessionBusyMapRef.current.delete(gone.session_id);
            sessionUnreadMapRef.current.delete(gone.session_id);
          }
        }
        return kept;
      });
      setSessionUnreadMap((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          // Drop unread for deleted project tasks (already removed from ref).
          if (!sessionUnreadMapRef.current.has(id)) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      if (wasSelected) {
        setSelectedProjectId(null);
      }
      setExpandedProjectIds((prev) => {
        if (!prev.has(p.project_id)) return prev;
        const next = new Set(prev);
        next.delete(p.project_id);
        return next;
      });
      if (activeBelongs) {
        setSession(null);
        sessionIdRef.current = null;
        workPathRef.current = null;
        setLines([]);
        linesRef.current = [];
        clearAllPermissions();
        setAttachments([]);
        clearComposer();
        setBusy(false);
        setEngineContextTokens(null);
        setAgentStatus("disconnected");
      }
      await refreshSessions();
      void refreshProjects();
    } catch (err) {
      setError(String(err));
    }
  };

  /**
   * Mark UI as connecting with a generation id + safety timeout.
   * A hung ACP/engine spawn used to leave "连接中…" forever and block retries.
   */
  const beginConnecting = useCallback(() => {
    const gen = ++connectingGenRef.current;
    setConnecting(true);
    if (connectingTimerRef.current != null) {
      clearTimeout(connectingTimerRef.current);
      connectingTimerRef.current = null;
    }
    connectingTimerRef.current = setTimeout(() => {
      if (connectingGenRef.current !== gen) return;
      connectingTimerRef.current = null;
      setConnecting(false);
      setAgentStatus("failed");
      setError(t("err.connectTimeout"));
    }, 90_000);
    return gen;
  }, [t]);

  const endConnecting = useCallback((gen: number) => {
    if (connectingGenRef.current !== gen) return;
    if (connectingTimerRef.current != null) {
      clearTimeout(connectingTimerRef.current);
      connectingTimerRef.current = null;
    }
    setConnecting(false);
  }, []);

  /**
   * Force reconnect on the current / last task.
   * Must NEVER create a new "New task" — that caused an empty task to appear
   * every time the app relaunched with no focused session and the status pill
   * was clicked (or treated as reconnect).
   */
  const onConnect = async () => {
    if (session?.session_id) {
      await onActivateSession(
        sessions.find((s) => s.session_id === session.session_id) ?? {
          session_id: session.session_id,
          project_id: selectedProjectId ?? "",
          project_root: session.project_root ?? projectRoot,
          project_name: selectedProject?.name ?? "",
          work_path: session.work_path ?? "",
          title: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { forceReconnect: true },
      );
      return;
    }
    let lastId: string | null = null;
    try {
      lastId = localStorage.getItem("grokx.lastSessionId");
    } catch {
      /* ignore */
    }
    const target =
      (lastId
        ? sessions.find((s) => s.session_id === lastId)
        : undefined) ?? sessions[0];
    if (target) {
      await onActivateSession(target, { forceReconnect: true });
      return;
    }
    setError(t("err.noTaskReconnect"));
  };

  /**
   * Pick a folder as project (fixed path) via native dialog, then create
   * the first task with chat metadata under <project>/.grokx/tasks/<id>.
   */
  const onOpenProject = async () => {
    // Allow while another task is busy — multi-agent keeps it running.
    // Also allow while a previous connect is hung: beginConnecting() supersedes it.
    setView("workspace");
    setError(null);
    const connectGen = beginConnecting();
    try {
      const picked = await invoke<string | null>("pick_project_dir");
      if (!picked) {
        endConnecting(connectGen);
        return;
      }
      const leavingId = sessionIdRef.current;
      saveSessionScroll(leavingId);
      if (leavingId) {
        sessionLinesCacheRef.current.set(leavingId, linesRef.current);
      }
      await flushPersistHistory();
      setLines([]);
      linesRef.current = [];
      clearAllPermissions();
      setAttachments([]);
      clearComposer();
      setBusy(false);
      autoScrollEnabledRef.current = true;
      userScrollIntentRef.current = false;
      const root = picked;
      setProjectRoot(root);
      await invoke<string>("set_project_root", { projectRoot: root });
      const info = await invoke<SessionInfo>("connect_workspace", {
        projectRoot: root,
        autoApprove: permissionMode === "always-approve",
      });
      if (connectingGenRef.current !== connectGen) return;
      setSession({ ...info, status: "ready" });
      if (info.session_id) {
        sessionIdRef.current = info.session_id;
        try {
          localStorage.setItem("grokx.lastSessionId", info.session_id);
        } catch {
          /* ignore */
        }
      }
      if (info.project_root) setProjectRoot(info.project_root);
      // Successful connect ⇒ ready (ignore transitional "starting" from race).
      setAgentStatus("ready");
      push({
        kind: "system",
        text: t("chat.openedProject", { path: info.project_root ?? root }),
      });
      if (info.work_path) {
        push({
          kind: "system",
          text: t("chat.agentCwd", {
            path: info.project_root ?? root,
            metaPath: info.work_path,
          }),
        });
      }
      await refreshHierarchy({ projectRoot: info.project_root ?? root });
      await refreshModels();
    } catch (e) {
      if (connectingGenRef.current === connectGen) {
        setError(String(e));
        setAgentStatus("failed");
      }
    } finally {
      endConnecting(connectGen);
    }
  };

  /**
   * Create a new task.
   * - `underProject`: attach to that user project (nested under Projects).
   * - otherwise: temporary task under default sandbox (Tasks section only).
   * Agent cwd is the project root; <project>/.grokx/tasks/<id> holds chat metadata only.
   */
  const onNewSession = async (opts?: {
    underProject?: ProjectListRow | null;
  }) => {
    // Allow while another task is busy — prior agent keeps working in parallel.
    // Supersede a hung previous connect attempt.
    setView("workspace");
    // Remember where we were reading so returning to this task restores it.
    const leavingId = sessionIdRef.current;
    saveSessionScroll(leavingId);
    if (leavingId) {
      sessionLinesCacheRef.current.set(leavingId, linesRef.current);
    }
    // Save current task transcript before leaving.
    await flushPersistHistory();
    historyEpochRef.current += 1;
    setLines([]);
    linesRef.current = [];
    clearAllPermissions();
    setAttachments([]);
    clearComposer();
    setEditingUserId(null);
    setEditDraft("");
    setError(null);
    setBusy(false);
    // New task = new context window; drop previous engine total immediately.
    setEngineContextTokens(null);
    turnStartedAtRef.current = null;
    const connectGen = beginConnecting();
    // Fresh task starts at bottom with auto-follow on.
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    stickyUserIdRef.current = null;
    setStickyUserId(null);

    const userProject =
      opts?.underProject === undefined
        ? selectedProject
        : opts.underProject;
    const standalone = !userProject;
    try {
      let root = userProject?.root_path?.trim() || "";
      if (!root) {
        // Internal sandbox for standalone tasks — never appears in Projects.
        root = await invoke<string>("ensure_default_project");
        setProjectRoot(root);
      } else {
        if (root !== projectRoot) setProjectRoot(root);
        await invoke<string>("set_project_root", { projectRoot: root });
      }
      const info = await invoke<SessionInfo>("connect_workspace", {
        projectRoot: root,
        autoApprove: permissionMode === "always-approve",
      });
      if (connectingGenRef.current !== connectGen) return;
      setSession({ ...info, status: "ready" });
      sessionIdRef.current = info.session_id;
      try {
        localStorage.setItem("grokx.lastSessionId", info.session_id);
      } catch {
        /* ignore */
      }
      // Ensure this id has no inherited engine total.
      sessionContextTokensRef.current.delete(info.session_id);
      setEngineContextTokens(null);
      workPathRef.current = info.work_path ?? null;
      if (info.project_root && !standalone) {
        setProjectRoot(info.project_root);
      }
      // Successful connect ⇒ ready (do not trust transitional info.status).
      setAgentStatus("ready");
      // Fresh task — empty history (no connection spam).
      setLines([]);
      linesRef.current = [];
      await refreshHierarchy({
        projectId: standalone ? null : userProject?.project_id ?? null,
        projectRoot: standalone ? null : info.project_root ?? root,
        standaloneTask: standalone,
      });
      await refreshModels();
    } catch (e) {
      if (connectingGenRef.current === connectGen) {
        setError(String(e));
        setAgentStatus("failed");
      }
    } finally {
      endConnecting(connectGen);
    }
  };

  /** New temporary task only (Tasks section +). */
  const onNewStandaloneTask = async () => {
    setSelectedProjectId(null);
    // Do not collapse expanded projects when creating a temporary task.
    await onNewSession({ underProject: null });
  };

  /** New task nested under a user project. */
  const onNewProjectTask = async (p: ProjectListRow, e?: React.MouseEvent) => {
    e?.stopPropagation();
    expandProject(p.project_id);
    setSelectedProjectId(p.project_id);
    setProjectRoot(p.root_path);
    await onNewSession({ underProject: p });
  };

  /** Activate an existing task (click) — restore history, never creates a new row.
   *  Other tasks keep running in the background (multi-agent). */
  const onActivateSession = async (
    s: SessionListRow,
    opts?: { forceReconnect?: boolean },
  ) => {
    if (renamingId === s.session_id) return;
    setView("workspace");

    // Open parent project (keep other projects expanded). Temporary tasks
    // only clear selection — they do not collapse open projects.
    const visibleProject = projects.find((p) => p.project_id === s.project_id);
    if (visibleProject) {
      expandProject(visibleProject.project_id);
      setSelectedProjectId(visibleProject.project_id);
    } else {
      setSelectedProjectId(null);
    }

    // Already the active task and agent is healthy — no engine restart.
    // If disconnected (or force), fall through and reconnect the same task.
    const agentReady = isAgentReadyStatus(agentStatus);
    if (
      session?.session_id === s.session_id &&
      !opts?.forceReconnect &&
      agentReady &&
      !connecting
    ) {
      return;
    }

    // Persist + cache the task we're leaving so background work continues cleanly.
    const leavingId = sessionIdRef.current;
    const leavingWork = workPathRef.current;
    const leavingLines = linesRef.current;
    // Capture scroll before DOM is replaced by the other task's transcript.
    saveSessionScroll(leavingId);
    if (historySaveTimer.current) {
      clearTimeout(historySaveTimer.current);
      historySaveTimer.current = null;
    }
    if (leavingId) {
      // Keep live transcript in memory while agent keeps working off-screen.
      sessionLinesCacheRef.current.set(leavingId, leavingLines);
      if (hasRealChatContent(leavingLines)) {
        await persistChatHistory(leavingId, leavingLines, leavingWork);
      }
    }

    // Invalidate any pending saves from the previous task.
    historyEpochRef.current += 1;
    const epoch = historyEpochRef.current;
    const connectGen = beginConnecting();

    setError(null);
    // Keep other tasks' permission queue entries (multi-agent).
    setAttachments([]);
    clearComposer();
    setEditingUserId(null);
    setEditDraft("");
    // Restore busy for the task we're entering (may still be streaming).
    const enteringBusy = sessionBusyMapRef.current.get(s.session_id) ?? false;
    busyRef.current = enteringBusy;
    setBusy(enteringBusy);
    turnStartedAtRef.current = enteringBusy ? Date.now() : null;
    stickyUserIdRef.current = null;
    setStickyUserId(null);

    // Optimistically highlight the clicked row immediately.
    setSession({
      session_id: s.session_id,
      project_root: s.project_root,
      work_path: s.work_path,
      status: "starting",
    });
    setAgentStatus("starting");
    sessionIdRef.current = s.session_id;
    try {
      localStorage.setItem("grokx.lastSessionId", s.session_id);
    } catch {
      /* ignore */
    }
    // Opening this task clears its unread indicator.
    clearSessionUnread(s.session_id);
    // Restore this task's last engine total (if any); otherwise estimate from chat.
    setEngineContextTokens(
      sessionContextTokensRef.current.get(s.session_id) ?? null,
    );
    workPathRef.current = s.work_path || null;
    if (s.project_root) setProjectRoot(s.project_root);

    // Prefer in-memory cache (includes live stream while we were away).
    // Clear previous task's lines immediately so background→active events
    // for the new task don't append onto the old transcript during await.
    const cached = sessionLinesCacheRef.current.get(s.session_id);
    if (cached && cached.length > 0) {
      setLines(cached);
      linesRef.current = cached;
    } else {
      setLines([]);
      linesRef.current = [];
    }

    // Entire activate path must clear `connecting` — early returns used to
    // leave Connecting stuck forever and block further task switches.
    try {
      let history =
        cached && cached.length > 0
          ? cached
          : await loadChatHistory(s.session_id, s.work_path);
      if (historyEpochRef.current !== epoch) return;
      // Apply scroll policy *before* setLines so the lines-effect auto-follow
      // does not race and yank the viewport to the bottom.
      const savedScroll = sessionScrollRef.current.get(s.session_id);
      if (!savedScroll || savedScroll.pinBottom) {
        autoScrollEnabledRef.current = true;
        userScrollIntentRef.current = false;
      } else {
        autoScrollEnabledRef.current = false;
        userScrollIntentRef.current = true;
      }
      setLines(history);
      linesRef.current = history;
      // Resume at the leave position (or bottom if first visit / was pinned).
      restoreSessionScroll(s.session_id);

      if (s.project_root) {
        try {
          await invoke<string>("set_project_root", {
            projectRoot: s.project_root,
          });
        } catch {
          /* path may still work via reconnect metadata */
        }
      }
      // reconnect_session focuses an already-live agent or spawns one —
      // does not kill other parallel agents.
      const info = await invoke<SessionInfo>("reconnect_session", {
        sessionId: s.session_id,
        autoApprove: permissionMode === "always-approve",
      });
      if (historyEpochRef.current !== epoch) return;
      if (info.session_id !== s.session_id) {
        console.warn(
          "activate returned different session id",
          info.session_id,
          "expected",
          s.session_id,
        );
      }
      setSession({
        session_id: s.session_id,
        project_root: info.project_root ?? s.project_root,
        work_path: info.work_path ?? s.work_path,
        status: "ready",
      });
      sessionIdRef.current = s.session_id;
      try {
        localStorage.setItem("grokx.lastSessionId", s.session_id);
      } catch {
        /* ignore */
      }
      workPathRef.current = info.work_path ?? s.work_path ?? null;
      if (info.project_root) setProjectRoot(info.project_root);
      // Successful reconnect ⇒ ready (ignore transitional info.status race).
      setAgentStatus("ready");

      // Prefer freshest in-memory cache (background events may have updated it).
      const cached2 = sessionLinesCacheRef.current.get(s.session_id);
      if (cached2 && cached2.length > 0) {
        const prev = linesRef.current;
        const historyChanged =
          cached2.length !== prev.length ||
          cached2.some(
            (l, i) => l.id !== prev[i]?.id || l.kind !== prev[i]?.kind,
          );
        if (historyChanged) {
          setLines(cached2);
          linesRef.current = cached2;
          restoreSessionScroll(s.session_id);
        }
      } else {
        // Re-load history after reconnect in case first load raced.
        const history2 = await loadChatHistory(
          s.session_id,
          info.work_path ?? s.work_path,
        );
        if (historyEpochRef.current !== epoch) return;
        if (history2.length > 0) {
          const prev = linesRef.current;
          const historyChanged =
            history2.length !== prev.length ||
            history2.some(
              (l, i) => l.id !== prev[i]?.id || l.kind !== prev[i]?.kind,
            );
          if (historyChanged) {
            setLines(history2);
            linesRef.current = history2;
            restoreSessionScroll(s.session_id);
          }
        }
      }

      // Sync busy from backend in case we missed events while away.
      try {
        const stillBusy = await invoke<boolean>("is_session_busy", {
          sessionId: s.session_id,
        });
        if (historyEpochRef.current === epoch) {
          setSessionBusyState(s.session_id, stillBusy);
        }
      } catch {
        /* keep map value */
      }

      // Keep list order stable: only refresh session metadata/titles.
      await refreshSessions();
      await refreshModels();
    } catch (e) {
      if (historyEpochRef.current === epoch) {
        setError(String(e));
        // Keep restored history visible even if reconnect fails.
        setAgentStatus("failed");
      }
    } finally {
      endConnecting(connectGen);
    }
  };

  /**
   * On launch: reopen the last focused task (history + engine reconnect).
   * Never invents a new "New task" — that only happens via explicit New task /
   * Open project actions.
   */
  const didRestoreLastSessionRef = useRef(false);
  const onActivateSessionRef = useRef(onActivateSession);
  onActivateSessionRef.current = onActivateSession;
  useEffect(() => {
    if (didRestoreLastSessionRef.current) return;
    if (sessions.length === 0) return;
    // User already started / opened something during boot.
    if (sessionIdRef.current) {
      didRestoreLastSessionRef.current = true;
      return;
    }
    didRestoreLastSessionRef.current = true;
    let lastId: string | null = null;
    try {
      lastId = localStorage.getItem("grokx.lastSessionId");
    } catch {
      /* ignore */
    }
    const byLast =
      lastId != null
        ? sessions.find((s) => s.session_id === lastId)
        : undefined;
    // Prefer remembered task; otherwise attach to the warm-started (most recent) one
    // so the UI matches the grok.exe process started at app launch.
    const target =
      byLast ??
      [...sessions].sort((a, b) =>
        (b.updated_at || "").localeCompare(a.updated_at || ""),
      )[0] ??
      null;
    if (target) {
      void onActivateSessionRef.current(target);
    }
  }, [sessions]);

  const startRename = (s: SessionListRow, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setRenamingId(s.session_id);
    setRenameDraft(s.title || s.session_id.slice(0, 8));
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const title = renameDraft.trim();
    const id = renamingId;
    setRenamingId(null);
    if (!title) return;
    try {
      await invoke("rename_session", { sessionId: id, title });
      // Mark as user-named so auto-title won't overwrite.
      autoTitledSessionRef.current.add(id);
      // Patch in place — keep list order (created_at).
      setSessions((prev) =>
        prev.map((row) =>
          row.session_id === id ? { ...row, title } : row,
        ),
      );
    } catch (err) {
      setError(String(err));
    }
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };

  const onDeleteSession = async (s: SessionListRow, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (connecting) return;
    const label = s.title ? displayTaskTitle(s.title, t) : s.session_id.slice(0, 8);
    const ok = window.confirm(t("confirm.deleteTask", { label }));
    if (!ok) return;

    // If deleting the active task, clear chat UI after.
    const wasActive = session?.session_id === s.session_id;
    if (wasActive) {
      await flushPersistHistory();
      historyEpochRef.current += 1;
    }

    try {
      await invoke("delete_session", { sessionId: s.session_id });
      setSessions((prev) => prev.filter((row) => row.session_id !== s.session_id));
      autoTitledSessionRef.current.delete(s.session_id);
      sessionScrollRef.current.delete(s.session_id);
      sessionContextTokensRef.current.delete(s.session_id);
      sessionLinesCacheRef.current.delete(s.session_id);
      sessionBusyMapRef.current.delete(s.session_id);
      setSessionBusyMap((prev) => {
        if (!(s.session_id in prev)) return prev;
        const next = { ...prev };
        delete next[s.session_id];
        return next;
      });
      clearSessionUnread(s.session_id);

      if (wasActive) {
        setSession(null);
        sessionIdRef.current = null;
        workPathRef.current = null;
        setLines([]);
        linesRef.current = [];
        clearAllPermissions();
        setAttachments([]);
        clearComposer();
        setBusy(false);
        setAgentStatus("disconnected");
      }
      try {
        const last = localStorage.getItem("grokx.lastSessionId");
        if (last === s.session_id) {
          localStorage.removeItem("grokx.lastSessionId");
        }
      } catch {
        /* ignore */
      }
      // Refresh project counts if needed.
      void refreshProjects();
    } catch (err) {
      setError(String(err));
    }
  };

  const addAttachments = useCallback(
    (
      files: Array<{
        path: string;
        name?: string | null;
        mime?: string | null;
        size?: number | null;
        previewUrl?: string | null;
        isDir?: boolean | null;
      }>,
    ) => {
      if (!files.length) return;
      setAttachments((prev) => {
        const seen = new Set(prev.map((p) => p.path));
        const next = [...prev];
        for (const f of files) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          const isDir = Boolean(f.isDir);
          const displayName = attachmentDisplayName({
            name: f.name,
            path: f.path,
          });
          next.push({
            path: f.path,
            name: displayName,
            mime: f.mime ?? null,
            size: f.size,
            previewUrl: isDir ? null : (f.previewUrl ?? null),
            isDir,
          });
        }
        return next;
      });
    },
    [],
  );

  const onPickAttachments = async () => {
    try {
      const files = await invoke<
        Array<{
          path: string;
          name?: string | null;
          mime?: string | null;
          size?: number | null;
        }>
      >("pick_attachments");
      if (!files?.length) return;
      addAttachments(files);
    } catch (e) {
      setError(String(e));
    }
  };

  const fileToBase64 = (file: File | Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") {
          reject(new Error("failed to read file"));
          return;
        }
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });

  const savePastedBlob = async (
    blob: Blob,
    nameHint?: string | null,
  ): Promise<Attachment | null> => {
    let mime = (blob.type || "").trim();
    if (!mime || mime === "application/octet-stream") {
      // macOS screenshots often omit type; assume PNG for image-like blobs.
      mime = "image/png";
    }
    const dataBase64 = await fileToBase64(blob);
    const saved = await invoke<{
      path: string;
      name?: string | null;
      mime?: string | null;
      size?: number | null;
    }>("save_pasted_attachment", {
      payload: {
        dataBase64,
        mime,
        name: nameHint || null,
      },
    });
    let previewUrl: string | null = null;
    if (mime.startsWith("image/")) {
      try {
        previewUrl = URL.createObjectURL(blob);
      } catch {
        previewUrl = null;
      }
    }
    return {
      path: saved.path,
      name:
        saved.name ||
        nameHint ||
        saved.path.split(/[/\\]/).pop() ||
        "paste.png",
      mime: saved.mime ?? mime,
      size: saved.size ?? blob.size,
      previewUrl,
    };
  };

  /** Collect image/file entries from a paste event (macOS screenshots included). */
  const collectPasteFiles = (cd: DataTransfer): File[] => {
    const out: File[] = [];
    const seen = new Set<string>();
    const pushFile = (f: File | null) => {
      if (!f || f.size === 0) return;
      const key = `${f.name}|${f.size}|${f.type}|${f.lastModified}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(f);
    };

    // 1) items: preferred — catches image/png from Cmd+Ctrl+Shift+4 / Cmd+C
    if (cd.items) {
      for (let i = 0; i < cd.items.length; i++) {
        const item = cd.items[i];
        const type = (item.type || "").toLowerCase();
        if (item.kind === "file" || type.startsWith("image/")) {
          pushFile(item.getAsFile());
        }
      }
    }
    // 2) files list
    if (cd.files) {
      for (let i = 0; i < cd.files.length; i++) {
        pushFile(cd.files.item(i));
      }
    }
    return out;
  };

  const attachOsClipboardImage = async (): Promise<boolean> => {
    try {
      const saved = await invoke<{
        path: string;
        name?: string | null;
        mime?: string | null;
        size?: number | null;
      } | null>("read_clipboard_image");
      if (!saved?.path) return false;
      addAttachments([
        {
          path: saved.path,
          name: saved.name || "clipboard.png",
          mime: saved.mime || "image/png",
          size: saved.size,
          previewUrl: null,
        },
      ]);
      return true;
    } catch (e) {
      console.warn("read_clipboard_image failed", e);
      return false;
    }
  };

  const onComposerPaste = async (
    e: React.ClipboardEvent<HTMLDivElement>,
  ) => {
    const cd = e.clipboardData;
    if (!cd) return;

    const fileItems = collectPasteFiles(cd);
    const types = cd.types ? Array.from(cd.types) : [];
    const looksLikeImage =
      fileItems.some((f) => (f.type || "").startsWith("image/") || !f.type) ||
      types.some((t) => t.toLowerCase().startsWith("image/") || t === "Files");

    // Pure text paste — leave to the browser.
    if (fileItems.length === 0 && !looksLikeImage) {
      return;
    }

    // We handle image/file ourselves so text doesn't swallow the paste.
    if (fileItems.length > 0 || looksLikeImage) {
      e.preventDefault();
    }

    if (!session) {
      setError(t("err.openTaskAttach"));
      return;
    }

    try {
      const saved: Attachment[] = [];
      for (const file of fileItems) {
        const name =
          file.name && file.name !== "image.png" && file.name !== "blob"
            ? file.name
            : `paste-${Date.now()}.png`;
        const att = await savePastedBlob(file, name);
        if (att) saved.push(att);
      }
      if (saved.length) {
        addAttachments(saved);
        return;
      }
      // Fallback: OS clipboard image (macOS screenshot often only here).
      if (looksLikeImage || types.length === 0) {
        const ok = await attachOsClipboardImage();
        if (!ok && fileItems.length === 0) {
          // Last resort: try OS clipboard even if types looked empty.
          await attachOsClipboardImage();
        }
      }
    } catch (err) {
      setError(String(err));
    }
  };

  /** Global paste while composer focused is covered; also allow paste when dock is focused. */
  useEffect(() => {
    const onWindowPaste = (ev: ClipboardEvent) => {
      const t = ev.target as HTMLElement | null;
      // If paste is already on our textarea, React handler runs.
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      // Ignore paste in settings forms.
      if (view !== "workspace") return;
      if (!session || busy) return;
      const cd = ev.clipboardData;
      if (!cd) return;
      const files = collectPasteFiles(cd);
      const types = cd.types ? Array.from(cd.types) : [];
      const looksLikeImage =
        files.length > 0 ||
        types.some((x) => x.toLowerCase().startsWith("image/") || x === "Files");
      if (!looksLikeImage) return;
      ev.preventDefault();
      void (async () => {
        try {
          if (files.length) {
            const saved: Attachment[] = [];
            for (const file of files) {
              const att = await savePastedBlob(
                file,
                file.name || `paste-${Date.now()}.png`,
              );
              if (att) saved.push(att);
            }
            if (saved.length) {
              addAttachments(saved);
              return;
            }
          }
          await attachOsClipboardImage();
        } catch (err) {
          setError(String(err));
        }
      })();
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, busy, view]);

  /**
   * OS drag-drop of files/folders into the chat (Tauri native paths).
   * Folders become removable path chips (Cursor-style); files attach as usual.
   */
  useEffect(() => {
    if (view !== "workspace") {
      setComposerDropActive(false);
      return;
    }

    const pointInEl = (
      clientX: number,
      clientY: number,
      el: HTMLElement | null,
    ): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      );
    };

    const toClientPoint = (position: {
      x: number;
      y: number;
      toLogical?: (scale: number) => { x: number; y: number };
    }) => {
      const dpr = window.devicePixelRatio || 1;
      if (typeof position.toLogical === "function") {
        const logical = position.toLogical(dpr);
        return { x: logical.x, y: logical.y };
      }
      return { x: position.x / dpr, y: position.y / dpr };
    };

    const overDropZone = (position: { x: number; y: number }) => {
      const { x, y } = toClientPoint(position);
      return (
        pointInEl(x, y, chatPaneRef.current) ||
        pointInEl(x, y, composerDockRef.current)
      );
    };

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    void (async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.type === "leave") {
            setComposerDropActive(false);
            return;
          }
          if (payload.type === "enter" || payload.type === "over") {
            setComposerDropActive(overDropZone(payload.position));
            return;
          }
          if (payload.type !== "drop") return;
          setComposerDropActive(false);
          if (!overDropZone(payload.position)) return;
          if (!sessionIdRef.current) {
            setError(t("err.openTaskAttach"));
            return;
          }
          const paths = payload.paths ?? [];
          if (!paths.length) return;
          void (async () => {
            try {
              const resolved = await invoke<
                Array<{
                  path: string;
                  name?: string | null;
                  mime?: string | null;
                  size?: number | null;
                  is_dir?: boolean | null;
                }>
              >("resolve_drop_paths", { paths });
              if (!resolved?.length) return;
              const pathChips: PathChipData[] = [];
              const fileAtts: Array<{
                path: string;
                name?: string | null;
                mime?: string | null;
                size?: number | null;
                previewUrl?: string | null;
                isDir?: boolean;
              }> = [];
              for (const r of resolved) {
                const isDir = Boolean(r.is_dir);
                if (isDir) {
                  pathChips.push({
                    path: r.path,
                    name:
                      r.name ||
                      r.path.replace(/[\\/]+$/, "").split(/[/\\]/).pop() ||
                      r.path,
                    isDir: true,
                  });
                  continue;
                }
                const isImg = isImageAttachment({
                  name: r.name,
                  mime: r.mime,
                  isDir: false,
                });
                // Non-image files → inline path chips (Cursor @file).
                // Images stay as attachments (vision / preview).
                if (!isImg) {
                  pathChips.push({
                    path: r.path,
                    name:
                      r.name ||
                      r.path.replace(/[\\/]+$/, "").split(/[/\\]/).pop() ||
                      r.path,
                    isDir: false,
                  });
                  continue;
                }
                let previewUrl: string | null = null;
                try {
                  previewUrl = convertFileSrc(r.path);
                } catch {
                  previewUrl = null;
                }
                fileAtts.push({
                  path: r.path,
                  name: r.name,
                  mime: r.mime,
                  size: r.size,
                  previewUrl,
                  isDir: false,
                });
              }
              for (const chip of pathChips) {
                composerRef.current?.insertPathChip(chip);
              }
              if (fileAtts.length) addAttachments(fileAtts);
              composerRef.current?.focus();
            } catch (err) {
              setError(String(err));
            }
          })();
        });
      } catch (err) {
        console.warn("onDragDropEvent unavailable", err);
      }
    })();

    return () => {
      cancelled = true;
      setComposerDropActive(false);
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, addAttachments, t]);

  const removeAttachment = (path: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.path === path);
      if (target?.previewUrl) {
        try {
          URL.revokeObjectURL(target.previewUrl);
        } catch {
          /* ignore */
        }
      }
      return prev.filter((a) => a.path !== path);
    });
  };

  const openAttachmentPreview = useCallback((a: Attachment) => {
    if (!isImageAttachment(a)) return;
    let src = a.previewUrl || "";
    if (!src && a.path) {
      try {
        src = convertFileSrc(a.path);
      } catch {
        src = "";
      }
    }
    if (!src) return;
    setAttachmentPreview({ src, name: attachmentDisplayName(a) });
  }, []);

  useEffect(() => {
    if (!attachmentPreview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAttachmentPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attachmentPreview]);

  const onModelChange = async (id: string) => {
    setModelSelectionMode("model");
    writeModelSelectionMode("model");
    setModelId(id);
    try {
      await invoke("set_model", { modelId: id });
    } catch {
      /* local selection still applies on next prompt */
    }
  };

  const onPerformanceTierChange = useCallback(
    async (tier: PerformanceTier) => {
      setModelSelectionMode("tier");
      writeModelSelectionMode("tier");
      setPerformanceTier(tier);
      writePerformanceTier(tier);
      const resolved = resolveModelForPerformanceTier(vendors, tier, "chat");
      if (resolved) {
        setModelId(resolved.modelId);
        try {
          await invoke("set_model", { modelId: resolved.modelId });
        } catch {
          /* next prompt still uses resolved id */
        }
      }
    },
    [vendors],
  );

  const setDefaultTierAndSave = useCallback(
    (tier: PerformanceTier) => {
      setGrokDefaultTier(tier);
      writePerformanceTier(tier);
      if (modelSelectionMode === "tier") {
        void onPerformanceTierChange(tier);
      } else {
        setPerformanceTier(tier);
      }
    },
    [modelSelectionMode, onPerformanceTierChange],
  );

  const cancelEditUser = useCallback(() => {
    setEditingUserId(null);
    setEditDraft("");
  }, []);

  const beginEditUser = useCallback(
    (line: Extract<ChatLine, { kind: "user" }>) => {
      if (busy || connecting) return;
      setEditingUserId(line.id);
      setEditDraft(line.text ?? "");
      // Focus after paint so the textarea exists.
      requestAnimationFrame(() => {
        const el = editTextareaRef.current;
        if (!el) return;
        el.focus();
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        // Place caret at end.
        const len = el.value.length;
        el.setSelectionRange(len, len);
      });
    },
    [busy, connecting],
  );

  /**
   * Re-send from an edited user bubble: keep history up to that message,
   * replace its text, drop everything after, and start a new turn.
   */
  const onResendEditedUser = async () => {
    if (!editingUserId || busy || connecting) return;
    const text = editDraft.trim();
    const idx = linesRef.current.findIndex(
      (l) => l.kind === "user" && l.id === editingUserId,
    );
    if (idx < 0) {
      cancelEditUser();
      return;
    }
    const original = linesRef.current[idx];
    if (original.kind !== "user") {
      cancelEditUser();
      return;
    }
    const keepAtts = original.attachments ?? [];
    if (!text && keepAtts.length === 0) return;

    const visionBlock = visionGuardMessage({ text, atts: keepAtts });
    if (visionBlock) {
      push({ kind: "error", text: visionBlock });
      openVlmRequiredModal();
      setModelPickerOpen(true);
      return;
    }

    // Truncate transcript: keep messages before this user bubble, then the
    // edited user message (attachments preserved; text updated).
    const kept = linesRef.current.slice(0, idx);
    const updatedUser: ChatLine = {
      ...original,
      text: text || original.text,
      at: new Date().toISOString(),
    };
    const next: ChatLine[] = [
      ...kept,
      updatedUser,
      {
        id: nextLineId("waiting"),
        kind: "waiting",
        text: t("chat.thinking"),
      },
    ];
    setLines(next);
    linesRef.current = next;
    if (sessionIdRef.current) {
      sessionLinesCacheRef.current.set(sessionIdRef.current, next);
    }
    setEditingUserId(null);
    setEditDraft("");
    // Persist truncated + edited history immediately (don't wait for debounce).
    if (sessionIdRef.current) {
      void persistChatHistory(
        sessionIdRef.current,
        next,
        workPathRef.current,
      );
    }

    turnStartedAtRef.current = Date.now();
    verbalNudgeUsedRef.current = false;
    const sid = sessionIdRef.current;
    if (sid) setSessionBusyState(sid, true);
    else setBusy(true);
    enableAutoScroll();

    // Prompt text: edited text, or empty if image-only (engine gets attachments).
    const promptText = text;
    const attPayload = keepAtts.map((a) => ({
      path: a.path,
      name: a.name,
      mime: a.mime ?? null,
      size: a.size ?? null,
      is_dir: Boolean(a.isDir),
    }));

    try {
      await invoke("send_prompt_rich", {
        payload: {
          text: promptText,
          attachments: attPayload,
          model: modelId || null,
          effort: null,
        },
      });
    } catch (e) {
      if (sid) setSessionBusyState(sid, false);
      else setBusy(false);
      clearWaiting();
      push({ kind: "error", text: formatAgentErrorMessage(String(e)) });
      finishTurnCollapse(true);
    }
  };

  /**
   * Grok Build `/goal` helpers.
   * - Primary flag click: enter goal compose mode (`/goal ` in input, button stays on)
   * - Second click / menu: status / pause / resume / clear
   */
  const sendGoalCommand = useCallback(
    async (cmd: "status" | "pause" | "resume" | "clear") => {
      setGoalMenuOpen(false);
      if (!session || busy) return;
      const text = `/goal ${cmd}`;
      turnStartedAtRef.current = Date.now();
      longRunDismissedRef.current = false;
      setLongRunNotice(null);
      verbalNudgeUsedRef.current = true; // slash meta — no verbal nudge
      const sid = sessionIdRef.current;
      if (sid) userStoppedSessionRef.current = null;
      if (sid) setSessionBusyState(sid, true);
      else setBusy(true);
      enableAutoScroll();
      push({
        kind: "user",
        text,
        at: new Date().toISOString(),
      });
      push({ kind: "waiting", text: t("chat.thinking") });
      try {
        await invoke("send_prompt_rich", {
          payload: {
            text,
            attachments: [],
            model: modelId || null,
            effort: null,
          },
        });
      } catch (e) {
        if (sid) setSessionBusyState(sid, false);
        else setBusy(false);
        clearWaiting();
        push({ kind: "error", text: String(e) });
        finishTurnCollapse(true);
      }
    },
    [
      session,
      busy,
      modelId,
      setSessionBusyState,
      enableAutoScroll,
      push,
      clearWaiting,
      finishTurnCollapse,
    ],
  );

  /** Write `/goal ` into the composer and keep the flag selected while drafting. */
  const armGoalCompose = useCallback(() => {
    setGoalMenuOpen(false);
    const cur = (composerRef.current?.getPayload()?.text ?? "").trim();
    if (!cur) {
      composerRef.current?.setValue("/goal ");
    } else if (/^\/goal(\s|$)/i.test(cur)) {
      // Already a goal command — leave body, just focus.
    } else {
      composerRef.current?.setValue(`/goal ${cur}`);
    }
    setGoalDraftArmed(true);
    setComposerHasText(true);
    composerRef.current?.focus();
  }, []);

  /** Clear bare `/goal` prefix; leave other draft text alone. */
  const disarmGoalCompose = useCallback(() => {
    setGoalMenuOpen(false);
    const cur = (composerRef.current?.getPayload()?.text ?? "").trim();
    if (/^\/goal\s*$/i.test(cur)) {
      composerRef.current?.clear();
      setComposerHasText(false);
    } else if (/^\/goal\s+/i.test(cur)) {
      const rest = cur.replace(/^\/goal\s+/i, "");
      composerRef.current?.setValue(rest);
      setComposerHasText(Boolean(rest.trim()));
    }
    setGoalDraftArmed(false);
    composerRef.current?.focus();
  }, []);

  const onGoalSetClick = useCallback(() => {
    armGoalCompose();
  }, [armGoalCompose]);

  /** Flag button: first click arms `/goal`; when already armed, open manage menu. */
  const onGoalButtonClick = useCallback(() => {
    if (!session || busy) return;
    const cur = (composerRef.current?.getPayload()?.text ?? "").trim();
    const draftIsGoal = /^\/goal(\s|$)/i.test(cur);
    const liveGoal = Boolean(
      goalState &&
        goalState.status !== "complete" &&
        goalState.status !== "cleared",
    );

    if (goalMenuOpen) {
      setGoalMenuOpen(false);
      return;
    }

    // Already drafting a goal (or a live goal is running) → manage menu.
    if (draftIsGoal || liveGoal || goalDraftArmed) {
      setGoalMenuOpen(true);
      return;
    }

    // First click: enter goal compose mode immediately.
    armGoalCompose();
  }, [
    session,
    busy,
    goalMenuOpen,
    goalState,
    goalDraftArmed,
    armGoalCompose,
  ]);

  useEffect(() => {
    if (!goalMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = goalMenuRef.current;
      if (el && !el.contains(e.target as Node)) {
        setGoalMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGoalMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [goalMenuOpen]);

  const onSend = async () => {
    // If editing a past message, that flow owns send.
    if (editingUserId) {
      await onResendEditedUser();
      return;
    }
    // Flush any pending typed-path conversion before reading payload.
    const rich = composerRef.current?.getPayload() ?? {
      text: "",
      pathChips: [],
    };
    const text = rich.text.trim();
    const chipAtts: Attachment[] = rich.pathChips.map((c) => ({
      path: c.path,
      name: c.name,
      mime: c.isDir ? "inode/directory" : null,
      size: null,
      previewUrl: null,
      isDir: c.isDir,
    }));
    const pendingAttachments = [...attachments, ...chipAtts].filter(
      (a, i, arr) => arr.findIndex((x) => x.path === a.path) === i,
    );
    if ((!text && pendingAttachments.length === 0) || busy) return;

    // Block use of local Bonsai / engine while required deps are still downloading.
    try {
      const ready = await invoke<{
        ok: boolean;
        message: string;
        local_llm_ready: boolean;
        local_llm_blocked: boolean;
        grok_ready: boolean;
      }>("get_dependency_readiness");
      setDepReadiness((prev) =>
        prev
          ? { ...prev, ...ready }
          : {
              ...ready,
              downloading_ids: [],
              missing_ids: [],
              paused_ids: [],
            },
      );
      const blocked =
        ready.local_llm_blocked || Boolean(bonsaiTuneRef.current?.blocked);
      if (needsLocalLlm && !ready.local_llm_ready) {
        push({
          kind: "error",
          text: blocked
            ? t("deps.bonsaiRequires8g")
            : ready.message || t("deps.notReadyRemind"),
        });
        if (!blocked) {
          setSettingsSection("dependencies");
          setView("settings");
        }
        return;
      }
      if (!ready.grok_ready) {
        push({
          kind: "error",
          text: ready.message || t("deps.grokNotReadyRemind"),
        });
        setSettingsSection("dependencies");
        setView("settings");
        return;
      }
    } catch {
      /* if readiness probe fails, fall through to normal send */
    }

    // Tier mode: ensure engine uses the auto-resolved model for this turn.
    if (modelSelectionMode === "tier") {
      const needVision =
        pendingAttachments.some((a) => !a.isDir && isImageAttachment(a)) ||
        pendingAttachments.some(
          (a) =>
            !a.isDir &&
            isImageAttachment({ name: a.name || a.path, mime: a.mime }),
        ) ||
        looksLikeMediaGenIntent(text) ||
        (pendingAttachments.some((a) => Boolean(a.isDir)) &&
          looksLikeVisionIntent(text));
      const resolved = resolveModelForPerformanceTier(
        vendors,
        performanceTier,
        needVision ? "vision" : "chat",
      );
      if (resolved && resolved.modelId !== modelId) {
        setModelId(resolved.modelId);
        try {
          await invoke("set_model", { modelId: resolved.modelId });
        } catch {
          /* continue; prompt may still pick up settings */
        }
      }
    }

    const visionBlock = visionGuardMessage({
      text,
      atts: pendingAttachments,
    });
    if (visionBlock) {
      push({ kind: "error", text: visionBlock });
      openVlmRequiredModal();
      setModelPickerOpen(true);
      return;
    }

    clearComposer();
    setAttachments([]);
    turnStartedAtRef.current = Date.now();
    longRunDismissedRef.current = false;
    setLongRunNotice(null);
    // Fresh user turn: allow one auto-nudge again if the model only talks.
    verbalNudgeUsedRef.current = false;
    const sid = sessionIdRef.current;
    // New prompt clears Stop guard so this turn can show Working.
    if (sid) userStoppedSessionRef.current = null;
    if (sid) setSessionBusyState(sid, true);
    else setBusy(true);
    // New user turn: resume gentle auto-follow from the bottom.
    enableAutoScroll();
    const chatAtts: ChatAttachment[] = pendingAttachments.map((a) => {
      const name = attachmentDisplayName(a);
      const isDir = Boolean(a.isDir);
      let previewSrc: string | null = isDir ? null : (a.previewUrl ?? null);
      if (
        !previewSrc &&
        !isDir &&
        a.path &&
        isImageAttachment({ name, mime: a.mime, isDir: false })
      ) {
        try {
          previewSrc = convertFileSrc(a.path);
        } catch {
          previewSrc = null;
        }
      }
      return {
        path: a.path,
        name,
        mime: a.mime ?? null,
        size: a.size ?? null,
        previewSrc,
        isDir,
      };
    });
    // User bubble always keeps original attachment names (Word/docx etc.).
    // Text is the typed prompt; files render as chips under the bubble.
    const display = text;
    push({
      kind: "user",
      text: display,
      at: new Date().toISOString(),
      attachments: chatAtts.length ? chatAtts : undefined,
    });
    // Immediate left-side feedback so the UI doesn't look frozen.
    push({ kind: "waiting", text: t("chat.thinking") });
    try {
      await invoke("send_prompt_rich", {
        payload: {
          text,
          attachments: pendingAttachments.map((a) => ({
            path: a.path,
            name: attachmentDisplayName(a),
            mime: a.mime ?? null,
            size: a.size ?? null,
            is_dir: Boolean(a.isDir),
          })),
          model: modelId || null,
          effort: null,
        },
      });
    } catch (e) {
      if (sid) setSessionBusyState(sid, false);
      else setBusy(false);
      clearWaiting();
      push({ kind: "error", text: formatAgentErrorMessage(String(e)) });
      finishTurnCollapse(true);
    }
  };

  /**
   * Stop button: end the active task's in-flight work immediately.
   * - UI leaves Working right away
   * - Soft-cancel + force-restart agent (clears wedged `task_already_running`)
   * - Auto-nudge is suppressed so we do not restart after stop
   */
  const onCancel = async () => {
    const sid = sessionIdRef.current;
    // Suppress verbal auto-continue after a user stop.
    verbalNudgeUsedRef.current = true;
    autoNudgeInFlightRef.current = false;
    if (sid) userStoppedSessionRef.current = sid;
    setLongRunNotice(null);
    longRunDismissedRef.current = true;

    // Optimistic UI: stop spinner / dock badge before RPC returns.
    if (sid) setSessionBusyState(sid, false);
    else setBusy(false);
    clearPermissionsForSession(sid);
    clearWaiting();

    try {
      await invoke("cancel_turn");
    } catch (e) {
      // Still settle the turn in the transcript.
      push({
        kind: "system",
        text: t("chat.stopRequested", { err: String(e) }),
      });
    } finally {
      // Collapse thinking/tools and show cancelled end state.
      finishTurnCollapse(false);
      // Ensure a cancelled system line is visible if bridge event was missed.
      setLines((prev) => {
        const lastUser = (() => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].kind === "user") return i;
          }
          return -1;
        })();
        const tail = lastUser >= 0 ? prev.slice(lastUser + 1) : prev;
        const hasRestartNote = tail.some(
          (l) =>
            (l.kind === "system" || l.kind === "error") &&
            /agent restarted/i.test(l.text),
        );
        if (hasRestartNote) return prev;
        const next: ChatLine[] = [
          ...prev,
          {
            id: nextLineId("system"),
            kind: "system",
            text: t("chat.turnStopped"),
          },
        ];
        linesRef.current = next;
        return next;
      });
      if (sid) setSessionBusyState(sid, false);
      else setBusy(false);
      void flushPersistHistory();
    }
  };

  /** Windowed chat rows: same ChatLine plus height estimate for virtualization. */
  const virtualChatItems = useMemo(
    () =>
      lines.map((line) => ({
        ...line,
        estimateHeight: estimateChatLineHeight(line),
      })),
    [lines],
  );

  /** Drag the vertical split between sidebar ↔ chat or chat ↔ Outputs. */
  const onPanelResizeStart = useCallback(
    (kind: "sidebar" | "right", e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      panelDragRef.current = {
        kind,
        startX: e.clientX,
        startW: kind === "sidebar" ? sidebarWidth : rightWidth,
      };
      document.body.classList.add("resizing-panels");
    },
    [sidebarWidth, rightWidth],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = panelDragRef.current;
      if (!drag) return;
      if (drag.kind === "sidebar") {
        const next = clampWidth(
          drag.startW + (e.clientX - drag.startX),
          SIDEBAR_W_MIN,
          SIDEBAR_W_MAX,
        );
        setSidebarWidth(next);
      } else {
        // Right edge: drag handle is on the left of the rail; move left → wider.
        const next = clampWidth(
          drag.startW - (e.clientX - drag.startX),
          RIGHT_W_MIN,
          RIGHT_W_MAX,
        );
        setRightWidth(next);
      }
    };
    const onUp = () => {
      if (!panelDragRef.current) return;
      const kind = panelDragRef.current.kind;
      panelDragRef.current = null;
      document.body.classList.remove("resizing-panels");
      if (kind === "sidebar") {
        writeStoredWidth("grokx.sidebarWidth", sidebarWidthRef.current);
      } else {
        writeStoredWidth("grokx.rightWidth", rightWidthRef.current);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-panels");
    };
  }, []);

  /** Bases for resolving relative markdown images / media. */
  const chatMediaBases = useMemo(
    () => [session?.project_root, session?.work_path, projectRoot],
    [session?.work_path, session?.project_root, projectRoot],
  );

  const onPermission = async (
    decision: "allow_once" | "deny",
    requestId?: string,
  ) => {
    const activeSid = session?.session_id;
    const target =
      (requestId
        ? activePendingPerms.find((p) => p.id === requestId)
        : activePendingPerms[0]) ?? null;
    if (!target) return;
    // Never approve/deny another task's request while viewing this one.
    if (target.session_id && activeSid && target.session_id !== activeSid) {
      push({
        kind: "system",
        text: t("approvals.switchTaskFirst"),
      });
      return;
    }
    const id = target.id;
    try {
      await invoke("resolve_permission", { requestId: id, decision });
      push({
        kind: "system",
        text:
          decision === "deny"
            ? t("approvals.deniedLog", { summary: target.summary })
            : t("approvals.allowedLog", { summary: target.summary }),
      });
      // Only drop this request — keep other queued approvals visible.
      removePermission(id);
      // After allow, tools continue — keep Working until turn_finished.
      if (decision !== "deny") {
        setBusy(true);
      }
    } catch (e) {
      push({ kind: "error", text: String(e) });
    }
  };

  const needsLocalLlm = useMemo(() => {
    const id = (modelId || "").trim().toLowerCase();
    if (id === BONSAI_MODEL_ID) return true;
    const profile =
      modelProfiles.find((p) => p.model_id === modelId) ?? modelProfiles[0];
    const base = (profile?.base_url || "").toLowerCase();
    return base.includes("127.0.0.1:8080") || base.includes("localhost:8080");
  }, [modelId, modelProfiles]);

  /** Poll / ensure local llama only after runtime files (incl. CUDA DLLs) are on disk. */
  useEffect(() => {
    if (!needsLocalLlm) {
      setLocalLlmStatus("n/a");
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let inFlight = false;
    const tick = async () => {
      try {
        const s = await invoke<string>("local_llm_status");
        if (!cancelled) setLocalLlmStatus(s);
        const filesReady = depReadiness?.local_llm_ready === true;
        const alreadyUp = s === "ready" || s === "starting";
        if (filesReady && !alreadyUp && !inFlight && attempts < 3) {
          attempts += 1;
          inFlight = true;
          void invoke<string>("ensure_local_llm")
            .catch(() => {
              /* status poll will surface failure */
            })
            .finally(() => {
              inFlight = false;
            });
        }
      } catch {
        if (!cancelled) setLocalLlmStatus("failed:status");
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [needsLocalLlm, depReadiness?.local_llm_ready]);

  /** Poll dependency readiness; kick auto-download of missing items when online. */
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await invoke<{
          ok: boolean;
          message: string;
          local_llm_ready: boolean;
          local_llm_blocked: boolean;
          grok_ready: boolean;
          downloading_ids: string[];
          missing_ids: string[];
          paused_ids: string[];
        }>("get_dependency_readiness");
        if (!cancelled) setDepReadiness(r);
        // If something is still missing (and not paused), ask backend to start downloads.
        // missing_ids already excludes Bonsai/llama when GPU is insufficient; still fetch grok.exe.
        if (r.missing_ids.length > 0 && r.downloading_ids.length === 0) {
          void invoke<string[]>("download_all_missing_dependencies").catch(() => {
            /* offline / already in flight */
          });
        }
      } catch {
        /* ignore — catalog may be unavailable early */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const agentReady = isAgentReadyStatus(agentStatus);
  const localLlmBlocked =
    Boolean(depReadiness?.local_llm_blocked) || Boolean(bonsaiTune?.blocked);
  const depsBlockingLocal =
    needsLocalLlm && depReadiness != null && !depReadiness.local_llm_ready;
  const depsDownloading =
    !localLlmBlocked &&
    ((depReadiness?.downloading_ids.length ?? 0) > 0 ||
      (needsLocalLlm &&
        depsBlockingLocal &&
        (depReadiness?.missing_ids.length ?? 0) > 0));
  const localLlmReady =
    !needsLocalLlm ||
    ((localLlmStatus === "ready" || localLlmStatus === "n/a") && !depsBlockingLocal);
  const waitingLocalModel =
    needsLocalLlm &&
    !localLlmBlocked &&
    agentReady &&
    !localLlmReady &&
    (!localLlmStatus.startsWith("failed") || depsBlockingLocal);

  const connected = useMemo(
    () => Boolean(session?.session_id) && agentReady && localLlmReady,
    [session, agentReady, localLlmReady],
  );

  const statusClass = busy
    ? "busy"
    : connected
      ? "ready"
      : waitingLocalModel ||
          depsDownloading ||
          connecting ||
          isAgentStartingStatus(agentStatus)
        ? "busy"
        : "";
  const statusLabel = connecting
    ? t("nav.connecting")
    : isAgentStartingStatus(agentStatus)
      ? t("status.starting")
      : busy
        ? t("status.working")
        : connected
          ? t("status.ready")
          : depsDownloading && needsLocalLlm
            ? t("status.depsDownloading")
            : localLlmBlocked && needsLocalLlm
              ? t("status.bonsaiRequires8g")
              : waitingLocalModel
                ? t("status.loadingModel")
                : localLlmStatus.startsWith("failed") && needsLocalLlm
                  ? t("status.localModelFailed")
                  : depsBlockingLocal
                    ? t("status.depsNotReady")
                    : formatAgentStatusLabel(agentStatus, t);
  const activeTaskTitle =
    sessions.find((s) => s.session_id === session?.session_id)?.title || null;
  const title =
    (activeTaskTitle ? displayTaskTitle(activeTaskTitle, t) : null) ||
    selectedProject?.name ||
    shortPath(session?.project_root || projectRoot, t("topbar.noProject")) ||
    "FreeCoder";

  const layoutStyle = {
    ["--sidebar-w" as string]: sidebarOpen
      ? `${sidebarWidth}px`
      : "52px",
    ["--right-w" as string]: `${rightWidth}px`,
  } as CSSProperties;

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("grokx.sidebarOpen", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  /** Open right rail, or collapse if already open. */
  const toggleRightPanel = useCallback(() => {
    setOutputsOpen((open) => !open);
  }, []);

  const sideChatSessionId = session?.session_id ?? null;
  const sideChatMessages = sideChatSessionId
    ? (sideChatBySession[sideChatSessionId] ?? [])
    : [];

  const updateSideChatMessages = useCallback(
    (updater: (prev: SideChatMessage[]) => SideChatMessage[]) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      setSideChatBySession((map) => {
        const prev = map[sid] ?? [];
        return { ...map, [sid]: updater(prev) };
      });
    },
    [],
  );

  return (
    <div
      className={`layout${outputsOpen ? "" : " layout-outputs-collapsed"}${
        sidebarOpen ? "" : " layout-sidebar-collapsed"
      }${view === "settings" ? " layout-settings" : ""}`}
      style={layoutStyle}
    >
      {view !== "settings" && (
      <aside className={`sidebar${sidebarOpen ? "" : " sidebar-collapsed"}`}>
        {/* Full sidebar chrome under traffic lights — drag to move the window. */}
        <div
          className="sidebar-titlebar"
          onMouseDown={onTitlebarMouseDown}
          onDoubleClick={onTitlebarDoubleClick}
        >
          <div className="brand-row">
            {sidebarOpen ? (
              <>
                <button
                  type="button"
                  className="brand brand-btn"
                  title={t("nav.backToWorkspace")}
                  onClick={() => setView("workspace")}
                >
                  <img
                    src={brandIcon}
                    alt=""
                    className="brand-logo"
                    width={22}
                    height={22}
                    draggable={false}
                  />
                  <span>FreeCoder</span>
                </button>
                <button
                  type="button"
                  className="icon-btn sidebar-collapse-btn"
                  title={t("nav.collapseSidebar")}
                  aria-label={t("nav.collapseSidebar")}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSidebar();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <IconChevronLeft size={16} />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="icon-btn sidebar-expand-btn brand-collapsed-btn"
                title={t("nav.expandSidebar")}
                aria-label={t("nav.expandSidebar")}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSidebar();
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <img
                  src={brandIcon}
                  alt=""
                  className="brand-logo brand-logo-collapsed"
                  width={28}
                  height={28}
                  draggable={false}
                />
              </button>
            )}
          </div>
        </div>

        {sidebarOpen && (
        <>
        {/*
          Projects = fixed folders; tasks nest under the selected project.
          Tasks = temporary sessions (default sandbox) only.
          New task: use Tasks + / project +.
        */}
        <div className="section-label-row">
          <button
            type="button"
            className={`section-label-btn${
              projectsSectionOpen ? "" : " collapsed"
            }`}
            aria-expanded={projectsSectionOpen}
            title={
              projectsSectionOpen
                ? t("nav.collapseProjects")
                : t("nav.expandProjects")
            }
            onClick={() => {
              setProjectsSectionOpen((v) => {
                const next = !v;
                try {
                  localStorage.setItem(
                    "grokx.sidebar.projectsOpen",
                    next ? "1" : "0",
                  );
                } catch {
                  /* ignore */
                }
                return next;
              });
            }}
          >
            <span className="section-chevron" aria-hidden>
              {projectsSectionOpen ? (
                <IconChevronDown size={14} />
              ) : (
                <IconChevronRight size={14} />
              )}
            </span>
            <span className="section-label">{t("nav.projects")}</span>
          </button>
          <button
            type="button"
            className="session-add-btn"
            title={t("nav.openProjectFolder")}
            disabled={connecting}
            onClick={() => void onOpenProject()}
          >
            <IconPlus size={16} />
          </button>
        </div>
        {projectsSectionOpen && (
        <div className="project-list">
          {projects.length === 0 && (
            <div className="session-empty">
              {t("nav.noProjects")}
            </div>
          )}
          {projects.map((p) => {
            const isExpanded = expandedProjectIds.has(p.project_id);
            const isSelected = p.project_id === selectedProjectId;
            const nested = sessionsByProjectId.get(p.project_id) ?? [];
            // When project is collapsed, still surface child task activity.
            let nestedWorking = 0;
            let nestedUnread = 0;
            let nestedNeedsApproval = 0;
            for (const s of nested) {
              const childActive = s.session_id === session?.session_id;
              if (
                sessionBusyMap[s.session_id] ||
                (childActive && busy)
              ) {
                nestedWorking += 1;
              }
              if (sessionUnreadMap[s.session_id] && !childActive) {
                nestedUnread += 1;
              }
              if (
                sessionsNeedingApproval.has(s.session_id) &&
                !childActive
              ) {
                nestedNeedsApproval += 1;
              }
            }
            const projectWorking = nestedWorking > 0;
            const projectUnread = nestedUnread > 0;
            const projectNeedsApproval = nestedNeedsApproval > 0;
            // Show unread on the project row only while collapsed.
            const showProjectUnread = projectUnread && !isExpanded;
            const showProjectApproval = projectNeedsApproval && !isExpanded;
            return (
              <div key={p.project_id} className="project-block">
                <div
                  className={`project-row${isSelected ? " active" : ""}${
                    isExpanded ? " expanded" : ""
                  }${projectWorking ? " working" : ""}${
                    showProjectUnread ? " unread" : ""
                  }${showProjectApproval ? " needs-approval" : ""}`}
                  onClick={() => void onSelectProject(p)}
                  title={
                    showProjectApproval
                      ? t("nav.approvalTasksTip", {
                          n: nestedNeedsApproval,
                          path: p.root_path,
                        })
                      : projectWorking
                      ? t("nav.workingTasksTip", {
                          n: nestedWorking,
                          path: p.root_path,
                        })
                      : showProjectUnread
                        ? t("nav.unreadTasksTip", {
                            n: nestedUnread,
                            path: p.root_path,
                          })
                        : isExpanded
                          ? t("nav.expandedTip", { path: p.root_path })
                          : t("nav.projectTip", { path: p.root_path })
                  }
                >
                  <div className="project-row-main">
                    {projectWorking ? (
                      <span
                        className="session-working-spin project-working-spin"
                        title={
                          nestedWorking === 1
                            ? t("nav.taskWorkingOne")
                            : t("nav.tasksWorking", { n: nestedWorking })
                        }
                        aria-label={
                          nestedWorking === 1
                            ? t("nav.taskWorkingOne")
                            : t("nav.tasksWorking", { n: nestedWorking })
                        }
                      />
                    ) : (
                      <span className="project-icon" aria-hidden>
                        <IconFolder size={15} />
                      </span>
                    )}
                    <div className="project-title">
                      {p.name}
                      {showProjectApproval && (
                        <span
                          className="session-approval-dot"
                          title={
                            nestedNeedsApproval === 1
                              ? t("nav.approvalTaskOne")
                              : t("nav.approvalTasks", { n: nestedNeedsApproval })
                          }
                          aria-label={t("nav.approvalInProject")}
                        />
                      )}
                      {showProjectUnread && !showProjectApproval && (
                        <span
                          className="session-unread-dot"
                          title={
                            nestedUnread === 1
                              ? t("nav.unreadTaskOne")
                              : t("nav.unreadTasks", { n: nestedUnread })
                          }
                          aria-label={t("nav.unreadInProject")}
                        />
                      )}
                    </div>
                    <span
                      className={`project-count${
                        projectWorking ? " project-count-working" : ""
                      }`}
                      title={
                        projectWorking
                          ? t("nav.workingTotal", {
                              working: nestedWorking,
                              total: nested.length,
                            })
                          : undefined
                      }
                    >
                      {projectWorking
                        ? `${nestedWorking}/${nested.length}`
                        : nested.length}
                    </span>
                    <button
                      type="button"
                      className="session-action-btn project-add-task-btn"
                      title={t("nav.newTaskUnderProject")}
                      disabled={connecting}
                      onClick={(e) => void onNewProjectTask(p, e)}
                    >
                      <IconPlus size={12} />
                    </button>
                    <button
                      type="button"
                      className="session-action-btn session-delete-btn project-delete-btn"
                      title={t("nav.removeProject")}
                      onClick={(e) => void onDeleteProject(p, e)}
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="project-tasks">
                    {nested.length === 0 && (
                      <div className="session-empty session-empty-nested">
                        {t("nav.noNestedTasks")}
                      </div>
                    )}
                    {nested.map((s) => {
                      const isActive = s.session_id === session?.session_id;
                      const isWorking = Boolean(
                        sessionBusyMap[s.session_id] ||
                          (isActive && busy),
                      );
                      const isUnread = Boolean(
                        sessionUnreadMap[s.session_id] && !isActive,
                      );
                      const needsApproval = Boolean(
                        sessionsNeedingApproval.has(s.session_id) && !isActive,
                      );
                      return (
                        <div
                          key={s.session_id}
                          className={`session-row nested task-row${
                            isActive ? " active" : ""
                          }${isWorking ? " working" : ""}${
                            isUnread ? " unread" : ""
                          }${needsApproval ? " needs-approval" : ""}`}
                          onClick={() => void onActivateSession(s)}
                          onDoubleClick={(e) => startRename(s, e)}
                          title={
                            needsApproval
                              ? t("nav.nestedApprovalTip", {
                                  project: p.name,
                                  path: s.work_path || "<project>/.grokx/tasks/…",
                                })
                              : isWorking
                              ? t("nav.nestedWorkingTip", {
                                  path: s.work_path || "<project>/.grokx/tasks/…",
                                })
                              : isUnread
                                ? t("nav.nestedUnreadTip", {
                                    project: p.name,
                                    path: s.work_path || "<project>/.grokx/tasks/…",
                                  })
                                : t("nav.nestedTaskTip", {
                                    project: p.name,
                                    path: s.work_path || "<project>/.grokx/tasks/…",
                                  })
                          }
                        >
                          {renamingId === s.session_id ? (
                            <input
                              ref={renameInputRef}
                              className="session-rename-input"
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void commitRename();
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelRename();
                                }
                              }}
                              onBlur={() => void commitRename()}
                            />
                          ) : (
                            <>
                              <div className="session-row-main">
                                {isWorking ? (
                                  <span
                                    className="session-working-spin"
                                    title={t("status.working")}
                                    aria-label={t("status.working")}
                                  />
                                ) : (
                                  <span className="task-icon" aria-hidden>
                                    <IconTask size={13} />
                                  </span>
                                )}
                                <div className="session-title">
                                  {s.title
                                    ? displayTaskTitle(s.title, t)
                                    : s.session_id.slice(0, 8)}
                                  {needsApproval && (
                                    <span
                                      className="session-approval-dot"
                                      title={t("approvals.title")}
                                      aria-label={t("nav.needsApproval")}
                                    />
                                  )}
                                  {isUnread && !needsApproval && (
                                    <span
                                      className="session-unread-dot"
                                      title={t("common.unread")}
                                      aria-label={t("nav.unreadActivity")}
                                    />
                                  )}
                                </div>
                                <button
                                  type="button"
                                  className="session-action-btn"
                                  title={t("nav.renameTask")}
                                  onClick={(e) => startRename(s, e)}
                                >
                                  <IconPen size={12} />
                                </button>
                                <button
                                  type="button"
                                  className="session-action-btn session-delete-btn"
                                  title={t("nav.deleteTask")}
                                  onClick={(e) => void onDeleteSession(s, e)}
                                >
                                  <IconTrash size={12} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        )}

        {/* Temporary tasks only (not bound to a user Project) */}
        <div className="section-label-row">
          <button
            type="button"
            className={`section-label-btn${
              tasksSectionOpen ? "" : " collapsed"
            }`}
            aria-expanded={tasksSectionOpen}
            title={
              tasksSectionOpen ? t("nav.collapseTasks") : t("nav.expandTasks")
            }
            onClick={() => {
              setTasksSectionOpen((v) => {
                const next = !v;
                try {
                  localStorage.setItem(
                    "grokx.sidebar.tasksOpen",
                    next ? "1" : "0",
                  );
                } catch {
                  /* ignore */
                }
                return next;
              });
            }}
          >
            <span className="section-chevron" aria-hidden>
              {tasksSectionOpen ? (
                <IconChevronDown size={14} />
              ) : (
                <IconChevronRight size={14} />
              )}
            </span>
            <span className="section-label">{t("nav.tasks")}</span>
          </button>
          <button
            type="button"
            className="session-add-btn"
            title={t("nav.newTempTask")}
            disabled={connecting}
            onClick={() => void onNewStandaloneTask()}
          >
            <IconPlus size={16} />
          </button>
        </div>
        {tasksSectionOpen && (
        <div className="session-list">
          {temporarySessions.length === 0 && (
            <div className="session-empty">
              {t("nav.noTasks")}
            </div>
          )}
          {temporarySessions.map((s) => {
            const isActive = s.session_id === session?.session_id;
            const isWorking = Boolean(
              sessionBusyMap[s.session_id] || (isActive && busy),
            );
            const isUnread = Boolean(
              sessionUnreadMap[s.session_id] && !isActive,
            );
            const needsApproval = Boolean(
              sessionsNeedingApproval.has(s.session_id) && !isActive,
            );
            return (
              <div
                key={s.session_id}
                className={`session-row task-row${isActive ? " active" : ""}${
                  isWorking ? " working" : ""
                }${isUnread ? " unread" : ""}${
                  needsApproval ? " needs-approval" : ""
                }`}
                onClick={() => void onActivateSession(s)}
                onDoubleClick={(e) => startRename(s, e)}
                title={
                  needsApproval
                    ? t("nav.tempApprovalTip", {
                        path: s.work_path || "~/.grokx/workspace/.grokx/tasks/…",
                      })
                    : isWorking
                    ? t("nav.tempWorkingTip", {
                        path: s.work_path || "~/.grokx/workspace/.grokx/tasks/…",
                      })
                    : isUnread
                      ? t("nav.tempUnreadTip", {
                          path: s.work_path || "~/.grokx/workspace/.grokx/tasks/…",
                        })
                      : t("nav.tempTaskTip", {
                          path: s.work_path || "~/.grokx/workspace/.grokx/tasks/…",
                        })
                }
              >
                {renamingId === s.session_id ? (
                  <input
                    ref={renameInputRef}
                    className="session-rename-input"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    onBlur={() => void commitRename()}
                  />
                ) : (
                  <>
                    <div className="session-row-main">
                      {isWorking ? (
                        <span
                          className="session-working-spin"
                          title={t("status.working")}
                          aria-label={t("status.working")}
                        />
                      ) : (
                        <span className="task-icon" aria-hidden>
                          <IconTask size={13} />
                        </span>
                      )}
                      <div className="session-title">
                        {s.title
                          ? displayTaskTitle(s.title, t)
                          : s.session_id.slice(0, 8)}
                        {needsApproval && (
                          <span
                            className="session-approval-dot"
                            title={t("approvals.title")}
                            aria-label={t("nav.needsApproval")}
                          />
                        )}
                        {isUnread && !needsApproval && (
                          <span
                            className="session-unread-dot"
                            title={t("common.unread")}
                            aria-label={t("nav.unreadActivity")}
                          />
                        )}
                      </div>
                      <button
                        type="button"
                        className="session-action-btn"
                        title={t("nav.renameTask")}
                        onClick={(e) => startRename(s, e)}
                      >
                        <IconPen size={12} />
                      </button>
                      <button
                        type="button"
                        className="session-action-btn session-delete-btn"
                        title={t("nav.deleteTask")}
                        onClick={(e) => void onDeleteSession(s, e)}
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        )}

        <div className="sidebar-bottom">
          <button
            type="button"
            className="nav-item sidebar-settings-btn"
            title={t("nav.settingsTitle")}
            onClick={() => {
              setView("settings");
              setSettingsSection("general");
              void loadSettings();
            }}
          >
            <span className="nav-glyph">
              <IconSettings size={16} />
            </span>
            {t("nav.settings")}
          </button>
        </div>
        </>
        )}
      </aside>
      )}

      {view !== "settings" &&
        (sidebarOpen ? (
          <div
            className="panel-resizer panel-resizer-sidebar"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("nav.resizeSidebar")}
            title={t("nav.dragResizeSidebar")}
            onMouseDown={(e) => onPanelResizeStart("sidebar", e)}
          />
        ) : (
          <div className="panel-resizer panel-resizer-sidebar panel-resizer-sidebar-collapsed" />
        ))}

      {view === "settings" ? (
        <div className="settings-shell">
          <aside
            className="settings-rail"
            onMouseDown={onTitlebarMouseDown}
            onDoubleClick={onTitlebarDoubleClick}
          >
            <div className="settings-rail-top">
              <button
                type="button"
                className="settings-back-btn"
                onClick={() => setView("workspace")}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <IconChevronLeft size={16} />
                {t("settings.back")}
              </button>
            </div>
            <nav className="settings-rail-nav" aria-label={t("nav.settings")}>
              <div className="settings-rail-group">{t("settings.configuration")}</div>
              <button
                type="button"
                className={`settings-rail-item${
                  settingsSection === "general" ? " active" : ""
                }`}
                onClick={() => setSettingsSection("general")}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <IconTool size={15} />
                {t("settings.general")}
              </button>
              <button
                type="button"
                className={`settings-rail-item${
                  settingsSection === "model" ? " active" : ""
                }`}
                onClick={() => setSettingsSection("model")}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <IconGoal size={15} />
                {t("settings.model")}
              </button>
              <button
                type="button"
                className={`settings-rail-item${
                  settingsSection === "extensions" ? " active" : ""
                }`}
                onClick={() => setSettingsSection("extensions")}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <IconPuzzle size={15} />
                {t("settings.extensions")}
              </button>
              <button
                type="button"
                className={`settings-rail-item${
                  settingsSection === "dependencies" ? " active" : ""
                }`}
                onClick={() => setSettingsSection("dependencies")}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <IconFile size={15} />
                {t("settings.dependencies")}
              </button>
              <button
                type="button"
                className={`settings-rail-item${
                  settingsSection === "about" ? " active" : ""
                }`}
                onClick={() => setSettingsSection("about")}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <IconInfo size={15} />
                {t("settings.about")}
              </button>
            </nav>
          </aside>

          <main className="settings-content">
            <div className="settings-content-scroll">
              {settingsSection === "general" && (
                <>
                  <h1 className="settings-page-title">{t("settings.general")}</h1>
                  <p className="settings-page-lead">{t("settings.generalLead")}</p>
                  {settingsMsg && (
                    <div
                      className={
                        settingsMsgIsError ? "error-banner" : "settings-ok"
                      }
                    >
                      {settingsMsg}
                    </div>
                  )}

                  <h2 className="settings-group-title">{t("settings.language")}</h2>
                  <div className="settings-group-card">
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.language")}</div>
                        <div className="settings-row-desc">{t("settings.languageDesc")}</div>
                      </div>
                      <select
                        className="settings-select settings-row-control"
                        value={locale}
                        onChange={(e) => {
                          const next = normalizeLocale(e.target.value) as UiLocale;
                          setLocale(next);
                          void invoke("save_settings", {
                            update: { ui_language: next },
                          }).catch((err) => console.warn("save ui_language failed", err));
                        }}
                      >
                        <option value="zh-CN">{t("settings.langZh")}</option>
                        <option value="en">{t("settings.langEn")}</option>
                      </select>
                    </div>
                  </div>

                  <h2 className="settings-group-title">{t("settings.defaultTier")}</h2>
                  <div className="settings-group-card">
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.defaultTier")}</div>
                        <div className="settings-row-desc">{t("settings.defaultTierDesc")}</div>
                      </div>
                      <select
                        className="settings-select settings-row-control"
                        value={grokDefaultTier}
                        onChange={(e) =>
                          setDefaultTierAndSave(
                            e.target.value as PerformanceTier,
                          )
                        }
                      >
                        {PERFORMANCE_TIERS.map((tier) => (
                          <option key={tier} value={tier}>
                            {displayNameForPerformanceTier(tier)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <h2 className="settings-group-title">{t("settings.defaultModels")}</h2>
                  <div className="settings-group-card">
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.defaultChatModel")}</div>
                        <div className="settings-row-desc">{t("settings.defaultChatModelDesc")}</div>
                      </div>
                      <select
                        className="settings-select settings-row-control"
                        value={
                          chatDefaultProfiles.some((p) => p.model_id === grokDefaultModel)
                            ? grokDefaultModel
                            : chatDefaultProfiles[0]?.model_id || grokDefaultModel
                        }
                        onChange={(e) =>
                          void setDefaultModelAndSave(e.target.value, {
                            userPinned: true,
                          })
                        }
                      >
                        {chatDefaultProfiles.map((p) => (
                          <option key={p.model_id} value={p.model_id}>
                            {displayNameForModel(p.model_id)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.defaultImageModel")}</div>
                        <div className="settings-row-desc">{t("settings.defaultImageModelDesc")}</div>
                      </div>
                      <select
                        className="settings-select settings-row-control"
                        value={
                          imageDefaultProfiles.some((p) => p.model_id === defaultImageModel)
                            ? defaultImageModel
                            : imageDefaultProfiles[0]?.model_id || defaultImageModel
                        }
                        onChange={(e) => void setDefaultImageModelAndSave(e.target.value)}
                        disabled={imageDefaultProfiles.length === 0}
                      >
                        {imageDefaultProfiles.length === 0 ? (
                          <option value="">{t("settings.defaultMediaNone")}</option>
                        ) : (
                          imageDefaultProfiles.map((p) => (
                            <option key={p.model_id} value={p.model_id}>
                              {displayNameForModel(p.model_id)}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.defaultVideoModel")}</div>
                        <div className="settings-row-desc">{t("settings.defaultVideoModelDesc")}</div>
                      </div>
                      <select
                        className="settings-select settings-row-control"
                        value={
                          videoDefaultProfiles.some((p) => p.model_id === defaultVideoModel)
                            ? defaultVideoModel
                            : videoDefaultProfiles[0]?.model_id || defaultVideoModel
                        }
                        onChange={(e) => void setDefaultVideoModelAndSave(e.target.value)}
                        disabled={videoDefaultProfiles.length === 0}
                      >
                        {videoDefaultProfiles.length === 0 ? (
                          <option value="">{t("settings.defaultMediaNone")}</option>
                        ) : (
                          videoDefaultProfiles.map((p) => (
                            <option key={p.model_id} value={p.model_id}>
                              {displayNameForModel(p.model_id)}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                  </div>

                  <h2 className="settings-group-title">{t("settings.permissions")}</h2>
                  <div className="settings-group-card">
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.toolPermission")}</div>
                        <div className="settings-row-desc">
                          {t("settings.toolPermissionDesc")}
                        </div>
                      </div>
                      <select
                        className="settings-select settings-row-control"
                        value={permissionMode}
                        onChange={(e) =>
                          void setPermissionModeAndSave(
                            normalizePermissionMode(e.target.value),
                          )
                        }
                      >
                        <option value="ask">{t("settings.permAsk")}</option>
                        <option value="auto">{t("settings.permAuto")}</option>
                        <option value="always-approve">{t("settings.permFullTrust")}</option>
                      </select>
                    </div>
                  </div>

                  <h2 className="settings-group-title">{t("settings.engineUiSection")}</h2>
                  <div className="settings-group-card">
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.maxThoughtsWidth")}</div>
                        <div className="settings-row-desc">{t("settings.maxThoughtsWidthDesc")}</div>
                      </div>
                      <input
                        className="settings-row-input settings-row-control"
                        type="number"
                        min={40}
                        max={400}
                        value={grokEngineForm.max_thoughts_width}
                        onChange={(e) =>
                          setGrokEngineForm((prev) => ({
                            ...prev,
                            max_thoughts_width: Number(e.target.value) || 120,
                          }))
                        }
                      />
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.forkSecondaryModel")}</div>
                        <div className="settings-row-desc">{t("settings.forkSecondaryModelDesc")}</div>
                      </div>
                      <select
                        className="settings-select settings-row-control"
                        value={grokEngineForm.fork_secondary_model}
                        onChange={(e) =>
                          setGrokEngineForm((prev) => ({
                            ...prev,
                            fork_secondary_model: e.target.value,
                          }))
                        }
                      >
                        <option value="">{t("settings.forkSecondaryNone")}</option>
                        {modelProfiles.map((p) => (
                          <option key={p.model_id} value={p.model_id}>
                            {displayNameForModel(p.model_id)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <div className="settings-row-label">{t("settings.compactMode")}</div>
                        <div className="settings-row-desc">{t("settings.compactModeDesc")}</div>
                      </div>
                      <label className="settings-toggle">
                        <input
                          type="checkbox"
                          checked={grokEngineForm.compact_mode}
                          onChange={(e) =>
                            setGrokEngineForm((prev) => ({
                              ...prev,
                              compact_mode: e.target.checked,
                            }))
                          }
                        />
                        <span className="settings-toggle-ui" />
                      </label>
                    </div>
                  </div>
                  <div className="btn-row settings-save-row">
                    <button
                      className="btn btn-primary"
                      onClick={() => void onSaveEngineConfig()}
                      disabled={savingSettings}
                    >
                      {savingSettings ? t("settings.saving") : t("settings.save")}
                    </button>
                    <button
                      className="btn"
                      onClick={() => void loadSettings()}
                      disabled={savingSettings}
                    >
                      {t("settings.reload")}
                    </button>
                  </div>
                </>
              )}

              {settingsSection === "model" && (
                <>
                  <h1 className="settings-page-title">{t("settings.model")}</h1>
                  {settingsMsg && (
                    <div
                      className={
                        settingsMsgIsError
                          ? "error-banner"
                          : "settings-ok"
                      }
                    >
                      {settingsMsg}
                    </div>
                  )}

                  <div className="settings-model-layout">
                    <div className="settings-model-list">
                      <div className="settings-model-list-head">
                        <h2 className="settings-group-title">{t("settings.vendorList")}</h2>
                        <div className="settings-add-vendor-wrap" ref={addVendorMenuRef}>
                          <button
                            type="button"
                            className="btn btn-ghost settings-model-add"
                            onClick={() => setAddVendorMenuOpen((o) => !o)}
                          >
                            + {t("settings.addVendor")}
                          </button>
                          {addVendorMenuOpen && (
                            <div className="settings-add-vendor-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => addVendor("deepseek")}
                              >
                                DeepSeek
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => addVendor("bailian")}
                              >
                                {t("settings.vendorBailian")}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => addVendor("custom")}
                              >
                                {t("settings.vendorCustom")}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <ul className="settings-model-items">
                        {vendors.map((v) => (
                          <li
                            key={v.id}
                            className={`settings-model-list-row${
                              v.id === editingVendorId ? " active" : ""
                            }`}
                          >
                            <div className="settings-model-item-top">
                              <button
                                type="button"
                                className="settings-model-item-select"
                                onClick={() => setEditingVendorId(v.id)}
                              >
                                <span className="settings-model-item-name">
                                  {v.name}
                                </span>
                              </button>
                              {!v.locked && (
                                <button
                                  type="button"
                                  className="icon-btn settings-model-delete"
                                  title={t("settings.deleteVendor")}
                                  aria-label={t("settings.deleteVendor")}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    deleteVendor(v.id);
                                  }}
                                >
                                  <IconTrash size={12} />
                                </button>
                              )}
                            </div>
                            <button
                              type="button"
                              className="settings-model-item-select settings-model-item-sub"
                              onClick={() => setEditingVendorId(v.id)}
                            >
                              <span className="settings-model-item-id">
                                {v.locked
                                  ? t("settings.vendorLocal")
                                  : v.models.filter((m) => m.enabled).length > 0
                                    ? t("settings.vendorModelCount", {
                                        n: v.models.filter((m) => m.enabled).length,
                                      })
                                    : t("settings.vendorNoModels")}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {editingVendor && (
                      <div className="settings-model-editor">
                        <div className="settings-group-card">
                          {(editingVendor.kind === "deepseek" ||
                            editingVendor.kind === "bailian") && (
                            <div className="settings-row">
                              <div className="settings-row-text">
                                <div className="settings-row-label">
                                  {t("settings.balanceQuery")}
                                </div>
                                <div className="settings-row-desc settings-balance-result">
                                  {editingVendor.kind === "deepseek"
                                    ? balanceQueryBusy
                                      ? t("settings.balanceQuerying")
                                      : vendorBalanceSummary ||
                                        (!(
                                          editingVendor.api_key.trim() ||
                                          editingVendor.has_api_key
                                        )
                                          ? t("settings.balanceNeedKey")
                                          : "—")
                                    : t("settings.balanceBailianHint")}
                                </div>
                              </div>
                              <div className="btn-row">
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={
                                    endpointProbeBusy ||
                                    fetchModelsBusy ||
                                    balanceQueryBusy ||
                                    savingSettings
                                  }
                                  onClick={() => {
                                    if (editingVendor.kind === "deepseek") {
                                      void onQueryDeepseekBalance();
                                    } else {
                                      setBailianBalanceModalOpen(true);
                                    }
                                  }}
                                >
                                  {editingVendor.kind === "deepseek" &&
                                  balanceQueryBusy
                                    ? t("settings.balanceQuerying")
                                    : t("settings.balanceRefresh")}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  disabled={savingSettings}
                                  onClick={() => {
                                    if (
                                      editingVendor.kind === "deepseek" ||
                                      editingVendor.kind === "bailian"
                                    ) {
                                      openExternalUrl(
                                        vendorTopUpUrl(editingVendor.kind),
                                      );
                                    }
                                  }}
                                >
                                  {t("settings.balanceTopUp")}
                                </button>
                              </div>
                            </div>
                          )}
                          {editingVendor.locked ? (
                            <div className="settings-row settings-row-stack">
                              <div className="settings-row-text">
                                <div className="settings-row-label">
                                  {editingVendor.name}
                                </div>
                                <div className="settings-row-desc">
                                  {bonsaiTune?.blocked
                                    ? t("settings.bonsaiRequires8g")
                                    : t("settings.bonsaiLocalDesc")}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <>
                              {editingVendor.kind === "custom" && (
                                <div className="settings-row settings-row-stack">
                                  <div className="settings-row-text">
                                    <div className="settings-row-label">
                                      {t("settings.vendorName")}
                                    </div>
                                    <div className="settings-row-desc">
                                      {t("settings.vendorNameDesc")}
                                    </div>
                                  </div>
                                  <input
                                    className="settings-row-input"
                                    value={editingVendor.name}
                                    onChange={(e) =>
                                      updateEditingVendor({ name: e.target.value })
                                    }
                                    placeholder={t("settings.vendorNamePlaceholder")}
                                  />
                                </div>
                              )}
                              <div className="settings-row settings-row-stack">
                                <div className="settings-row-text">
                                  <div className="settings-row-label">{t("settings.baseUrl")}</div>
                                  <div className="settings-row-desc">{t("settings.baseUrlDesc")}</div>
                                </div>
                                <input
                                  className="settings-row-input"
                                  value={editingVendor.base_url}
                                  onChange={(e) =>
                                    updateEditingVendor({ base_url: e.target.value })
                                  }
                                  placeholder={
                                    editingVendor.kind === "deepseek"
                                      ? "https://api.deepseek.com/v1"
                                      : editingVendor.kind === "bailian"
                                        ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
                                        : "https://api.example.com/v1"
                                  }
                                />
                              </div>
                              <div className="settings-row settings-row-stack">
                                <div className="settings-row-text">
                                  <div className="settings-row-label">
                                    {t("settings.apiKey")}
                                    {(Boolean(editingVendor.api_key.trim()) ||
                                      editingVendor.has_api_key) && (
                                      <span className="settings-api-key-status">
                                        {t("settings.apiKeySaved", {
                                          hint:
                                            (editingVendor.api_key.trim()
                                              ? maskApiKeyHint(editingVendor.api_key)
                                              : editingVendor.api_key_hint) || "••••",
                                        })}
                                      </span>
                                    )}
                                  </div>
                                  <div className="settings-row-desc">{t("settings.apiKeyDesc")}</div>
                                </div>
                                <input
                                  className={`settings-row-input${
                                    !apiKeyFocused &&
                                    (Boolean(editingVendor.api_key.trim()) ||
                                      editingVendor.has_api_key)
                                      ? " settings-api-key-masked"
                                      : ""
                                  }`}
                                  type={
                                    apiKeyFocused && editingVendor.api_key.trim()
                                      ? "password"
                                      : "text"
                                  }
                                  value={
                                    apiKeyFocused
                                      ? editingVendor.api_key
                                      : editingVendor.api_key.trim()
                                        ? maskApiKeyHint(editingVendor.api_key)
                                        : editingVendor.has_api_key
                                          ? editingVendor.api_key_hint ||
                                            t("settings.apiKeyMaskedFallback")
                                          : ""
                                  }
                                  onFocus={() => setApiKeyFocused(true)}
                                  onBlur={() => setApiKeyFocused(false)}
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    // Ignore edits that are just the masked placeholder.
                                    if (raw.includes("•") || raw.includes("*")) {
                                      updateEditingVendor({ api_key: "" });
                                      return;
                                    }
                                    if (!raw.trim()) {
                                      updateEditingVendor({ api_key: "" });
                                      return;
                                    }
                                    updateEditingVendor({
                                      api_key: raw,
                                      has_api_key: true,
                                      api_key_hint: maskApiKeyHint(raw),
                                    });
                                  }}
                                  placeholder={
                                    editingVendor.has_api_key ||
                                    Boolean(editingVendor.api_key.trim())
                                      ? t("settings.apiKeyPlaceholderReplace")
                                      : "sk-..."
                                  }
                                  autoComplete="off"
                                  spellCheck={false}
                                />
                                <div className="settings-api-key-actions">
                                  {vendorKindToGetKeyPlatform(
                                    editingVendor.kind,
                                  ) && (
                                    <button
                                      type="button"
                                      className="btn btn-ghost settings-inline-action"
                                      onClick={() => {
                                        const p = vendorKindToGetKeyPlatform(
                                          editingVendor.kind,
                                        );
                                        if (p) {
                                          setGetKeyWizardVendorId(
                                            editingVendor.id,
                                          );
                                          setGetKeyWizardPlatform(p);
                                        }
                                      }}
                                      disabled={savingSettings}
                                    >
                                      {t("getApiKey.button")}
                                    </button>
                                  )}
                                  {(editingVendor.has_api_key ||
                                    Boolean(editingVendor.api_key.trim())) && (
                                    <button
                                      type="button"
                                      className="btn btn-ghost settings-inline-action"
                                      onClick={() => void onClearApiKey()}
                                      disabled={savingSettings}
                                    >
                                      {t("settings.clearKey")}
                                    </button>
                                  )}
                                </div>
                              </div>
                            </>
                          )}

                          <div className="settings-row">
                            <div className="settings-row-text">
                              <div className="settings-row-label">{t("settings.apiBackend")}</div>
                              <div className="settings-row-desc">{t("settings.apiBackendDesc")}</div>
                            </div>
                            <select
                              className="settings-select settings-row-control"
                              value={editingVendor.api_backend}
                              onChange={(e) =>
                                updateEditingVendor({ api_backend: e.target.value })
                              }
                              disabled={editingVendor.locked}
                            >
                              <option value="chat_completions">chat_completions</option>
                              <option value="responses">responses</option>
                              <option value="anthropic_messages">anthropic_messages</option>
                            </select>
                          </div>
                          <div className="settings-row">
                            <div className="settings-row-text">
                              <div className="settings-row-label">{t("settings.contextWindow")}</div>
                              <div className="settings-row-desc">
                                {editingVendor.locked
                                  ? bonsaiTune?.blocked
                                    ? t("settings.bonsaiRequires8g")
                                    : t("settings.contextWindowDescBonsai", {
                                        label: bonsaiTune?.label || "GPU",
                                      })
                                  : t("settings.contextWindowDesc")}
                              </div>
                            </div>
                            <div className="settings-k-input">
                              <input
                                className="settings-row-input settings-row-control"
                                type="number"
                                min={1}
                                step={1}
                                value={tokensToKInput(editingVendor.context_window)}
                                disabled={editingVendor.locked}
                                onChange={(e) =>
                                  updateEditingVendor({
                                    context_window: parseKInputToTokens(
                                      e.target.value,
                                      VENDOR_TOKEN_DEFAULTS[editingVendor.kind].contextK,
                                    ),
                                  })
                                }
                                placeholder={String(
                                  VENDOR_TOKEN_DEFAULTS[editingVendor.kind].contextK,
                                )}
                              />
                              <span className="settings-k-suffix" aria-hidden>
                                k
                              </span>
                            </div>
                          </div>
                          <div className="settings-row">
                            <div className="settings-row-text">
                              <div className="settings-row-label">{t("settings.maxCompletionTokens")}</div>
                              <div className="settings-row-desc">
                                {editingVendor.locked
                                  ? t("settings.maxCompletionTokensDescBonsai", {
                                      k: tokensToK(
                                        editingVendor.max_completion_tokens,
                                      ),
                                    })
                                  : t("settings.maxCompletionTokensDesc")}
                              </div>
                            </div>
                            <div className="settings-k-input">
                              <input
                                className="settings-row-input settings-row-control"
                                type="number"
                                min={1}
                                step={1}
                                value={tokensToKInput(editingVendor.max_completion_tokens)}
                                disabled={editingVendor.locked}
                                onChange={(e) =>
                                  updateEditingVendor({
                                    max_completion_tokens: parseKInputToTokens(
                                      e.target.value,
                                      VENDOR_TOKEN_DEFAULTS[editingVendor.kind]
                                        .maxCompletionK,
                                    ),
                                  })
                                }
                                placeholder={String(
                                  VENDOR_TOKEN_DEFAULTS[editingVendor.kind]
                                    .maxCompletionK,
                                )}
                              />
                              <span className="settings-k-suffix" aria-hidden>
                                k
                              </span>
                            </div>
                          </div>

                          <div className="settings-row settings-row-stack">
                            <div className="settings-row-text">
                              <div className="settings-row-label">{t("settings.vendorModels")}</div>
                              <div className="settings-row-desc">
                                {editingVendor.locked
                                  ? bonsaiTune?.blocked
                                    ? t("settings.bonsaiModelUnavailable")
                                    : t("settings.bonsaiModelFixed")
                                  : editingVendor.kind === "custom"
                                    ? t("settings.customModelsDesc")
                                    : t("settings.vendorModelsDesc")}
                              </div>
                            </div>
                            {editingVendor.kind === "custom" && !editingVendor.locked && (
                              <div className="settings-custom-model-add">
                                <input
                                  className="settings-row-input"
                                  value={customModelDraft}
                                  onChange={(e) => setCustomModelDraft(e.target.value)}
                                  placeholder={t("settings.customModelPlaceholder")}
                                  onKeyDown={(e) => {
                                    if (e.key !== "Enter") return;
                                    e.preventDefault();
                                    const id = customModelDraft.trim();
                                    if (!id) return;
                                    const capability = customModelDraftCap;
                                    const performanceTier = customModelDraftTier;
                                    setVendors((prev) =>
                                      prev.map((v) => {
                                        if (v.id !== editingVendor.id) return v;
                                        if (
                                          v.models.some(
                                            (m) =>
                                              m.id.toLowerCase() === id.toLowerCase(),
                                          )
                                        ) {
                                          return v;
                                        }
                                        return {
                                          ...v,
                                          models: [
                                            ...v.models,
                                            {
                                              id,
                                              enabled: true,
                                              capability,
                                              performanceTier,
                                              remoteConfirmed: true,
                                            },
                                          ],
                                        };
                                      }),
                                    );
                                    setCustomModelDraft("");
                                    setCustomModelDraftTier("strong");
                                  }}
                                />
                                <select
                                  className="settings-cap-select"
                                  value={customModelDraftCap}
                                  aria-label={t("settings.modelCapability")}
                                  title={t("settings.modelCapability")}
                                  onChange={(e) =>
                                    setCustomModelDraftCap(
                                      e.target.value as Exclude<ModelCapability, "local">,
                                    )
                                  }
                                >
                                  {CUSTOM_MODEL_CAPABILITIES.map((cap) => (
                                    <option key={cap} value={cap}>
                                      {cap}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  className="settings-cap-select"
                                  value={customModelDraftTier}
                                  aria-label={t("settings.modelPerformanceTier")}
                                  title={t("settings.modelPerformanceTier")}
                                  onChange={(e) =>
                                    setCustomModelDraftTier(
                                      e.target.value as PerformanceTier,
                                    )
                                  }
                                >
                                  {PERFORMANCE_TIERS.map((tier) => (
                                    <option key={tier} value={tier}>
                                      {displayNameForPerformanceTier(tier)}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => {
                                    const id = customModelDraft.trim();
                                    if (!id) return;
                                    const capability = customModelDraftCap;
                                    const performanceTier = customModelDraftTier;
                                    setVendors((prev) =>
                                      prev.map((v) => {
                                        if (v.id !== editingVendor.id) return v;
                                        if (
                                          v.models.some(
                                            (m) =>
                                              m.id.toLowerCase() === id.toLowerCase(),
                                          )
                                        ) {
                                          return v;
                                        }
                                        return {
                                          ...v,
                                          models: [
                                            ...v.models,
                                            {
                                              id,
                                              enabled: true,
                                              capability,
                                              performanceTier,
                                              remoteConfirmed: true,
                                            },
                                          ],
                                        };
                                      }),
                                    );
                                    setCustomModelDraft("");
                                    setCustomModelDraftTier("strong");
                                  }}
                                >
                                  {t("settings.addCustomModel")}
                                </button>
                              </div>
                            )}
                            {editingVendor.models.length > 0 ? (
                              <ul className="settings-vendor-models">
                                {editingVendor.models.map((m) => (
                                  <li key={m.id} className="settings-vendor-model-row">
                                    {editingVendor.locked ? (
                                      <span className="settings-vendor-model-label">
                                        <ModelBrandIcon
                                          modelId={m.id}
                                          vendorKind={editingVendor.kind}
                                          size={16}
                                        />
                                        {displayNameForModel(m.id, editingVendor.kind)}
                                      </span>
                                    ) : (
                                      <label className="settings-vendor-model-label">
                                        <input
                                          type="checkbox"
                                          checked={m.enabled}
                                          onChange={(e) => {
                                            const enabled = e.target.checked;
                                            const next = vendors.map((v) =>
                                              v.id !== editingVendor.id
                                                ? v
                                                : {
                                                    ...v,
                                                    models: v.models.map((x) =>
                                                      x.id === m.id
                                                        ? { ...x, enabled }
                                                        : x,
                                                    ),
                                                  },
                                            );
                                            suppressModelAutoSaveRef.current = true;
                                            setVendors(next);
                                            // Immediate sync: default + composer follow uncheck/check.
                                            void persistModelProfiles({
                                              vendors: next,
                                              quiet: true,
                                            });
                                          }}
                                        />
                                        <ModelBrandIcon
                                          modelId={m.id}
                                          vendorKind={editingVendor.kind}
                                          size={16}
                                        />
                                        <span className="mono">{m.id}</span>
                                        {editingVendor.kind === "custom" ? (
                                          <>
                                            <select
                                              className="settings-cap-select"
                                              value={resolveModelCapability(
                                                m.id,
                                                m.capability,
                                              )}
                                              aria-label={t("settings.modelCapability")}
                                              title={t("settings.modelCapability")}
                                              onClick={(e) => e.stopPropagation()}
                                              onChange={(e) => {
                                                e.stopPropagation();
                                                const capability = e.target
                                                  .value as ModelCapability;
                                                const next = vendors.map((v) =>
                                                  v.id !== editingVendor.id
                                                    ? v
                                                    : {
                                                        ...v,
                                                        models: v.models.map((x) =>
                                                          x.id === m.id
                                                            ? { ...x, capability }
                                                            : x,
                                                        ),
                                                      },
                                                );
                                                suppressModelAutoSaveRef.current = true;
                                                setVendors(next);
                                                void persistModelProfiles({
                                                  vendors: next,
                                                  quiet: true,
                                                });
                                              }}
                                            >
                                              {CUSTOM_MODEL_CAPABILITIES.map((cap) => (
                                                <option key={cap} value={cap}>
                                                  {cap}
                                                </option>
                                              ))}
                                            </select>
                                            <select
                                              className="settings-cap-select"
                                              value={resolvePerformanceTier(
                                                m.id,
                                                m.performanceTier,
                                                "custom",
                                              )}
                                              aria-label={t(
                                                "settings.modelPerformanceTier",
                                              )}
                                              title={t("settings.modelPerformanceTier")}
                                              onClick={(e) => e.stopPropagation()}
                                              onChange={(e) => {
                                                e.stopPropagation();
                                                const performanceTier = e.target
                                                  .value as PerformanceTier;
                                                const next = vendors.map((v) =>
                                                  v.id !== editingVendor.id
                                                    ? v
                                                    : {
                                                        ...v,
                                                        models: v.models.map((x) =>
                                                          x.id === m.id
                                                            ? {
                                                                ...x,
                                                                performanceTier,
                                                              }
                                                            : x,
                                                        ),
                                                      },
                                                );
                                                suppressModelAutoSaveRef.current = true;
                                                setVendors(next);
                                                void persistModelProfiles({
                                                  vendors: next,
                                                  quiet: true,
                                                });
                                              }}
                                            >
                                              {PERFORMANCE_TIERS.map((tier) => (
                                                <option key={tier} value={tier}>
                                                  {displayNameForPerformanceTier(tier)}
                                                </option>
                                              ))}
                                            </select>
                                          </>
                                        ) : (
                                          (() => {
                                            const cap = resolveModelCapability(
                                              m.id,
                                              m.capability,
                                            );
                                            return (
                                              <span className="settings-vendor-model-meta">
                                                <span className="settings-model-cap">
                                                  {isMediaToolCapability(cap)
                                                    ? `${cap} · MCP`
                                                    : cap}
                                                </span>
                                                {editingVendor.kind ===
                                                  "bailian" && (
                                                  <button
                                                    type="button"
                                                    className="btn btn-ghost settings-free-quota-btn"
                                                    title={t(
                                                      "settings.bailianFreeQuotaTitle",
                                                      { model: m.id },
                                                    )}
                                                    onClick={(e) => {
                                                      e.preventDefault();
                                                      e.stopPropagation();
                                                      openExternalUrl(
                                                        bailianModelFreeQuotaUrl(
                                                          m.id,
                                                        ),
                                                      );
                                                    }}
                                                  >
                                                    {t(
                                                      "settings.bailianFreeQuota",
                                                    )}
                                                  </button>
                                                )}
                                              </span>
                                            );
                                          })()
                                        )}
                                        {editingVendor.kind === "custom" && (
                                          <button
                                            type="button"
                                            className="icon-btn settings-model-delete"
                                            title={t("settings.removeCustomModel")}
                                            aria-label={t("settings.removeCustomModel")}
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              const next = vendors.map((v) =>
                                                v.id !== editingVendor.id
                                                  ? v
                                                  : {
                                                      ...v,
                                                      models: v.models.filter(
                                                        (x) => x.id !== m.id,
                                                      ),
                                                    },
                                              );
                                              suppressModelAutoSaveRef.current = true;
                                              setVendors(next);
                                              void persistModelProfiles({
                                                vendors: next,
                                                quiet: true,
                                              });
                                            }}
                                          >
                                            <IconTrash size={12} />
                                          </button>
                                        )}
                                      </label>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="settings-row-desc">
                                {editingVendor.kind === "custom"
                                  ? t("settings.customModelsEmpty")
                                  : fetchModelsBusy
                                    ? t("settings.fetching")
                                    : t("settings.vendorModelsEmpty")}
                              </div>
                            )}
                          </div>

                          <div className="settings-row">
                            <div className="settings-row-text">
                              <div className="settings-row-label">{t("settings.probeEndpoint")}</div>
                              <div className="settings-row-desc">
                                {editingVendor.locked
                                  ? t("settings.probeDescTestOnly")
                                  : editingVendor.kind === "custom"
                                    ? t("settings.probeDescTestOnly")
                                    : t("settings.probeDesc")}
                              </div>
                            </div>
                            <div className="btn-row">
                              <button
                                type="button"
                                className="btn"
                                disabled={
                                  endpointProbeBusy ||
                                  fetchModelsBusy ||
                                  balanceQueryBusy ||
                                  savingSettings
                                }
                                onClick={() => void onTestEndpoint()}
                              >
                                {endpointProbeBusy
                                  ? t("settings.testing")
                                  : t("settings.testConnection")}
                              </button>
                              {!editingVendor.locked &&
                                editingVendor.kind !== "custom" && (
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  disabled={
                                    endpointProbeBusy ||
                                    fetchModelsBusy ||
                                    balanceQueryBusy ||
                                    savingSettings
                                  }
                                  onClick={() => void onFetchRemoteModels()}
                                >
                                  {fetchModelsBusy
                                    ? t("settings.fetching")
                                    : t("settings.fetchModels")}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {settingsSection === "extensions" && (
                <ExtensionsPanel
                  onSettingsPatched={(s) => applyPublicSettings(s as PublicSettings)}
                />
              )}
              {settingsSection === "dependencies" && (
                <DependenciesPanel
                  onSettingsPatched={(s) => applyPublicSettings(s as PublicSettings)}
                />
              )}
              {settingsSection === "about" && (
                <section className="settings-about" aria-label={t("settings.about")}>
                  <div className="settings-about-hero">
                    <img
                      src={brandIcon}
                      alt=""
                      className="settings-about-logo"
                      width={72}
                      height={72}
                      draggable={false}
                    />
                    <h1 className="settings-about-name">FreeCoder</h1>
                    <p className="settings-about-tagline">
                      {t("settings.aboutTagline")}
                    </p>
                  </div>
                  <p className="settings-about-intro">
                    {t("settings.aboutIntro")}
                  </p>
                  <p className="settings-about-version">
                    {t("settings.aboutVersion")}{" "}
                    <span>{t("settings.aboutVersionValue")}</span>
                  </p>
                </section>
              )}
            </div>
          </main>
        </div>
      ) : (
        <>
          <main className="main">
            <header
              className="topbar"
              onMouseDown={onTitlebarMouseDown}
              onDoubleClick={onTitlebarDoubleClick}
            >
              <div className="topbar-main">
                <h1 className="topbar-title">{title}</h1>
                <p className="topbar-sub">
                  {selectedProject
                    ? t("topbar.project", {
                        name: selectedProject.name,
                        path: displayShortPath(selectedProject.root_path),
                      })
                    : session?.work_path
                      ? t("topbar.tempTask")
                      : t("topbar.noProject")}
                  {session?.work_path
                    ? ` · ${displayShortPath(session.work_path)}`
                    : activeTaskTitle
                      ? ` · ${displayTaskTitle(activeTaskTitle, t)}`
                      : session?.session_id
                        ? ` · ${session.session_id.slice(0, 8)}`
                        : ""}
                </p>
              </div>
              <div className="topbar-actions">
                {/* Status is non-interactive — whole top strip moves the window. */}
                <button
                  type="button"
                  className={`status-pill${connected || busy ? "" : " status-pill-action"}`}
                  title={
                    connected || busy
                      ? busy
                        ? t("status.agentWorking")
                        : t("status.agentReady")
                      : waitingLocalModel
                        ? t("status.loadingModelTip")
                        : t("status.clickReconnect")
                  }
                  onClick={() => {
                    if (!connected && !busy && !waitingLocalModel) {
                      void onConnect();
                    }
                  }}
                  disabled={busy || connected || waitingLocalModel}
                >
                  <span className={`status-dot ${statusClass}`} />
                  {statusLabel}
                </button>
                <button
                  type="button"
                  className={`icon-btn topbar-outputs-toggle${
                    outputsOpen ? " is-active" : ""
                  }`}
                  title={
                    outputsOpen
                      ? t("status.hideOutputs")
                      : t("status.showOutputs")
                  }
                  aria-pressed={outputsOpen}
                  onClick={toggleRightPanel}
                >
                  {outputsOpen ? (
                    <IconChevronRight size={16} />
                  ) : (
                    <IconChevronLeft size={16} />
                  )}
                </button>
              </div>
            </header>

            <div
              ref={chatPaneRef}
              className={`chat-pane${
                sessionOutlineEntries.length > 0
                  ? sessionOutlineCollapsed
                    ? " has-outline-collapsed"
                    : " has-outline"
                  : ""
              }${composerDropActive ? " chat-pane-drop-active" : ""}`}
            >
              {/* Overlay (not in scroll flow) so show/hide never changes scrollHeight. */}
              {stickyUserId && stickyUserText != null && (
                <button
                  type="button"
                  className="user-sticky-bar"
                  title={t("chat.jumpTitle")}
                  onClick={() => jumpToUserMessage(stickyUserId)}
                >
                  <span className="user-sticky-label">{t("chat.yourMessage")}</span>
                  <span className="user-sticky-text">{stickyUserText}</span>
                  <span className="user-sticky-jump">{t("chat.jump")}</span>
                </button>
              )}
              <SessionOutline
                entries={sessionOutlineEntries}
                activeId={highlightUserId || stickyUserId}
                collapsed={sessionOutlineCollapsed}
                onToggleCollapsed={toggleSessionOutline}
                onJump={jumpToUserMessage}
              />
              <div className="chat-scroll" ref={chatScrollRef}>
              {lines.length === 0 ? (
                <div className="chat-inner">
                  <div className="empty-state">
                    <h2>{t("chat.startTitle")}</h2>
                    <p>
                      {t("chat.startBody1")} <strong>{t("chat.startTasksPlus")}</strong>{" "}
                      {t("chat.startBody3")}{" "}
                      <strong>{t("chat.startProjectsPlus")}</strong>
                      {t("chat.startBody4")}
                    </p>
                  </div>
                </div>
              ) : (
              <VirtualChatList
                ref={virtualChatRef}
                className="chat-inner"
                items={virtualChatItems}
                scrollerRef={chatScrollRef}
                overscanPx={900}
                footer={<div ref={bottomRef} />}
                renderItem={(line, i) => {
                  if (line.kind === "trace") {
                    return (
                      <div
                        key={line.id}
                        className="msg msg-trace"
                      >
                        <div
                          className={`trace-panel${
                            line.expanded ? " is-expanded" : ""
                          }`}
                        >
                          <button
                            type="button"
                            className="trace-summary"
                            onClick={() => toggleTrace(line.id)}
                            aria-expanded={line.expanded}
                          >
                            <span className="trace-chevron" aria-hidden>
                              {line.expanded ? "▾" : "▸"}
                            </span>
                            <span className="trace-label">
                              {t("chat.worked", { summary: summarizeTrace(line.items, t) })}
                            </span>
                            {line.durationMs > 0 ? (
                              <span
                                className="trace-duration"
                                title={t("chat.durationTitle")}
                              >
                                {formatDuration(line.durationMs)}
                              </span>
                            ) : (
                              <span
                                className="trace-duration is-unknown"
                                title={t("chat.durationUnknown")}
                              >
                                —
                              </span>
                            )}
                          </button>
                          {line.expanded && (
                            <div className="trace-body">
                              {line.items.map((item) => {
                                if (item.kind === "thought") {
                                  return (
                                    <div
                                      key={item.id}
                                      className="msg msg-thought trace-item"
                                    >
                                      <div className="msg-body md-body thought-md">
                                        <ChatMarkdown mediaBases={chatMediaBases}>
                                          {item.text}
                                        </ChatMarkdown>
                                      </div>
                                    </div>
                                  );
                                }
                                return (
                                  <div
                                    key={item.id}
                                    className={`msg-chip trace-item${
                                      item.kind === "tool" &&
                                      (item.count ?? 1) > 1
                                        ? " msg-chip-merged"
                                        : ""
                                    }`}
                                    title={
                                      item.kind === "tool" &&
                                      (item.count ?? 1) > 1
                                        ? t("chat.repeatedTimes", {
                                            text: item.text,
                                            n: item.count ?? 1,
                                          })
                                        : undefined
                                    }
                                  >
                                    <span className="chip-icon">
                                      <ChipIcon kind={item.kind} />
                                    </span>
                                    <span>
                                      {item.kind === "tool"
                                        ? formatToolChipLabel(item)
                                        : item.text}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "tool" || line.kind === "system") {
                    const label =
                      line.kind === "tool"
                        ? formatToolChipLabel(line)
                        : line.text;
                    return (
                      <div
                        key={line.id}
                        className={`msg-chip${
                          line.kind === "tool" && (line.count ?? 1) > 1
                            ? " msg-chip-merged"
                            : ""
                        }`}
                        title={
                          line.kind === "tool" && (line.count ?? 1) > 1
                            ? t("chat.repeatedTimes", {
                                text: line.text,
                                n: line.count ?? 1,
                              })
                            : undefined
                        }
                      >
                        <span className="chip-icon">
                          <ChipIcon kind={line.kind} />
                        </span>
                        <span>{label}</span>
                      </div>
                    );
                  }
                  if (line.kind === "waiting") {
                    return (
                      <div
                        key={line.id}
                        className="msg msg-waiting"
                      >
                        <div className="msg-body waiting-body">
                          <span className="waiting-dots" aria-hidden>
                            <span />
                            <span />
                            <span />
                          </span>
                          <span>{line.text}</span>
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "assistant") {
                    const streaming =
                      busy && i === lines.length - 1;
                    const canCopy = Boolean(line.text.trim()) && !streaming;
                    const copiedMd =
                      copiedMsg?.id === line.id && copiedMsg.format === "md";
                    const copiedPlain =
                      copiedMsg?.id === line.id &&
                      copiedMsg.format === "plain";
                    return (
                      <div key={line.id} className="msg msg-assistant">
                        <div
                          className={`msg-assistant-wrap${
                            streaming ? " is-streaming" : ""
                          }`}
                        >
                          <div className="msg-body md-body">
                            <ChatMarkdown
                              mediaBases={chatMediaBases}
                              streaming={streaming}
                            >
                              {line.text}
                            </ChatMarkdown>
                          </div>
                          {canCopy && (
                            <div className="msg-actions">
                              <button
                                type="button"
                                className={`msg-copy-btn${
                                  copiedMd ? " msg-copy-btn-done" : ""
                                }`}
                                title={
                                  copiedMd
                                    ? t("chat.copiedMd")
                                    : t("chat.copyMd")
                                }
                                aria-label={
                                  copiedMd
                                    ? t("chat.copiedMd")
                                    : t("chat.copyReplyMd")
                                }
                                onClick={() =>
                                  void copyAssistantText(
                                    line.id,
                                    line.text,
                                    "md",
                                  )
                                }
                              >
                                {copiedMd ? (
                                  <IconCheck size={14} />
                                ) : (
                                  <IconCopy size={14} />
                                )}
                                <span>
                                  {copiedMd ? t("attach.copied") : t("attach.markdown")}
                                </span>
                              </button>
                              <button
                                type="button"
                                className={`msg-copy-btn${
                                  copiedPlain ? " msg-copy-btn-done" : ""
                                }`}
                                title={
                                  copiedPlain
                                    ? t("chat.copiedPlain")
                                    : t("chat.copyPlain")
                                }
                                aria-label={
                                  copiedPlain
                                    ? t("chat.copiedPlain")
                                    : t("chat.copyReplyPlain")
                                }
                                onClick={() =>
                                  void copyAssistantText(
                                    line.id,
                                    line.text,
                                    "plain",
                                  )
                                }
                              >
                                {copiedPlain ? (
                                  <IconCheck size={14} />
                                ) : (
                                  <IconCopy size={14} />
                                )}
                                <span>
                                  {copiedPlain ? t("attach.copied") : t("attach.text")}
                                </span>
                              </button>
                              {(line.tokens != null ||
                                line.tokensPerSec != null) && (
                                <span
                                  className="msg-metrics"
                                  title={
                                    line.streamMs != null
                                      ? t("attach.tokensStreamTip", {
                                          tokens: line.tokens ?? "?",
                                          sec: (line.streamMs / 1000).toFixed(1),
                                        })
                                      : t("attach.tokensTip")
                                  }
                                >
                                  {line.tokens != null && (
                                    <span className="msg-metric">
                                      ~{line.tokens} tok
                                    </span>
                                  )}
                                  {line.tokensPerSec != null && (
                                    <span className="msg-metric">
                                      {formatTokensPerSec(line.tokensPerSec)}{" "}
                                      tok/s
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "thought") {
                    return (
                      <div
                        key={line.id}
                        className="msg msg-thought"
                      >
                        <div className="msg-body md-body thought-md">
                          <ChatMarkdown mediaBases={chatMediaBases}>
                            {line.text}
                          </ChatMarkdown>
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "error") {
                    return (
                      <div
                        key={line.id}
                        className="msg msg-error"
                      >
                        <div className="msg-body">{line.text}</div>
                      </div>
                    );
                  }
                  if (line.kind === "user") {
                    const timeLabel = formatMessageTime(line.at);
                    const atts = line.attachments ?? [];
                    const imgs = atts.filter(
                      (a) =>
                        isImageAttachment(a) && (a.previewSrc || a.path),
                    );
                    const files = atts.filter((a) => !isImageAttachment(a));
                    const isEditing = editingUserId === line.id;
                    const canEdit = !busy && !connecting && !isEditing;
                    return (
                      <div
                        key={line.id}
                        className={`msg msg-user${
                          highlightUserId === line.id ? " msg-user-highlight" : ""
                        }${isEditing ? " msg-user-editing" : ""}`}
                        data-user-msg={line.id}
                        ref={(el) => {
                          if (el) userMsgEls.current.set(line.id, el);
                          else userMsgEls.current.delete(line.id);
                        }}
                      >
                        <div
                          className="msg-user-stack"
                          onCopy={(e) => {
                            const payload = selectionCopyPayload(e.currentTarget);
                            if (!payload) return;
                            e.clipboardData.setData("text/plain", payload.plain);
                            e.clipboardData.setData(
                              CLIPBOARD_CHIPS_MIME,
                              JSON.stringify(payload.chips),
                            );
                            e.preventDefault();
                          }}
                        >
                          {isEditing ? (
                            <div className="msg-body msg-user-edit-body">
                              {imgs.length > 0 && (
                                <div className="msg-user-thumbs">
                                  {imgs.map((a) => {
                                    const src =
                                      a.previewSrc ||
                                      (a.path ? convertFileSrc(a.path) : "");
                                    return src ? (
                                      <span
                                        key={a.path || a.name}
                                        className="msg-user-thumb"
                                      >
                                        <img src={src} alt={a.name} />
                                      </span>
                                    ) : null;
                                  })}
                                </div>
                              )}
                              {files.length > 0 && (
                                <div className="msg-user-files">
                                  {files.map((a) => {
                                    const label = attachmentDisplayName(a);
                                    const isDir = Boolean(a.isDir);
                                    return (
                                      <span
                                        key={a.path || label}
                                        className={`msg-user-file-chip${
                                          isDir ? " is-folder" : ""
                                        }`}
                                        title={a.path || label}
                                        data-path={a.path || undefined}
                                        data-name={label}
                                        data-isdir={isDir ? "1" : "0"}
                                      >
                                        {isDir ? (
                                          <>
                                            <IconFolder size={12} /> @{label}
                                          </>
                                        ) : (
                                          <>
                                            <IconFile size={12} /> {label}
                                          </>
                                        )}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                              <textarea
                                ref={editTextareaRef}
                                className="msg-user-edit-input"
                                value={editDraft}
                                rows={2}
                                placeholder={t("chat.editPlaceholder")}
                                onChange={(e) => {
                                  setEditDraft(e.target.value);
                                  const el = e.target;
                                  el.style.height = "auto";
                                  el.style.height = `${Math.min(
                                    el.scrollHeight,
                                    200,
                                  )}px`;
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") {
                                    e.preventDefault();
                                    cancelEditUser();
                                  } else if (
                                    e.key === "Enter" &&
                                    (e.metaKey || e.ctrlKey)
                                  ) {
                                    e.preventDefault();
                                    void onResendEditedUser();
                                  }
                                }}
                              />
                              <div className="msg-user-edit-actions">
                                <button
                                  type="button"
                                  className="msg-user-edit-cancel"
                                  onClick={cancelEditUser}
                                >
                                  {t("common.cancel")}
                                </button>
                                <button
                                  type="button"
                                  className="msg-user-edit-send"
                                  disabled={
                                    !editDraft.trim() &&
                                    (line.attachments?.length ?? 0) === 0
                                  }
                                  title={t("chat.sendEditTitle")}
                                  onClick={() => void onResendEditedUser()}
                                >
                                  <IconSend size={13} />
                                  {t("chat.sendEdit")}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="msg-body">
                                {imgs.length > 0 && (
                                  <div className="msg-user-thumbs">
                                    {imgs.map((a) => {
                                      const src =
                                        a.previewSrc ||
                                        (a.path ? convertFileSrc(a.path) : "");
                                      return (
                                        <a
                                          key={a.path || a.name}
                                          className="msg-user-thumb"
                                          href={src || undefined}
                                          title={a.name}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            if (a.path) {
                                              void openUrl(
                                                a.path.startsWith("file:")
                                                  ? a.path
                                                  : `file://${a.path}`,
                                              ).catch(() => {});
                                            }
                                          }}
                                        >
                                          {src ? (
                                            <img src={src} alt={a.name} />
                                          ) : (
                                            <span className="msg-user-file-chip">
                                              {a.name}
                                            </span>
                                          )}
                                        </a>
                                      );
                                    })}
                                  </div>
                                )}
                                {files.length > 0 && (
                                  <div className="msg-user-files">
                                    {files.map((a) => {
                                      const label = attachmentDisplayName(a);
                                      const isDir = Boolean(a.isDir);
                                      return (
                                        <button
                                          key={a.path || label}
                                          type="button"
                                          className={`msg-user-file-chip${
                                            isDir ? " is-folder" : ""
                                          }`}
                                          title={a.path || label}
                                          data-path={a.path || undefined}
                                          data-name={label}
                                          data-isdir={isDir ? "1" : "0"}
                                          onClick={() => {
                                            if (!a.path) return;
                                            void invoke("open_path", {
                                              path: a.path,
                                            }).catch(() => {
                                              void openUrl(
                                                a.path.startsWith("file:")
                                                  ? a.path
                                                  : `file://${a.path}`,
                                              ).catch(() => {});
                                            });
                                          }}
                                        >
                                          {isDir ? (
                                            <>
                                              <IconFolder size={12} /> @{label}
                                            </>
                                          ) : (
                                            <>
                                              <IconFile size={12} /> {label}
                                            </>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                {line.text ? (
                                  <div className="msg-user-text">
                                    {line.text}
                                  </div>
                                ) : null}
                                {!line.text &&
                                  files.length === 0 &&
                                  imgs.length === 0 && (
                                    <div className="msg-user-text muted">
                                      {t("chat.emptyMessage")}
                                    </div>
                                  )}
                              </div>
                              <div className="msg-user-meta">
                                {canEdit && (
                                  <button
                                    type="button"
                                    className="msg-user-edit-btn"
                                    title={t("chat.editTooltip")}
                                    aria-label={t("chat.editAria")}
                                    onClick={() => beginEditUser(line)}
                                  >
                                    <IconPen size={12} />
                                    {t("chat.edit")}
                                  </button>
                                )}
                                {timeLabel && (
                                  <time
                                    className="msg-user-time"
                                    dateTime={line.at}
                                    title={
                                      line.at
                                        ? new Date(line.at).toLocaleString()
                                        : undefined
                                    }
                                  >
                                    {timeLabel}
                                  </time>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  }
                  // Exhaustive for ChatLine kinds handled above.
                  return null;
                }}
              />
              )}
              </div>
              <div className="chat-bottom-stack">
              {showScrollToBottom && (
                <button
                  type="button"
                  className="scroll-to-bottom-btn"
                  title={t("chat.scrollBottom")}
                  aria-label={t("chat.scrollBottom")}
                  onClick={jumpToBottom}
                >
                  <IconChevronDown size={18} />
                </button>
              )}

            <div
              ref={composerDockRef}
              className={`composer-dock${
                composerDropActive ? " composer-dock-drop-active" : ""
              }`}
            >
              {composerDropActive && (
                <div className="composer-drop-overlay" aria-hidden>
                  <IconFolder size={22} />
                  <span>{t("composer.dropHint")}</span>
                </div>
              )}
              {elsewhereApprovalHints.length > 0 && (
                <div className="composer-perm-elsewhere" role="status">
                  <div className="composer-perm-elsewhere-label">
                    {t("approvals.elsewhereTitle")}
                  </div>
                  <div className="composer-perm-elsewhere-list">
                    {elsewhereApprovalHints.map((h) => (
                      <button
                        key={h.sessionId}
                        type="button"
                        className="composer-perm-elsewhere-item"
                        disabled={!h.row}
                        title={t("approvals.elsewhereSwitchTip")}
                        onClick={() => {
                          if (h.row) void onActivateSession(h.row);
                        }}
                      >
                        <span className="composer-perm-elsewhere-dot" aria-hidden />
                        <span className="composer-perm-elsewhere-text">
                          {h.projectName
                            ? t("approvals.elsewhereItemProject", {
                                project: h.projectName,
                                task: h.title,
                                n: h.count,
                              })
                            : t("approvals.elsewhereItem", {
                                task: h.title,
                                n: h.count,
                              })}
                        </span>
                        <span className="composer-perm-elsewhere-go">
                          {t("approvals.elsewhereGo")}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {pendingPerm && (
                <div
                  className="composer-perm-card"
                  role="alertdialog"
                  aria-labelledby="composer-perm-title"
                  aria-describedby="composer-perm-summary"
                >
                  <div className="composer-perm-header">
                    <div className="composer-perm-header-text">
                      <span className="composer-perm-badge">
                        {activePendingPerms.length > 1
                          ? t("approvals.waiting", { n: activePendingPerms.length })
                          : t("approvals.title")}
                      </span>
                      <h3 id="composer-perm-title" className="composer-perm-tool">
                        {pendingPerm.tool_name}
                      </h3>
                    </div>
                    <div className="composer-perm-actions">
                      <button
                        type="button"
                        className="btn composer-perm-deny"
                        onClick={() => void onPermission("deny", pendingPerm.id)}
                      >
                        {t("approvals.deny")}
                      </button>
                      <button
                        type="button"
                        className="btn composer-perm-allow"
                        autoFocus
                        onClick={() =>
                          void onPermission("allow_once", pendingPerm.id)
                        }
                      >
                        {t("approvals.allow")}
                      </button>
                    </div>
                  </div>
                  <p id="composer-perm-summary" className="composer-perm-summary">
                    {pendingPerm.summary}
                  </p>
                  {pendingPerm.detail && (
                    <pre className="composer-perm-detail">{pendingPerm.detail}</pre>
                  )}
                  {activePendingPerms.length > 1 && (
                    <p className="composer-perm-queue-hint muted">
                      {t("approvals.queueHint", {
                        n: activePendingPerms.length - 1,
                      })}
                    </p>
                  )}
                </div>
              )}
              {longRunNotice && busy && (
                <div className="long-run-banner" role="status">
                  <div className="long-run-banner-text">
                    <strong>
                      {t("longRun.stillWorking", { sec: longRunNotice.elapsedSec })}
                    </strong>
                    <span>
                      {longRunNotice.toolHint
                        ? ` ${t("longRun.toolHint")}`
                        : ` ${t("longRun.generic")}`}
                    </span>
                    {longRunNotice.toolHint && (
                      <code className="long-run-tool-hint" title={longRunNotice.toolHint}>
                        {longRunNotice.toolHint}
                      </code>
                    )}
                  </div>
                  <div className="long-run-banner-actions">
                    <button
                      type="button"
                      className="btn btn-primary long-run-stop"
                      onClick={() => void onCancel()}
                      title={t("longRun.stopTitle")}
                    >
                      <IconStop size={13} />
                      {t("longRun.stop")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        longRunDismissedRef.current = true;
                        setLongRunNotice(null);
                      }}
                    >
                      {t("longRun.dismiss")}
                    </button>
                  </div>
                </div>
              )}
              {visionMismatch && (
                <div className="composer-vision-warn" role="status">
                  <IconAlert size={14} />
                  <span className="composer-vision-warn-text">
                    {mediaGenIntent
                      ? availableVisionModels.length > 0
                        ? t("composer.mediaGenWarn", {
                            model: displayNameForModel(modelId),
                            suggestions: formatVisionSuggestions(),
                          })
                        : t("composer.mediaGenWarnNone", {
                            model: displayNameForModel(modelId),
                          })
                      : pendingHasImages
                        ? availableVisionModels.length > 0
                          ? t("composer.visionWarn", {
                              model: displayNameForModel(modelId),
                              suggestions: formatVisionSuggestions(),
                            })
                          : t("composer.visionWarnNone", {
                              model: displayNameForModel(modelId),
                            })
                        : availableVisionModels.length > 0
                          ? t("composer.visionWarnFolder", {
                              model: displayNameForModel(modelId),
                              suggestions: formatVisionSuggestions(),
                            })
                          : t("composer.visionWarnFolderNone", {
                              model: displayNameForModel(modelId),
                            })}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost composer-vision-warn-btn"
                    onClick={() => {
                      openVlmRequiredModal();
                      setModelPickerOpen(true);
                    }}
                  >
                    {t("composer.switchModel")}
                  </button>
                </div>
              )}
              {attachments.filter((a) => !a.isDir).length > 0 && (
                <div className="attach-row">
                  {attachments
                    .filter((a) => !a.isDir)
                    .map((a) => {
                    const label = attachmentDisplayName(a);
                    const isImg = isImageAttachment(a);
                    const thumbSrc =
                      isImg && (a.previewUrl || a.path)
                        ? a.previewUrl ||
                          (a.path ? convertFileSrc(a.path) : "")
                        : "";
                    return (
                      <div
                        key={a.path}
                        className={`attach-chip${
                          isImg ? " attach-chip-image" : ""
                        }${isImg && thumbSrc ? " attach-chip-clickable" : ""}`}
                        title={
                          isImg && thumbSrc
                            ? t("attach.previewClick", { label })
                            : a.path || label
                        }
                        role={isImg && thumbSrc ? "button" : undefined}
                        tabIndex={isImg && thumbSrc ? 0 : undefined}
                        onClick={
                          isImg && thumbSrc
                            ? () => openAttachmentPreview(a)
                            : undefined
                        }
                        onKeyDown={
                          isImg && thumbSrc
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  openAttachmentPreview(a);
                                }
                              }
                            : undefined
                        }
                      >
                        {isImg && thumbSrc ? (
                          <img
                            className="attach-thumb"
                            src={thumbSrc}
                            alt={label}
                          />
                        ) : (
                          <span className="attach-icon attach-icon-svg" aria-hidden>
                            <IconFile size={14} />
                          </span>
                        )}
                        <span className="attach-name">{label}</span>
                        {a.size != null && (
                          <span className="attach-size">
                            {formatBytes(a.size)}
                          </span>
                        )}
                        <button
                          type="button"
                          className="attach-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeAttachment(a.path);
                          }}
                          aria-label={t("err.removeAttachment")}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {goalState && goalState.status !== "complete" && (
                <div
                  className={`composer-goal-banner status-${goalState.status.replace(
                    /_/g,
                    "-",
                  )}`}
                  role="status"
                  title={goalState.pauseMessage || goalState.objective}
                >
                  <IconGoal size={14} />
                  <div className="composer-goal-banner-text">
                    <strong>
                      {t("composer.goalBannerActive", {
                        status: goalState.status,
                      })}
                    </strong>
                    <span>
                      {t("composer.goalBannerObjective", {
                        objective: goalState.objective || "—",
                      })}
                    </span>
                  </div>
                </div>
              )}
              <ComposerInput
                ref={composerRef}
                disabled={!session || (busy && !pendingPerm)}
                placeholder={
                  session
                    ? t("composer.placeholder")
                    : t("composer.placeholderNoSession")
                }
                onPaste={(e) => {
                  void onComposerPaste(e);
                }}
                onResolvePath={resolveComposerPath}
                convertLabel={t("composer.chipConvert")}
                removeLabel={t("composer.chipRemove")}
                onSubmit={() => {
                  void onSend();
                }}
                onDraftChange={onComposerDraftChange}
                onDraftSettled={onComposerDraftSettled}
              />
              <div className="composer-bar">
                <div className="composer-left">
                  <button
                    type="button"
                    className="composer-plus"
                    title={t("composer.attach")}
                    onClick={() => void onPickAttachments()}
                    disabled={!session || busy}
                  >
                    <IconPaperclip size={16} />
                  </button>
                  <div className="composer-goal-wrap" ref={goalMenuRef}>
                    <button
                      type="button"
                      className={`composer-plus composer-goal-btn${
                        goalMenuOpen ||
                        goalDraftArmed ||
                        (goalState &&
                          goalState.status !== "complete" &&
                          goalState.status !== "cleared")
                          ? " active"
                          : ""
                      }`}
                      title={
                        goalState?.objective
                          ? `${t("composer.goalTitle")} — ${goalState.objective}`
                          : goalDraftArmed
                            ? t("composer.goalArmedTip")
                            : t("composer.goalTitle")
                      }
                      aria-label={t("composer.goalAria")}
                      aria-haspopup="menu"
                      aria-expanded={goalMenuOpen}
                      aria-pressed={goalDraftArmed}
                      disabled={!session || busy}
                      onClick={onGoalButtonClick}
                    >
                      <IconGoal size={16} />
                    </button>
                    {goalMenuOpen && (
                      <div className="composer-goal-menu" role="menu">
                        {goalDraftArmed ? (
                          <button
                            type="button"
                            role="menuitem"
                            className="composer-goal-item"
                            onClick={disarmGoalCompose}
                          >
                            <strong>{t("composer.goalDisarm")}</strong>
                            <span>{t("composer.goalDisarmHint")}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            role="menuitem"
                            className="composer-goal-item"
                            onClick={onGoalSetClick}
                          >
                            <strong>{t("composer.goalSet")}</strong>
                            <span>{t("composer.goalSetHint")}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          className="composer-goal-item"
                          disabled={busy}
                          onClick={() => void sendGoalCommand("status")}
                        >
                          <strong>{t("composer.goalStatus")}</strong>
                          <span>/goal status</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="composer-goal-item"
                          disabled={busy}
                          onClick={() => void sendGoalCommand("pause")}
                        >
                          <strong>{t("composer.goalPause")}</strong>
                          <span>/goal pause</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="composer-goal-item"
                          disabled={busy}
                          onClick={() => void sendGoalCommand("resume")}
                        >
                          <strong>{t("composer.goalResume")}</strong>
                          <span>/goal resume</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="composer-goal-item danger"
                          disabled={busy}
                          onClick={() => void sendGoalCommand("clear")}
                        >
                          <strong>{t("composer.goalClear")}</strong>
                          <span>/goal clear</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <select
                    className={`composer-select access-select access-mode-${permissionMode}`}
                    value={permissionMode}
                    onChange={(e) =>
                      void setPermissionModeAndSave(
                        normalizePermissionMode(e.target.value),
                      )
                    }
                    title={
                      permissionMode === "always-approve"
                        ? t("composer.permFullTip")
                        : permissionMode === "auto"
                          ? t("composer.permAutoTip")
                          : t("composer.permAskTip")
                    }
                    aria-label={t("composer.permAria")}
                  >
                    <option value="ask">{t("settings.permAsk")}</option>
                    <option value="auto">{t("settings.permAuto")}</option>
                    <option value="always-approve">{t("settings.permFullTrust")}</option>
                  </select>
                  {session && (
                    <div
                      className={contextMeterClass}
                      title={
                        contextFromEngine
                          ? t("composer.contextEngine", {
                              used: contextUsed.toLocaleString(),
                              total: contextWindow.toLocaleString(),
                            })
                          : t("composer.contextEst", {
                              used: contextUsed.toLocaleString(),
                              total: contextWindow.toLocaleString(),
                            })
                      }
                    >
                      <div className="context-meter-track" aria-hidden>
                        <div
                          className="context-meter-fill"
                          style={{ width: `${contextPct}%` }}
                        />
                      </div>
                      <span className="context-meter-label">
                        {formatTokenCount(contextUsed)}/
                        {formatTokenCount(contextWindow)}
                        {contextFromEngine ? "" : " ~"}
                      </span>
                    </div>
                  )}
                </div>
                <div className="composer-right">
                  <div className="composer-model-picker" ref={modelPickerRef}>
                    <button
                      type="button"
                      className="composer-model-trigger"
                      title={
                        modelSelectionMode === "tier"
                          ? t("composer.performanceTier")
                          : t("composer.model")
                      }
                      disabled={busy}
                      aria-haspopup="listbox"
                      aria-expanded={modelPickerOpen}
                      onClick={() => setModelPickerOpen((o) => !o)}
                    >
                      {modelSelectionMode === "model" ? (
                        <ModelBrandIcon
                          modelId={modelId}
                          vendorKind={
                            selectableModels.find((m) => m.id === modelId)
                              ?.vendorKind
                          }
                          size={14}
                        />
                      ) : null}
                      <span className="composer-model-trigger-label">
                        {modelSelectionMode === "tier"
                          ? displayNameForPerformanceTier(performanceTier)
                          : displayNameForModel(
                              modelId,
                              selectableModels.find((m) => m.id === modelId)
                                ?.vendorKind,
                            )}
                      </span>
                      <IconChevronDown size={12} />
                    </button>
                    {modelPickerOpen && (
                      <ul
                        className="composer-model-menu"
                        role="listbox"
                        aria-label={t("composer.model")}
                      >
                        <li className="composer-model-menu-section" aria-hidden>
                          {t("composer.performanceTier")}
                        </li>
                        {PERFORMANCE_TIERS.map((tier) => (
                          <li
                            key={`tier-${tier}`}
                            role="option"
                            aria-selected={
                              modelSelectionMode === "tier" &&
                              performanceTier === tier
                            }
                          >
                            <button
                              type="button"
                              className={`composer-model-option${
                                modelSelectionMode === "tier" &&
                                performanceTier === tier
                                  ? " active"
                                  : ""
                              }`}
                              onClick={() => {
                                setModelPickerOpen(false);
                                void onPerformanceTierChange(tier);
                              }}
                            >
                              <span>{displayNameForPerformanceTier(tier)}</span>
                            </button>
                          </li>
                        ))}
                        <li className="composer-model-menu-divider" aria-hidden />
                        <li className="composer-model-menu-section" aria-hidden>
                          {t("composer.model")}
                        </li>
                        {(selectableModels.length
                          ? selectableModels
                          : [
                              {
                                id: BONSAI_MODEL_ID,
                                name: displayNameForModel(BONSAI_MODEL_ID),
                                vendorKind: "bonsai" as VendorKind,
                              },
                            ]
                        ).map((m) => (
                          <li
                            key={m.id}
                            role="option"
                            aria-selected={
                              modelSelectionMode === "model" && m.id === modelId
                            }
                          >
                            <button
                              type="button"
                              className={`composer-model-option${
                                modelSelectionMode === "model" && m.id === modelId
                                  ? " active"
                                  : ""
                              }`}
                              onClick={() => {
                                setModelPickerOpen(false);
                                void onModelChange(m.id);
                              }}
                            >
                              <ModelBrandIcon
                                modelId={m.id}
                                vendorKind={m.vendorKind}
                                size={16}
                              />
                              <span>{m.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {busy ? (
                    <button
                      type="button"
                      className="send-btn stop"
                      onClick={() => void onCancel()}
                      title={t("composer.stop")}
                      aria-label={t("composer.stop")}
                    >
                      <IconStop size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="send-btn"
                      onClick={() => void onSend()}
                      disabled={
                        !session ||
                        (!composerHasText && attachments.length === 0)
                      }
                      title={t("composer.send")}
                    >
                      <IconSend size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
              </div>
            </div>
          </main>

          {outputsOpen && (
            <>
              <div
                className="panel-resizer panel-resizer-right"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("outputs.resize")}
                title={t("outputs.dragResize")}
                onMouseDown={(e) => onPanelResizeStart("right", e)}
              />
              <aside className="right right-chat-mode">
              <div
                className="right-header"
                onMouseDown={onTitlebarMouseDown}
                onDoubleClick={onTitlebarDoubleClick}
              >
                <h2>{t("outputs.sideChat")}</h2>
              </div>

              <SideChat
                sessionId={sideChatSessionId}
                connected={connected}
                messages={sideChatMessages}
                onMessagesChange={updateSideChatMessages}
                active={outputsOpen}
              />
            </aside>
            </>
          )}
        </>
      )}

      {attachmentPreview && (
        <div
          className="attach-preview-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("attach.previewAria", { name: attachmentPreview.name })}
          onClick={() => setAttachmentPreview(null)}
        >
          <div
            className="attach-preview-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="attach-preview-bar">
              <span className="attach-preview-name" title={attachmentPreview.name}>
                {attachmentPreview.name}
              </span>
              <button
                type="button"
                className="attach-preview-close"
                onClick={() => setAttachmentPreview(null)}
                aria-label={t("attach.closePreview")}
              >
                ×
              </button>
            </div>
            <img
              className="attach-preview-img"
              src={attachmentPreview.src}
              alt={attachmentPreview.name}
            />
          </div>
        </div>
      )}

      {bailianBalanceModalOpen && (
        <div
          className="getkey-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bailian-balance-title"
          onClick={() => setBailianBalanceModalOpen(false)}
        >
          <div
            className="getkey-modal settings-balance-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="getkey-modal-header">
              <h3 id="bailian-balance-title" className="getkey-modal-title">
                {t("settings.balanceBailianModalTitle")}
              </h3>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("common.close")}
                onClick={() => setBailianBalanceModalOpen(false)}
              >
                ×
              </button>
            </header>
            <p className="settings-balance-modal-body">
              {t("settings.balanceBailianModalBody")}
            </p>
            <div className="btn-row settings-balance-modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setBailianBalanceModalOpen(false)}
              >
                {t("common.close")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  openExternalUrl("https://usercenter2.aliyun.com/home");
                  setBailianBalanceModalOpen(false);
                }}
              >
                {t("settings.balanceBailianOpenConsole")}
              </button>
            </div>
          </div>
        </div>
      )}

      {vlmRequiredModalOpen && (
        <div
          className="getkey-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vlm-required-title"
          onClick={() => setVlmRequiredModalOpen(false)}
        >
          <div
            className="getkey-modal settings-balance-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="getkey-modal-header">
              <h3 id="vlm-required-title" className="getkey-modal-title">
                {t("modal.vlmRequiredTitle")}
              </h3>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("common.close")}
                onClick={() => setVlmRequiredModalOpen(false)}
              >
                ×
              </button>
            </header>
            <p className="settings-balance-modal-body">
              {availableVisionModels.length > 0
                ? t("modal.vlmRequiredBody", {
                    suggestions: formatVisionSuggestions(),
                  })
                : t("modal.vlmRequiredBodyNone")}
            </p>
            <div className="btn-row settings-balance-modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setVlmRequiredModalOpen(false)}
              >
                {t("common.close")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setVlmRequiredModalOpen(false);
                  setModelPickerOpen(true);
                }}
              >
                {t("modal.vlmRequiredSwitch")}
              </button>
            </div>
          </div>
        </div>
      )}

      {getKeyWizardPlatform && getKeyWizardVendorId && (
        <GetApiKeyWizard
          platform={getKeyWizardPlatform}
          platformLabel={
            getKeyWizardPlatform === "bailian"
              ? t("settings.vendorBailian")
              : "DeepSeek"
          }
          onClose={() => {
            setGetKeyWizardPlatform(null);
            setGetKeyWizardVendorId(null);
          }}
          onSuccess={async (apiKey) => {
            const vendorId = getKeyWizardVendorId;
            const next = vendors.map((v) =>
              v.id === vendorId
                ? {
                    ...v,
                    api_key: apiKey,
                    has_api_key: true,
                    api_key_hint: maskApiKeyHint(apiKey),
                  }
                : v,
            );
            suppressModelAutoSaveRef.current = true;
            setVendors(next);
            setApiKeyFocused(false);
            await persistModelProfiles({ vendors: next, quiet: true });
            showSettingsMsg(t("getApiKey.savedMsg"), false);
          }}
        />
      )}
    </div>
  );
}
