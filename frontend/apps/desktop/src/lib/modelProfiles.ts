/** Vendor-centric model settings (Settings → Models) + flat profile expand for save. */

export type VendorKind = "bonsai" | "deepseek" | "bailian" | "custom";

export type ModelCapability = "llm" | "vlm" | "video" | "image" | "local";

/** Composer selection: auto-pick by performance tier, or pick a concrete model. */
export type ModelSelectionMode = "tier" | "model";

/** Performance tier used for auto model routing (强 / 中 / 弱). */
export type PerformanceTier = "strong" | "medium" | "weak";

export const PERFORMANCE_TIERS: PerformanceTier[] = [
  "strong",
  "medium",
  "weak",
];

/** Selectable capabilities for custom vendor models. */
export const CUSTOM_MODEL_CAPABILITIES: Exclude<ModelCapability, "local">[] = [
  "llm",
  "vlm",
  "image",
  "video",
];

/** Models the Agent may use for chat / reasoning (not media generation backends). */
export function isAgentChatCapability(cap?: ModelCapability): boolean {
  return !cap || cap === "llm" || cap === "vlm" || cap === "local";
}

/** Media-generation backends exposed via Bailian MCP tools — not chat models. */
export function isMediaToolCapability(cap?: ModelCapability): boolean {
  return cap === "image" || cap === "video";
}

export function parseModelCapability(
  raw?: string | null,
): ModelCapability | undefined {
  const v = (raw || "").trim().toLowerCase();
  if (
    v === "llm" ||
    v === "vlm" ||
    v === "image" ||
    v === "video" ||
    v === "local"
  ) {
    return v;
  }
  return undefined;
}

/** Curated catalog wins; otherwise stored custom choice; else llm. */
export function resolveModelCapability(
  modelId: string,
  stored?: ModelCapability | string | null,
): ModelCapability {
  return (
    capabilityForModel(modelId) ??
    parseModelCapability(typeof stored === "string" ? stored : stored ?? null) ??
    "llm"
  );
}

export type VendorModel = {
  /** Unique id sent to the API (also the display name for remote models). */
  id: string;
  enabled: boolean;
  capability?: ModelCapability;
  /**
   * Custom-vendor performance tier (default strong).
   * Curated catalogs ignore this and use {@link curatedPerformanceTiers}.
   */
  performanceTier?: PerformanceTier;
  /**
   * Confirmed present by a successful remote `/models` fetch.
   * Bonsai / custom are always treated as confirmed.
   * `undefined` = legacy (treat as confirmed for backward compatibility).
   */
  remoteConfirmed?: boolean;
};

export type VendorRow = {
  /** Stable vendor row id (not the model id). */
  id: string;
  kind: VendorKind;
  /** Shown in the left vendor list. */
  name: string;
  base_url: string;
  /** Draft API key; empty = keep saved key on save. */
  api_key: string;
  has_api_key: boolean;
  api_key_hint?: string | null;
  api_backend: string;
  context_window: string;
  max_completion_tokens: string;
  models: VendorModel[];
  /** Local Bonsai — cannot delete / no remote fetch. */
  locked: boolean;
};

/** Flat endpoint row used when talking to save_settings / legacy paths. */
export type ModelProfileRow = {
  model_id: string;
  name: string;
  base_url: string;
  api_key: string;
  has_api_key: boolean;
  api_key_hint?: string | null;
  api_backend: string;
  context_window: string;
  max_completion_tokens: string;
  enabled: boolean;
  /** Stable Settings vendor row id. */
  vendor_id?: string;
  /** Persisted for custom models; curated vendors ignore and use catalog. */
  capability?: ModelCapability;
  /** Persisted for custom models; curated use hard-coded tier maps. */
  performance_tier?: PerformanceTier;
  /** See {@link VendorModel.remoteConfirmed}. */
  remote_confirmed?: boolean;
};

export type PublicEndpointLike = {
  model_id: string;
  name?: string | null;
  base_url?: string | null;
  has_api_key?: boolean;
  api_key_hint?: string | null;
  api_backend?: string | null;
  context_window?: number | null;
  max_completion_tokens?: number | null;
  enabled?: boolean | null;
  vendor_id?: string | null;
  capability?: string | null;
  performance_tier?: string | null;
  remote_confirmed?: boolean | null;
};

export const BONSAI_MODEL_ID = "bonsai-local";
export const BONSAI_DISPLAY_NAME = "Bonsai 27B (1Bit)";
export const BONSAI_BASE_URL = "http://127.0.0.1:8080/v1";

export const DEEPSEEK_DEFAULT_BASE = "https://api.deepseek.com/v1";
export const BAILIAN_DEFAULT_BASE =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 1k tokens = 1024. Bonsai CUDA (NVIDIA ≥8GB) uses 48k context. */
export const TOKENS_PER_K = 1024;

/** Last-resort Bonsai fallback until hardware tune is loaded (8GB+ CUDA 48k). */
export const VENDOR_TOKEN_DEFAULTS: Record<
  VendorKind,
  { contextK: number; maxCompletionK: number }
> = {
  bonsai: { contextK: 48, maxCompletionK: 16 },
  deepseek: { contextK: 256, maxCompletionK: 128 },
  bailian: { contextK: 256, maxCompletionK: 128 },
  custom: { contextK: 256, maxCompletionK: 128 },
};

/** Historical 12GB Bonsai defaults — treat as unset and replace with GPU tune. */
const STALE_BONSAI_CONTEXT_WINDOWS = new Set([98_304]);

export type BonsaiHardwareTune = {
  n_gpu_layers: number;
  ctx_size: number;
  max_completion_tokens: number;
  force_cpu: boolean;
  blocked?: boolean;
  label: string;
};

let bonsaiHardwareTune: BonsaiHardwareTune | null = null;

export function setBonsaiHardwareTune(tune: BonsaiHardwareTune | null) {
  bonsaiHardwareTune = tune;
}

export function getBonsaiHardwareTune(): BonsaiHardwareTune | null {
  return bonsaiHardwareTune;
}

export function applyBonsaiHardwareTune(
  vendor: VendorRow,
  tune: BonsaiHardwareTune,
): VendorRow {
  if (vendor.kind !== "bonsai" || tune.blocked) return vendor;
  return {
    ...vendor,
    context_window: String(tune.ctx_size),
    max_completion_tokens: String(tune.max_completion_tokens),
  };
}

function bonsaiFallbackTokens(): {
  context_window: string;
  max_completion_tokens: string;
} {
  if (bonsaiHardwareTune && !bonsaiHardwareTune.blocked) {
    return {
      context_window: String(bonsaiHardwareTune.ctx_size),
      max_completion_tokens: String(bonsaiHardwareTune.max_completion_tokens),
    };
  }
  return defaultTokensForKind("bonsai");
}

function resolveBonsaiStoredTokens(
  stored: string | undefined,
  fallback: string,
): string {
  const n = Number(stored);
  if (
    !stored ||
    !Number.isFinite(n) ||
    n <= 0 ||
    STALE_BONSAI_CONTEXT_WINDOWS.has(n)
  ) {
    return fallback;
  }
  return String(Math.floor(n));
}

export function kToTokens(k: number): number {
  return Math.max(1, Math.round(k * TOKENS_PER_K));
}

export function tokensToK(tokens: number | string | null | undefined): number {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / TOKENS_PER_K);
}

export function tokensToKInput(tokens: number | string | null | undefined): string {
  if (tokens === "" || tokens == null) return "";
  const k = tokensToK(tokens);
  return k > 0 ? String(k) : "";
}

export function parseKInputToTokens(
  raw: string,
  fallbackK: number,
): string {
  const cleaned = raw.trim().replace(/k$/i, "");
  if (!cleaned) return "";
  const k = Number(cleaned);
  if (!Number.isFinite(k) || k <= 0) {
    return String(kToTokens(fallbackK));
  }
  return String(kToTokens(k));
}

export function defaultTokensForKind(kind: VendorKind): {
  context_window: string;
  max_completion_tokens: string;
} {
  const d = VENDOR_TOKEN_DEFAULTS[kind];
  return {
    context_window: String(kToTokens(d.contextK)),
    max_completion_tokens: String(kToTokens(d.maxCompletionK)),
  };
}

/** DeepSeek: keep only these after fetch. */
export const DEEPSEEK_ALLOWLIST = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;

/** 阿里百炼: keep only these after fetch (when present). */
export const BAILIAN_ALLOWLIST = [
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen3.7-flash",
  "happyhorse-1.1-i2v",
  "happyhorse-1.1-t2v",
  "happyhorse-1.1-r2v",
  "qwen-image-3.0",
  "qwen-image-3.0-pro",
] as const;

const MODEL_CAPABILITY: Record<string, ModelCapability> = {
  "deepseek-v4-flash": "llm",
  "deepseek-v4-pro": "llm",
  "qwen3.7-plus": "vlm",
  // Max is text-only on Bailian; Plus/Flash are the multimodal (VLM) SKUs.
  "qwen3.7-max": "llm",
  "qwen3.7-flash": "vlm",
  "happyhorse-1.1-i2v": "video",
  "happyhorse-1.1-t2v": "video",
  "happyhorse-1.1-r2v": "video",
  "qwen-image-3.0": "image",
  "qwen-image-3.0-pro": "image",
  [BONSAI_MODEL_ID]: "vlm",
};

/**
 * Hard-coded curated performance tiers (not editable in Settings).
 * HappyHorse / Qwen Image entries participate only in MCP media routing.
 */
const CURATED_TIER_MEMBERSHIP: Record<PerformanceTier, readonly string[]> = {
  strong: [
    "deepseek-v4-pro",
    "qwen3.7-plus",
    "qwen3.7-max",
    "happyhorse-1.1-i2v",
    "happyhorse-1.1-t2v",
    "happyhorse-1.1-r2v",
    "qwen-image-3.0-pro",
  ],
  medium: [
    "deepseek-v4-flash",
    "qwen3.7-plus",
    "happyhorse-1.1-i2v",
    "happyhorse-1.1-t2v",
    "happyhorse-1.1-r2v",
    "qwen-image-3.0",
  ],
  weak: [
    "deepseek-v4-flash",
    "qwen3.7-flash",
    "happyhorse-1.1-i2v",
    "happyhorse-1.1-t2v",
    "happyhorse-1.1-r2v",
    "qwen-image-3.0",
    BONSAI_MODEL_ID,
  ],
};

/** Vendor family priority when auto-picking inside a tier: local → DeepSeek → Qwen → custom. */
function vendorFamilyRank(kind: VendorKind, modelId: string): number {
  if (kind === "bonsai" || modelId === BONSAI_MODEL_ID) return 0;
  if (kind === "deepseek" || modelId.toLowerCase().startsWith("deepseek")) return 1;
  if (
    kind === "bailian" ||
    modelId.toLowerCase().startsWith("qwen") ||
    modelId.toLowerCase().startsWith("happyhorse")
  ) {
    return 2;
  }
  return 3;
}

export function parsePerformanceTier(
  raw?: string | null,
): PerformanceTier | undefined {
  const v = (raw || "").trim().toLowerCase();
  if (v === "strong" || v === "medium" || v === "weak") return v;
  return undefined;
}

/** Curated catalog tiers for a model id (may appear in multiple tiers). */
export function curatedPerformanceTiers(
  modelId: string,
): PerformanceTier[] | undefined {
  const id = modelId.trim().toLowerCase();
  const out: PerformanceTier[] = [];
  for (const tier of PERFORMANCE_TIERS) {
    if (CURATED_TIER_MEMBERSHIP[tier].some((m) => m.toLowerCase() === id)) {
      out.push(tier);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Resolve the performance tier used for routing.
 * Curated models use hard-coded membership; custom uses stored value (default strong).
 */
export function resolvePerformanceTier(
  modelId: string,
  stored?: PerformanceTier | string | null,
  vendorKind?: VendorKind,
): PerformanceTier {
  const curated = curatedPerformanceTiers(modelId);
  if (curated && curated.length > 0) {
    // Prefer the highest tier membership for display; routing checks membership.
    if (curated.includes("strong")) return "strong";
    if (curated.includes("medium")) return "medium";
    return "weak";
  }
  if (vendorKind === "bonsai" || modelId === BONSAI_MODEL_ID) return "weak";
  return parsePerformanceTier(typeof stored === "string" ? stored : stored ?? null) ?? "strong";
}

export function modelBelongsToTier(
  modelId: string,
  tier: PerformanceTier,
  opts?: {
    storedTier?: PerformanceTier | string | null;
    vendorKind?: VendorKind;
  },
): boolean {
  const curated = curatedPerformanceTiers(modelId);
  if (curated) return curated.includes(tier);
  if (opts?.vendorKind === "bonsai" || modelId === BONSAI_MODEL_ID) {
    return tier === "weak";
  }
  const stored =
    parsePerformanceTier(
      typeof opts?.storedTier === "string"
        ? opts.storedTier
        : opts?.storedTier ?? null,
    ) ?? "strong";
  return stored === tier;
}

export function displayNameForPerformanceTier(tier: PerformanceTier): string {
  switch (tier) {
    case "strong":
      return "强";
    case "medium":
      return "中";
    case "weak":
      return "弱";
  }
}

/** Search order: current → lower tiers → higher tiers. */
export function tierSearchOrder(preferred: PerformanceTier): PerformanceTier[] {
  const idx = PERFORMANCE_TIERS.indexOf(preferred);
  const down = PERFORMANCE_TIERS.slice(idx);
  const up = PERFORMANCE_TIERS.slice(0, idx).reverse();
  const seen = new Set<PerformanceTier>();
  const out: PerformanceTier[] = [];
  for (const t of [...down, ...up]) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export type TierResolveNeed = "chat" | "vision" | "image" | "video";

function modelMatchesNeed(
  modelId: string,
  capability: ModelCapability,
  need: TierResolveNeed,
): boolean {
  if (need === "image") return capability === "image";
  if (need === "video") return capability === "video";
  if (need === "vision") {
    return supportsVisionInput(modelId, capability);
  }
  // chat: llm / vlm / local — not media backends
  return isAgentChatCapability(capability);
}

/**
 * Whether a vendor model may be used for auto tier routing.
 * Chat: enabled + credentials + remote confirmed (A+C).
 * Media MCP: enabled + credentials; remote confirm optional (often absent from /models).
 */
export function isModelUsableForTierRouting(
  v: VendorRow,
  m: VendorModel,
  need: TierResolveNeed,
): boolean {
  if (!m.enabled || isVendorPlaceholderModel(m.id)) return false;
  if (!vendorHasCredentials(v)) return false;
  const cap = resolveModelCapability(m.id, m.capability);
  if (!modelMatchesNeed(m.id, cap, need)) return false;

  const isMedia = need === "image" || need === "video";
  if (isMedia) return true;

  // Chat / vision: require remote confirmation when explicitly false.
  if (v.kind === "bonsai" || v.kind === "custom") return true;
  if (m.remoteConfirmed === false) return false;
  return true;
}

export type TierResolveResult = {
  modelId: string;
  tierUsed: PerformanceTier;
  vendorKind: VendorKind;
};

/**
 * Auto-pick a model for the preferred performance tier.
 * Within a tier: local → DeepSeek → Qwen → custom; catalog order as tie-break.
 */
export function resolveModelForPerformanceTier(
  vendors: VendorRow[],
  preferred: PerformanceTier,
  need: TierResolveNeed = "chat",
): TierResolveResult | null {
  for (const tier of tierSearchOrder(preferred)) {
    const catalogOrder = new Map<string, number>();
    CURATED_TIER_MEMBERSHIP[tier].forEach((id, i) => {
      catalogOrder.set(id.toLowerCase(), i);
    });

    type Cand = {
      modelId: string;
      vendorKind: VendorKind;
      family: number;
      catalogIdx: number;
    };
    const cands: Cand[] = [];

    for (const v of vendors) {
      for (const m of v.models) {
        if (!modelBelongsToTier(m.id, tier, {
          storedTier: m.performanceTier,
          vendorKind: v.kind,
        })) {
          continue;
        }
        if (!isModelUsableForTierRouting(v, m, need)) continue;
        cands.push({
          modelId: m.id,
          vendorKind: v.kind,
          family: vendorFamilyRank(v.kind, m.id),
          catalogIdx:
            catalogOrder.get(m.id.toLowerCase()) ??
            1000 + cands.length,
        });
      }
    }

    cands.sort((a, b) => {
      if (a.family !== b.family) return a.family - b.family;
      return a.catalogIdx - b.catalogIdx;
    });

    const best = cands[0];
    if (best) {
      return {
        modelId: best.modelId,
        tierUsed: tier,
        vendorKind: best.vendorKind,
      };
    }
  }
  return null;
}

const SELECTION_MODE_KEY = "grokx.modelSelectionMode";
const PERFORMANCE_TIER_KEY = "grokx.performanceTier";
const DEFAULT_TIER_PIN_KEY = "grokx.defaultPerformanceTierPinned";

export function readModelSelectionMode(): ModelSelectionMode {
  try {
    const v = localStorage.getItem(SELECTION_MODE_KEY);
    if (v === "model" || v === "tier") return v;
  } catch {
    /* ignore */
  }
  return "tier";
}

export function writeModelSelectionMode(mode: ModelSelectionMode): void {
  try {
    localStorage.setItem(SELECTION_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function readPerformanceTier(fallback: PerformanceTier = "medium"): PerformanceTier {
  try {
    const v = parsePerformanceTier(localStorage.getItem(PERFORMANCE_TIER_KEY));
    if (v) return v;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function writePerformanceTier(tier: PerformanceTier): void {
  try {
    localStorage.setItem(PERFORMANCE_TIER_KEY, tier);
  } catch {
    /* ignore */
  }
}

export function readDefaultTierPinned(): boolean {
  try {
    return localStorage.getItem(DEFAULT_TIER_PIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDefaultTierPinned(pinned: boolean): void {
  try {
    if (pinned) localStorage.setItem(DEFAULT_TIER_PIN_KEY, "1");
    else localStorage.removeItem(DEFAULT_TIER_PIN_KEY);
  } catch {
    /* ignore */
  }
}

export type ModelIconKind = "bonsai" | "deepseek" | "qwen" | "happyhorse" | "generic";

export function modelIconKind(modelId: string, vendorKind?: VendorKind): ModelIconKind {
  const id = modelId.trim().toLowerCase();
  if (id === BONSAI_MODEL_ID || vendorKind === "bonsai") return "bonsai";
  if (id.startsWith("deepseek") || vendorKind === "deepseek") return "deepseek";
  if (id.startsWith("happyhorse")) return "happyhorse";
  if (
    id.startsWith("qwen") ||
    id.includes("qwen") ||
    vendorKind === "bailian"
  ) {
    return "qwen";
  }
  return "generic";
}

export function capabilityForModel(modelId: string): ModelCapability | undefined {
  return MODEL_CAPABILITY[modelId.trim().toLowerCase()] ?? MODEL_CAPABILITY[modelId];
}

/**
 * Whether this model can accept image inputs (vision / VLM).
 * Known text-only models (DeepSeek LLM, video/image-gen) → false.
 * Known VLMs → true. Unknown custom ids → true (avoid false blocks).
 */
export function supportsVisionInput(
  modelId: string,
  capability?: ModelCapability | null,
): boolean {
  const id = modelId.trim();
  if (!id) return false;
  // Prefer curated catalog so custom stored caps don't override known SKUs.
  const known = capabilityForModel(id);
  const cap = known ?? parseModelCapability(capability) ?? null;
  if (cap === "vlm") return true;
  if (cap === "llm" || cap === "video" || cap === "image" || cap === "local") {
    return false;
  }

  const lower = id.toLowerCase();
  if (lower.startsWith("deepseek")) return false;
  if (
    /\b(vlm|vision|gpt-4o|gpt-4\.1|gemini|claude-3|claude-4)\b/i.test(lower) ||
    lower.includes("-vl-") ||
    lower.includes("-vl.") ||
    lower.endsWith("-vl") ||
    /qwen.*vl/i.test(lower)
  ) {
    return true;
  }
  // Unknown custom endpoint — don't block; engine will error if unsupported.
  return true;
}

/** Enabled profiles that can take image inputs. */
export function listVisionCapableModels(
  models: Array<{
    id: string;
    name?: string | null;
    capability?: ModelCapability | null;
    enabled?: boolean | null;
  }>,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (m.enabled === false) continue;
    const id = (m.id || "").trim();
    if (!id || seen.has(id)) continue;
    if (!supportsVisionInput(id, m.capability)) continue;
    seen.add(id);
    out.push({
      id,
      name: (m.name || "").trim() || displayNameForModel(id),
    });
  }
  return out;
}

/**
 * Common image filename extensions. Delimiter after ext avoids needing `\b`
 * (which is unreliable next to CJK characters).
 */
export const IMAGE_FILE_EXT_RE =
  /\.(png|jpe?g|jfif|gif|webp|bmp|svgz?|ico|tiff?|heic|heif|avif|raw|psd|ai|apng|jxl)(?=$|[^a-z0-9])/i;

/**
 * User text that likely needs reading/understanding images.
 * Used with folder chips / path refs. Intentionally wide on extensions.
 */
export function looksLikeVisionIntent(text: string): boolean {
  const s = (text || "").trim();
  if (!s) return false;
  if (IMAGE_FILE_EXT_RE.test(s)) return true;
  return /(图[片像]|照片|相片|截图|屏摄|识图|看图|读图|描[述画]图|这[张幅]图|那[张幅]图|几张图|哪些图|哪[张些]图|有没有.*图|图里|图中|screenshots?|images?|photos?|pictures?|bitmaps?)/i.test(
    s,
  );
}

/**
 * User text that asks the agent to generate an image or video (Bailian MCP).
 * After generation the conversation carries multimodal parts, so the chat
 * model must be a VLM — text-only models (e.g. DeepSeek) fail with `image_url`.
 */
export function looksLikeMediaGenIntent(text: string): boolean {
  const s = (text || "").trim();
  if (!s) return false;
  return /(生成|画|绘制|创作|做|制作|出品|渲染).{0,24}(图|图片|插画|海报|封面|壁纸|漫画|视频|短片|动画|影片|短视频)|(图|图片|插画|海报|封面|壁纸|漫画|视频|短片|动画|影片|短视频).{0,12}(生成|画|绘制|创作)|(text[-\s]?to[-\s]?(image|video)|image[-\s]?gen|video[-\s]?gen|generate\s+(an?\s+)?(image|picture|photo|video|clip|animation)|create\s+(an?\s+)?(image|picture|photo|video|clip)|draw\s+(me\s+|an?\s+)?|make\s+(me\s+)?(an?\s+)?(image|picture|video)|imagine\s)/i.test(
    s,
  );
}

export function displayNameForModel(modelId: string, vendorKind?: VendorKind): string {
  if (modelId === BONSAI_MODEL_ID || vendorKind === "bonsai") {
    return BONSAI_DISPLAY_NAME;
  }
  return modelId;
}

export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  if (!s.includes("://")) s = `http://${s}`;
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** UI mask matching backend `mask_api_key_hint` (first4 + bullets + last4). */
export function maskApiKeyHint(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 8) return `${k.slice(0, Math.min(2, k.length))}••••`;
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

export function detectVendorKind(
  baseUrl: string,
  modelIds: string[] = [],
): VendorKind {
  const u = normalizeBaseUrl(baseUrl).toLowerCase();
  const ids = modelIds.map((m) => m.toLowerCase());
  if (
    ids.includes(BONSAI_MODEL_ID) ||
    u.includes("127.0.0.1:8080") ||
    u.includes("localhost:8080")
  ) {
    return "bonsai";
  }
  if (u.includes("deepseek")) return "deepseek";
  if (
    u.includes("dashscope") ||
    u.includes("aliyun") ||
    u.includes("bailian") ||
    ids.some(
      (id) =>
        id.startsWith("qwen") ||
        id.startsWith("happyhorse") ||
        id.includes("qwen"),
    )
  ) {
    return "bailian";
  }
  return "custom";
}

export function vendorDisplayName(kind: VendorKind, fallback?: string): string {
  switch (kind) {
    case "bonsai":
      return BONSAI_DISPLAY_NAME;
    case "deepseek":
      return "DeepSeek";
    case "bailian":
      return "阿里百炼";
    default:
      return fallback?.trim() || "Custom";
  }
}

function allowlistForKind(kind: VendorKind): readonly string[] | null {
  if (kind === "deepseek") return DEEPSEEK_ALLOWLIST;
  if (kind === "bailian") return BAILIAN_ALLOWLIST;
  return null;
}

/** Filter remote models for a vendor; preserves allowlist order when applicable.
 *
 * For curated vendors (DeepSeek / 阿里百炼), always return the full allowlist.
 * Video / image models (e.g. HappyHorse) often are not listed by OpenAI-compatible
 * `/models`, but are still callable — so we keep them in the catalog.
 */
export function filterFetchedModels(
  kind: VendorKind,
  remote: { id: string; name?: string }[],
): VendorModel[] {
  const allow = allowlistForKind(kind);
  if (!allow) {
    return remote
      .map((m) => m.id.trim())
      .filter(Boolean)
      .map((id) => ({
        id,
        enabled: true,
        capability: capabilityForModel(id),
        remoteConfirmed: true,
      }));
  }
  const byLower = new Map<string, string>();
  for (const m of remote) {
    const id = m.id.trim();
    if (!id) continue;
    byLower.set(id.toLowerCase(), id);
  }
  return allow.map((want) => {
    const hit =
      byLower.get(want.toLowerCase()) ??
      [...byLower.entries()].find(([k]) => k.includes(want.toLowerCase()))?.[1];
    const cap = capabilityForModel(want);
    // Media SKUs often omit from OpenAI-compatible /models but remain callable.
    const mediaAlways =
      cap === "image" || cap === "video" || want.startsWith("happyhorse");
    return {
      id: hit || want,
      enabled: true,
      capability: cap,
      remoteConfirmed: Boolean(hit) || mediaAlways,
    };
  });
}

/** Seed curated catalog without waiting for /models (bailian video etc.). */
export function curatedModelsForKind(kind: VendorKind): VendorModel[] {
  const allow = allowlistForKind(kind);
  if (!allow) return [];
  return allow.map((id) => {
    const cap = capabilityForModel(id);
    const mediaAlways =
      cap === "image" || cap === "video" || id.startsWith("happyhorse");
    return {
      id,
      enabled: true,
      capability: cap,
      // Not yet confirmed by /models unless media (catalog-callable).
      remoteConfirmed: mediaAlways ? true : false,
    };
  });
}

export function defaultBonsaiVendor(): VendorRow {
  const tokens = bonsaiFallbackTokens();
  return {
    id: "vendor-bonsai",
    kind: "bonsai",
    name: BONSAI_DISPLAY_NAME,
    base_url: BONSAI_BASE_URL,
    api_key: "",
    has_api_key: true,
    api_key_hint: "local",
    api_backend: "chat_completions",
    context_window: tokens.context_window,
    max_completion_tokens: tokens.max_completion_tokens,
    models: [
      {
        id: BONSAI_MODEL_ID,
        enabled: true,
        capability: "vlm",
        performanceTier: "weak",
        remoteConfirmed: true,
      },
    ],
    locked: true,
  };
}

export function newVendorPreset(kind: Exclude<VendorKind, "bonsai">): VendorRow {
  const stamp = Date.now();
  const tokens = defaultTokensForKind(kind);
  if (kind === "deepseek") {
    return {
      id: `vendor-deepseek-${stamp}`,
      kind: "deepseek",
      name: "DeepSeek",
      base_url: DEEPSEEK_DEFAULT_BASE,
      api_key: "",
      has_api_key: false,
      api_backend: "chat_completions",
      context_window: tokens.context_window,
      max_completion_tokens: tokens.max_completion_tokens,
      models: curatedModelsForKind("deepseek").map((m) => ({ ...m, enabled: false })),
      locked: false,
    };
  }
  if (kind === "bailian") {
    return {
      id: `vendor-bailian-${stamp}`,
      kind: "bailian",
      name: "阿里百炼",
      base_url: BAILIAN_DEFAULT_BASE,
      api_key: "",
      has_api_key: false,
      api_backend: "chat_completions",
      context_window: tokens.context_window,
      max_completion_tokens: tokens.max_completion_tokens,
      models: curatedModelsForKind("bailian").map((m) => ({ ...m, enabled: false })),
      locked: false,
    };
  }
  return {
    id: `vendor-custom-${stamp}`,
    kind: "custom",
    name: "Custom",
    base_url: "",
    api_key: "",
    has_api_key: false,
    api_backend: "chat_completions",
    context_window: tokens.context_window,
    max_completion_tokens: tokens.max_completion_tokens,
    models: [],
    locked: false,
  };
}

export function endpointToProfileRow(ep: PublicEndpointLike): ModelProfileRow {
  const model_id = ep.model_id || "";
  const name =
    model_id === BONSAI_MODEL_ID
      ? BONSAI_DISPLAY_NAME
      : (ep.name || "").trim() || model_id;
  return {
    model_id,
    name,
    base_url: ep.base_url || "",
    api_key: "",
    has_api_key: Boolean(ep.has_api_key),
    api_key_hint: ep.api_key_hint,
    api_backend: ep.api_backend || "chat_completions",
    context_window: String(
      ep.context_window ?? kToTokens(VENDOR_TOKEN_DEFAULTS.custom.contextK),
    ),
    max_completion_tokens: String(
      ep.max_completion_tokens ??
        kToTokens(VENDOR_TOKEN_DEFAULTS.custom.maxCompletionK),
    ),
    enabled: ep.enabled !== false,
    vendor_id: ep.vendor_id?.trim() || undefined,
    capability: parseModelCapability(ep.capability),
    performance_tier: parsePerformanceTier(ep.performance_tier),
    remote_confirmed:
      typeof ep.remote_confirmed === "boolean" ? ep.remote_confirmed : undefined,
  };
}

function vendorIdFromPlaceholder(modelId: string): string | null {
  if (!modelId.startsWith("__vendor__")) return null;
  const id = modelId.slice("__vendor__".length).trim();
  return id || null;
}

/** Group flat profiles into vendor rows (vendor_id → shared base_url → per-id). */
export function profilesToVendors(profiles: ModelProfileRow[]): VendorRow[] {
  if (profiles.length === 0) return [defaultBonsaiVendor()];

  const groups = new Map<string, ModelProfileRow[]>();
  const order: string[] = [];

  for (const p of profiles) {
    const fromPlaceholder = vendorIdFromPlaceholder(p.model_id);
    const key =
      p.model_id === BONSAI_MODEL_ID || p.vendor_id === "vendor-bonsai"
        ? "__bonsai__"
        : (p.vendor_id && p.vendor_id.trim()) ||
          fromPlaceholder ||
          normalizeBaseUrl(p.base_url) ||
          `id:${p.model_id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(p);
  }

  const vendors: VendorRow[] = [];
  let hasBonsai = false;

  for (const key of order) {
    const list = groups.get(key)!;
    const first = list[0];
    const modelIds = list.map((p) => p.model_id);
    const kind = detectVendorKind(first.base_url, modelIds);
    if (kind === "bonsai" || key === "__bonsai__") {
      hasBonsai = true;
      const bonsai = defaultBonsaiVendor();
      bonsai.has_api_key = first.has_api_key || bonsai.has_api_key;
      bonsai.api_key_hint = first.api_key_hint ?? bonsai.api_key_hint;
      const staleBonsai =
        STALE_BONSAI_CONTEXT_WINDOWS.has(Number(first.context_window));
      bonsai.context_window = staleBonsai
        ? bonsai.context_window
        : resolveBonsaiStoredTokens(first.context_window, bonsai.context_window);
      bonsai.max_completion_tokens = staleBonsai
        ? bonsai.max_completion_tokens
        : resolveBonsaiStoredTokens(
            first.max_completion_tokens,
            bonsai.max_completion_tokens,
          );
      vendors.push(bonsai);
      continue;
    }

    const stableId =
      list.map((p) => p.vendor_id?.trim()).find(Boolean) ||
      list.map((p) => vendorIdFromPlaceholder(p.model_id)).find(Boolean) ||
      (key.startsWith("vendor-") ? key : `vendor-${kind}-${vendors.length}`);

    const models: VendorModel[] = [];
    let displayName = vendorDisplayName(kind, first.name);
    for (const p of list) {
      if (p.model_id.startsWith("__vendor__")) {
        // Identity / credentials placeholder — keep display name if set.
        if (p.name.trim() && p.name.trim() !== p.model_id) {
          displayName = p.name.trim();
        }
        continue;
      }
      models.push({
        id: p.model_id,
        enabled: p.enabled !== false,
        capability: resolveModelCapability(p.model_id, p.capability),
        performanceTier:
          kind === "custom"
            ? resolvePerformanceTier(p.model_id, p.performance_tier, kind)
            : undefined,
        remoteConfirmed: p.remote_confirmed,
      });
    }
    // Curated vendors: ensure full allowlist stays visible even if some were never saved.
    if (kind === "deepseek" || kind === "bailian") {
      const have = new Set(models.map((m) => m.id.toLowerCase()));
      for (const m of curatedModelsForKind(kind)) {
        if (!have.has(m.id.toLowerCase())) {
          models.push({ ...m, enabled: false });
        }
      }
      // Force catalog capabilities for curated SKUs.
      for (const m of models) {
        const catalog = capabilityForModel(m.id);
        if (catalog) m.capability = catalog;
        // Curated tiers are hard-coded — clear any stored custom tier.
        m.performanceTier = undefined;
      }
      displayName = vendorDisplayName(kind);
    }
    vendors.push({
      id: stableId,
      kind,
      name: displayName,
      base_url: first.base_url,
      api_key: "",
      has_api_key: list.some((p) => p.has_api_key),
      api_key_hint: list.find((p) => p.api_key_hint)?.api_key_hint,
      api_backend: first.api_backend || "chat_completions",
      context_window:
        first.context_window || defaultTokensForKind(kind).context_window,
      max_completion_tokens:
        first.max_completion_tokens ||
        defaultTokensForKind(kind).max_completion_tokens,
      models,
      locked: false,
    });
  }

  if (!hasBonsai) {
    vendors.unshift(defaultBonsaiVendor());
  }
  return vendors;
}

/** Expand vendors → flat profiles for persistence (name === model_id except Bonsai). */
export function vendorsToProfiles(vendors: VendorRow[]): ModelProfileRow[] {
  const out: ModelProfileRow[] = [];
  for (const v of vendors) {
    const realModels = v.models.filter((m) => !m.id.startsWith("__vendor__"));
    // Always persist an identity row for non-bonsai so empty "Custom" vendors survive save.
    if (v.kind !== "bonsai") {
      out.push({
        model_id: `__vendor__${v.id}`,
        name: v.name,
        base_url: v.base_url,
        api_key: v.api_key,
        has_api_key: v.has_api_key,
        api_key_hint: v.api_key_hint,
        api_backend: v.api_backend,
        context_window: v.context_window,
        max_completion_tokens: v.max_completion_tokens,
        enabled: false,
        vendor_id: v.id,
      });
    }
    const models =
      realModels.length > 0
        ? realModels
        : v.kind === "bonsai"
          ? [{ id: BONSAI_MODEL_ID, enabled: true, capability: "vlm" as const }]
          : [];
    for (const m of models) {
      out.push({
        model_id: m.id,
        name:
          m.id === BONSAI_MODEL_ID || v.kind === "bonsai"
            ? BONSAI_DISPLAY_NAME
            : m.id,
        base_url: v.base_url,
        api_key: v.api_key,
        has_api_key: v.has_api_key,
        api_key_hint: v.api_key_hint,
        api_backend: v.api_backend,
        context_window: v.context_window,
        max_completion_tokens: v.max_completion_tokens,
        enabled: m.enabled,
        vendor_id: v.kind === "bonsai" ? "vendor-bonsai" : v.id,
        capability: resolveModelCapability(m.id, m.capability),
        performance_tier:
          v.kind === "custom"
            ? resolvePerformanceTier(m.id, m.performanceTier, v.kind)
            : undefined,
        remote_confirmed:
          typeof m.remoteConfirmed === "boolean" ? m.remoteConfirmed : undefined,
      });
    }
  }
  return out.length > 0
    ? out
    : (() => {
        const tokens = defaultTokensForKind("bonsai");
        return [
          {
            model_id: BONSAI_MODEL_ID,
            name: BONSAI_DISPLAY_NAME,
            base_url: BONSAI_BASE_URL,
            api_key: "",
            has_api_key: true,
            api_key_hint: "local",
            api_backend: "chat_completions",
            context_window: tokens.context_window,
            max_completion_tokens: tokens.max_completion_tokens,
            enabled: true,
            vendor_id: "vendor-bonsai",
            remote_confirmed: true,
          },
        ];
      })();
}

export function isVendorPlaceholderModel(modelId: string): boolean {
  return modelId.startsWith("__vendor__");
}

/**
 * Preferred default chat model priority.
 * While the user has not manually set a default, each vendor save re-ranks
 * by this list (so DS → then Qwen upgrades to Qwen; Qwen → then DS stays Qwen).
 */
export const DEFAULT_CHAT_MODEL_PRIORITY = [
  "qwen3.7-plus",
  "qwen3.7-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  BONSAI_MODEL_ID,
] as const;

/** Set only when the user manually changes the default model in Settings. */
const DEFAULT_MODEL_PIN_KEY = "grokx.defaultModelPinned";
/** Obsolete one-shot flag — ignored so priority can still upgrade DS → Qwen. */
const DEFAULT_MODEL_AUTO_DONE_KEY = "grokx.defaultModelAutoDone";

/** True after the user manually chose a default model. */
export function readDefaultModelPinned(): boolean {
  try {
    // Migrate away from obsolete one-shot lock (it also wrote the pin key).
    if (localStorage.getItem(DEFAULT_MODEL_AUTO_DONE_KEY) === "1") {
      localStorage.removeItem(DEFAULT_MODEL_AUTO_DONE_KEY);
      localStorage.removeItem(DEFAULT_MODEL_PIN_KEY);
      return false;
    }
    return localStorage.getItem(DEFAULT_MODEL_PIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDefaultModelPinned(pinned: boolean): void {
  try {
    if (pinned) {
      localStorage.setItem(DEFAULT_MODEL_PIN_KEY, "1");
    } else {
      localStorage.removeItem(DEFAULT_MODEL_PIN_KEY);
    }
    // Drop obsolete one-shot lock so auto priority can work again if unpinned.
    localStorage.removeItem(DEFAULT_MODEL_AUTO_DONE_KEY);
  } catch {
    /* ignore */
  }
}

/** Vendor is usable for default-model selection (bonsai if GPU allows; others need a key). */
export function vendorHasCredentials(v: VendorRow): boolean {
  if (v.kind === "bonsai") {
    if (getBonsaiHardwareTune()?.blocked) return false;
    return true;
  }
  return Boolean(v.api_key.trim()) || v.has_api_key;
}

/** Enabled agent-chat model ids on vendors that have credentials. */
export function collectEnabledChatModelIds(vendors: VendorRow[]): Set<string> {
  const out = new Set<string>();
  for (const v of vendors) {
    if (!vendorHasCredentials(v)) continue;
    for (const m of v.models) {
      if (!m.enabled || isVendorPlaceholderModel(m.id)) continue;
      const cap = resolveModelCapability(m.id, m.capability);
      if (!isAgentChatCapability(cap)) continue;
      out.add(m.id);
    }
  }
  return out;
}

/**
 * Pick the best default model from currently connected + enabled chat models.
 * No Ali/DS chat models → bonsai-local.
 */
export function pickPreferredDefaultModel(vendors: VendorRow[]): string {
  const enabled = collectEnabledChatModelIds(vendors);
  const byLower = new Map<string, string>();
  for (const id of enabled) byLower.set(id.toLowerCase(), id);

  for (const want of DEFAULT_CHAT_MODEL_PRIORITY) {
    const hit = byLower.get(want.toLowerCase());
    if (hit) return hit;
  }

  if (byLower.has(BONSAI_MODEL_ID.toLowerCase())) return BONSAI_MODEL_ID;
  const first = enabled.values().next().value;
  return typeof first === "string" && first ? first : BONSAI_MODEL_ID;
}

/**
 * Resolve which default model to persist.
 *
 * - Not user-pinned → always {@link pickPreferredDefaultModel} (DS then Qwen upgrades).
 * - User-pinned → keep current while still enabled; else fall back to preferred.
 */
export function resolveAutoDefaultModel(
  vendors: VendorRow[],
  opts?: {
    current?: string | null;
    pinned?: boolean;
    fallback?: string | null;
  },
): string {
  const preferred = pickPreferredDefaultModel(vendors);
  const current = (opts?.current || "").trim();
  const fallback = (opts?.fallback || "").trim();
  const pinned = opts?.pinned ?? readDefaultModelPinned();

  if (pinned) {
    return (
      findEnabledChatModelId(vendors, current) ||
      findEnabledChatModelId(vendors, fallback) ||
      preferred
    );
  }

  return preferred;
}

/** Return `id` if it is still an enabled chat model on a credentialed vendor. */
export function findEnabledChatModelId(
  vendors: VendorRow[],
  id: string | null | undefined,
): string | null {
  const want = (id || "").trim();
  if (!want) return null;
  const enabled = collectEnabledChatModelIds(vendors);
  if (enabled.has(want)) return want;
  const lower = want.toLowerCase();
  for (const e of enabled) {
    if (e.toLowerCase() === lower) return e;
  }
  return null;
}

/**
 * Dialog / composer model: keep current if still enabled, else fall back to
 * the resolved default (after vendor delete or model uncheck).
 */
export function resolveComposerModelId(
  vendors: VendorRow[],
  opts: {
    current?: string | null;
    fallbackDefault: string;
  },
): string {
  return (
    findEnabledChatModelId(vendors, opts.current) ||
    findEnabledChatModelId(vendors, opts.fallbackDefault) ||
    pickPreferredDefaultModel(vendors)
  );
}

export function profileToSavePayload(p: ModelProfileRow) {
  const fallback = defaultTokensForKind(
    p.model_id === BONSAI_MODEL_ID
      ? "bonsai"
      : p.model_id.startsWith("deepseek")
        ? "deepseek"
        : p.model_id.startsWith("qwen") || p.model_id.startsWith("happyhorse")
          ? "bailian"
          : "custom",
  );
  const cw = Number(p.context_window);
  const maxTok = Number(p.max_completion_tokens);
  const isBonsai = p.model_id === BONSAI_MODEL_ID;
  const draftKey = p.api_key.trim();
  return {
    model_id: p.model_id.trim(),
    // Remote: name === id. Bonsai keeps a friendly label for the engine UI.
    name: isBonsai
      ? BONSAI_DISPLAY_NAME
      : p.model_id.startsWith("__vendor__")
        ? p.name.trim() || null
        : p.model_id.trim() || null,
    base_url: p.base_url.trim() || null,
    // Never send masked placeholders as a new key.
    api_key:
      draftKey && !draftKey.includes("•") && !draftKey.includes("*")
        ? draftKey
        : null,
    api_backend: p.api_backend.trim() || null,
    context_window: Number.isFinite(cw) && cw > 0 ? cw : Number(fallback.context_window),
    max_completion_tokens:
      Number.isFinite(maxTok) && maxTok > 0
        ? maxTok
        : Number(fallback.max_completion_tokens),
    enabled: p.enabled !== false,
    vendor_id: p.vendor_id?.trim() || null,
    capability: p.model_id.startsWith("__vendor__")
      ? null
      : resolveModelCapability(p.model_id, p.capability),
    performance_tier: p.model_id.startsWith("__vendor__")
      ? null
      : curatedPerformanceTiers(p.model_id)
        ? null
        : resolvePerformanceTier(p.model_id, p.performance_tier),
    remote_confirmed:
      typeof p.remote_confirmed === "boolean" ? p.remote_confirmed : null,
  };
}

/** @deprecated use newVendorPreset — kept for any leftover call sites */
export function newModelProfile(id?: string): ModelProfileRow {
  const model_id = id || `model-${Date.now()}`;
  const tokens = defaultTokensForKind("custom");
  return {
    model_id,
    name: model_id,
    base_url: "",
    api_key: "",
    has_api_key: false,
    api_backend: "chat_completions",
    context_window: tokens.context_window,
    max_completion_tokens: tokens.max_completion_tokens,
    enabled: true,
    capability: "llm",
  };
}

export type GrokEngineForm = {
  max_thoughts_width: number;
  fork_secondary_model: string;
  compact_mode: boolean;
  auto_update: boolean;
};

export function defaultGrokEngineForm(): GrokEngineForm {
  return {
    max_thoughts_width: 120,
    fork_secondary_model: "",
    compact_mode: false,
    auto_update: false,
  };
}

export function grokEngineFromPublic(
  raw?: Partial<GrokEngineForm> | null,
): GrokEngineForm {
  const d = defaultGrokEngineForm();
  if (!raw) return d;
  return {
    max_thoughts_width:
      typeof raw.max_thoughts_width === "number" && raw.max_thoughts_width > 0
        ? raw.max_thoughts_width
        : d.max_thoughts_width,
    fork_secondary_model: raw.fork_secondary_model ?? d.fork_secondary_model,
    compact_mode: raw.compact_mode ?? d.compact_mode,
    auto_update: raw.auto_update ?? d.auto_update,
  };
}
