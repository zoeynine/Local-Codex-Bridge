import assert from "node:assert/strict";
import test from "node:test";
import { AppServerManager, resolveCodexExecutable } from "../src/app-server.js";
import { ControlSurface } from "../src/tools.js";
import * as appServerExports from "../src/app-server.js";
test("version diagnostics identify older readers without claiming newer versions compatible", () => {
    const diagnose = appServerExports.diagnoseCodexVersion;
    assert.equal(typeof diagnose, "function");
    assert.equal(diagnose("0.147.0", "0.155.0-alpha.16"), "reader_older_than_thread_creator");
    assert.equal(diagnose("0.158.0-alpha.2.1", "0.155.0-alpha.16"), "reader_not_older_compatibility_unverified");
    assert.equal(diagnose(null, "0.155.0"), "version_unknown");
});
test("explicit Desktop binary selection overrides PATH and invalid selections fail", () => {
    assert.equal(resolveCodexExecutable({ CODEX_EXE: "/desktop/codex", CODEX_DESKTOP_EXE: "/other/codex" }), "/desktop/codex");
    assert.equal(resolveCodexExecutable({ CODEX_DESKTOP_EXE: "/desktop/codex" }), "/desktop/codex");
    assert.throws(() => resolveCodexExecutable({ CODEX_DESKTOP_EXE: "bad\npath" }), /control character/);
});
class HistoryManager extends AppServerManager {
    failure;
    mode;
    calls = [];
    constructor(failure, mode = "legacy") {
        super(undefined, { executable: "unused" });
        this.failure = failure;
        this.mode = mode;
    }
    async request(_method, params) {
        const include = params.includeTurns;
        this.calls.push(include);
        if (this.failure && (include || this.failure === "permission denied"))
            throw new Error(this.failure);
        return { thread: { id: "thread-test", cliVersion: "0.155.0-alpha.16", historyMode: this.mode, turns: [] } };
    }
}
test("unbounded turns are rejected without hydration even for incompatible stored items", async () => {
    const manager = new HistoryManager("Codex app-server thread/read failed: unknown variant `functionCallOutput`, expected `userMessage`");
    const surface = new ControlSurface(manager);
    await assert.rejects(surface.call("codex_threads", { thread_id: "thread-test", include_turns: true }), /latest_messages/);
    assert.deepEqual(manager.calls, []);
});
test("observe metadata fallback never synthesizes terminal or live state", async () => {
    const manager = new HistoryManager("unknown variant `functionCallOutput`");
    const result = await new ControlSurface(manager).call("codex_observe", { thread_id: "thread-test" });
    assert.equal(result.history_available, false);
    assert.equal(result.terminal, null);
    assert.equal(result.live_state_reconstructable, false);
});
test("unrelated read errors are not hidden by metadata fallback", async () => {
    const manager = new HistoryManager("permission denied");
    await assert.rejects(new ControlSurface(manager).call("codex_threads", { thread_id: "thread-test" }), /permission denied/);
    assert.deepEqual(manager.calls, [false]);
});
test("read and observe reject another thread's identity including metadata fallback", async () => {
    for (const failure of [undefined, "unknown variant `functionCallOutput`"]) {
        for (const name of ["codex_threads", "codex_observe"]) {
            const manager = new HistoryManager(failure);
            await assert.rejects(new ControlSurface(manager).call(name, {
                thread_id: "another-thread",
            }), /mismatched thread identity/);
        }
    }
});
test("observe paginated history is explicitly unavailable without full hydration", async () => {
    const manager = new HistoryManager(undefined, "paginated");
    const result = await new ControlSurface(manager).call("codex_observe", { thread_id: "thread-test" });
    assert.equal(result.history_available, false);
    assert.equal(result.compatibility.classification, "unbounded_history_disabled");
    assert.deepEqual(manager.calls, [false]);
});
