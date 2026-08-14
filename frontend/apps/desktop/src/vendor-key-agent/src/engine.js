import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { send, sendStatus, sendError, waitForCommand } from "./protocol.js";
import { extractKey } from "./extract.js";
import {
  waitFirst,
  clickFirst,
  fillFirst,
  clickModalConfirm,
  clickButtonByText,
  dismissBlockingModal,
  isLoginReady,
} from "./dom.js";

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

function interpolate(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{timestamp\}\}/g, String(Date.now()));
}

export function loadFlow(flowsDir, platformId) {
  const file = path.join(flowsDir, `${platformId}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(`未找到平台配置: ${file}`);
  }
  const doc = yaml.load(fs.readFileSync(file, "utf8"));
  if (!doc?.steps?.length) {
    throw new Error(`平台配置无效或无步骤: ${platformId}`);
  }
  return doc;
}

/**
 * Wait until logged-in UI signals appear, or user sends continue, or timeout.
 * Periodically revisits API Key URL because login often lands on home.
 */
async function waitForLogin({ page, step, commandIter, flowAbort }) {
  const timeout = step.timeout_ms || FLOW_TIMEOUT_MS;
  const pollMs = step.poll_ms || 1500;
  const stableNeed = Math.max(1, Number(step.stable_polls) || 2);
  const revisitUrl = step.revisit_url || null;
  const revisitEvery = Math.max(pollMs * 2, Number(step.revisit_every_ms) || 10000);
  const pathHints = step.url_path_includes || [];
  const deadline = Date.now() + timeout;

  send({
    type: "waiting_login",
    message:
      step.message ||
      "请在浏览器中完成登录；检测到登录成功后将自动继续（也可点「已登录」跳过等待）",
    timeout_ms: timeout,
  });
  sendStatus(
    "wait_login",
    step.message || "等待登录中…登录成功后将自动获取 API Key",
  );

  let manualContinue = false;
  let cancelled = false;
  const cmdWatcher = (async () => {
    try {
      for await (const cmd of commandIter) {
        if (cmd.type === "cancel") {
          cancelled = true;
          return;
        }
        if (cmd.type === "continue") {
          manualContinue = true;
          return;
        }
      }
    } catch (_) {
      /* stdin closed */
    }
  })();

  let stableHits = 0;
  let lastUrl = "";
  let lastReason = "";
  let lastRevisitAt = Date.now();

  while (Date.now() < deadline) {
    if (flowAbort.aborted) {
      throw new Error("整个流程超时（10 分钟），已关闭浏览器");
    }
    if (cancelled) {
      throw new Error("用户取消");
    }
    if (manualContinue) {
      sendStatus("wait_login", "已手动确认登录，开始自动创建/提取 Key…");
      return;
    }

    let url = "";
    try {
      url = page.url();
    } catch (_) {
      url = "";
    }
    if (url && url !== lastUrl) {
      lastUrl = url;
      stableHits = 0;
      sendStatus("wait_login", `当前页面：${url.slice(0, 140)}`);
    }

    const onTargetPath =
      pathHints.length === 0 ||
      pathHints.some((p) => String(url).toLowerCase().includes(String(p).toLowerCase()));

    const urlExcludes = step.url_excludes || [];
    const urlIncludes = step.url_includes || [];
    const onBlockedUrl = urlExcludes.some((ex) =>
      String(url).toLowerCase().includes(String(ex).toLowerCase()),
    );
    const onAllowedHost =
      urlIncludes.length === 0 ||
      urlIncludes.some((u) => String(url).toLowerCase().includes(String(u).toLowerCase()));

    // Revisit only after leaving login hosts — never interrupt sign-in / OAuth.
    if (
      revisitUrl &&
      Date.now() - lastRevisitAt >= revisitEvery &&
      !onBlockedUrl &&
      onAllowedHost &&
      !onTargetPath
    ) {
      try {
        sendStatus("wait_login", "回到 API Key 页检测登录态…");
        await page.goto(revisitUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForTimeout(800);
      } catch (e) {
        sendStatus("wait_login", `回访 API Key 页失败：${e.message || e}`);
      }
      lastRevisitAt = Date.now();
      stableHits = 0;
    } else if (revisitUrl && Date.now() - lastRevisitAt >= revisitEvery) {
      lastRevisitAt = Date.now();
    }

    const result = await isLoginReady(page, step);
    const ready = result === true || result?.ready === true;
    const reason = result?.reason || (ready ? "ok" : "no");

    if (ready) {
      stableHits += 1;
      sendStatus(
        "wait_login",
        `已检测到登录特征（${stableHits}/${stableNeed} · ${reason}）…`,
      );
      if (stableHits >= stableNeed) {
        sendStatus("wait_login", "已确认登录成功，开始自动创建/提取 Key…");
        return;
      }
    } else {
      if (stableHits > 0) {
        sendStatus("wait_login", "登录信号不稳定，继续等待…");
      } else if (reason !== lastReason) {
        lastReason = reason;
        sendStatus("wait_login", `等待登录中（${reason}）…`);
      }
      stableHits = 0;
    }

    await page.waitForTimeout(pollMs);
  }

  void cmdWatcher;
  throw new Error("等待登录超时（10 分钟），已停止获取");
}

/**
 * Run the flow. commandIter is an async iterator of stdin commands.
 * Returns extracted key string.
 */
export async function runFlow({ page, flow, commandIter }) {
  const flowAbort = { aborted: false };
  const flowTimer = setTimeout(() => {
    flowAbort.aborted = true;
    sendError("整个流程超时（10 分钟）", true);
  }, FLOW_TIMEOUT_MS);

  let extractedKey = null;
  let loginResolved = false;

  try {
    for (let i = 0; i < flow.steps.length; i++) {
      if (flowAbort.aborted) {
        throw new Error("整个流程超时（10 分钟），已关闭浏览器");
      }

      const step = flow.steps[i];
      const stepId = `${flow.id}:${i}:${step.type}`;
      sendStatus(step.type, step.message || step.type, { stepIndex: i, stepId });

      try {
        switch (step.type) {
          case "navigate": {
            await page.goto(step.url, {
              waitUntil: "domcontentloaded",
              timeout: 60000,
            });
            await page.waitForTimeout(step.wait_ms || 800);
            break;
          }
          case "wait_selector": {
            await waitFirst(page, step.selector, step.timeout_ms || 15000);
            break;
          }
          case "auto_click": {
            if (step.texts?.length) {
              await clickButtonByText(page, step.texts, step.timeout_ms || 12000);
            } else {
              await clickFirst(page, step.selector, step.timeout_ms || 12000);
            }
            break;
          }
          case "modal_confirm": {
            await clickModalConfirm(page, step);
            break;
          }
          case "dismiss_modal": {
            await dismissBlockingModal(page, step);
            break;
          }
          case "sleep": {
            await page.waitForTimeout(step.ms || 500);
            break;
          }
          case "auto_fill": {
            await fillFirst(
              page,
              step.selector,
              interpolate(step.value || ""),
              step.timeout_ms || 8000,
            );
            break;
          }
          case "extract": {
            extractedKey = await extractKey(page, step);
            send({
              type: "key_extracted",
              platform: flow.id,
              key: extractedKey,
              message: "已成功提取 API Key",
            });
            break;
          }
          case "wait_login": {
            await waitForLogin({ page, step, commandIter, flowAbort });
            loginResolved = true;
            break;
          }
          case "user_action": {
            const timeout = step.timeout_ms || FLOW_TIMEOUT_MS;
            send({
              type: "waiting_login",
              message: step.message || "请完成操作后点击「已登录」",
              timeout_ms: timeout,
            });
            await waitForCommand(commandIter, ["continue"], timeout);
            sendStatus("user_action", "用户已确认，开始自动创建/提取 Key…");
            loginResolved = true;
            break;
          }
          case "condition": {
            const found = await waitFirst(
              page,
              step.selector,
              step.timeout_ms || 2000,
            ).catch(() => null);
            const exists = !!found;
            if (step.when === "visible" && !exists && step.skip_to != null) {
              i = step.skip_to - 1;
            }
            if (step.when === "hidden" && exists && step.skip_to != null) {
              i = step.skip_to - 1;
            }
            break;
          }
          default:
            sendError(`未知步骤类型: ${step.type}`, true);
        }
      } catch (err) {
        if (step.optional) {
          sendStatus(step.type, `可选步骤跳过: ${err.message}`, {
            optional: true,
          });
          continue;
        }
        throw err;
      }

      void loginResolved;
    }

    if (!extractedKey) {
      throw new Error("流程结束但未提取到 Key");
    }

    send({ type: "done", platform: flow.id, key: extractedKey });
    return extractedKey;
  } finally {
    clearTimeout(flowTimer);
  }
}
