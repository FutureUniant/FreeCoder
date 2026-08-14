/**
 * Line-delimited JSON protocol over stdin/stdout.
 */

export function send(msg) {
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(line);
  // 管道模式下确保主进程能立刻读到
  if (typeof process.stdout.hasRef === "function") {
    try {
      process.stdout.cork?.();
      process.stdout.uncork?.();
    } catch (_) {}
  }
}

export function sendStatus(step, message, extra = {}) {
  send({ type: "status", step, message, ...extra });
}

export function sendError(message, recoverable = true, extra = {}) {
  send({ type: "error", message, recoverable, ...extra });
}

/**
 * Read stdin line by line. Returns an async iterator of parsed JSON objects.
 */
export async function* readCommands() {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch (e) {
      sendError(`无效指令 JSON: ${trimmed}`, true);
    }
  }
}

/**
 * Wait for a specific command type (e.g. "continue" or "cancel").
 * Resolves with the command, or rejects on cancel/timeout.
 */
export function waitForCommand(commandIter, expectedTypes, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待用户操作超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    try {
      for await (const cmd of commandIter) {
        if (cmd.type === "cancel") {
          clearTimeout(timer);
          reject(new Error("用户取消"));
          return;
        }
        if (expectedTypes.includes(cmd.type)) {
          clearTimeout(timer);
          resolve(cmd);
          return;
        }
      }
      clearTimeout(timer);
      reject(new Error("主进程关闭了通信通道"));
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}
