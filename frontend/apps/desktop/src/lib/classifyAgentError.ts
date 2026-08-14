/** Product app error codes (aligned with grok-build `sampling/app_error.rs`). */

export type AppErrorCode =
  | "NETWORK"
  | "CONTEXT_OVERFLOW"
  | "VISION_REQUIRED"
  | "WEB_SEARCH_UNAVAILABLE"
  | "RATE_LIMIT"
  | "AUTH"
  | "INTERNAL";

const TAG_RE = /\[APP_CODE:([A-Z0-9_]+)\]/;

export function extractAppCodeTag(message: string): AppErrorCode | null {
  const m = TAG_RE.exec(message || "");
  if (!m) return null;
  return normalizeAppCode(m[1]);
}

export function stripAppCodeTag(message: string): string {
  return (message || "").replace(TAG_RE, "").trim();
}

export function normalizeAppCode(raw?: string | null): AppErrorCode | null {
  const c = (raw || "").trim().toUpperCase();
  switch (c) {
    case "NETWORK":
    case "CONTEXT_OVERFLOW":
    case "VISION_REQUIRED":
    case "WEB_SEARCH_UNAVAILABLE":
    case "RATE_LIMIT":
    case "AUTH":
    case "INTERNAL":
      return c;
    default:
      return null;
  }
}

/** Classify from explicit code, message tag, or known substrings (fallback). */
export function classifyAgentError(
  message: string,
  explicitCode?: string | null,
): { code: AppErrorCode; displaySource: string } {
  const fromExplicit = normalizeAppCode(explicitCode);
  if (fromExplicit) {
    return { code: fromExplicit, displaySource: stripAppCodeTag(message) };
  }
  const fromTag = extractAppCodeTag(message);
  if (fromTag) {
    return { code: fromTag, displaySource: stripAppCodeTag(message) };
  }

  const raw = message || "";
  const m = raw.toLowerCase();

  if (
    raw.includes("BAILIAN_API_KEY_REQUIRED") ||
    m.includes("dashscope_api_key") ||
    (m.includes("bailian") && (m.includes("api key") || m.includes("api_key")))
  ) {
    return { code: "WEB_SEARCH_UNAVAILABLE", displaySource: raw };
  }
  if (
    m.includes("exceed_context") ||
    m.includes("context_size") ||
    m.includes("context length") ||
    m.includes("context_window") ||
    m.includes("maximum context") ||
    m.includes("too many tokens") ||
    m.includes("prompt is too long")
  ) {
    return { code: "CONTEXT_OVERFLOW", displaySource: raw };
  }
  if (
    m.includes("connection refused") ||
    m.includes("connection reset") ||
    m.includes("network unreachable") ||
    m.includes("failed to connect") ||
    m.includes("dns") ||
    m.includes("tls handshake") ||
    m.includes("error sending request")
  ) {
    return { code: "NETWORK", displaySource: raw };
  }
  if (m.includes("rate limit") || m.includes("too many requests") || m.includes("-32003")) {
    return { code: "RATE_LIMIT", displaySource: raw };
  }
  if (
    (m.includes("vision") || m.includes("image input") || m.includes("multimodal")) &&
    (m.includes("not support") || m.includes("cannot") || m.includes("unable"))
  ) {
    return { code: "VISION_REQUIRED", displaySource: raw };
  }
  // Text-only chat APIs (e.g. DeepSeek) reject OpenAI-style image parts.
  if (
    m.includes("image_url") &&
    (m.includes("unknown variant") ||
      m.includes("expected `text`") ||
      m.includes("expected \"text\"") ||
      m.includes("deserialize"))
  ) {
    return { code: "VISION_REQUIRED", displaySource: raw };
  }
  if (m.includes("unauthorized") || (m.includes("auth") && m.includes("401"))) {
    return { code: "AUTH", displaySource: raw };
  }

  return { code: "INTERNAL", displaySource: raw };
}
