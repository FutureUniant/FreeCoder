/**
 * Rich composer: plain text + inline path chips (Cursor-style).
 * Draft state lives here so keystrokes do NOT re-render the full App.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

export type PathChipData = {
  path: string;
  name: string;
  isDir: boolean;
};

export type ComposerPayload = {
  /** Visible text with path chips omitted. */
  text: string;
  pathChips: PathChipData[];
};

export type ComposerInputHandle = {
  getValue: () => string;
  getPayload: () => ComposerPayload;
  setValue: (v: string) => void;
  clear: () => void;
  focus: () => void;
  isEmpty: () => boolean;
  insertPathChip: (chip: PathChipData) => void;
};

type Props = {
  disabled?: boolean;
  placeholder?: string;
  onPaste?: (e: ClipboardEvent<HTMLDivElement>) => void;
  onSubmit?: () => void;
  onDraftChange?: (text: string) => void;
  onDraftSettled?: (text: string) => void;
  /** Probe a typed/pasted path; return chip data if it exists on disk. */
  onResolvePath?: (raw: string) => Promise<PathChipData | null>;
  convertLabel?: string;
  removeLabel?: string;
  className?: string;
};

const DRAFT_SETTLE_MS = 400;
const CHIP_ATTR = "data-composer-chip";
/** Structured path chips for same-app copy → paste (survives @label-only selection). */
export const CLIPBOARD_CHIPS_MIME = "application/x-grokx-path-chips";

/** Absolute / explicit relative paths worth probing. */
function looksLikePath(raw: string): boolean {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (s.length < 2 || /\n/.test(s)) return false;
  // Slash commands (`/goal`, `/compact …`) — not filesystem paths.
  // `/Users/…` still matches as a path (extra `/` after the first segment).
  if (/^\/[A-Za-z][\w-]*(?:\s|$)/.test(s)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (/^\\\\[^\\/\s]/.test(s)) return true;
  if (/^\/[^/\s]/.test(s)) return true;
  if (/^\.\.?[\\/]/.test(s)) return true;
  return false;
}

/** Split a leading filesystem path from trailing prompt text (chat copy). */
function splitLeadingPath(text: string): { path: string; rest: string } | null {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.trim()) return null;

  const nl = normalized.indexOf("\n");
  const firstLine = (nl >= 0 ? normalized.slice(0, nl) : normalized).trim();
  const afterNl = nl >= 0 ? normalized.slice(nl + 1) : "";

  if (looksLikePath(firstLine)) {
    return { path: firstLine.replace(/^["']|["']$/g, ""), rest: afterNl };
  }

  // Same line: `C:\folder 后面的问题`
  const spaced = firstLine.match(/^(.+?)(\s+)(.+)$/);
  if (spaced) {
    const cand = spaced[1].trim().replace(/^["']|["']$/g, "");
    if (looksLikePath(cand)) {
      const restSame = spaced[3];
      return {
        path: cand,
        rest: afterNl ? `${restSame}\n${afterNl}` : restSame,
      };
    }
  }
  return null;
}

function basenameOf(path: string): string {
  const leaf = path.replace(/[\\/]+$/, "").split(/[/\\]/).pop();
  return leaf || path;
}

function chipHtml(
  chip: PathChipData,
  labels: { convert: string; remove: string },
): string {
  const name = chip.name || basenameOf(chip.path);
  const label = `@${name}`;
  const kind = chip.isDir ? "folder" : "file";
  const icon = chip.isDir
    ? `<svg class="composer-path-chip-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`
    : `<svg class="composer-path-chip-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>`;
  return (
    `<span ${CHIP_ATTR}="1" contenteditable="false" data-path="${escapeAttr(
      chip.path,
    )}" data-name="${escapeAttr(name)}" data-isdir="${
      chip.isDir ? "1" : "0"
    }" data-kind="${kind}" class="composer-path-chip" title="${escapeAttr(
      chip.path,
    )}">` +
    `<span class="composer-path-chip-ico" aria-hidden="true">${icon}</span>` +
    `<span class="composer-path-chip-label">${escapeHtml(label)}</span>` +
    `<button type="button" class="composer-path-chip-convert" tabindex="-1" title="${escapeAttr(
      labels.convert,
    )}" aria-label="${escapeAttr(labels.convert)}">⇄</button>` +
    `<button type="button" class="composer-path-chip-remove" tabindex="-1" title="${escapeAttr(
      labels.remove,
    )}" aria-label="${escapeAttr(labels.remove)}">×</button>` +
    `</span>`
  );
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readChip(el: HTMLElement): PathChipData {
  return {
    path: el.getAttribute("data-path") || "",
    name: el.getAttribute("data-name") || "",
    isDir: el.getAttribute("data-isdir") === "1",
  };
}

function serializeRoot(root: HTMLElement): ComposerPayload {
  let text = "";
  const pathChips: PathChipData[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.textContent || "").replace(/\u00a0/g, " ");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.getAttribute(CHIP_ATTR) === "1") {
      const chip = readChip(node);
      if (chip.path) pathChips.push(chip);
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    // Block-ish breaks
    if (node.tagName === "DIV" || node.tagName === "P") {
      if (text.length && !text.endsWith("\n")) text += "\n";
    }
    node.childNodes.forEach(walk);
  };

  root.childNodes.forEach(walk);
  // Collapse a trailing lone newline from empty trailing div.
  if (text === "\n") text = "";
  // Contenteditable often injects ZWSP; strip so `/goal` stays parseable.
  text = text.replace(/^[\uFEFF\u200B\u200C\u200D\u2060]+/, "");
  return { text, pathChips };
}

function meterText(payload: ComposerPayload): string {
  if (!payload.pathChips.length) return payload.text;
  const paths = payload.pathChips.map((c) => c.path).join(" ");
  return payload.text ? `${payload.text} ${paths}` : paths;
}

function blockHasChip(el: HTMLElement): boolean {
  return !!el.querySelector(`[${CHIP_ATTR}="1"]`);
}

/** Visible text excluding path-chip labels (those are not typed content). */
function blockTypedText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`[${CHIP_ATTR}="1"]`).forEach((n) => n.remove());
  return (clone.textContent || "").replace(/\u00a0/g, " ").trim();
}

/**
 * Chromium contenteditable wraps lines in <div>/<p> and leaves empty
 * `<div><br></div>` after deleting text before a chip — which pushes the
 * chip onto a visual "second line". Prune that noise without fighting
 * normal typing caret positions.
 */
function normalizeComposerDom(root: HTMLElement) {
  // 1) Drop empty block wrappers (no chip, no typed text) — the usual
  //    leftover after deleting all text before an inline chip.
  const blocks = Array.from(root.querySelectorAll("div, p"));
  for (const block of blocks) {
    if (!(block instanceof HTMLElement)) continue;
    if (block.getAttribute(CHIP_ATTR) === "1") continue;
    if (blockHasChip(block)) continue;
    if (blockTypedText(block)) continue;
    block.remove();
  }

  // 2) If a block only wraps chip(s) (+ spacers), unwrap it so the chip
  //    sits on the same line as siblings instead of starting a new block.
  const chipOnlyBlocks = Array.from(root.querySelectorAll("div, p"));
  for (const block of chipOnlyBlocks) {
    if (!(block instanceof HTMLElement)) continue;
    if (!blockHasChip(block)) continue;
    if (blockTypedText(block)) continue; // real typed text stays in its block
    while (block.firstChild) {
      block.parentNode?.insertBefore(block.firstChild, block);
    }
    block.remove();
  }

  // 3) Strip leading <br> / whitespace-only text before a chip.
  while (root.firstChild) {
    const first = root.firstChild;
    if (first.nodeName === "BR") {
      root.removeChild(first);
      continue;
    }
    if (first.nodeType === Node.TEXT_NODE) {
      const raw = first.textContent || "";
      const next = first.nextSibling;
      const nextIsChip =
        next instanceof HTMLElement && next.getAttribute(CHIP_ATTR) === "1";
      if (!raw.replace(/\u00a0/g, " ").trim() && nextIsChip) {
        root.removeChild(first);
        continue;
      }
      if (/^[\n\r]+/.test(raw) && next) {
        const stripped = raw.replace(/^[\n\r]+/, "");
        if (!stripped) {
          root.removeChild(first);
          continue;
        }
        first.textContent = stripped;
        continue;
      }
      break;
    }
    break;
  }

  // 4) Chip-only editor: rebuild as a flat inline row (no blank first line).
  const chips = Array.from(
    root.querySelectorAll(`[${CHIP_ATTR}="1"]`),
  ) as HTMLElement[];
  if (chips.length === 0) return;

  const payload = serializeRoot(root);
  if (payload.text.replace(/\n/g, "").trim()) return;

  const alreadyFlat = Array.from(root.childNodes).every((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      return !/\n/.test(n.textContent || "");
    }
    return (
      n instanceof HTMLElement &&
      (n.getAttribute(CHIP_ATTR) === "1" || n.nodeName === "BR")
    );
  });
  const hasLeadingBr =
    root.firstChild?.nodeName === "BR" ||
    (root.firstChild?.nodeType === Node.TEXT_NODE &&
      /^[\n\r]/.test(root.firstChild.textContent || ""));
  if (alreadyFlat && !hasLeadingBr) return;

  const frag = document.createDocumentFragment();
  for (const chip of chips) {
    frag.appendChild(chip);
    frag.appendChild(document.createTextNode("\u00a0"));
  }
  root.innerHTML = "";
  root.appendChild(frag);
}

function placeCaretAfter(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Expand path chips in a DOM tree to full filesystem paths. */
export function plainTextWithExpandedPaths(root: Node): string {
  const wrap = document.createElement("div");
  wrap.appendChild(root.cloneNode(true));
  wrap.querySelectorAll(`[${CHIP_ATTR}="1"], [data-path]`).forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const path = el.getAttribute("data-path") || "";
    if (path) el.replaceWith(document.createTextNode(path));
  });
  return (wrap.innerText || wrap.textContent || "").replace(/\u00a0/g, " ");
}

function chipDataFromEl(el: HTMLElement): PathChipData | null {
  const path = (el.getAttribute("data-path") || "").trim();
  if (!path) return null;
  const name =
    (el.getAttribute("data-name") || "").trim() ||
    path.replace(/[\\/]+$/, "").split(/[/\\]/).pop() ||
    path;
  return {
    path,
    name,
    isDir: el.getAttribute("data-isdir") === "1",
  };
}

function pathChipsIntersectingSelection(
  container: HTMLElement,
): HTMLElement[] {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);

  const hit = Array.from(
    container.querySelectorAll("[data-path]"),
  ).filter((el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (!el.getAttribute("data-path")) return false;
    if (sel.isCollapsed) {
      const node = range.startContainer;
      const host =
        node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : (node as HTMLElement);
      return Boolean(host && (el === host || el.contains(host)));
    }
    try {
      return range.intersectsNode(el);
    } catch {
      return false;
    }
  }) as HTMLElement[];

  if (hit.length > 0) return hit;

  // Selection of text inside a chip/button often doesn't "intersect" the
  // element in cloneContents — walk closest().
  let node: Node | null = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const inside = (node as HTMLElement | null)?.closest?.("[data-path]");
  if (inside instanceof HTMLElement && container.contains(inside)) {
    return [inside];
  }
  return [];
}

export type PathChipCopyPayload = {
  plain: string;
  chips: PathChipData[];
};

/**
 * Build clipboard payload for a selection that includes path chips.
 * Returns null when the selection has no path chip.
 */
export function selectionCopyPayload(
  container: HTMLElement,
): PathChipCopyPayload | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const chipEls = pathChipsIntersectingSelection(container);
  if (!chipEls.length) return null;

  const chips: PathChipData[] = [];
  const seen = new Set<string>();
  for (const el of chipEls) {
    const c = chipDataFromEl(el);
    if (!c || seen.has(c.path)) continue;
    seen.add(c.path);
    chips.push(c);
  }
  if (!chips.length) return null;

  const range = sel.getRangeAt(0);

  // Selection entirely inside one chip (or collapsed on it) → just the path.
  if (chips.length === 1 && chipEls.length === 1) {
    const chip = chipEls[0];
    const fullyInside =
      sel.isCollapsed ||
      (chip.contains(range.startContainer) &&
        chip.contains(range.endContainer));
    if (fullyInside) {
      return { plain: chips[0].path, chips };
    }
  }

  const wrap = document.createElement("div");
  if (!sel.isCollapsed) {
    wrap.appendChild(range.cloneContents());
  }
  wrap.querySelectorAll("[data-path], [data-composer-chip]").forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const path = el.getAttribute("data-path") || "";
    if (path) el.replaceWith(document.createTextNode(path));
  });

  let plain = (wrap.innerText || wrap.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  // cloneContents of a <button> chip often yields only "@name" text nodes.
  for (const el of chipEls) {
    const c = chipDataFromEl(el);
    if (!c) continue;
    if (plain.includes(c.path)) continue;
    const rawLabel = (el.textContent || "").replace(/\s+/g, " ").trim();
    const variants = Array.from(
      new Set(
        (
          [
            rawLabel,
            rawLabel.replace(/^@/, ""),
            c.name ? `@${c.name}` : "",
            c.name,
          ] as string[]
        ).filter((x) => x && x.length > 0),
      ),
    );
    let replaced = false;
    for (const v of variants) {
      if (plain.includes(v)) {
        plain = plain.replace(v, c.path);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      // Chip + message: put path on its own first line.
      plain = plain ? `${c.path}\n${plain}` : c.path;
    }
  }

  if (!plain.trim()) {
    plain = chips.map((c) => c.path).join("\n");
  }

  return { plain, chips };
}

/** @deprecated use selectionCopyPayload — kept for callers that only need plain text. */
export function selectionPlainWithPaths(container: HTMLElement): string | null {
  return selectionCopyPayload(container)?.plain ?? null;
}

function insertNodeAtCaret(node: Node, root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
    root.appendChild(node);
    // spacer text so caret can sit after chip
    const spacer = document.createTextNode("\u00a0");
    root.appendChild(spacer);
    placeCaretAfter(spacer);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  const spacer = document.createTextNode("\u00a0");
  node.parentNode?.insertBefore(spacer, node.nextSibling);
  placeCaretAfter(spacer);
}

/** Token immediately before caret that might be a filesystem path. */
function pathTokenBeforeCaret(root: HTMLElement): {
  token: string;
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
} | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;

  let node: Node | null = range.startContainer;
  let offset = range.startOffset;

  // If caret is in element, step into previous text.
  if (node.nodeType !== Node.TEXT_NODE) {
    const el = node as HTMLElement;
    if (offset === 0) return null;
    const prev = el.childNodes[offset - 1];
    if (!prev || prev.nodeType !== Node.TEXT_NODE) return null;
    node = prev;
    offset = prev.textContent?.length ?? 0;
  }

  const text = node.textContent || "";
  const before = text.slice(0, offset);

  // Prefer quoted paths (supports spaces).
  const quoted = before.match(/(?:^|[\s([{])"([^"]+)"$/);
  const quotedSq = before.match(/(?:^|[\s([{])'([^']+)'$/);
  let raw = "";
  let matched = "";
  if (quoted) {
    raw = quoted[1];
    matched = `"${quoted[1]}"`;
  } else if (quotedSq) {
    raw = quotedSq[1];
    matched = `'${quotedSq[1]}'`;
  } else {
    const m = before.match(/(?:^|[\s([{])([^\s([{]+)$/);
    if (!m) return null;
    raw = (m[1] || "").replace(/[,.;:!?)\]]+$/, "");
    matched = raw;
  }

  if (!looksLikePath(raw)) return null;

  const tokenStartInBefore = before.lastIndexOf(matched);
  if (tokenStartInBefore < 0) return null;

  return {
    token: raw,
    startContainer: node,
    startOffset: tokenStartInBefore,
    endContainer: node,
    endOffset: tokenStartInBefore + matched.length,
  };
}

export const ComposerInput = memo(
  forwardRef<ComposerInputHandle, Props>(function ComposerInput(
    {
      disabled,
      placeholder,
      onPaste,
      onSubmit,
      onDraftChange,
      onDraftSettled,
      onResolvePath,
      convertLabel = "Convert to path text",
      removeLabel = "Remove",
      className,
    },
    ref,
  ) {
    const edRef = useRef<HTMLDivElement | null>(null);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resolvingRef = useRef(false);
    const labelsRef = useRef({ convert: convertLabel, remove: removeLabel });
    labelsRef.current = { convert: convertLabel, remove: removeLabel };
    const onDraftChangeRef = useRef(onDraftChange);
    const onDraftSettledRef = useRef(onDraftSettled);
    const onResolvePathRef = useRef(onResolvePath);
    onDraftChangeRef.current = onDraftChange;
    onDraftSettledRef.current = onDraftSettled;
    onResolvePathRef.current = onResolvePath;

    const resize = useCallback(() => {
      const el = edRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(Math.max(el.scrollHeight, 48), 160)}px`;
    }, []);

    const syncEmptyClass = useCallback(() => {
      const el = edRef.current;
      if (!el) return;
      normalizeComposerDom(el);
      const payload = serializeRoot(el);
      const empty = !payload.text.trim() && payload.pathChips.length === 0;
      el.classList.toggle("is-empty", empty);
      return { payload, empty, meter: meterText(payload) };
    }, []);

    const notify = useCallback(() => {
      const state = syncEmptyClass();
      if (!state) return;
      onDraftChangeRef.current?.(state.meter);
      if (!onDraftSettledRef.current) return;
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        const again = syncEmptyClass();
        if (again) onDraftSettledRef.current?.(again.meter);
      }, DRAFT_SETTLE_MS);
      resize();
    }, [resize, syncEmptyClass]);

    const makeChipElement = useCallback((chip: PathChipData): HTMLElement => {
      const wrap = document.createElement("div");
      wrap.innerHTML = chipHtml(chip, labelsRef.current);
      return wrap.firstElementChild as HTMLElement;
    }, []);

    const tryConvertToken = useCallback(async () => {
      const el = edRef.current;
      const resolve = onResolvePathRef.current;
      if (!el || !resolve || resolvingRef.current || disabled) return;

      const hit = pathTokenBeforeCaret(el);
      if (!hit) return;

      resolvingRef.current = true;
      try {
        const chip = await resolve(hit.token);
        if (!chip?.path) return;
        // Caret / token may have moved while awaiting.
        const again = pathTokenBeforeCaret(el);
        if (!again || again.token !== hit.token) return;

        const range = document.createRange();
        range.setStart(again.startContainer, again.startOffset);
        range.setEnd(again.endContainer, again.endOffset);
        range.deleteContents();

        const node = makeChipElement(chip);
        range.insertNode(node);
        const spacer = document.createTextNode("\u00a0");
        node.parentNode?.insertBefore(spacer, node.nextSibling);
        placeCaretAfter(spacer);
        notify();
      } catch {
        /* ignore probe failures */
      } finally {
        resolvingRef.current = false;
      }
    }, [disabled, makeChipElement, notify]);

    const scheduleResolve = useCallback(() => {
      if (!onResolvePathRef.current) return;
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
      resolveTimer.current = setTimeout(() => {
        void tryConvertToken();
      }, 280);
    }, [tryConvertToken]);

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => {
          const el = edRef.current;
          if (!el) return "";
          return meterText(serializeRoot(el));
        },
        getPayload: () => {
          const el = edRef.current;
          if (!el) return { text: "", pathChips: [] };
          return serializeRoot(el);
        },
        setValue: (v: string) => {
          const el = edRef.current;
          if (!el) return;
          el.textContent = v;
          notify();
          placeCaretAtEnd(el);
        },
        clear: () => {
          const el = edRef.current;
          if (!el) return;
          el.innerHTML = "";
          notify();
        },
        focus: () => edRef.current?.focus(),
        isEmpty: () => {
          const el = edRef.current;
          if (!el) return true;
          const p = serializeRoot(el);
          return !p.text.trim() && p.pathChips.length === 0;
        },
        insertPathChip: (chip: PathChipData) => {
          const el = edRef.current;
          if (!el || !chip.path) return;
          el.focus();
          // Dedupe: if same path chip already present, skip.
          const existing = el.querySelector(
            `[${CHIP_ATTR}="1"][data-path="${CSS.escape(chip.path)}"]`,
          );
          if (existing) {
            placeCaretAfter(existing);
            return;
          }
          insertNodeAtCaret(makeChipElement(chip), el);
          notify();
        },
      }),
      [makeChipElement, notify],
    );

    useEffect(() => {
      const el = edRef.current;
      if (!el) return;
      // Prefer <br> over <div> for soft line breaks (Shift+Enter).
      try {
        document.execCommand("defaultParagraphSeparator", false, "br");
      } catch {
        /* ignore */
      }
      syncEmptyClass();
      resize();
    }, [syncEmptyClass, resize, placeholder]);

    const onInput = (_e: FormEvent<HTMLDivElement>) => {
      notify();
      scheduleResolve();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // Convert pending path token before send when possible.
        void (async () => {
          await tryConvertToken();
          onSubmit?.();
        })();
        return;
      }

      if (e.key === " " || e.key === "Tab") {
        // Let space insert, then convert previous token.
        requestAnimationFrame(() => {
          void tryConvertToken();
        });
      }

      // Backspace: if caret is right after a chip, remove the chip.
      if (e.key === "Backspace") {
        const sel = window.getSelection();
        const root = edRef.current;
        if (!sel || !sel.isCollapsed || !root) return;
        const range = sel.getRangeAt(0);
        let node: Node | null = range.startContainer;
        let offset = range.startOffset;

        let chip: HTMLElement | null = null;
        if (node.nodeType === Node.TEXT_NODE && offset === 0) {
          const prev = node.previousSibling;
          if (prev instanceof HTMLElement && prev.getAttribute(CHIP_ATTR) === "1") {
            chip = prev;
          }
        } else if (node === root && offset > 0) {
          const prev = root.childNodes[offset - 1];
          if (prev instanceof HTMLElement && prev.getAttribute(CHIP_ATTR) === "1") {
            chip = prev;
          }
        } else if (
          node instanceof HTMLElement &&
          offset > 0 &&
          node.childNodes[offset - 1] instanceof HTMLElement
        ) {
          const prev = node.childNodes[offset - 1] as HTMLElement;
          if (prev.getAttribute(CHIP_ATTR) === "1") chip = prev;
        }

        if (chip) {
          e.preventDefault();
          const parent = chip.parentNode;
          const idx = parent
            ? Array.prototype.indexOf.call(parent.childNodes, chip)
            : -1;
          chip.remove();
          if (parent && idx >= 0) {
            const sel2 = window.getSelection();
            if (sel2) {
              const r2 = document.createRange();
              if (idx < parent.childNodes.length) {
                const at = parent.childNodes[idx];
                if (at.nodeType === Node.TEXT_NODE) {
                  r2.setStart(at, 0);
                } else {
                  r2.setStartBefore(at);
                }
              } else {
                r2.selectNodeContents(parent);
                r2.collapse(false);
              }
              r2.collapse(true);
              sel2.removeAllRanges();
              sel2.addRange(r2);
            }
          } else {
            placeCaretAtEnd(root);
          }
          notify();
        }
      }
    };

    const onEditorClick = (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const convertBtn = target.closest(".composer-path-chip-convert");
      const removeBtn = target.closest(".composer-path-chip-remove");
      const chipEl = target.closest(`[${CHIP_ATTR}="1"]`) as HTMLElement | null;
      if (!chipEl || !edRef.current?.contains(chipEl)) return;

      if (removeBtn) {
        e.preventDefault();
        e.stopPropagation();
        chipEl.remove();
        notify();
        edRef.current?.focus();
        return;
      }

      if (convertBtn) {
        e.preventDefault();
        e.stopPropagation();
        const chip = readChip(chipEl);
        const text = document.createTextNode(chip.path);
        chipEl.replaceWith(text);
        placeCaretAfter(text);
        notify();
        edRef.current?.focus();
      }
    };

    const insertPlainText = (text: string) => {
      const el = edRef.current;
      if (!el) return;
      // Prefer insertText so undo stack stays sane.
      try {
        document.execCommand("insertText", false, text);
      } catch {
        insertNodeAtCaret(document.createTextNode(text), el);
      }
    };

    const onEditorCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
      const el = edRef.current;
      if (!el) return;
      const payload = selectionCopyPayload(el);
      if (!payload) return;
      e.clipboardData.setData("text/plain", payload.plain);
      e.clipboardData.setData(
        CLIPBOARD_CHIPS_MIME,
        JSON.stringify(payload.chips),
      );
      e.preventDefault();
    };

    const onEditorPaste = (e: ClipboardEvent<HTMLDivElement>) => {
      // Let parent handle image/file clipboard items.
      onPaste?.(e);
      if (e.defaultPrevented) return;

      const structured = e.clipboardData?.getData(CLIPBOARD_CHIPS_MIME) ?? "";
      const raw = e.clipboardData?.getData("text/plain") ?? "";
      const text = raw.replace(/\r\n/g, "\n");

      // Preferred: restore chips from structured clipboard (copy from chat/composer).
      if (structured) {
        let chips: PathChipData[] = [];
        try {
          const parsed = JSON.parse(structured) as PathChipData[];
          if (Array.isArray(parsed)) chips = parsed.filter((c) => c?.path);
        } catch {
          chips = [];
        }
        if (chips.length) {
          e.preventDefault();
          const el = edRef.current;
          if (!el) return;
          let rest = text;
          for (const c of chips) {
            insertNodeAtCaret(makeChipElement(c), el);
            rest = rest.split(c.path).join("");
          }
          rest = rest.replace(/^\n+/, "").replace(/\n+$/, "");
          if (rest.trim()) insertPlainText(rest);
          notify();
          return;
        }
      }

      if (!text.trim() || !onResolvePathRef.current) return;

      const split = splitLeadingPath(text);
      if (!split) return;

      e.preventDefault();
      void (async () => {
        const chip = await onResolvePathRef.current?.(split.path);
        const el = edRef.current;
        if (!el) return;
        if (chip?.path) {
          insertNodeAtCaret(makeChipElement(chip), el);
          if (split.rest) insertPlainText(split.rest);
        } else {
          insertPlainText(text);
        }
        notify();
      })();
    };

    return (
      <div
        ref={edRef}
        className={`composer-rich${className ? ` ${className}` : ""} is-empty`}
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={placeholder}
        data-placeholder={placeholder || ""}
        suppressContentEditableWarning
        onInput={onInput}
        onKeyDown={onKeyDown}
        onMouseDown={onEditorClick}
        onCopy={onEditorCopy}
        onPaste={onEditorPaste}
        onBlur={() => {
          void tryConvertToken();
        }}
      />
    );
  }),
);

ComposerInput.displayName = "ComposerInput";
