/**
 * 从页面拿到 API Key → 通过返回值交给 engine → stdout JSON 发给 GetKey 填入输入框。
 * 不依赖 GetKey 去读剪贴板；点「复制」只是辅助手段。
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { clickModalConfirm } from "./dom.js";
import { send, sendStatus } from "./protocol.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PATTERNS = [
  /sk-ws-[A-Za-z0-9._-]{8,}/g,
  /sk-sp-[A-Za-z0-9._-]{8,}/g,
  /sk-[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9._-]{16,}/g,
];

function compilePatterns(step) {
  if (Array.isArray(step.patterns) && step.patterns.length) {
    return step.patterns.map((p) => new RegExp(p, "g"));
  }
  if (step.pattern) {
    return [new RegExp(step.pattern, "g")];
  }
  return DEFAULT_PATTERNS.map((p) => new RegExp(p.source, "g"));
}

function looksLikeKey(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 16 || t.length > 200) return false;
  if (!t.startsWith("sk-")) return false;
  if (t.includes("*") || t.includes("•") || t.includes("…") || t.includes("...")) {
    return false;
  }
  return /^sk-[A-Za-z0-9._-]+$/.test(t);
}

function pickBestKey(text, patterns) {
  if (!text) return null;
  const found = [];
  for (const pattern of patterns) {
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
    );
    for (const m of text.matchAll(re)) {
      const v = m[0].trim();
      if (looksLikeKey(v)) found.push(v);
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.length - a.length);
  return found[0];
}

function parseCredentialText(text, patterns) {
  const source = String(text || "");
  const urls = source.match(/https?:\/\/[^\s"'<>，。]+/g) || [];
  const cleanUrls = [...new Set(urls.map((url) => url.replace(/[),;]+$/, "")))];
  const openaiBaseUrl =
    cleanUrls.find((url) => /\/compatible-mode\/v1\/?$/i.test(url)) || null;
  const dashscopeBaseUrl =
    cleanUrls.find((url) => /\/api\/v1\/?$/i.test(url)) || null;
  const hostMatch = source.match(
    /API\s*Host\s*[:：]?\s*(?:https?:\/\/)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i
  );
  let apiHost = hostMatch?.[1] || null;
  if (!apiHost && openaiBaseUrl) {
    try {
      apiHost = new URL(openaiBaseUrl).host;
    } catch (_) {}
  }
  return {
    key: pickBestKey(source, patterns),
    config: {
      apiHost,
      openaiBaseUrl,
      dashscopeBaseUrl,
    },
  };
}

function hasConfig(config) {
  return !!(
    config?.apiHost ||
    config?.openaiBaseUrl ||
    config?.dashscopeBaseUrl
  );
}

async function readPageCredentialInfo(page, patterns) {
  const texts = [];
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => document.body?.innerText || "");
      if (text) texts.push(text);
    } catch (_) {}
  }
  return parseCredentialText(texts.join("\n"), patterns);
}

function decodeDownloadedFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  const utf8 = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (utf8.includes("\u0000")) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  return utf8;
}

async function downloadCredentialFile(page, patterns) {
  const exportDir =
    process.env.GETKEY_EXPORT_DIR ||
    path.join(process.env.TEMP || process.env.TMP || "/tmp", "GetKey", "exports");
  fs.mkdirSync(exportDir, { recursive: true });

  for (const frame of page.frames()) {
    const candidates = [
      frame.getByRole("button", { name: /^(下载|Download)$/i }),
      frame.locator('button:has-text("下载"), a:has-text("下载")'),
    ];
    for (const candidate of candidates) {
      const button = candidate.last();
      if (!(await button.isVisible().catch(() => false))) continue;
      try {
        sendStatus("extract", "发现凭据下载按钮，正在下载完整配置…");
        const downloadPromise = page.waitForEvent("download", { timeout: 8000 });
        await button.click({ timeout: 3000 });
        const download = await downloadPromise;
        const suggested = download.suggestedFilename().replace(/[<>:"/\\|?*]/g, "_");
        const filename = `${Date.now()}-${suggested || "bailian-credentials.txt"}`;
        const savedPath = path.join(exportDir, filename);
        await download.saveAs(savedPath);
        const text = decodeDownloadedFile(fs.readFileSync(savedPath));
        const parsed = parseCredentialText(text, patterns);
        sendStatus("extract", `凭据文件已保存: ${savedPath}`);
        return { ...parsed, downloadPath: savedPath };
      } catch (e) {
        sendStatus("extract", `下载未成功，改用页面读取: ${e.message || e}`);
        return null;
      }
    }
  }
  return null;
}

/** 在所有 frame 里直接找出明文 Key（最可靠） */
async function findKeyInDom(page, patterns) {
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(() => {
        const keys = [];
        const push = (s) => {
          const t = (s || "").trim();
          if (
            /^sk-[A-Za-z0-9._-]{16,200}$/.test(t) &&
            !/[*…•]/.test(t) &&
            !t.includes("...")
          ) {
            keys.push(t);
          }
        };

        for (const el of document.querySelectorAll(
          "input, textarea, code, pre, span, div, p, td, li, [data-clipboard-text]"
        )) {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            push(el.value);
          }
          push(el.getAttribute?.("data-clipboard-text"));
          // 只取叶子节点短文本，避免整页拼接
          if (el.childElementCount === 0) {
            push(el.textContent);
          }
        }

        // 弹窗全文再扫一遍
        for (const modal of document.querySelectorAll(
          ".ant-modal, .arco-modal, .arco-modal-wrapper, [role='dialog'], .next-dialog, .semi-modal"
        )) {
          const style = window.getComputedStyle(modal);
          if (style.display === "none" || style.visibility === "hidden") continue;
          if (modal.classList?.contains("arco-modal-wrapper-hide")) continue;
          const text = modal.innerText || "";
          const m = text.match(/sk-[A-Za-z0-9._-]{16,200}/g);
          if (m) m.forEach(push);
        }

        // Key 常被拆在多层 span 中，叶子节点本身不是完整值。
        // innerText 只包含当前渲染的页面文本，不会把脚本源码误当成 Key。
        const pageMatches = (document.body?.innerText || "").match(
          /sk-[A-Za-z0-9._-]{16,200}/g
        );
        if (pageMatches) pageMatches.forEach(push);

        keys.sort((a, b) => b.length - a.length);
        return keys[0] || "";
      });
      if (looksLikeKey(found)) return found;
      const fromPatterns = pickBestKey(found, patterns);
      if (fromPatterns) return fromPatterns;
    } catch (_) {}
  }
  return null;
}

/**
 * 点击「复制」：优先点 Key 旁边的复制按钮；成功后从 DOM/剪贴板取 Key。
 * 返回 { clicked, key }
 */
async function clickCopyNearKey(page, patterns) {
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(() => {
        const isKey = (s) =>
          /^sk-[A-Za-z0-9._-]{16,200}$/.test((s || "").trim());

        // 1) 找含明文 Key 的节点，点它附近的复制按钮
        const all = [...document.querySelectorAll("input, textarea, code, span, div, p, td")];
        for (const el of all) {
          const val =
            (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? el.value
              : "") ||
            el.getAttribute?.("data-clipboard-text") ||
            (el.childElementCount === 0 ? el.textContent : "") ||
            "";
          const t = val.trim();
          if (!isKey(t)) continue;

          // 复制图标经常是 Key 节点的兄弟元素；逐层向上找，避免只查最近 div。
          let root = el.parentElement;
          for (let depth = 0; root && depth < 6; depth++, root = root.parentElement) {
            const btns = [
              ...root.querySelectorAll(
                "button, a, [role='button'], [title], [data-testid*='copy' i], .anticon-copy, [class*='copy' i], [aria-label*='复制'], [aria-label*='copy' i]"
              ),
            ];
            for (const btn of btns) {
              const label = (
                btn.getAttribute("aria-label") ||
                btn.getAttribute("title") ||
                btn.getAttribute("data-testid") ||
                btn.textContent ||
                btn.className ||
                ""
              ).toString();
              if (/复制|copy|clipboard/i.test(label) || btn.classList?.contains("anticon-copy")) {
                btn.click();
                return { clicked: true, key: t };
              }
            }
            // Key 行附近的无文字图标按钮。
            const iconBtn = root.querySelector(
              "button.ant-btn-icon-only, button:has(.anticon), button:has(svg)"
            );
            if (iconBtn) {
              iconBtn.click();
              return { clicked: true, key: t };
            }
          }
        }

        // 2) 弹窗里按文案点「复制」
        const modal = document.querySelector(
          ".ant-modal:not([style*='display: none']), [role='dialog']"
        );
        const scope = modal || document;
        for (const btn of scope.querySelectorAll("button, a, [role='button']")) {
          const name = (btn.textContent || "").trim();
          if (
            name === "复制" ||
            name === "复制 API Key" ||
            name === "复制API Key" ||
            name === "Copy"
          ) {
            btn.click();
            return { clicked: true, key: "" };
          }
        }
        return { clicked: false, key: "" };
      });

      if (result?.key && looksLikeKey(result.key)) {
        return { clicked: !!result.clicked, key: result.key };
      }
      if (result?.clicked) {
        await page.waitForTimeout(300);
        const browserClip = await readBrowserClipboard(page);
        const fromBrowser =
          pickBestKey(browserClip, patterns) ||
          (looksLikeKey(browserClip) ? browserClip : null);
        if (fromBrowser) return { clicked: true, key: fromBrowser };
        const clip = await readSystemClipboard();
        const fromClip = pickBestKey(clip, patterns) || (looksLikeKey(clip) ? clip : null);
        if (fromClip) return { clicked: true, key: fromClip };
        const domKey = await findKeyInDom(page, patterns);
        if (domKey) return { clicked: true, key: domKey };
        return { clicked: true, key: null };
      }
    } catch (_) {}
  }
  return { clicked: false, key: null };
}

async function readBrowserClipboard(page) {
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(async () => {
        try {
          return (await navigator.clipboard?.readText?.()) || "";
        } catch (_) {
          return "";
        }
      });
      if (text) return text.trim();
    } catch (_) {}
  }
  return "";
}

async function readSystemClipboard() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
        { windowsHide: true, timeout: 5000, encoding: "utf8" }
      );
      return (stdout || "").replace(/^\uFEFF/, "").trim();
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("pbpaste", [], {
        timeout: 5000,
        encoding: "utf8",
      });
      return (stdout || "").trim();
    }
    const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"], {
      timeout: 5000,
      encoding: "utf8",
    });
    return (stdout || "").trim();
  } catch {
    return "";
  }
}

function writeSystemClipboard(text) {
  return new Promise((resolve) => {
    try {
      if (process.platform === "win32") {
        const child = spawn("cmd", ["/c", "clip"], { windowsHide: true });
        child.stdin.end(text, "utf8");
        child.on("close", () => resolve());
        child.on("error", () => resolve());
        return;
      }
      const child = spawn(process.platform === "darwin" ? "pbcopy" : "xclip",
        process.platform === "darwin" ? [] : ["-selection", "clipboard"]);
      child.stdin.end(text, "utf8");
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

/**
 * 提取 Key：DOM → 点复制 → 系统剪贴板。
 * 一旦拿到，立刻通过 stdout 推给 GetKey（同时 return 给 flow）。
 */
export async function extractKey(page, step) {
  const timeout = step.timeout_ms || 30000;
  const patterns = compilePatterns(step);
  const deadline = Date.now() + timeout;
  const downloaded = await downloadCredentialFile(page, patterns).catch(() => null);

  const finish = async (key, how, suppliedConfig = null) => {
    const k = key.trim();
    const pageInfo = await readPageCredentialInfo(page, patterns).catch(() => ({
      config: null,
    }));
    const defaults =
      step.default_config && typeof step.default_config === "object"
        ? step.default_config
        : null;
    const config = hasConfig(suppliedConfig)
      ? suppliedConfig
      : hasConfig(downloaded?.config)
        ? downloaded.config
        : hasConfig(pageInfo.config)
          ? pageInfo.config
          : defaults;
    sendStatus("extract", `已获取 API Key（${how}，长度 ${k.length}），正在回传 GetKey…`);

    // 通道1：写临时文件（GUI 会轮询读取，最稳）
    try {
      const keyPath =
        process.env.GETKEY_KEY_FILE ||
        `${process.env.TEMP || process.env.TMP || "/tmp"}/getkey-last-api-key.txt`;
      fs.writeFileSync(keyPath, k, "utf8");
      sendStatus("extract", `Key 已写入文件: ${keyPath}`);
    } catch (e) {
      sendStatus("extract", `写 Key 文件失败: ${e.message || e}`);
    }

    // 通道2：stdout JSON → 主进程 Event → 前端输入框
    send({
      type: "key_extracted",
      key: k,
      message: `已获取 API Key（${how}）`,
      how,
      config: hasConfig(config) ? config : undefined,
      downloadPath: downloaded?.downloadPath,
    });

    // 通道3：系统剪贴板
    await writeSystemClipboard(k).catch(() => {});
    return k;
  };

  if (downloaded?.key) {
    return finish(downloaded.key, "下载文件", downloaded.config);
  }

  let triedSubmitCreate = false;

  while (Date.now() < deadline) {
    // 0) 若仍停在「创建 API Key」表单弹窗（底部是「创建」），先提交创建
    if (!triedSubmitCreate) {
      const stillCreateForm = await page.evaluate(() => {
        const roots = [
          ...document.querySelectorAll(
            ".arco-modal-wrapper, .arco-modal, .ant-modal, [role='dialog']"
          ),
        ];
        for (const root of roots) {
          const style = window.getComputedStyle(root);
          if (style.display === "none" || style.visibility === "hidden") continue;
          if (root.classList?.contains("arco-modal-wrapper-hide")) continue;
          const text = root.innerText || "";
          if (/所属项目|权限/.test(text) && /创建\s*API\s*Key|名称/.test(text)) {
            if (/sk-[A-Za-z0-9._-]{16,}/.test(text)) return false;
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (stillCreateForm) {
        sendStatus("extract", "检测到创建弹窗未提交，正在点击「创建」…");
        try {
          await clickModalConfirm(page, {
            timeout_ms: 8000,
            confirm_texts: ["创建", "确定", "确认", "Create"],
          });
          triedSubmitCreate = true;
          await page.waitForTimeout(1200);
        } catch (e) {
          sendStatus("extract", `提交创建弹窗失败: ${e.message || e}`);
          triedSubmitCreate = true;
        }
      }
    }

    // 1) 直接从页面 DOM 读明文（不依赖复制按钮）
    const domKey = await findKeyInDom(page, patterns);
    if (domKey) return finish(domKey, "页面DOM");

    // 2) 点击复制按钮（Key 旁或弹窗内），点完再读
    sendStatus("extract", "尝试点击页面「复制」按钮…");
    const { clicked, key: afterCopy } = await clickCopyNearKey(page, patterns);
    if (afterCopy) return finish(afterCopy, clicked ? "点击复制" : "页面");

    // 3) 系统剪贴板（用户或页面刚复制过）
    const browserClip = await readBrowserClipboard(page);
    const fromBrowser =
      pickBestKey(browserClip, patterns) ||
      (looksLikeKey(browserClip) ? browserClip : null);
    if (fromBrowser) return finish(fromBrowser, "浏览器剪贴板");

    const clip = await readSystemClipboard();
    const fromClip = pickBestKey(clip, patterns) || (looksLikeKey(clip) ? clip : null);
    if (fromClip) return finish(fromClip, "系统剪贴板");

    if (clicked) {
      sendStatus("extract", "已点击复制，等待剪贴板…");
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    "未能从页面获取 API Key。请确认创建成功弹窗仍打开并显示明文，或手动复制后点「从剪贴板填入」。"
  );
}
