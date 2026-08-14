/**
 * Cross-frame DOM helpers. Aliyun consoles often put UI inside iframes;
 * also avoid waiting full timeout on each comma-separated selector.
 */

/** @param {import('playwright').Page} page */
export function allFrames(page) {
  return page.frames();
}

function splitSelectors(selector) {
  return String(selector || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Wait until ANY selector is visible in ANY frame, within total timeoutMs.
 */
export async function waitFirst(page, selector, timeoutMs = 15000) {
  const parts = splitSelectors(selector);
  const deadline = Date.now() + timeoutMs;
  let lastErr;

  while (Date.now() < deadline) {
    const slice = Math.min(1200, Math.max(300, deadline - Date.now()));
    for (const frame of allFrames(page)) {
      for (const sel of parts) {
        try {
          const loc = frame.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) {
            return { frame, selector: sel, locator: loc };
          }
          // quick probe
          await loc.waitFor({ state: "visible", timeout: Math.min(250, slice) });
          return { frame, selector: sel, locator: loc };
        } catch (e) {
          lastErr = e;
        }
      }
    }
    // text fallbacks for common buttons
    for (const frame of allFrames(page)) {
      for (const text of textCandidatesFromSelector(selector)) {
        try {
          const loc = frame.getByRole("button", { name: text }).first();
          if (await loc.isVisible().catch(() => false)) {
            return { frame, selector: `text=${text}`, locator: loc };
          }
        } catch (e) {
          lastErr = e;
        }
      }
    }
    await page.waitForTimeout(150);
  }

  throw lastErr || new Error(`等待元素超时（${timeoutMs}ms）: ${selector}`);
}

function textCandidatesFromSelector(selector) {
  const texts = [];
  const re = /has-text\("([^"]+)"\)/g;
  let m;
  while ((m = re.exec(selector))) texts.push(m[1]);
  return [...new Set(texts)];
}

export async function clickFirst(page, selector, timeoutMs = 12000) {
  const { locator } = await waitFirst(page, selector, timeoutMs);
  await locator.click({ timeout: 5000 });
}

export async function fillFirst(page, selector, value, timeoutMs = 8000) {
  try {
    const { locator } = await waitFirst(page, selector, timeoutMs);
    await locator.fill(value, { timeout: 5000 });
    return;
  } catch (_) {
    // try textarea in visible modal across frames
    for (const frame of allFrames(page)) {
      try {
        const ta = frame.locator("textarea:visible").first();
        if (await ta.isVisible().catch(() => false)) {
          await ta.fill(value, { timeout: 3000 });
          return;
        }
      } catch (_) {}
    }
    throw new Error(`无法填写: ${selector}`);
  }
}

function confirmNameRegex(step = {}) {
  const texts = Array.isArray(step.confirm_texts) ? step.confirm_texts : null;
  if (texts?.length) {
    const body = texts
      .map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    return new RegExp(`^(${body})$`, "i");
  }
  return /^(确定|确认|OK|创建|Create|Create key|Create API key)$/i;
}

/**
 * Click primary confirm in a visible modal (any frame).
 * 火山方舟创建弹窗底部是精确「创建」，不能点到页面上的「创建 API Key」。
 */
export async function clickModalConfirm(page, step = {}) {
  const timeout = step.timeout_ms || 10000;
  const deadline = Date.now() + timeout;
  const confirmReSource = confirmNameRegex(step).source;
  let lastErr;

  while (Date.now() < deadline) {
    for (const frame of allFrames(page)) {
      try {
        // 优先：在可见弹窗里找精确文案按钮（火山 =「创建」）
        const clicked = await frame.evaluate((reSource) => {
          const confirmRe = new RegExp(reSource, "i");
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            if (el.classList?.contains("arco-modal-wrapper-hide")) return false;
            const rect = el.getBoundingClientRect?.();
            return !rect || (rect.width > 20 && rect.height > 20);
          };
          const roots = [
            ...document.querySelectorAll(
              ".arco-modal-wrapper, .arco-modal, .ant-modal-wrap, .ant-modal, [role='dialog'], .next-dialog, .semi-modal"
            ),
          ];
          for (const root of roots.reverse()) {
            if (!isVisible(root)) continue;
            const text = (root.innerText || "").slice(0, 800);
            // 创建表单弹窗 / 成功弹窗都算
            const looksLikeKeyModal =
              /创建\s*API\s*Key|API\s*Key|所属项目|权限|名称|复制|sk-/i.test(text);
            if (!looksLikeKeyModal && roots.length > 1) continue;

            const buttons = [...root.querySelectorAll("button, .arco-btn, [role='button']")];
            // 1) 精确确认文案
            const exact = buttons.find((b) => {
              if (!isVisible(b)) return false;
              const name = (b.textContent || "").replace(/\s+/g, " ").trim();
              return confirmRe.test(name);
            });
            if (exact) {
              exact.click();
              return { ok: true, how: exact.textContent?.trim() || "exact" };
            }
            // 2) footer primary，但排除「创建 API Key」
            const footer =
              root.querySelector(".arco-modal-footer, .ant-modal-footer, [class*='footer']") ||
              root;
            const primary = [
              ...footer.querySelectorAll(
                "button.arco-btn-primary, button.ant-btn-primary, button[type='button']"
              ),
            ].find((b) => {
              if (!isVisible(b)) return false;
              const name = (b.textContent || "").replace(/\s+/g, " ").trim();
              if (/取消|关闭|Cancel|Close/i.test(name)) return false;
              if (/API\s*Key|密钥/i.test(name) && name.length > 4) return false;
              return true;
            });
            if (primary) {
              primary.click();
              return { ok: true, how: primary.textContent?.trim() || "primary" };
            }
          }
          return { ok: false };
        }, confirmReSource);

        if (clicked?.ok) {
          await page.waitForTimeout(600);
          return;
        }
      } catch (e) {
        lastErr = e;
      }

      // Playwright 兜底：只在 dialog 作用域内点「创建/确定」
      try {
        const dialog = frame.locator(
          ".arco-modal-wrapper:not(.arco-modal-wrapper-hide) .arco-modal, .arco-modal:visible, .ant-modal:visible, [role='dialog']:visible"
        );
        const btn = dialog
          .getByRole("button", { name: confirmNameRegex(step) })
          .last();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(600);
          return;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    await page.waitForTimeout(150);
  }

  throw lastErr || new Error("无法点击弹窗确认按钮（创建/确定）");
}

/**
 * Dismiss blocking overlays (e.g. DeepSeek「绑定邮箱」) before other clicks.
 * Prefer "稍后再填", then close/X, then Escape.
 */
export async function dismissBlockingModal(page, step = {}) {
  const timeout = step.timeout_ms || 4000;
  const deadline = Date.now() + timeout;
  const texts = step.texts?.length
    ? step.texts
    : ["稍后再填", "Fill in later", "以后再说", "跳过", "暂不绑定", "Not now", "Skip"];
  const closeSelectors = step.selectors?.length
    ? step.selectors
    : [
        ".ds-modal-wrapper [aria-label='Close']",
        ".ds-modal-wrapper [aria-label='关闭']",
        ".ds-modal-wrapper .ds-modal-close",
        ".ds-modal-wrapper button:has(svg)",
        "[role='dialog'] [aria-label='Close']",
        "[role='dialog'] .ant-modal-close",
      ];

  let dismissed = false;

  while (Date.now() < deadline) {
    for (const frame of allFrames(page)) {
      // 1) 文案按钮：稍后再填
      for (const text of texts) {
        try {
          const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const candidates = [
            frame.getByRole("button", { name: text, exact: true }),
            frame.getByRole("button", { name: new RegExp(`^${escaped}$`, "i") }),
            frame.locator(`.ds-modal-wrapper [role="button"]:has-text("${text}")`),
            frame.locator(`[role="dialog"] [role="button"]:has-text("${text}")`),
            frame.locator(`button:has-text("${text}")`),
            frame.locator(`[role="button"]:has-text("${text}")`),
          ];
          for (const loc of candidates) {
            const el = loc.first();
            if (await el.isVisible().catch(() => false)) {
              await el.click({ timeout: 2000, force: true }).catch(async () => {
                await el.evaluate((node) => node.click());
              });
              dismissed = true;
              break;
            }
          }
          if (dismissed) break;
        } catch (_) {}
      }
      if (dismissed) break;

      // 2) 关闭按钮
      for (const sel of closeSelectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 1500, force: true }).catch(async () => {
              await el.evaluate((node) => node.click());
            });
            dismissed = true;
            break;
          }
        } catch (_) {}
      }
      if (dismissed) break;

      // 3) 若仍有 ds-modal-wrapper，直接移除遮罩（兜底）
      try {
        const removed = await frame.evaluate(() => {
          const wrappers = [
            ...document.querySelectorAll(
              ".ds-modal-wrapper, .ds-theme.ds-modal-wrapper"
            ),
          ];
          let n = 0;
          for (const w of wrappers) {
            const style = window.getComputedStyle(w);
            if (style.display === "none" || style.visibility === "hidden") continue;
            w.remove();
            n += 1;
          }
          return n;
        });
        if (removed > 0) dismissed = true;
      } catch (_) {}
    }

    if (dismissed) {
      await page.waitForTimeout(400);
      // 确认遮罩已消失；若还在再试一次 Escape
      const stillThere = await page
        .locator(".ds-modal-wrapper")
        .first()
        .isVisible()
        .catch(() => false);
      if (!stillThere) return true;
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      return true;
    }

    await page.waitForTimeout(120);
  }

  // 无弹窗也算成功（optional 步骤）
  return false;
}

/** Click button by visible text across frames (fast path). */
export async function clickButtonByText(page, texts, timeoutMs = 12000) {
  const list = Array.isArray(texts) ? texts : [texts];
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  let triedDismiss = false;

  while (Date.now() < deadline) {
    for (const frame of allFrames(page)) {
      for (const text of list) {
        try {
          // exact / contains；火山/阿里云控制台按钮可能是 span 包在 button 里
          const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const candidates = [
            frame.getByRole("button", { name: text, exact: true }),
            frame.getByRole("button", { name: new RegExp(escaped, "i") }),
            frame.locator(`button:has-text("${text}")`),
            frame.locator(`a:has-text("${text}")`),
            frame.locator(`[role="button"]:has-text("${text}")`),
            frame.locator(`.arco-btn:has-text("${text}")`),
            frame.locator(`span:text-is("${text}")`),
          ];
          for (const loc of candidates) {
            const el = loc.first();
            if (await el.isVisible().catch(() => false)) {
              await el.click({ timeout: 3000 });
              return;
            }
          }
        } catch (e) {
          lastErr = e;
          const msg = String(e?.message || e);
          // 被弹窗挡住时先关掉再重试
          if (!triedDismiss && /intercepts pointer events|ds-modal-wrapper/i.test(msg)) {
            triedDismiss = true;
            await dismissBlockingModal(page, { timeout_ms: 3500 });
          }
        }
      }
    }
    await page.waitForTimeout(120);
  }
  throw lastErr || new Error(`未找到按钮: ${list.join(" / ")}`);
}

/**
 * Detect logged-in console by visible button/link texts across frames.
 * Used by wait_login to auto-continue without a manual 「继续」 click.
 */
export async function pageHasAnyButtonText(page, texts) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  if (list.length === 0) return false;

  for (const frame of allFrames(page)) {
    for (const text of list) {
      try {
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const candidates = [
          frame.getByRole("button", { name: text, exact: true }),
          frame.getByRole("button", { name: new RegExp(`^\\s*${escaped}\\s*$`, "i") }),
          frame.locator(`button:has-text("${text}")`),
          frame.locator(`[role="button"]:has-text("${text}")`),
          frame.locator(`.arco-btn:has-text("${text}")`),
          frame.locator(`.ant-btn:has-text("${text}")`),
        ];
        for (const loc of candidates) {
          const el = loc.first();
          if (await el.isVisible().catch(() => false)) {
            return true;
          }
        }
      } catch (_) {
        /* try next */
      }
    }
  }
  return false;
}

/** Same as pageHasAnyButtonText but requires an enabled (clickable) control. */
export async function pageHasEnabledButtonText(page, texts) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  if (list.length === 0) return false;

  for (const frame of allFrames(page)) {
    for (const text of list) {
      try {
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const candidates = [
          frame.getByRole("button", { name: text, exact: true }),
          frame.getByRole("button", { name: new RegExp(`^\\s*${escaped}\\s*$`, "i") }),
          frame.locator(`button:has-text("${text}")`),
          frame.locator(`[role="button"]:has-text("${text}")`),
          frame.locator(`.arco-btn:has-text("${text}")`),
          frame.locator(`.ant-btn:has-text("${text}")`),
        ];
        for (const loc of candidates) {
          const el = loc.first();
          if (!(await el.isVisible().catch(() => false))) continue;
          const disabled = await el.isDisabled().catch(() => false);
          if (disabled) continue;
          const ariaDisabled = await el.getAttribute("aria-disabled").catch(() => null);
          if (ariaDisabled === "true") continue;
          const cls = (await el.getAttribute("class").catch(() => "")) || "";
          if (/disabled|is-disabled|btn-disabled/i.test(cls)) continue;
          return true;
        }
      } catch (_) {
        /* try next */
      }
    }
  }
  return false;
}

/** True if any deny text appears as visible UI copy (login form etc.). */
export async function pageHasDenySignals(page, denyTexts) {
  const list = (Array.isArray(denyTexts) ? denyTexts : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  if (list.length === 0) return false;

  for (const frame of allFrames(page)) {
    try {
      const hit = await frame.evaluate((needles) => {
        const body = (document.body?.innerText || "").replace(/\s+/g, " ");
        return needles.some((t) => body.includes(t));
      }, list);
      if (hit) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

/** Visible body/copy markers (logged-in console pages). */
export async function pageHasReadyMarkers(page, markers, urlExcludes = []) {
  const list = (Array.isArray(markers) ? markers : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  if (list.length === 0) return false;

  for (const frame of allFrames(page)) {
    try {
      const fu = (frame.url() || "").toLowerCase();
      if (urlExcludes.some((ex) => ex && fu.includes(String(ex).toLowerCase()))) {
        continue;
      }
      const hit = await frame.evaluate((needles) => {
        const body = (document.body?.innerText || "").replace(/\s+/g, " ");
        return needles.some((t) => body.includes(t));
      }, list);
      if (hit) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

/**
 * Login-ready check for wait_login.
 * Positive signals: enabled create button/link OR ready_markers on page.
 * Negative: login hosts / login-form deny texts.
 */
export async function isLoginReady(page, step = {}) {
  let url = "";
  try {
    url = page.url() || "";
  } catch (_) {
    return { ready: false, reason: "no-url" };
  }

  const urlExcludes = step.url_excludes || [
    "login.aliyun.com",
    "passport.aliyun.com",
    "account.aliyun.com",
    "signin.",
  ];

  const frameUrls = [];
  try {
    for (const frame of allFrames(page)) {
      try {
        frameUrls.push(frame.url() || "");
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ignore */
  }

  const allUrls = [url, ...frameUrls];
  for (const u of allUrls) {
    const lower = String(u || "").toLowerCase();
    for (const ex of urlExcludes) {
      if (ex && lower.includes(String(ex).toLowerCase())) {
        return { ready: false, reason: `login-url:${ex}` };
      }
    }
  }

  const urlIncludes = step.url_includes || [];
  if (
    urlIncludes.length > 0 &&
    !urlIncludes.some((u) => url.toLowerCase().includes(String(u).toLowerCase()))
  ) {
    return { ready: false, reason: "url-not-allowed" };
  }

  const pathIncludes = step.url_path_includes || [];
  if (pathIncludes.length > 0) {
    let pathOk = false;
    try {
      const path = new URL(url).pathname + (new URL(url).hash || "");
      pathOk = pathIncludes.some((p) =>
        path.toLowerCase().includes(String(p).toLowerCase()),
      );
    } catch (_) {
      pathOk = pathIncludes.some((p) =>
        url.toLowerCase().includes(String(p).toLowerCase()),
      );
    }
    if (!pathOk) {
      return { ready: false, reason: "wrong-path" };
    }
  }

  if (await pageHasDenySignals(page, step.deny_texts || [])) {
    return { ready: false, reason: "deny-text" };
  }

  const texts = step.texts || [];
  const markers = step.ready_markers || [];
  if (texts.length === 0 && markers.length === 0 && !step.selector) {
    return { ready: false, reason: "no-signals" };
  }

  const safeFrames = allFrames(page).filter((frame) => {
    try {
      const fu = (frame.url() || "").toLowerCase();
      return !urlExcludes.some((ex) => ex && fu.includes(String(ex).toLowerCase()));
    } catch (_) {
      return true;
    }
  });

  const wantEnabled = step.require_enabled !== false;
  if (texts.length > 0) {
    const hit = wantEnabled
      ? await framesHaveEnabledButtonText(safeFrames, texts)
      : await framesHaveAnyButtonText(safeFrames, texts);
    if (hit) return { ready: true, reason: "create-button" };
  }

  if (markers.length > 0) {
    const hit = await pageHasReadyMarkers(page, markers, urlExcludes);
    if (hit) return { ready: true, reason: "ready-marker" };
  }

  if (step.selector) {
    try {
      const found = await waitFirst(page, step.selector, 600);
      if (found) {
        const disabled = await found.locator.isDisabled().catch(() => false);
        if (!disabled) return { ready: true, reason: "selector" };
      }
    } catch (_) {
      /* ignore */
    }
  }

  return { ready: false, reason: "no-positive" };
}

async function framesHaveAnyButtonText(frames, texts) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  for (const frame of frames) {
    for (const text of list) {
      try {
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const candidates = [
          frame.getByRole("button", { name: text, exact: true }),
          frame.getByRole("button", { name: new RegExp(escaped, "i") }),
          frame.getByRole("link", { name: new RegExp(escaped, "i") }),
          frame.locator(`button:has-text("${text}")`),
          frame.locator(`a:has-text("${text}")`),
          frame.locator(`[role="button"]:has-text("${text}")`),
          frame.locator(`.arco-btn:has-text("${text}")`),
          frame.locator(`.ant-btn:has-text("${text}")`),
          frame.getByText(text, { exact: false }),
        ];
        for (const loc of candidates) {
          if (await loc.first().isVisible().catch(() => false)) return true;
        }
      } catch (_) {
        /* next */
      }
    }
  }
  return false;
}

async function framesHaveEnabledButtonText(frames, texts) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  for (const frame of frames) {
    for (const text of list) {
      try {
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const candidates = [
          frame.getByRole("button", { name: text, exact: true }),
          frame.getByRole("button", { name: new RegExp(escaped, "i") }),
          frame.getByRole("link", { name: new RegExp(escaped, "i") }),
          frame.locator(`button:has-text("${text}")`),
          frame.locator(`a:has-text("${text}")`),
          frame.locator(`[role="button"]:has-text("${text}")`),
          frame.locator(`.arco-btn:has-text("${text}")`),
          frame.locator(`.ant-btn:has-text("${text}")`),
          // Custom clickable nodes (DeepSeek sometimes uses non-button wrappers)
          frame.locator(`div:has-text("${text}")`).filter({ hasText: new RegExp(escaped, "i") }),
        ];
        for (const loc of candidates) {
          const el = loc.first();
          if (!(await el.isVisible().catch(() => false))) continue;
          if (await el.isDisabled().catch(() => false)) continue;
          if ((await el.getAttribute("aria-disabled").catch(() => null)) === "true") {
            continue;
          }
          const cls = (await el.getAttribute("class").catch(() => "")) || "";
          if (/disabled|is-disabled|btn-disabled/i.test(cls)) continue;
          return true;
        }
      } catch (_) {
        /* next */
      }
    }
  }
  return false;
}



