import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AppServerManager } from "../src/app-server.js";
const bridgeEntry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fakeCodex = fileURLToPath(new URL("../../test/fake-codex.mjs", import.meta.url));
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (error.code === "ESRCH") {
            return false;
        }
        throw error;
    }
}
async function waitForPidFile(path) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        try {
            const pid = Number(readFileSync(path, "utf8").trim());
            if (Number.isInteger(pid) && pid > 0) {
                return pid;
            }
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
        await delay(20);
    }
    throw new Error("fake Codex did not publish its pid");
}
async function waitForExit(child) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
    }
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill(process.platform === "darwin" ? "SIGKILL" : undefined);
            reject(new Error("Bridge did not exit after shutdown request"));
        }, 5_000);
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
    });
}
async function exerciseShutdown(mode, stubbornAppServer = false) {
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
    let appServerPid;
    const responses = new Map();
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
        while (true) {
            const newline = stdout.indexOf("\n");
            if (newline < 0)
                break;
            const line = stdout.slice(0, newline).replace(/\r$/, "");
            stdout = stdout.slice(newline + 1);
            if (!line)
                continue;
            const message = JSON.parse(line);
            if (typeof message.id === "number") {
                responses.get(message.id)?.(message);
                responses.delete(message.id);
            }
        }
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const request = async (id, method, params) => {
        const response = new Promise((resolve, reject) => {
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
        }
        else {
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
    }
    finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill(process.platform === "darwin" ? "SIGKILL" : undefined);
            await waitForExit(child).catch(() => undefined);
        }
        if (appServerPid !== undefined && processExists(appServerPid)) {
            process.kill(appServerPid, process.platform === "darwin" ? "SIGKILL" : undefined);
            const deadline = Date.now() + 3_000;
            while (processExists(appServerPid) && Date.now() < deadline) {
                await delay(20);
            }
        }
        rmSync(directory, { recursive: true, force: true });
    }
}
async function exerciseWindowsManagerClose(stubbornAppServer) {
    const directory = mkdtempSync(join(tmpdir(), "local-codex-bridge-manager-close-"));
    const pidFile = join(directory, "app-server.pid");
    const manager = new AppServerManager(undefined, {
        executable: process.execPath,
        prefixArgs: [fakeCodex],
        environment: {
            ...process.env,
            LOCAL_CODEX_BRIDGE_FAKE_PID_FILE: pidFile,
            ...(stubbornAppServer ? { LOCAL_CODEX_BRIDGE_FAKE_STUBBORN_SHUTDOWN: "1" } : {}),
        },
        requestTimeoutMs: 2_000,
    });
    let appServerPid;
    try {
        await manager.request("thread/list", {});
        appServerPid = await waitForPidFile(pidFile);
        assert.equal(processExists(appServerPid), true);
        await manager.close();
        const deadline = Date.now() + 3_000;
        while (processExists(appServerPid) && Date.now() < deadline) {
            await delay(20);
        }
        assert.equal(processExists(appServerPid), false, "Codex app-server must not be orphaned after manager close");
    }
    finally {
        await manager.close().catch(() => undefined);
        if (appServerPid !== undefined && processExists(appServerPid)) {
            process.kill(appServerPid);
            const deadline = Date.now() + 3_000;
            while (processExists(appServerPid) && Date.now() < deadline) {
                await delay(20);
            }
        }
        rmSync(directory, { recursive: true, force: true });
    }
}
test("macOS Bridge process shutdown reaps the exact Codex app-server child", {
    skip: process.platform !== "darwin",
}, async (t) => {
    await t.test("stdin EOF", () => exerciseShutdown("eof"));
    await t.test("SIGINT", () => exerciseShutdown("sigint"));
    await t.test("stdin EOF hard-terminates a stubborn child without orphaning it", () => exerciseShutdown("eof", true));
});
test("Windows AppServerManager close reaps the exact spawned fake Codex child", {
    skip: process.platform !== "win32",
}, async (t) => {
    await t.test("normal fixture", () => exerciseWindowsManagerClose(false));
    await t.test("stubborn fixture", () => exerciseWindowsManagerClose(true));
});
