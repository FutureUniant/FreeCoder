import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { send, sendStatus, sendError } from "./protocol.js";

const CLIPBOARD_PERMS = ["clipboard-read", "clipboard-write"];

const KNOWN_ORIGINS = [
  "https://bailian.console.aliyun.com",
  "https://platform.deepseek.com",
  "https://console.volcengine.com",
];

function bundledBrowsersReady() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return false;
  try {
    return fs
      .readdirSync(root)
      .some((n) => {
        const lower = n.toLowerCase();
        return lower.startsWith("chromium") || lower.startsWith("chrome");
      });
  } catch {
    return false;
  }
}

function launchErrorHint(err) {
  const msg = err?.message || String(err);
  if (/Executable doesn't exist|Please run.*playwright install/i.test(msg)) {
    return (
      "未找到可用的 Chromium。请重新执行 pnpm install / pnpm tauri dev（会自动下载），或手动：pnpm setup:api-key\n" +
      "（也可安装本机 Chrome / Edge，将自动改用系统浏览器）"
    );
  }
  return msg;
}

/**
 * Launch headed browser.
 * Prefer project/bundled Playwright Chromium when present;
 * otherwise try system Edge → Chrome first (Windows 更稳),
 * then bundled Chromium last so missing-browser errors are clearer.
 */
export async function launchBrowser() {
  const launchOpts = {
    headless: false,
    // Ephemeral profile every run — 「阻止」剪贴板权限不会带到下一次。
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
  };

  const hasBundled = bundledBrowsersReady();
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    sendStatus(
      "browser",
      hasBundled
        ? `使用项目 Chromium: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`
        : `PLAYWRIGHT_BROWSERS_PATH 已设置但未装好浏览器，将优先尝试系统浏览器`,
    );
  }

  const attempts = hasBundled
    ? [
        { label: "项目 Chromium", opts: { ...launchOpts } },
        { label: "系统 Edge", opts: { ...launchOpts, channel: "msedge" } },
        { label: "系统 Chrome", opts: { ...launchOpts, channel: "chrome" } },
      ]
    : [
        { label: "系统 Edge", opts: { ...launchOpts, channel: "msedge" } },
        { label: "系统 Chrome", opts: { ...launchOpts, channel: "chrome" } },
        { label: "项目 Chromium", opts: { ...launchOpts } },
      ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      sendStatus("browser", `正在启动 ${attempt.label}…`);
      const browser = await chromium.launch(attempt.opts);
      sendStatus("browser", `${attempt.label} 已启动`);
      return {
        browser,
        channel: attempt.opts.channel || "chromium",
      };
    } catch (e) {
      const hint = launchErrorHint(e);
      errors.push(`${attempt.label}: ${hint}`);
      sendStatus("browser", `${attempt.label} 启动失败：${hint}`);
    }
  }

  const summary =
    "无法启动浏览器。\n" +
    errors.map((e) => `· ${e}`).join("\n") +
    "\n请重新 pnpm install / pnpm tauri dev，或执行：pnpm setup:api-key";
  sendError(summary, true);
  throw new Error(summary);
}

async function grantClipboard(context, origin) {
  if (!origin || origin === "about:blank" || origin.startsWith("chrome")) {
    return;
  }
  // 只 grant，绝不 clearPermissions：clear 会让站点重新弹「允许/阻止」，
  // 用户点阻止后同一次会话内很难再自动拿到剪贴板。
  await context.grantPermissions(CLIPBOARD_PERMS, { origin }).catch(() => {});
}

export async function createContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    permissions: CLIPBOARD_PERMS,
  });

  for (const origin of KNOWN_ORIGINS) {
    await grantClipboard(context, origin);
  }

  const page = await context.newPage();

  // 站点申请权限时一律允许（含用户上次误点「阻止」后的再次申请）
  page.on("dialog", async (dialog) => {
    try {
      await dialog.accept();
    } catch (_) {}
  });

  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      const origin = new URL(page.url()).origin;
      await grantClipboard(context, origin);
    } catch (_) {}
  });

  page.on("close", () => {
    send({ type: "browser_closed", message: "浏览器窗口已关闭" });
  });

  return { context, page };
}

export async function closeAll(browser, context) {
  try {
    if (context) await context.close();
  } catch (_) {}
  try {
    if (browser) await browser.close();
  } catch (_) {}
}

/** Resolve flows directory (dev vs pkg). */
export function resolveFlowsDir() {
  if (process.env.GETKEY_FLOWS_DIR && fs.existsSync(process.env.GETKEY_FLOWS_DIR)) {
    return process.env.GETKEY_FLOWS_DIR;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "flows"),
    path.join(process.cwd(), "flows"),
    path.join(process.cwd(), "vendor-key-agent", "flows"),
    path.join(process.cwd(), "src", "vendor-key-agent", "flows"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}
