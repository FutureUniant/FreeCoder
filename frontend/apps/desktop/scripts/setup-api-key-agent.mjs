/**
 * Setup / sync the in-app vendor API key agent (Playwright).
 *
 * Usage:
 *   pnpm ensure:api-key   # idempotent — used by tauri dev/build (recommended)
 *   pnpm setup:api-key    # force reinstall deps + Chromium + sync
 *   pnpm sync:api-key-agent
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = path.join(root, "src", "vendor-key-agent");
const browsersPath = path.join(root, "ms-playwright");
const mode = process.argv[2] || "ensure";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      ...opts,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

function hasChromium(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    return fs
      .readdirSync(dir)
      .some(
        (n) =>
          n.toLowerCase().startsWith("chromium") ||
          n.toLowerCase().startsWith("chrome"),
      );
  } catch {
    return false;
  }
}

function hasAgentDeps() {
  return fs.existsSync(
    path.join(agentDir, "node_modules", "playwright", "cli.js"),
  );
}

function syncResources() {
  if (!fs.existsSync(agentDir)) {
    console.warn(`[api-key-agent] skip sync — missing ${agentDir}`);
    return;
  }

  const srcFlows = path.join(agentDir, "flows");
  const dstFlows = path.join(root, "src-tauri", "resources", "flows");
  const srcJs = path.join(agentDir, "src");
  const dstJs = path.join(
    root,
    "src-tauri",
    "resources",
    "vendor-key-agent",
    "src",
  );

  fs.mkdirSync(dstFlows, { recursive: true });
  for (const name of fs.readdirSync(srcFlows)) {
    if (!name.endsWith(".yaml")) continue;
    fs.copyFileSync(path.join(srcFlows, name), path.join(dstFlows, name));
  }

  fs.mkdirSync(dstJs, { recursive: true });
  for (const name of fs.readdirSync(srcJs)) {
    if (!name.endsWith(".js")) continue;
    fs.copyFileSync(path.join(srcJs, name), path.join(dstJs, name));
  }

  if (hasChromium(browsersPath)) {
    const dstBrowsers = path.join(
      root,
      "src-tauri",
      "resources",
      "ms-playwright",
    );
    // Avoid expensive full copy on every ensure when already mirrored.
    if (!hasChromium(dstBrowsers)) {
      fs.rmSync(dstBrowsers, { recursive: true, force: true });
      fs.cpSync(browsersPath, dstBrowsers, { recursive: true });
      console.log(`[api-key-agent] mirrored Chromium → resources/ms-playwright`);
    }
  }
}

async function installDeps() {
  if (!fs.existsSync(path.join(agentDir, "package.json"))) {
    throw new Error(`missing ${agentDir}`);
  }
  console.log("[api-key-agent] installing Node deps…");
  await run("npm", [
    "install",
    "--prefix",
    agentDir,
    "--registry=https://registry.npmmirror.com",
  ]);
}

async function installBrowsers() {
  fs.mkdirSync(browsersPath, { recursive: true });
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const cli = path.join(agentDir, "node_modules", "playwright", "cli.js");
  if (!fs.existsSync(cli)) {
    throw new Error("playwright missing after npm install");
  }
  console.log(
    `[api-key-agent] downloading Chromium → ${browsersPath} (~90MB, first time only)…`,
  );
  await run(process.execPath, [cli, "install", "chromium"], {
    cwd: agentDir,
    env: process.env,
    shell: false,
  });
}

async function ensure() {
  try {
    if (!hasAgentDeps()) {
      await installDeps();
    }
    if (!hasChromium(browsersPath)) {
      await installBrowsers();
    } else {
      console.log("[api-key-agent] Chromium already present — skip download");
    }
    syncResources();
    console.log("[api-key-agent] ready");
  } catch (e) {
    // Don't block `pnpm tauri dev` — system Chrome/Edge can still be used.
    console.warn(`[api-key-agent] ensure failed (non-fatal): ${e.message || e}`);
    try {
      syncResources();
    } catch (_) {
      /* ignore */
    }
  }
}

async function main() {
  if (mode === "sync") {
    syncResources();
    return;
  }
  if (mode === "browsers") {
    if (!hasAgentDeps()) await installDeps();
    await installBrowsers();
    syncResources();
    return;
  }
  if (mode === "all" || mode === "force") {
    await installDeps();
    await installBrowsers();
    syncResources();
    console.log("[api-key-agent] ready");
    return;
  }
  // default: ensure (idempotent)
  await ensure();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
