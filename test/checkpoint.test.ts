import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppServerManager } from "../src/app-server.js";
import {
  CHECKPOINT_DIRECTORY_ENV,
  CheckpointStore,
  LEGACY_CHECKPOINT_DIRECTORY_ENV,
  resolveCheckpointDirectory,
} from "../src/checkpoint.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

const unavailableAppServer = {} as unknown as AppServerManager;

test("checkpoint is the sole addition to the existing tool catalog", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), [
    "codex_threads",
    "codex_turn",
    "codex_observe",
    "codex_steer",
    "codex_respond",
    "codex_interrupt",
    "codex_checkpoint",
  ]);
  const turn = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_turn");
  assert.match(
    turn?.description ?? "",
    /Prefer continuing the same native thread when its context remains useful, but a fresh thread is allowed/,
  );
  assert.match(turn?.description ?? "", /thread_id is not a permanent task identity/);
  const checkpoint = TOOL_DEFINITIONS.at(-1);
  assert.match(
    checkpoint?.description ?? "",
    /Initialization is not tied to crossing a ChatGPT window or round/,
  );
  assert.match(
    checkpoint?.description ?? "",
    /initialize early when a task is already expected to be sufficiently long or complex/,
  );
  assert.match(
    checkpoint?.description ?? "",
    /elapsed time, observe\/poll count, token count, or mere silence are not automatic triggers/,
  );
  assert.match(checkpoint?.description ?? "", /Do not use for one-shot work/);
  assert.match(checkpoint?.description ?? "", /keyed to one native Codex thread_id/);
  assert.match(
    checkpoint?.description ?? "",
    /the key is not a permanent task identity and does not require future work to remain on that thread/,
  );
  assert.match(
    checkpoint?.description ?? "",
    /Before final acceptance of a checkpointed task, read it once/,
  );
  const observe = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_observe");
  assert.match(
    observe?.description ?? "",
    /absence of new command activity alone is not evidence of a stall/,
  );
  const steer = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_steer");
  assert.match(
    steer?.description ?? "",
    /steer only for a semantic redirect or correction based on new evidence or changed user intent/,
  );
});

test("checkpoint directory uses the macOS default without automatic Windows fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "local-codex-bridge-darwin-home-"));
  try {
    const canonical = join(
      home,
      "Library",
      "Application Support",
      "LocalCodexBridge",
      "checkpoints",
    );
    assert.equal(resolveCheckpointDirectory({}, home), canonical);

    const formerCanonical = join(
      home,
      "AppData",
      "Local",
      "LocalCodexBridge",
      "checkpoints",
    );
    mkdirSync(formerCanonical, { recursive: true });
    assert.equal(resolveCheckpointDirectory({}, home), canonical);

    assert.throws(() => resolveCheckpointDirectory({}, "relative-home"), /absolute macOS home/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("checkpoint directory honors explicit canonical and legacy environment aliases", () => {
  const home = mkdtempSync(join(tmpdir(), "local-codex-bridge-checkpoint-env-test-"));
  const explicitCanonical = join(home, "explicit-canonical");
  const explicitLegacy = join(home, "explicit-legacy");
  try {
    assert.equal(
      resolveCheckpointDirectory({
        [CHECKPOINT_DIRECTORY_ENV]: explicitCanonical,
        [LEGACY_CHECKPOINT_DIRECTORY_ENV]: explicitLegacy,
      }, home),
      explicitCanonical,
    );
    assert.equal(
      resolveCheckpointDirectory({
        [LEGACY_CHECKPOINT_DIRECTORY_ENV]: explicitLegacy,
      }, home),
      explicitLegacy,
    );
    assert.throws(
      () => resolveCheckpointDirectory({ [CHECKPOINT_DIRECTORY_ENV]: "relative" }, home),
      /must be an absolute path/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("checkpoint keeps immutable original plus only previous/current across store instances", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-codex-bridge-checkpoint-store-test-"));
  const threadId = "019f-checkpoint-native-thread";

  try {
    const firstControl = new ControlSurface(
      unavailableAppServer,
      new CheckpointStore(directory),
    );
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
    assert.throws(
      () => new CheckpointStore(directory).read(oversizedThreadId),
      /Checkpoint file exceeds the bounded size limit/,
    );
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
    }) as Record<string, unknown>;
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
    }) as Record<string, unknown>;
    const updatedCheckpoint = updated.checkpoint as Record<string, unknown>;
    assert.equal(
      (updatedCheckpoint.previous as Record<string, unknown>).current_understanding,
      "Understanding A",
    );
    assert.equal(
      (updatedCheckpoint.current as Record<string, unknown>).current_understanding,
      "Understanding B",
    );

    for (const [field, changed] of [
      ["original_goal", "Changed goal"],
      ["original_constraints", "Changed constraints"],
      ["original_acceptance", "Changed acceptance"],
    ] as const) {
      await assert.rejects(
        firstControl.call("codex_checkpoint", {
          action: "update",
          thread_id: threadId,
          [field]: changed,
          current_decision: "Rejected decision",
        }),
        new RegExp(`${field} is immutable after checkpoint initialization`),
      );
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
    }) as Record<string, unknown>;
    const rotatedCheckpoint = rotated.checkpoint as Record<string, unknown>;
    assert.equal(
      (rotatedCheckpoint.original as Record<string, unknown>).original_goal,
      "Original goal",
    );
    assert.equal(
      (rotatedCheckpoint.previous as Record<string, unknown>).current_understanding,
      "Understanding B",
    );
    assert.equal(
      (rotatedCheckpoint.current as Record<string, unknown>).current_understanding,
      "Understanding C",
    );
    assert.equal(
      (rotatedCheckpoint.current as Record<string, unknown>).current_amendment,
      null,
    );
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
    const stored = JSON.parse(readFileSync(join(directory, files[0]!), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal("history" in stored, false);
    assert.equal("events" in stored, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
