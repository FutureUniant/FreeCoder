export type UiLocale = "zh-CN" | "en";

export function normalizeLocale(raw?: string | null): UiLocale {
  const v = (raw || "").trim();
  if (v === "en" || v === "en-US" || v === "en-GB" || v === "english") return "en";
  return "zh-CN";
}

export const LOCALE_STORAGE_KEY = "grokx.ui.language";
