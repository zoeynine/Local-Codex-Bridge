import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { terminateAppServerChild } from "../src/app-server.js";
import { DARWIN_PLATFORM_POLICY, createWindowsPlatformPolicy, platformPolicyFor, } from "../src/platform.js";
import { TOOL_DEFINITIONS } from "../src/tools.js";
test("Windows and Darwin cwd policies are explicit peers", () => {
    const windows = createWindowsPlatformPolicy(() => ({ status: 0 }));
    assert.equal(windows.validateCwd("D:/Bridge/project"), "D:\\Bridge\\project");
    assert.throws(() => windows.validateCwd("relative\\path"), /drive-letter/);
    assert.throws(() => windows.validateCwd("\\\\server\\share"), /UNC or Windows device/);
    assert.throws(() => windows.validateCwd("\\\\?\\D:\\Bridge"), /UNC or Windows device/);
    assert.equal(DARWIN_PLATFORM_POLICY.validateCwd("/Users/example/../bridge"), "/Users/bridge");
    assert.throws(() => DARWIN_PLATFORM_POLICY.validateCwd("Users/example/bridge"), /absolute POSIX path on macOS/);
});
test("checkpoint defaults remain platform-native and Windows alone preserves its legacy default", () => {
    const canonicalWindows = createWindowsPlatformPolicy(() => ({ status: 0 }), () => false);
    assert.equal(canonicalWindows.resolveDefaultCheckpointDirectory({ LOCALAPPDATA: "D:\\Local" }, "D:\\Users\\Example"), "D:\\Local\\LocalCodexBridge\\checkpoints");
    const legacyPath = "D:\\Local\\Lumen\\CodexControlV2\\checkpoints";
    const legacyWindows = createWindowsPlatformPolicy(() => ({ status: 0 }), (candidate) => candidate === legacyPath);
    assert.equal(legacyWindows.resolveDefaultCheckpointDirectory({ LOCALAPPDATA: "D:\\Local" }, "D:\\Users\\Example"), legacyPath);
    assert.equal(DARWIN_PLATFORM_POLICY.resolveDefaultCheckpointDirectory({ LOCALAPPDATA: "D:\\must-not-be-used" }, "/Users/example"), "/Users/example/Library/Application Support/LocalCodexBridge/checkpoints");
});
test("spawn and termination mechanisms stay platform-specific", () => {
    const invocations = [];
    const runner = (executable, args, options) => {
        invocations.push({
            executable,
            args: [...args],
            shell: options.shell,
            windowsHide: options.windowsHide,
        });
        return { status: 0 };
    };
    const windows = createWindowsPlatformPolicy(runner);
    const windowsSignals = [];
    const windowsChild = {
        pid: 4242,
        exitCode: null,
        signalCode: null,
        kill: (signal) => {
            windowsSignals.push(signal);
            return true;
        },
    };
    windows.softTerminateChild(windowsChild);
    windows.hardTerminateChild(windowsChild);
    assert.deepEqual(windowsSignals, [undefined]);
    assert.deepEqual(invocations, [{
            executable: "taskkill.exe",
            args: ["/PID", "4242", "/T", "/F"],
            shell: false,
            windowsHide: true,
        }]);
    assert.deepEqual(windows.appServerSpawnOptions(), {
        shell: false,
        windowsHide: true,
    });
    const darwinSignals = [];
    const darwinChild = {
        pid: 5252,
        exitCode: null,
        signalCode: null,
        kill: (signal) => {
            darwinSignals.push(signal);
            return true;
        },
    };
    DARWIN_PLATFORM_POLICY.softTerminateChild(darwinChild);
    DARWIN_PLATFORM_POLICY.hardTerminateChild(darwinChild);
    assert.deepEqual(darwinSignals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(DARWIN_PLATFORM_POLICY.appServerSpawnOptions(), {
        shell: false,
    });
});
test("unsupported platforms fail clearly and cwd tool schema wording stays native", () => {
    assert.throws(() => platformPolicyFor("linux"), /Unsupported platform linux/);
    for (const toolName of ["codex_threads", "codex_turn"]) {
        const tool = TOOL_DEFINITIONS.find(({ name }) => name === toolName);
        const properties = tool?.inputSchema.properties;
        const description = String(properties?.cwd?.description ?? "");
        assert.match(description, /absolute native cwd/i);
        assert.doesNotMatch(description, /Windows|macOS|POSIX/);
    }
});
test("shared child shutdown escalates in order and verifies exit after hard termination", async () => {
    const events = [];
    const child = new EventEmitter();
    child.pid = 6262;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = { end: () => events.push("graceful") };
    child.kill = () => true;
    const policy = {
        ...DARWIN_PLATFORM_POLICY,
        hasChildExited: (candidate) => candidate.exitCode !== null || candidate.signalCode !== null,
        softTerminateChild: () => events.push("soft"),
        hardTerminateChild: () => {
            events.push("hard");
            child.exitCode = 137;
            child.emit("exit", 137, null);
        },
    };
    await terminateAppServerChild(child, policy, { gracefulMs: 1, softMs: 1, hardMs: 10 });
    assert.deepEqual(events, ["graceful", "soft", "hard"]);
    assert.equal(policy.hasChildExited(child), true);
});
test("shutdown rechecks prevent soft and hard escalation after a newly observed exit", async (t) => {
    const createChild = (events) => {
        const child = new EventEmitter();
        child.pid = 6767;
        child.exitCode = null;
        child.signalCode = null;
        child.stdin = { end: () => events.push("graceful") };
        child.kill = () => true;
        return child;
    };
    await t.test("pre-soft recheck", async () => {
        const events = [];
        const child = createChild(events);
        let exitChecks = 0;
        const policy = {
            ...DARWIN_PLATFORM_POLICY,
            hasChildExited: () => ++exitChecks === 3,
            softTerminateChild: () => events.push("soft"),
            hardTerminateChild: () => events.push("hard"),
        };
        await terminateAppServerChild(child, policy, { gracefulMs: 1, softMs: 1, hardMs: 1 });
        assert.equal(exitChecks, 3);
        assert.deepEqual(events, ["graceful"]);
    });
    await t.test("pre-hard recheck", async () => {
        const events = [];
        const child = createChild(events);
        let exitChecks = 0;
        const policy = {
            ...DARWIN_PLATFORM_POLICY,
            hasChildExited: () => ++exitChecks === 5,
            softTerminateChild: () => events.push("soft"),
            hardTerminateChild: () => events.push("hard"),
        };
        await terminateAppServerChild(child, policy, { gracefulMs: 1, softMs: 1, hardMs: 1 });
        assert.equal(exitChecks, 5);
        assert.deepEqual(events, ["graceful", "soft"]);
    });
});
test("hard-termination command failure is followed by tracked-child exit verification", async () => {
    const events = [];
    const child = new EventEmitter();
    child.pid = 7272;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = { end: () => events.push("graceful") };
    child.kill = () => true;
    const policy = {
        ...DARWIN_PLATFORM_POLICY,
        hasChildExited: (candidate) => candidate.exitCode !== null || candidate.signalCode !== null,
        softTerminateChild: () => events.push("soft"),
        hardTerminateChild: () => {
            events.push("hard-failed");
            queueMicrotask(() => {
                child.exitCode = 1;
                child.emit("exit", 1, null);
            });
            throw new Error("synthetic hard-stop command failure");
        },
    };
    await terminateAppServerChild(child, policy, { gracefulMs: 1, softMs: 1, hardMs: 10 });
    assert.deepEqual(events, ["graceful", "soft", "hard-failed"]);
    assert.equal(policy.hasChildExited(child), true);
});
