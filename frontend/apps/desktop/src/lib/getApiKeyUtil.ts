import { invoke } from "@tauri-apps/api/core";

/** Extract a plausible API key from free-form text. */
export function pickKeyFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = String(text).match(/sk-(?:ws-|sp-)?[A-Za-z0-9._-]{16,}/);
  if (!m) return null;
  const key = m[0].trim();
  if (
    key.includes("*") ||
    key.includes("•") ||
    key.includes("…") ||
    key.includes("...")
  ) {
    return null;
  }
  return key;
}

/** Read API key from OS clipboard (Tauri arboard first, then navigator). */
export async function readKeyFromClipboard(): Promise<string | null> {
  try {
    const text = await invoke<string | null>("read_clipboard_text");
    const key = pickKeyFromText(text);
    if (key) return key;
  } catch (e) {
    console.warn("read_clipboard_text failed:", e);
  }

  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      const key = pickKeyFromText(text);
      if (key) return key;
    }
  } catch (e) {
    console.warn("navigator.clipboard blocked or failed:", e);
  }

  return null;
}

export type GetKeyPlatformId = "deepseek" | "bailian";

export function vendorKindToGetKeyPlatform(
  kind: string,
): GetKeyPlatformId | null {
  if (kind === "deepseek" || kind === "bailian") return kind;
  return null;
}
