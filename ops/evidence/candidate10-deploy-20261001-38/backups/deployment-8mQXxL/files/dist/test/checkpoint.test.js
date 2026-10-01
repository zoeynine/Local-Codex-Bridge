import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHECKPOINT_DIRECTORY_ENV, CheckpointStore, LEGACY_CHECKPOINT_DIRECTORY_ENV, resolveCheckpointDirectory, } from "../src/checkpoint.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";
import { DARWIN_PLATFORM_POLICY, WINDOWS_PLATFORM_POLICY, } from "../src/platform.js";
const unavailableAppServer = {};
test("checkpoint remains the final tool in the current tool catalog", () => {
    assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), [
        "codex_threads",
        "codex_models",
        "codex_turn",
        "codex_observe",
        "codex_steer",
        "codex_respond",
        "codex_interrupt",
        "codex_checkpoint",
    ]);
    const turn = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_turn");
    assert.match(turn?.description ?? "", /Prefer continuing the same native thread when its context remains useful, but a fresh thread is allowed/);
    assert.match(turn?.description ?? "", /thread_id is not a permanent task identity/);
    assert.match(turn?.description ?? "", /outcome is UNKNOWN/);
    const checkpoint = TOOL_DEFINITIONS.at(-1);
    assert.match(checkpoint?.description ?? "", /Initialization is not tied to crossing a ChatGPT window or round/);
    assert.match(checkpoint?.description ?? "", /initialize early when a task is already expected to be sufficiently long or complex/);
    assert.match(checkpoint?.description ?? "", /elapsed time, observe\/poll count, token count, or mere silence are not automatic triggers/);
    assert.match(checkpoint?.description ?? "", /Do not use for one-shot work/);
    assert.match(checkpoint?.description ?? "", /keyed to one native Codex thread_id/);
    assert.match(checkpoint?.description ?? "", /the key is not a permanent task identity and does not require future work to remain on that thread/);
    assert.match(checkpoint?.description ?? "", /Before final acceptance of a checkpointed task, read it once/);
    const observe = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_observe");
    assert.match(observe?.description ?? "", /absence of new command activity alone is not evidence of a stall/);
    const steer = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_steer");
    assert.match(steer?.description ?? "", /steer only for a semantic redirect or correction based on new evidence or changed user intent/);
    assert.match(steer?.description ?? "", /outcome is UNKNOWN/);
    const interrupt = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_interrupt");
    assert.match(interrupt?.description ?? "", /outcome is UNKNOWN/);
});
test("Windows checkpoint default preserves legacy data", {
    skip: process.platform !== "win32",
}, () => {
    const base = mkdtempSync(join(tmpdir(), "local-codex-bridge-checkpoint-config-test-"));
    const legacyDefault = join(base, "Lumen", "CodexControlV2", "checkpoints");
    const canonicalDefault = join(base, "LocalCodexBridge", "checkpoints");
    try {
        assert.equal(resolveCheckpointDirectory({ LOCALAPPDATA: base }, base, WINDOWS_PLATFORM_POLICY), canonicalDefault);
        mkdirSync(legacyDefault, { recursive: true });
        assert.equal(resolveCheckpointDirectory({ LOCALAPPDATA: base }, base, WINDOWS_PLATFORM_POLICY), legacyDefault);
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});
test("checkpoint overrides use injected native path semantics and preserve alias precedence", () => {
    assert.equal(resolveCheckpointDirectory({
        [CHECKPOINT_DIRECTORY_ENV]: "D:/Bridge/canonical/../checkpoints",
        [LEGACY_CHECKPOINT_DIRECTORY_ENV]: "E:/legacy",
    }, "D:\\Users\\Example", WINDOWS_PLATFORM_POLICY), "D:\\Bridge\\checkpoints");
    assert.equal(resolveCheckpointDirectory({ [LEGACY_CHECKPOINT_DIRECTORY_ENV]: "E:/legacy/../checkpoints" }, "D:\\Users\\Example", WINDOWS_PLATFORM_POLICY), "E:\\checkpoints");
    assert.equal(resolveCheckpointDirectory({ [CHECKPOINT_DIRECTORY_ENV]: "\\\\server\\share\\bridge\\..\\checkpoints" }, "D:\\Users\\Example", WINDOWS_PLATFORM_POLICY), "\\\\server\\share\\checkpoints");
    assert.equal(resolveCheckpointDirectory({ [CHECKPOINT_DIRECTORY_ENV]: "\\\\?\\D:\\Bridge\\..\\checkpoints" }, "D:\\Users\\Example", WINDOWS_PLATFORM_POLICY), "\\\\?\\D:\\checkpoints");
    assert.equal(resolveCheckpointDirectory({ [CHECKPOINT_DIRECTORY_ENV]: "/Users/example/bridge/../checkpoints" }, "/Users/example", DARWIN_PLATFORM_POLICY), "/Users/example/checkpoints");
});
test("Darwin checkpoint default uses Application Support without Windows fallback", () => {
    assert.equal(resolveCheckpointDirectory({
        LOCALAPPDATA: "D:\\must-not-be-used",
        USERPROFILE: "D:\\must-not-be-used",
    }, "/Users/example", DARWIN_PLATFORM_POLICY), "/Users/example/Library/Application Support/LocalCodexBridge/checkpoints");
    assert.throws(() => resolveCheckpointDirectory({}, "relative-home", DARWIN_PLATFORM_POLICY), /absolute macOS home directory/);
});
test("checkpoint keeps immutable original plus only previous/current across store instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-codex-bridge-checkpoint-store-test-"));
    const threadId = "019f-checkpoint-native-thread";
    try {
        const firstControl = new ControlSurface(unavailableAppServer, new CheckpointStore(directory));
        assert.deepEqual(await firstControl.call("codex_checkpoint", {
            action: "read",
            thread_id: threadId,
        }), {
            source: "local_codex_bridge_checkpoint",
            found: false,
            thread_id: threadId,
            checkpoint: null,
        });
        assert.deepEqual(readdirSync(directory), []);
        const oversizedThreadId = "019f-oversized-checkpoint-thread";
        const oversizedKey = createHash("sha256")
            .update(oversizedThreadId, "utf8")
            .digest("hex");
        const oversizedPath = join(directory, `${oversizedKey}.json`);
        writeFileSync(oversizedPath, Buffer.alloc(256 * 1024 + 1, 0x20));
        assert.throws(() => new CheckpointStore(directory).read(oversizedThreadId), /Checkpoint file exceeds the bounded size limit/);
        rmSync(oversizedPath);
        const initialized = await firstControl.call("codex_checkpoint", {
            action: "update",
            thread_id: threadId,
            original_goal: "Original goal",
            original_constraints: "Original constraints",
            original_acceptance: "Original acceptance",
            current_understanding: "Understanding A",
            current_decision: "Decision A",
            acceptance_status: "Not accepted A",
            next_step: "Step A",
        });
        assert.equal(initialized.operation, "initialized");
        const updated = await firstControl.call("codex_checkpoint", {
            action: "update",
            thread_id: threadId,
            effective_goal: "Effective goal B",
            current_amendment: "Amendment B",
            current_understanding: "Understanding B",
            current_decision: "Decision B",
            acceptance_status: "Not accepted B",
            next_step: "Step B",
        });
        const updatedCheckpoint = updated.checkpoint;
        assert.equal(updatedCheckpoint.previous.current_understanding, "Understanding A");
        assert.equal(updatedCheckpoint.current.current_understanding, "Understanding B");
        for (const [field, changed] of [
            ["original_goal", "Changed goal"],
            ["original_constraints", "Changed constraints"],
            ["original_acceptance", "Changed acceptance"],
        ]) {
            await assert.rejects(firstControl.call("codex_checkpoint", {
                action: "update",
                thread_id: threadId,
                [field]: changed,
                current_decision: "Rejected decision",
            }), new RegExp(`${field} is immutable after checkpoint initialization`));
        }
        const secondStore = new CheckpointStore(directory);
        const recovered = secondStore.read(threadId);
        assert.equal(recovered?.original.original_constraints, "Original constraints");
        assert.equal(recovered?.previous?.current_understanding, "Understanding A");
        assert.equal(recovered?.current.current_understanding, "Understanding B");
        const secondControl = new ControlSurface(unavailableAppServer, secondStore);
        const rotated = await secondControl.call("codex_checkpoint", {
            action: "update",
            thread_id: threadId,
            current_amendment: null,
            current_understanding: "Understanding C",
            current_decision: "Decision C",
            acceptance_status: "Ready for acceptance review",
            next_step: "Read before final acceptance",
        });
        const rotatedCheckpoint = rotated.checkpoint;
        assert.equal(rotatedCheckpoint.original.original_goal, "Original goal");
        assert.equal(rotatedCheckpoint.previous.current_understanding, "Understanding B");
        assert.equal(rotatedCheckpoint.current.current_understanding, "Understanding C");
        assert.equal(rotatedCheckpoint.current.current_amendment, null);
        assert.deepEqual(Object.keys(rotatedCheckpoint).sort(), [
            "created_at",
            "current",
            "original",
            "previous",
            "schema_version",
            "thread_id",
            "updated_at",
        ]);
        const files = readdirSync(directory);
        assert.equal(files.length, 1);
        assert.match(files[0] ?? "", /^[a-f0-9]{64}\.json$/);
        const stored = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
        assert.equal("history" in stored, false);
        assert.equal("events" in stored, false);
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
