#!/usr/bin/env node
/**
 * GetKey Sidecar — Playwright headed browser automation.
 * Protocol: line-delimited JSON on stdin/stdout.
 *
 * Usage:
 *   node src/index.js --platform deepseek
 *   GETKEY_FLOWS_DIR=/path/to/flows node src/index.js --platform bailian
 */

import { send, sendStatus, sendError, readCommands } from "./protocol.js";
import { launchBrowser, createContext, closeAll, resolveFlowsDir } from "./browser.js";
import { loadFlow, runFlow } from "./engine.js";

function parseArgs(argv) {
  const args = { platform: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--platform" && argv[i + 1]) {
      args.platform = argv[++i];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  let platform = args.platform;

  // Also accept start command from stdin if platform not given
  const commandIter = readCommands();

  sendStatus("init", "Sidecar 已启动", { pid: process.pid });

  if (!platform) {
    sendStatus("init", "等待 start 指令…");
    for await (const cmd of commandIter) {
      if (cmd.type === "cancel") {
        send({ type: "done", cancelled: true });
        process.exit(0);
      }
      if (cmd.type === "start" && cmd.platform) {
        platform = cmd.platform;
        break;
      }
    }
  }

  if (!platform) {
    sendError("未指定平台", false);
    process.exit(1);
  }

  const flowsDir = resolveFlowsDir();
  let flow;
  try {
    flow = loadFlow(flowsDir, platform);
  } catch (e) {
    sendError(e.message, false);
    process.exit(1);
  }

  sendStatus("init", `已加载流程: ${flow.name || platform}`, { platform });

  let browser, context, page;
  try {
    ({ browser } = await launchBrowser());
    ({ context, page } = await createContext(browser));

    // Watch for cancel in background while running
    // commandIter is shared — user_action waits on it
    await runFlow({ page, flow, commandIter });
  } catch (e) {
    sendError(e.message || String(e), true);
    send({ type: "done", failed: true, message: e.message });
    process.exitCode = 1;
  } finally {
    await closeAll(browser, context);
  }

  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  sendError(e.message || String(e), false);
  process.exit(1);
});
