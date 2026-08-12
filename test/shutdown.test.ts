import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bridgeEntry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fakeCodex = fileURLToPath(new URL("../../test/fake-codex.mjs", import.meta.url));

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await delay(20);
  }
  throw new Error("fake Codex did not publish its pid");
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Bridge did not exit after shutdown request"));
    }, 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function exerciseShutdown(
  mode: "eof" | "sigint",
  stubbornAppServer = false,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `local-codex-bridge-${mode}-`));
  const pidFile = join(directory, "app-server.pid");
  const checkpointDirectory = join(directory, "checkpoints");
  const child = spawn(process.execPath, [bridgeEntry], {
    env: {
      ...process.env,
      CODEX_EXE: fakeCodex,
      LOCAL_CODEX_BRIDGE_FAKE_PID_FILE: pidFile,
      ...(stubbornAppServer ? { LOCAL_CODEX_BRIDGE_FAKE_STUBBORN_SHUTDOWN: "1" } : {}),
      LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR: checkpointDirectory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let appServerPid: number | undefined;
  const responses = new Map<number, (message: Record<string, unknown>) => void>();
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === "number") {
        responses.get(message.id)?.(message);
        responses.delete(message.id);
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const request = async (
    id: number,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 3_000);
      responses.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return await response;
  };

  try {
    assert.equal((await request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "shutdown-test", version: "1" },
    })).error, undefined);
    assert.equal((await request(2, "tools/call", {
      name: "codex_threads",
      arguments: { thread_id: "stored-thread", include_turns: false },
    })).error, undefined);
    appServerPid = await waitForPidFile(pidFile);
    assert.equal(processExists(appServerPid), true);

    if (mode === "eof") {
      child.stdin.end();
    } else {
      child.kill("SIGINT");
    }
    const exit = await waitForExit(child);
    assert.deepEqual(exit, { code: 0, signal: null });

    const deadline = Date.now() + 3_000;
    while (processExists(appServerPid) && Date.now() < deadline) {
      await delay(20);
    }
    assert.equal(processExists(appServerPid), false, "Codex app-server must not be orphaned");
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child).catch(() => undefined);
    }
    if (appServerPid !== undefined && processExists(appServerPid)) {
      process.kill(appServerPid, "SIGKILL");
      const deadline = Date.now() + 3_000;
      while (processExists(appServerPid) && Date.now() < deadline) {
        await delay(20);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test("macOS Bridge shutdown reaps the Codex app-server child", async (t) => {
  await t.test("stdin EOF", () => exerciseShutdown("eof"));
  await t.test("SIGINT", () => exerciseShutdown("sigint"));
  await t.test("stdin EOF escalates to SIGKILL for a stubborn child", () =>
    exerciseShutdown("eof", true));
});
