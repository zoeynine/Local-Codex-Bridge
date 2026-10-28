import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import type { AppServerManager } from "../src/app-server.js";
import { ITEM_POLICIES, NOTIFICATION_POLICIES } from "../src/compact-schema.js";
import { NOTIFICATION_SHAPES } from "../src/compact-descriptors.js";
import { COMPACT_BATCH_CHARS, COMPACT_DRAIN_CEILING, COMPACT_EVENT_CHARS, routeCompactEvent } from "../src/observe-compact.js";
import { RuntimeStore, compactPlanSignatureFor, type RuntimeEvent } from "../src/runtime.js";
import { ControlSurface } from "../src/tools.js";
import { INSTALLED_NOTIFICATION_METHODS, INSTALLED_THREAD_ITEM_TYPES } from "./compact-installed-schema.js";

type Result = Record<string, any>;
const scope = { threadId: "t", turnId: "u", itemId: "i" };

function control(runtime: RuntimeStore): ControlSurface {
  return new ControlSurface({ runtime, request: async () => ({ thread: { id: "stored", turns: [] } }) } as unknown as AppServerManager);
}
function started(ringLimit?: number): RuntimeStore {
  const runtime = new RuntimeStore(ringLimit);
  runtime.markTurnAccepted("t", "u");
  return runtime;
}
function event(method: string, data: unknown, cursor = 1): RuntimeEvent {
  return { cursor, at: "2026-09-24T00:00:00.000Z", category: "event", method, data };
}
function completed(runtime: RuntimeStore, item: Record<string, unknown>): void {
  runtime.recordNotification("item/completed", { threadId: "t", turnId: "u", completedAtMs: 1, item });
}
function message(runtime: RuntimeStore, id: string, text: string, phase: string | null = "commentary"): void {
  completed(runtime, { type: "agentMessage", id, text, phase });
}
function command(id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "commandExecution", id, command: "npm test", cwd: "D:\\Bridge", commandActions: [], status, ...extra };
}
function rateLimits(): Record<string, unknown> {
  return { rateLimits: { limitId: null, limitName: null, normalModelSlug: null,
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, secondary: null,
    credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null } };
}
function turnCompleted(runtime: RuntimeStore, id: string, text: string): void {
  runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status: "completed", items: [{ type: "agentMessage", id, text, phase: "final_answer" }] } });
}
async function observe(runtime: RuntimeStore, cursor = 0, limit = 50, waitMs = 0, view: "compact" | "raw" = "compact"): Promise<Result> {
  return await control(runtime).call("codex_observe", { thread_id: "t", cursor, limit, wait_ms: waitMs, view }) as Result;
}

test("installed experimental schema is exhaustively classified by explicit manifest", () => {
  assert.equal(INSTALLED_NOTIFICATION_METHODS.length, 87);
  assert.equal(INSTALLED_THREAD_ITEM_TYPES.length, 19);
  assert.deepEqual(Object.keys(NOTIFICATION_POLICIES).sort(), [...INSTALLED_NOTIFICATION_METHODS].sort());
  assert.deepEqual(Object.keys(NOTIFICATION_SHAPES.methods).sort(), [...INSTALLED_NOTIFICATION_METHODS].sort());
  assert.deepEqual(Object.keys(ITEM_POLICIES).sort(), [...INSTALLED_THREAD_ITEM_TYPES].sort());
  for (const policy of [...Object.values(NOTIFICATION_POLICIES), ...Object.values(ITEM_POLICIES)]) {
    if (typeof policy === "object") {
      assert.equal(policy.kind, "diagnostic_passthrough");
      assert.equal(typeof policy.wake, "boolean");
    }
  }
});

test("gateway OAuth known shapes stay silent while malformed shapes fail open", async () => {
  const method = "account/gatewayOAuth/changed";
  for (const status of ["notReady", "started", "succeeded", "failed"]) {
    for (const optional of [{}, { authUrl: null, error: null }, { authUrl: "https://example.invalid/login", error: "native detail" }]) {
      const data = { providerId: "fixture-provider", status, ...optional };
      const routed = routeCompactEvent(event(method, data));
      assert.equal(routed.wake, false);
      assert.equal(routed.fact, null);
      assert.equal(routed.activity, undefined);
    }
  }
  for (const data of [{ status: "started" }, { providerId: 42, status: "started" },
    { providerId: "fixture-provider", status: "future-status" },
    { providerId: "fixture-provider", status: "started", authUrl: 42 }]) {
    const routed = routeCompactEvent(event(method, data));
    assert.equal(routed.wake, true);
    assert.equal(routed.fact?.type, "unknown");
  }

  const runtime = started();
  const pending = observe(runtime, 0, 50, 1_000);
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.recordNotification(method, { providerId: "fixture-provider", status: "started" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const compact = await observe(runtime);
  assert.equal(compact.next_cursor, 1);
  assert.equal(compact.events, undefined);
  assert.equal(compact.activity, undefined);
  const raw = await observe(runtime, 0, 50, 0, "raw");
  assert.equal(raw.next_cursor, 1);
  assert.equal(raw.events[0].method, method);
  assert.equal(raw.events[0].data.status, "started");
  message(runtime, "after-oauth", "next supervision wake");
  const woken = await pending;
  assert.equal(woken.next_cursor, 2);
  assert.deepEqual(woken.events.map((fact: Result) => fact.type), ["message"]);
});

test("installed-known diagnostic with a missing required schema field fails open as unknown", () => {
  const routed = routeCompactEvent(event("thread/closed", {}));
  assert.equal(routed.wake, true);
  assert.equal(routed.fact?.type, "unknown");
});

test("revision repro: settings boundary is typed and wakes", () => {
  const settings = { approvalPolicy: "never", approvalsReviewer: "user", collaborationMode: { mode: "default", settings: { model: "m" } }, cwd: "D:\\Bridge", model: "m", modelProvider: "openai", sandboxPolicy: { type: "dangerFullAccess" } };
  const changed = routeCompactEvent(event("thread/settings/updated", { threadId: "t", threadSettings: settings }));
  assert.equal(changed.fact?.type, "settings");
  assert.equal(changed.wake, true);
  const runtime = started();
  runtime.recordNotification("thread/settings/updated", { threadId: "t", threadSettings: settings });
  runtime.recordNotification("thread/settings/updated", { threadId: "t", threadSettings: { ...settings, personality: "friendly" } });
  const routes = runtime.observe("t", 0, 50)!.events.map((entry) => routeCompactEvent(entry));
  assert.equal(routes[0]?.fact?.type, "settings");
  assert.equal(routes[1]?.fact, null);
  runtime.recordNotification("thread/settings/updated", { threadId: "t", threadSettings: { ...settings, cwd: "D:\\Other" } });
  assert.equal(routeCompactEvent(runtime.observe("t", 2, 50)!.events[0]!).wake, true);
});
test("revision repro: optional reasoning shape stays silent", () => {
  assert.equal(routeCompactEvent(event("item/completed", { threadId: "t", turnId: "u", completedAtMs: 1, item: { type: "reasoning", id: "r" } })).fact, null);
});
test("revision-2 repro: malformed installed turn and ignored attachment wake through codex_observe", async () => {
  const runtime = started();
  runtime.recordNotification("turn/started", { threadId: "t", turn: {} });
  assert.equal(routeCompactEvent(runtime.observe("t", 0, 50)!.events[0]!).wake, true);
  const malformedTurn = await observe(runtime);
  assert.equal(malformedTurn.events?.[0]?.type, "unknown");
  assert.equal(malformedTurn.events?.[0]?.method, "turn/started");
  assert.ok(JSON.stringify(malformedTurn.events[0]).length <= COMPACT_EVENT_CHARS);
  runtime.recordNotification("thread/attachment/updated", { threadId: "t", attachmentId: 42, attachmentType: "file", identityKey: "x", operation: "created" });
  assert.equal(routeCompactEvent(runtime.observe("t", malformedTurn.next_cursor, 50)!.events[0]!).wake, true);
  const malformedAttachment = await observe(runtime, malformedTurn.next_cursor);
  assert.equal(malformedAttachment.events?.[0]?.type, "unknown");
  assert.equal(malformedAttachment.events?.[0]?.method, "thread/attachment/updated");
  assert.ok(JSON.stringify(malformedAttachment.events[0]).length <= COMPACT_EVENT_CHARS);
});
test("revision-2 control: absent optional reasoning fields remain silent through codex_observe", async () => {
  const runtime = started();
  completed(runtime, { type: "reasoning", id: "r" });
  const result = await observe(runtime);
  assert.equal(result.next_cursor, 1);
  assert.equal(result.events, undefined);
  assert.equal(result.activity.reasoning, 1);
});

test("revision-3: installed ignored notifications validate nested and array shapes", async () => {
  const runtime = started();
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["fs/changed", { watchId: "w", changedPaths: [42] }, true],
    ["fs/changed", { watchId: "w", changedPaths: ["a"] }, false],
    ["account/rateLimits/updated", { rateLimits: { primary: 42 } }, true],
    ["account/rateLimits/updated", { rateLimits: {} }, false],
    ["thread/realtime/outputAudio/delta", { threadId: "t", audio: { data: "AA==", numChannels: 1, sampleRate: 24000 } }, false],
    ["thread/realtime/outputAudio/delta", { threadId: "t", audio: { data: 42, numChannels: 1, sampleRate: 24000 } }, true],
    ["rawResponse/completed", { threadId: "t", turnId: "u", responseId: "r" }, false],
    ["rawResponse/completed", { threadId: "t", turnId: "u", responseId: "r", usage: 42 }, true],
    ["rawResponse/completed", { threadId: "t", turnId: "u", responseId: "r", usage: null, usageMetadata: null }, false],
    ["rawResponse/completed", { threadId: "t", turnId: "u" }, true],
    ["rawResponse/completed", { threadId: "t", turnId: "u", responseId: 42 }, true],
    ["rawResponseItem/completed", { threadId: "t", turnId: "u", item: { type: "other" } }, false],
    ["rawResponseItem/completed", { threadId: "t", turnId: "u", item: { type: 42 } }, true],
    ["item/fileChange/patchUpdated", { ...scope, changes: [{ path: "a", kind: 42, diff: "patch" }] }, true],
    ["item/fileChange/patchUpdated", { ...scope, changes: [{ path: "a", kind: { type: "update" }, diff: "patch" }] }, false],
    ["thread/closed", { threadId: 42 }, true],
    ["thread/closed", { threadId: "t" }, false],
  ];
  let cursor = 0;
  const observed: Array<[string, boolean]> = [];
  for (const [method, params, malformed] of cases) {
    runtime.recordNotification(method, params);
    const result = await observe(runtime, cursor);
    observed.push([method, result.events?.[0]?.type === "unknown"]);
    assert.equal(result.next_cursor, ++cursor, method);
  }
  assert.deepEqual(observed, cases.map(([method, , malformed]) => [method, malformed]));
});
test("stable image storage alternatives and raw additional tools retain their existing routes only for valid shapes", () => {
  for (const [storage, valid] of [
    [{ fileId: "generated-image-file" }, true],
    [{ result: "inline-image" }, true],
    [{ fileId: "generated-image-file", result: "" }, true], // Native schema permits both.
    [{}, false],
    [{ fileId: 42 }, false],
    [{ result: null }, false],
  ] as const) {
    const routed = routeCompactEvent(event("item/completed", {
      threadId: "t", turnId: "u", completedAtMs: 1,
      item: { type: "imageGeneration", id: "image", status: "completed", ...storage },
    }));
    assert.equal(routed.wake, !valid);
    assert.equal(routed.fact?.type, valid ? "image_generation" : "unknown");
    assert.equal(routed.activity, undefined);
    if (valid) assert.deepEqual(routed.fact, { type: "image_generation", item_id: "image", state: "completed" });
  }
  for (const [item, valid] of [
    [{ type: "additional_tools", role: "assistant", tools: [{ name: "native-tool" }] }, true],
    [{ type: "additional_tools", role: "assistant" }, false],
    [{ type: "additional_tools", role: "assistant", tools: 42 }, false],
  ] as const) {
    const routed = routeCompactEvent(event("rawResponseItem/completed", { threadId: "t", turnId: "u", item }));
    assert.equal(routed.wake, !valid);
    assert.equal(routed.fact?.type, valid ? undefined : "unknown");
    assert.equal(routed.activity, undefined);
  }
});

test("revision-2: long plan digest stays fixed, deduplicates, and resets across interrupted turn", async () => {
  const longStep = "x".repeat(100_000);
  assert.equal(compactPlanSignatureFor([{ step: longStep, status: "pending" }]).length, 64);
  assert.notEqual(compactPlanSignatureFor([{ step: longStep, status: "pending" }]), compactPlanSignatureFor([{ step: longStep, status: "completed" }]));
  const runtime = started();
  const plan = (turnId: string, status: string) => ({ threadId: "t", turnId, explanation: null, plan: [{ step: longStep, status }] });
  runtime.recordNotification("turn/plan/updated", plan("u", "pending"));
  const first = await observe(runtime);
  assert.equal(first.events?.[0]?.type, "plan");
  runtime.recordNotification("turn/plan/updated", plan("u", "pending"));
  const duplicate = await observe(runtime, first.next_cursor);
  assert.equal(duplicate.events, undefined);
  runtime.recordNotification("turn/plan/updated", plan("u", "completed"));
  const changed = await observe(runtime, duplicate.next_cursor);
  assert.equal(changed.events?.[0]?.steps?.[0]?.status, "completed");
  runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status: "interrupted", items: [] } });
  runtime.markTurnAccepted("t", "v");
  runtime.recordNotification("turn/plan/updated", plan("v", "completed"));
  const interrupted = await observe(runtime, changed.next_cursor);
  const nextTurn = await observe(runtime, interrupted.next_cursor);
  assert.equal(nextTurn.events?.some((entry: Result) => entry.type === "plan"), true);
});
test("revision repro: malformed diagnostic fails open", () => {
  assert.equal(routeCompactEvent(event("thread/closed", { threadId: 42 })).fact?.type, "unknown");
});
test("revision repro: successful process exit drops stdout", () => {
  const success = routeCompactEvent(event("process/exited", { processHandle: "p", exitCode: 0, stdout: "SUCCESS_BODY", stderr: "", stdoutCapReached: false, stderrCapReached: false }));
  assert.equal(success.wake, false);
  assert.equal(JSON.stringify(success.fact).includes("SUCCESS_BODY"), false);
  const failed = routeCompactEvent(event("process/exited", { processHandle: "p", exitCode: 1, stdout: "", stderr: "FAILURE", stdoutCapReached: false, stderrCapReached: false }));
  assert.equal(failed.wake, true);
  assert.equal(failed.fact?.error_tail, "FAILURE");
  for (const method of ["process/outputDelta", "command/exec/outputDelta"]) {
    const streamed = routeCompactEvent(event(method, { [method.startsWith("process") ? "processHandle" : "processId"]: "p", stream: "stdout", capReached: false, deltaBase64: "U1VDQ0VTUw==" }));
    assert.equal(streamed.wake, false);
    assert.equal(streamed.fact, null);
  }
});

test("revision repro: consumed final stays consumed after eviction", async () => {
  const final = started(2);
  message(final, "f", "FINAL", "final_answer");
  const consumed = await observe(final);
  final.recordNotification("item/agentMessage/delta", { ...scope, delta: "later" });
  turnCompleted(final, "f", "FINAL");
  const next = await observe(final, consumed.next_cursor);
  assert.equal(next.terminal.final_result, undefined);
  const many = started(2);
  message(many, "f", "FINAL", "final_answer");
  const first = await observe(many);
  message(many, "m1", "intermediate");
  message(many, "m2", "intermediate");
  turnCompleted(many, "f", "FINAL");
  assert.equal((await observe(many, first.next_cursor)).terminal.final_result, undefined);
  assert.equal((await observe(many, 0)).terminal.final_result, "FINAL");
});
test("revision repro: failed command uses actual output tail", async () => {
  const failed = started();
  completed(failed, command("c", "failed", { exitCode: 1, aggregatedOutput: "x".repeat(9_000) + "ERROR_TAIL" }));
  const projected = await observe(failed);
  assert.match(projected.events[0].error_tail, /ERROR_TAIL$/);
  const raw = await observe(failed, 0, 50, 0, "raw");
  assert.equal(JSON.stringify(raw.events).includes("ERROR_TAIL"), false);
});
test("revision repro: ahead cursor does not skip future", async () => {
  const ahead = started();
  ahead.recordNotification("item/reasoning/textDelta", { ...scope, delta: "a", contentIndex: 0 });
  const initial = await observe(ahead, 100);
  assert.equal(initial.next_cursor, 1);
  message(ahead, "m", "new");
  const continued = await observe(ahead, initial.next_cursor);
  assert.equal(continued.events[0].text, "new");
});

test("raw wait retains accepted command-output silence and failed-command wake", async () => {
  const runtime = started();
  let settled = false;
  const waiting = observe(runtime, 0, 50, 200, "raw").then((result) => { settled = true; return result; });
  runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "stdout" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  completed(runtime, command("c", "failed", { exitCode: 1, aggregatedOutput: "bad" }));
  const result = await waiting;
  assert.deepEqual(result.events.map((entry: RuntimeEvent) => entry.method), ["item/commandExecution/outputDelta", "item/completed"]);
});

test("36-event noise fixture has zero installed-known unknowns and only plan/commentary wake", () => {
  const runtime = started();
  for (let i = 0; i < 6; i++) runtime.recordNotification("item/reasoning/summaryTextDelta", { ...scope, delta: "thinking", summaryIndex: 0 });
  for (let i = 0; i < 3; i++) runtime.recordNotification("item/reasoning/summaryPartAdded", { ...scope, summaryIndex: i });
  for (let i = 0; i < 2; i++) runtime.recordNotification("turn/plan/updated", { threadId: "t", turnId: "u", explanation: null, plan: [{ step: "inspect", status: "inProgress" }] });
  for (let i = 0; i < 2; i++) runtime.recordNotification("account/rateLimits/updated", rateLimits());
  for (let i = 0; i < 10; i++) runtime.recordNotification("item/agentMessage/delta", { ...scope, delta: "x" });
  for (let i = 0; i < 10; i++) runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "x" });
  runtime.recordNotification("item/started", { threadId: "t", turnId: "u", startedAtMs: 1, item: { type: "reasoning", id: "r", summary: [], content: [] } });
  completed(runtime, { type: "reasoning", id: "r", summary: [], content: [] });
  message(runtime, "m", "complete commentary");
  const events = runtime.observe("t", 0, 100)!.events;
  const routes = events.map((candidate) => routeCompactEvent(candidate));
  assert.equal(events.length, 36);
  assert.equal(routes.filter((route) => route.fact?.type === "unknown").length, 0);
  assert.equal(routes.filter((route) => route.wake).length, 2);
  assert.deepEqual(routes.filter((route) => route.wake).map((route) => route.fact?.type), ["plan", "message"]);
});

test("commentary delta accumulates without wake; completed commentary wakes with full text", async () => {
  const runtime = started();
  let settled = false;
  const pending = observe(runtime, 0, 50, 300).then((value) => { settled = true; return value; });
  runtime.recordNotification("item/agentMessage/delta", { ...scope, itemId: "m", delta: "partial" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  message(runtime, "m", "complete commentary");
  const result = await pending;
  assert.deepEqual(result.events, [{ type: "message", item_id: "m", phase: "commentary", text: "complete commentary" }]);
  assert.equal(result.activity["item/agentMessage/delta"], 1);
  assert.equal(result.next_cursor, 2);
});

test("raw wait keeps its earlier unknown-method wake while compact accumulates reasoning", async () => {
  const runtime = started();
  let compactSettled = false;
  const compactWait = observe(runtime, 0, 50, 80).then((value) => { compactSettled = true; return value; });
  const rawWait = observe(runtime, 0, 50, 80, "raw");
  runtime.recordNotification("item/reasoning/summaryTextDelta", { ...scope, delta: "thinking", summaryIndex: 0 });
  const raw = await rawWait;
  assert.equal(raw.events[0].method, "item/reasoning/summaryTextDelta");
  assert.equal(compactSettled, false);
  const compact = await compactWait;
  assert.equal(compact.events, undefined);
  assert.equal(compact.activity["item/reasoning/summaryTextDelta"], 1);
});

test("225 silent reasoning, command-output, and file-patch events drain before commentary in one call", async () => {
  const runtime = started();
  for (let i = 0; i < 75; i++) runtime.recordNotification("item/reasoning/summaryTextDelta", { ...scope, delta: "r", summaryIndex: 0 });
  for (let i = 0; i < 75; i++) runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "out" });
  for (let i = 0; i < 75; i++) runtime.recordNotification("item/fileChange/patchUpdated", { ...scope, changes: [{ path: "a.txt", kind: { type: "update" }, diff: "large patch" }] });
  message(runtime, "m", "after silent events");
  const compact = await observe(runtime, 0, 50);
  assert.equal(compact.next_cursor, 226);
  assert.equal(compact.has_more, undefined);
  assert.deepEqual(compact.events.map((fact: Result) => fact.type), ["message"]);
  assert.equal(compact.activity["item/reasoning/summaryTextDelta"], 75);
  assert.equal(compact.activity["item/commandExecution/outputDelta"], 75);
  assert.equal(compact.activity["item/fileChange/patchUpdated"], 75);
  const raw = await observe(runtime, 0, 50, 0, "raw");
  assert.equal(raw.events.length, 50);
  assert.equal(raw.next_cursor, 50);
  assert.equal(raw.has_more, true);
});

test("silent-only deadline advances cursor and keeps activity; pure quiet returns no_change", async () => {
  const runtime = started();
  const pending = observe(runtime, 0, 50, 70);
  setTimeout(() => runtime.recordNotification("item/agentMessage/delta", { ...scope, delta: "x" }), 10);
  const active = await pending;
  assert.equal(active.next_cursor, 1);
  assert.equal(active.activity["item/agentMessage/delta"], 1);
  assert.equal(active.no_change, undefined);
  const quiet = await observe(runtime, 1, 50, 15);
  assert.deepEqual(quiet, { runtime_available: true, runtime_status: "inProgress", active_turn_id: "u", next_cursor: 1, no_change: true });
});

test("revision-only wake returns the current active turn in the same compact envelope", async () => {
  const runtime = started();
  const pending = observe(runtime, 0, 50, 1_000);
  await Promise.resolve();
  runtime.markTurnAccepted("t", "v");
  const compact = await pending;
  assert.equal(compact.runtime_status, "inProgress");
  assert.equal(compact.active_turn_id, "v");
  assert.equal(compact.next_cursor, 0);
  assert.equal(compact.no_change, undefined);
  assert.equal(compact.events, undefined);
  const raw = await observe(runtime, 0, 50, 0, "raw");
  assert.equal(raw.active_turn_id, "v");
  assert.equal(raw.next_cursor, 0);
  assert.deepEqual(raw.events, []);
});

test("multi-chunk compact deadline stays fixed despite continuing silent events", async () => {
  const runtime = started(800);
  for (let i = 0; i < 210; i++) runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "x" });
  const start = performance.now();
  const stream = setInterval(() => runtime.recordNotification("item/reasoning/textDelta", { ...scope, delta: "r", contentIndex: 0 }), 15);
  try {
    const result = await observe(runtime, 0, 50, 100);
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 80 && elapsed < 230, `elapsed ${elapsed}`);
    assert.ok(result.next_cursor > 210);
    assert.equal(result.no_change, undefined);
  } finally { clearInterval(stream); }
});

test("independent safety ceiling returns explicit resumable drainage yield", async () => {
  const runtime = started(3_000);
  for (let i = 0; i < COMPACT_DRAIN_CEILING + 2; i++) runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "x" });
  message(runtime, "m", "after ceiling");
  const first = await observe(runtime, 0, 50);
  assert.equal(first.next_cursor, COMPACT_DRAIN_CEILING);
  assert.equal(first.continuation, "drainage_yield");
  assert.equal(first.has_more, true);
  assert.equal(first.events, undefined);
  const second = await observe(runtime, first.next_cursor, 50);
  assert.equal(second.next_cursor, COMPACT_DRAIN_CEILING + 3);
  assert.equal(second.events[0].text, "after ceiling");
});

test("fact limit is separate from native scan count and preserves a consumable prefix", async () => {
  const runtime = started();
  for (let i = 0; i < 100; i++) runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "x" });
  completed(runtime, command("a", "completed", { exitCode: 0 }));
  completed(runtime, command("b", "completed", { exitCode: 0 }));
  const first = await observe(runtime, 0, 1);
  assert.equal(first.next_cursor, 101);
  assert.equal(first.events.length, 1);
  assert.equal(first.continuation, "fact_limit");
  const second = await observe(runtime, first.next_cursor, 1);
  assert.equal(second.next_cursor, 102);
  assert.equal(second.events[0].item_id, "b");
});

test("plan snapshot wakes only when steps or status change, including across observe calls", async () => {
  const runtime = started();
  const plan = (status: string) => ({ threadId: "t", turnId: "u", explanation: null, plan: [{ step: "inspect", status }] });
  runtime.recordNotification("turn/plan/updated", plan("inProgress"));
  const first = await observe(runtime);
  assert.equal(first.events[0].type, "plan");
  runtime.recordNotification("turn/plan/updated", plan("inProgress"));
  const repeat = await observe(runtime, first.next_cursor);
  assert.equal(repeat.next_cursor, 2);
  assert.equal(repeat.events, undefined);
  runtime.recordNotification("turn/plan/updated", plan("completed"));
  const changed = await observe(runtime, repeat.next_cursor);
  assert.equal(changed.events[0].steps[0].status, "completed");
});

test("rate limits, token usage, and UI account/app notifications stay in raw but leave no compact fact or activity", async () => {
  const runtime = started();
  runtime.recordNotification("account/rateLimits/updated", rateLimits());
  runtime.recordNotification("account/rateLimits/updated", { rateLimits: {} }); // Native JSON schema permits sparse rolling updates.
  runtime.recordNotification("account/updated", { authMode: null, planType: null });
  runtime.recordNotification("app/list/updated", { data: [] });
  const usage = { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  runtime.recordNotification("thread/tokenUsage/updated", { threadId: "t", turnId: "u", tokenUsage: { last: usage, total: { ...usage }, modelContextWindow: null } });
  const compact = await observe(runtime);
  assert.equal(compact.next_cursor, 5);
  assert.equal(compact.events, undefined);
  assert.equal(compact.activity, undefined);
  const raw = await observe(runtime, 0, 50, 0, "raw");
  assert.deepEqual(raw.events.map((entry: RuntimeEvent) => entry.method), ["account/rateLimits/updated", "account/rateLimits/updated", "account/updated", "app/list/updated", "thread/tokenUsage/updated"]);
});

test("known diagnostic is distinct from truly unknown and neither nests stringified JSON", () => {
  const diagnostic = routeCompactEvent(event("thread/closed", { threadId: "t", reason: "done" }), { threadId: "t" });
  const future = routeCompactEvent(event("future/method", { threadId: "t", turnId: "u", nested: { value: 1 } }), { threadId: "t", activeTurnId: "u" });
  assert.equal(diagnostic.fact?.type, "diagnostic_passthrough");
  assert.equal(future.fact?.type, "unknown");
  assert.equal(typeof future.fact?.data, "object");
  assert.deepEqual(future.fact?.data, { nested: { value: 1 } });
  assert.equal(future.wake, true);
  const malformedKnown = routeCompactEvent(event("item/reasoning/summaryTextDelta", { ...scope, delta: "x" }));
  assert.equal(malformedKnown.fact?.type, "unknown");
  assert.equal(malformedKnown.wake, true);
});

test("stable read-state and prediction diagnostics wake without adopting native state; malformed shapes stay unknown", async () => {
  const runtime = started();
  runtime.recordServerRequest(7, "item/permissions/requestApproval", { threadId: "t", turnId: "u", itemId: "i", permissions: {} });
  const before = runtime.observe("t", 0, 50)!;
  const notifications = [
    ["thread/readState/changed", { readState: { firstUnread: { type: "turn", turnId: "u" }, revision: "native-revision" } },
      { readState: { firstUnread: { type: "turn", turnId: "u" } } }],
    ["thread/prediction/updated", { sourceTurnId: "u", result: { type: "completed", text: "suggested follow-up" } },
      { sourceTurnId: "u", result: { type: "completed", text: 42 } }],
  ] as const;
  for (const [method, data, malformed] of notifications) {
    const params = { threadId: "t", ...data };
    const routed = routeCompactEvent(event(method, params), { threadId: "t", activeTurnId: "u" });
    assert.equal(routed.fact?.type, "diagnostic_passthrough");
    assert.equal(routed.wake, true);
    assert.deepEqual(routed.fact?.data, data);
    assert.ok(JSON.stringify(routed.fact).length <= COMPACT_EVENT_CHARS);
    runtime.recordNotification(method, params);
    const invalid = routeCompactEvent(event(method, { threadId: "t", ...malformed }));
    assert.equal(invalid.fact?.type, "unknown");
    assert.equal(invalid.wake, true);
  }
  const observed = runtime.observe("t", before.next_cursor, 50)!;
  assert.deepEqual(observed.events.map(entry => entry.method), notifications.map(([method]) => method));
  assert.deepEqual(observed.events.map(entry => entry.data), notifications.map(([, data]) => ({ threadId: "t", ...data })));
  assert.equal(observed.active_turn_id, "u");
  assert.equal(observed.terminal, null);
  assert.deepEqual(observed.pending_requests, before.pending_requests);
  assert.equal("readState" in observed, false);
  assert.equal("firstUnread" in observed, false);
  const facts: Result[] = [];
  let cursor = before.next_cursor;
  while (facts.length < notifications.length) {
    const compact = await observe(runtime, cursor);
    assert.ok(compact.next_cursor > cursor, "continuation must consume the next diagnostic");
    assert.ok(compact.events?.length > 0);
    assert.equal(compact.active_turn_id, "u");
    assert.equal(compact.terminal, undefined);
    assert.deepEqual(compact.pending_requests, before.pending_requests);
    facts.push(...compact.events);
    cursor = compact.next_cursor;
  }
  assert.deepEqual(facts.map(fact => fact.type), ["diagnostic_passthrough", "diagnostic_passthrough"]);
  assert.deepEqual(facts.map(fact => fact.method), notifications.map(([method]) => method));
  const bounded = routeCompactEvent(event("thread/prediction/updated", {
    threadId: "t", sourceTurnId: "u", result: { type: "completed", text: "x".repeat(10_000) },
  }));
  assert.equal(bounded.fact?.type, "diagnostic_passthrough");
  assert.equal(bounded.wake, true);
  assert.ok(JSON.stringify(bounded.fact).length <= COMPACT_EVENT_CHARS);
});

test("stable open error information preserves future variants while malformed primitives stay unknown", () => {
  for (const codexErrorInfo of ["sessionBudgetExceeded", "futurePolicy", { futurePolicy: { retryable: false } }]) {
    const routed = routeCompactEvent(event("error", {
      threadId: "t", turnId: "u", willRetry: false,
      error: { message: "Native error detail", codexErrorInfo },
    }));
    assert.equal(routed.fact?.type, "error");
    assert.equal(routed.wake, true);
    assert.deepEqual(JSON.parse(routed.fact?.message as string).codexErrorInfo, codexErrorInfo);
  }
  for (const malformed of [
    ...[42, false, []].map(codexErrorInfo => ({
      threadId: "t", turnId: "u", willRetry: false,
      error: { message: "Malformed native error detail", codexErrorInfo },
    })),
    { threadId: "t", turnId: "u", willRetry: false, error: { message: 42, codexErrorInfo: "futurePolicy" } },
    { threadId: "t", turnId: "u", error: { message: "Missing retry flag", codexErrorInfo: "futurePolicy" } },
  ]) {
    const routed = routeCompactEvent(event("error", malformed));
    assert.equal(routed.fact?.type, "unknown");
    assert.equal(routed.wake, true);
  }
});

test("command action and cwd remain typed; success omits output body; failure has bounded tail", () => {
  const startedCommand = routeCompactEvent(event("item/started", { threadId: "t", turnId: "u", startedAtMs: 1, item: command("c", "inProgress") }));
  const succeeded = routeCompactEvent(event("item/completed", { threadId: "t", turnId: "u", completedAtMs: 2, item: command("c", "completed", { exitCode: 0, aggregatedOutput: "SECRET_STDOUT" }) }));
  const failed = routeCompactEvent(event("item/completed", { threadId: "t", turnId: "u", completedAtMs: 3, item: command("f", "failed", { exitCode: 2, aggregatedOutput: "head" + "x".repeat(10_000) + "TAIL" }) }));
  assert.equal(startedCommand.fact?.command, "npm test");
  assert.equal(startedCommand.fact?.cwd, "D:\\Bridge");
  assert.equal(succeeded.wake, false);
  assert.equal(succeeded.fact?.output_chars, 13);
  assert.equal(JSON.stringify(succeeded.fact).includes("SECRET_STDOUT"), false);
  assert.equal(failed.wake, true);
  assert.equal(failed.fact?.exit_code, 2);
  assert.ok((failed.fact?.error_tail as string).endsWith("TAIL"));
  assert.ok((failed.fact?.error_tail as string).length <= 2_000);
  assert.equal(JSON.stringify(failed.fact).includes("head"), false);
});

test("file, MCP, dynamic, web, and collaboration lifecycle facts omit large bodies", () => {
  const shapes = [
    { type: "fileChange", id: "f", status: "completed", changes: [{ path: "a.txt", kind: { type: "update" }, diff: "FULL_DIFF" }] },
    { type: "mcpToolCall", id: "m", status: "completed", server: "s", tool: "fetch", arguments: {}, result: { content: ["FULL_RESULT"] } },
    { type: "dynamicToolCall", id: "d", status: "completed", tool: "run", arguments: { payload: "FULL_CONTENT" } },
    { type: "webSearch", id: "w", query: "question", action: null, results: ["FULL_RESULTS"] },
    { type: "collabAgentToolCall", id: "c", tool: "spawnAgent", status: "completed", senderThreadId: "t", receiverThreadIds: ["child"], agentsStates: {}, prompt: "FULL_PROMPT" },
    { type: "subAgentActivity", id: "s", kind: "completed", agentThreadId: "child", agentPath: "a" },
  ];
  const routes = shapes.map((item) => routeCompactEvent(event("item/completed", { threadId: "t", turnId: "u", completedAtMs: 1, item })));
  assert.deepEqual(routes.map((route) => route.fact?.type), ["file", "tool", "tool", "web_search", "collaboration", "subagent"]);
  assert.equal(JSON.stringify(routes).includes("FULL_"), false);
  assert.deepEqual(routes[0]?.fact?.paths, ["a.txt"]);
});

test("auto-review, guardian warning, strict review, and permission request are typed while pending params remain authoritative", async () => {
  const review = { status: "approved", riskLevel: "low", userAuthorization: "medium", rationale: "UNSTABLE_RATIONALE" };
  const action = { type: "command", source: "shell", command: "npm test", cwd: "D:\\Bridge" };
  const approval = routeCompactEvent(event("item/autoApprovalReview/completed", { threadId: "t", turnId: "u", reviewId: "r", startedAtMs: 1, completedAtMs: 2, targetItemId: "i", decisionSource: "agent", review, action }));
  assert.equal(approval.fact?.type, "auto_approval_review");
  assert.equal(approval.fact?.review_status, "approved");
  assert.equal(approval.fact?.action_type, "command");
  assert.equal(JSON.stringify(approval.fact).includes("UNSTABLE_RATIONALE"), false);
  assert.equal(routeCompactEvent(event("guardianWarning", { threadId: "t", message: "review warning" })).fact?.type, "warning");
  assert.equal(routeCompactEvent(event("autoApprovalReview/strictReviewRequired", { threadId: "t", turnId: "u", startedAtMs: 1 })).fact?.state, "strict_review_required");
  const runtime = started();
  const params = { threadId: "t", turnId: "u", itemId: "i", startedAtMs: 1, cwd: "D:\\Bridge", environmentId: null, reason: "need access", permissions: { network: null, fileSystem: { write: ["D:\\Bridge"] } } };
  runtime.recordServerRequest(7, "item/permissions/requestApproval", params);
  const result = await observe(runtime);
  assert.equal(result.events[0].type, "request");
  assert.equal(result.events[0].request_id, 7);
  assert.deepEqual(result.pending_requests[0].params, params);
});

test("final and partial answers deliver once in monotonic cursor stream; native status and old-cursor replay remain intact", async () => {
  for (const phase of ["final_answer", "partial_answer"]) for (const length of [3_000, 10_000]) {
    const runtime = started();
    const text = "F".repeat(length);
    const status = phase === "partial_answer" ? "interrupted" : "completed";
    message(runtime, "final", text, phase);
    runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status,
      items: [{ type: "agentMessage", id: "final", text, phase }] } });
    const first = await observe(runtime);
    assert.equal(first.events.filter((fact: Result) => fact.type === "message").length, 1);
    assert.equal(first.events[0].phase, phase);
    assert.ok(JSON.stringify(first.events[0]).length <= COMPACT_EVENT_CHARS);
    assert.equal(first.terminal.status, status);
    assert.equal(first.terminal.final_result, undefined);
    assert.equal(first.terminal.final_result_pending, length > 4_000 ? true : undefined);
    assert.equal(first.terminal.final_result_meta?.complete, length > 4_000 ? undefined : true);
    const next = await observe(runtime, first.next_cursor);
    assert.equal(next.events, undefined);
    assert.equal(next.terminal.status, status);
    assert.equal(next.terminal.final_result_pending, undefined);
    assert.equal(next.terminal.final_result, length > 4_000 ? text : undefined);
    assert.equal((await observe(runtime, next.next_cursor)).terminal.final_result, undefined);
    const replay = await observe(runtime, 0);
    assert.equal(replay.events[0].type, "message");
  }
});

test("compact final completion preserves the middle and real projection completeness", async () => {
  for (const text of [
    "HEAD" + "x".repeat(5_000) + "VERDICT_MIDDLE" + "y".repeat(5_000) + "TAIL",
    "x".repeat(47_980) + "VERDICT_AT_END",
    "\u0001".repeat(3_000), // Under 4k, but JSON escaping exceeds the event budget.
  ]) {
    const runtime = started();
    message(runtime, "f", text, "final_answer");
    const first = await observe(runtime);
    assert.notEqual(first.events[0].text, text);
    runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status: "completed", items: [] } });
    const end = await observe(runtime, first.next_cursor);
    assert.equal(end.terminal.final_result, text);
    assert.equal(end.terminal.final_result_meta.complete, true);
    assert.equal((await observe(runtime, end.next_cursor)).terminal.final_result, undefined);
  }
  const changed = started();
  message(changed, "f", "EARLIER", "final_answer");
  const earlier = await observe(changed);
  turnCompleted(changed, "f", "UPDATED_FINAL");
  assert.equal((await observe(changed, earlier.next_cursor)).terminal.final_result, "UPDATED_FINAL");
});

test("terminal metadata waits for final content when final and terminal arrive together", async () => {
  for (const wait of [false, true]) for (const terminalItems of [false, true]) {
    for (const length of [3_000, 10_033, 60_024]) {
      const runtime = started();
      const text = "A".repeat(length);
      const waiting = wait ? observe(runtime, 0, 50, 10_000) : null;
      // A synchronous burst also exercises an already-waiting observer without timers.
      message(runtime, "f", text, "final_answer");
      runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status: "completed",
        items: terminalItems ? [{ type: "agentMessage", id: "f", text, phase: "final_answer" }] : [] } });
      const first = await (waiting ?? observe(runtime));
      assert.equal(first.terminal.status, "completed");
      assert.equal(first.has_more, true);
      assert.equal(first.terminal.final_result, undefined);
      if (length > 4_000) {
        assert.notEqual(first.events[0].text, text);
        assert.equal(first.terminal.final_result_pending, true);
        assert.equal(first.terminal.final_result_meta, undefined);
      } else {
        assert.equal(first.events[0].text, text);
        assert.equal(first.terminal.final_result_pending, undefined);
        assert.equal(first.terminal.final_result_meta.complete, true);
      }
      const next = await observe(runtime, first.next_cursor);
      assert.equal(next.terminal.final_result_pending, undefined);
      assert.equal(next.terminal.final_result, length > 4_000 ? text.slice(0, 48_000) : undefined);
      assert.equal(next.terminal.final_result_meta.complete, length <= 48_000);
      assert.equal((await observe(runtime, next.next_cursor)).terminal.final_result, undefined);
      assert.deepEqual((await observe(runtime, 0)).terminal, first.terminal);
    }
  }
});

test("a terminal snapshot cannot advertise an unscanned short final as complete", async () => {
  const runtime = started();
  message(runtime, "earlier", "Still working");
  message(runtime, "f", "DONE", "final_answer");
  turnCompleted(runtime, "f", "DONE");
  const before = await observe(runtime, 0, 1);
  assert.equal(before.events[0].item_id, "earlier");
  assert.equal(before.terminal.final_result_pending, true);
  assert.equal(before.terminal.final_result_meta, undefined);
  const final = await observe(runtime, before.next_cursor, 1);
  assert.equal(final.events[0].text, "DONE");
  assert.equal(final.terminal.final_result_pending, undefined);
  assert.equal(final.terminal.final_result_meta.complete, true);
  assert.equal(final.terminal.final_result, undefined);
});

test("a later empty message start preserves compact final identity and once-only delivery", async () => {
  for (const status of ["completed", "interrupted"]) for (const length of [3_000, 10_000]) {
    const runtime = started();
    const text = "F".repeat(length);
    message(runtime, "f", text, "final_answer");
    const first = await observe(runtime);
    runtime.recordNotification("item/started", { threadId: "t", turnId: "u", startedAtMs: 2,
      item: { type: "agentMessage", id: "next", text: "", phase: null } });
    runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status, items: [] } });
    const end = await observe(runtime, first.next_cursor);
    assert.equal(end.terminal.status, status);
    assert.equal(end.terminal.final_result, length > 4_000 ? text : undefined);
    assert.equal(end.terminal.final_result_meta.complete, true);
    assert.equal(end.terminal.final_result_pending, undefined);
    assert.equal((await observe(runtime, end.next_cursor)).terminal.final_result, undefined);
  }
});

test("compact distinguishes a bounded or partial terminal from a complete final", async () => {
  const text = "HEAD-MARKER " + "x".repeat(60_000) + " TAIL-MARKER";
  for (const completedItem of [true, false]) {
    const runtime = started(2);
    runtime.recordNotification("item/agentMessage/delta", { ...scope, delta: text });
    if (completedItem) message(runtime, "i", text, "final_answer");
    runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status: completedItem ? "completed" : "interrupted", items: [] } });
    let cursor = 0; let final: Result | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await observe(runtime, cursor);
      cursor = page.next_cursor;
      if (page.terminal.final_result !== undefined) final = page.terminal;
      if (!page.has_more) break;
    }
    assert.ok(final);
    assert.equal(final.final_result.length, 48_000);
    assert.equal(final.final_result_meta.complete, false);
    assert.equal(final.final_result_meta.source_complete, completedItem);
    assert.equal(final.final_result_meta.truncated, true);
    assert.equal(final.final_result_meta.observed_chars, text.length);
    assert.equal(final.final_result_meta.retained, completedItem ? "head" : "tail");
    assert.equal((await observe(runtime, cursor)).terminal.final_result, undefined);
  }
});

test("compact head/tail clipping does not split surrogate pairs", () => {
  const text = "a".repeat(1_999) + "🌱" + "b".repeat(3_999) + "🌱" + "c".repeat(1_999);
  const routed = routeCompactEvent(event("item/completed", { threadId: "t", turnId: "u", completedAtMs: 1,
    item: { type: "agentMessage", id: "f", phase: "final_answer", text } }));
  assert.equal((routed.fact!.text as string).isWellFormed(), true);
  assert.equal((routed.fact!.text_truncation as Result).head_chars, 1_999);
  assert.equal((routed.fact!.text_truncation as Result).tail_chars, 1_999);
});

test("split final and evicted final fallback are each delivered once", async () => {
  const runtime = started(); const text = "S".repeat(3_000);
  message(runtime, "final", text, "final_answer");
  const first = await observe(runtime);
  turnCompleted(runtime, "final", text);
  const second = await observe(runtime, first.next_cursor);
  assert.equal(second.terminal.final_result, undefined);
  const evicted = started(2);
  message(evicted, "final", text, "final_answer");
  evicted.recordNotification("item/agentMessage/delta", { ...scope, delta: "other" });
  turnCompleted(evicted, "final", text);
  const fallback = await observe(evicted);
  assert.equal(fallback.cursor_lost, true);
  assert.equal(fallback.cursor_floor, 1);
  assert.equal(fallback.terminal.final_result, text);
  const after = await observe(evicted, fallback.next_cursor);
  assert.equal(after.terminal.final_result, undefined);
});

test("fact budget, lifecycle coalescing, and continuation envelope preserve raw replay", async () => {
  const runtime = started();
  runtime.recordNotification("item/started", { threadId: "t", turnId: "u", startedAtMs: 1, item: command("c", "inProgress") });
  completed(runtime, command("c", "completed", { exitCode: 0 }));
  const coalesced = await observe(runtime);
  assert.equal(coalesced.events.length, 1);
  assert.equal(coalesced.events[0].lifecycle, "completed");
  assert.equal(coalesced.events[0].cursor, undefined);
  assert.equal(coalesced.next_cursor, 2);
  assert.equal(coalesced.cursor_floor, undefined);
  assert.equal(coalesced.trace, undefined);
  const raw = await observe(runtime, 0, 50, 0, "raw");
  assert.deepEqual(raw.events.map((entry: RuntimeEvent) => entry.cursor), [1, 2]);
  const large = started(100);
  for (let i = 0; i < 70; i++) completed(large, command(`c-${i}`, "completed", { command: "a".repeat(1_000), exitCode: 0 }));
  const budget = await observe(large, 0, 100);
  assert.equal(budget.continuation, "event_budget");
  assert.ok(budget.next_cursor < 70);
  assert.ok(JSON.stringify(budget.events).length <= COMPACT_BATCH_CHARS + 100);
  const continued = await observe(large, budget.next_cursor, 100);
  assert.equal(continued.events[0].item_id, `c-${budget.next_cursor}`);
});

test("routing inspects original array tails before raw transport truncation", async () => {
  const malformed = started();
  malformed.recordNotification("fs/changed", { watchId: "w", changedPaths: [...Array(90).fill("valid"), 42] });
  const unknown = await observe(malformed);
  assert.equal(unknown.events[0].type, "unknown");

  const valid = started();
  valid.recordNotification("item/fileChange/patchUpdated", { ...scope, changes: Array.from({ length: 90 }, (_, i) => ({ path: String(i), kind: { type: "update" }, diff: "patch" })) });
  const rawBefore = JSON.stringify(await observe(valid, 0, 50, 0, "raw"));
  const compact = await observe(valid);
  assert.equal(compact.events, undefined);
  assert.equal(compact.activity["item/fileChange/patchUpdated"], 1);
  assert.equal(compact.next_cursor, 1);
  assert.equal(JSON.stringify(await observe(valid, 0, 50, 0, "raw")), rawBefore);
  assert.equal(rawBefore.includes("compactRoute"), false);
});

test("invalid plan and settings events cannot suppress subsequent valid snapshots", async () => {
  const runtime = started();
  const plan = { ...scope, explanation: null, plan: [{ step: "inspect", status: "pending" }] };
  const settings = { approvalPolicy: "never", approvalsReviewer: "user", collaborationMode: { mode: "default", settings: { model: "m" } }, cwd: "D:\\Bridge", model: "m", modelProvider: "openai", sandboxPolicy: { type: "dangerFullAccess" } };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ["turn/plan/updated", { ...plan, explanation: 42 }, plan, "plan"],
    ["thread/settings/updated", { threadId: "t", threadSettings: { ...settings, personality: 42 } }, { threadId: "t", threadSettings: settings }, "settings"],
  ];
  let cursor = 0;
  for (const [method, invalid, valid, type] of cases) {
    runtime.recordNotification(method, invalid);
    const malformed = await observe(runtime, cursor);
    assert.equal(malformed.events[0].type, "unknown");
    runtime.recordNotification(method, valid);
    const delivered = await observe(runtime, malformed.next_cursor);
    assert.equal(delivered.events[0].type, type);
    runtime.recordNotification(method, valid);
    const duplicate = await observe(runtime, delivered.next_cursor);
    assert.equal(duplicate.events, undefined);
    cursor = duplicate.next_cursor;
  }
});

test("invalid final items leave one terminal fallback available", async () => {
  for (const invalid of [
    { threadId: "t", turnId: "u", item: { type: "agentMessage", id: "f", text: "FINAL", phase: "final_answer" } },
    { threadId: "t", turnId: "u", completedAtMs: 1, item: { type: "agentMessage", id: "f", text: "FINAL", phase: "future_phase" } },
  ]) {
    const runtime = started();
    runtime.recordNotification("item/completed", invalid);
    const malformed = await observe(runtime);
    assert.equal(malformed.events[0].type, "unknown");
    turnCompleted(runtime, "f", "FINAL");
    const terminal = await observe(runtime, malformed.next_cursor);
    assert.equal(terminal.terminal.final_result, "FINAL");
    assert.equal((await observe(runtime, terminal.next_cursor)).terminal.final_result, undefined);
  }
});

test("lifecycle coalescing uses original identity and never consumes a malformed completion", async () => {
  const id = "item-" + "x".repeat(5_000);
  const runtime = started();
  runtime.recordNotification("item/started", { threadId: "t", turnId: "u", startedAtMs: 1, item: command(id + "a", "inProgress") });
  completed(runtime, command(id + "b", "completed", { exitCode: 0 }));
  const distinct = await observe(runtime);
  assert.equal(distinct.events.length, 2);
  assert.deepEqual(distinct.events.map((fact: Result) => fact.lifecycle), ["started", "completed"]);

  const malformed = started();
  malformed.recordNotification("item/started", { threadId: "t", turnId: "u", startedAtMs: 1, item: command(id, "inProgress") });
  completed(malformed, command(id, "completed", { exitCode: "bad" }));
  const preserved = await observe(malformed);
  assert.deepEqual(preserved.events.map((fact: Result) => fact.type), ["command", "unknown"]);
});

test("cached projections stay bounded and replay scope elision leaves retained facts intact", async () => {
  const runtime = started();
  completed(runtime, { type: "fileChange", id: "files", status: "completed", changes: Array.from({ length: 90 }, (_, i) => ({ path: "\\\n".repeat(500) + i, kind: { type: "update" }, diff: "diff".repeat(1_000) })) });
  const files = await observe(runtime);
  assert.equal(files.events[0].type, "file");
  assert.equal(files.events[0].change_count, 90);
  assert.ok(JSON.stringify(files.events[0]).length <= COMPACT_EVENT_CHARS);
  runtime.recordNotification("future/method", { ...scope, message: "evidence" });
  const retained = runtime.observe("t", files.next_cursor, 50)!.events[0]!;
  const before = JSON.stringify(retained.compactRoute);
  const scoped = routeCompactEvent(retained, { threadId: "t", activeTurnId: "u" });
  assert.equal((scoped.fact?.data as Result).threadId, undefined);
  assert.equal(JSON.stringify(retained.compactRoute), before);
  assert.equal((routeCompactEvent(retained).fact?.data as Result).threadId, "t");
});

test("an elapsed compact deadline never hides an outstanding approval as no_change", async (t) => {
  const runtime = started();
  const params = {
    ...scope, command: "npm test",
    networkApprovalContext: { host: "api.example.com", protocol: "https" },
    proposedNetworkPolicyAmendments: [
      { host: "api.example.com", action: "allow" },
      { host: "api.example.com", action: "deny" },
    ],
  };
  runtime.recordServerRequest(7, "item/commandExecution/requestApproval", params);
  // The request event was already consumed, but the request remains pending.
  // Advance the clock during snapshot collection to exercise the deadline edge
  // without relying on host timing or an arbitrary sleep.
  let expired = false;
  const read = runtime.observe.bind(runtime);
  t.mock.method(performance, "now", () => expired ? 2 : 0);
  t.mock.method(runtime, "observe", (...args: Parameters<RuntimeStore["observe"]>) => {
    const result = read(...args);
    expired = true;
    return result;
  });
  const result = await observe(runtime, 1, 50, 1);
  assert.equal(result.no_change, undefined);
  assert.equal(result.pending_requests.length, 1);
  assert.equal(result.pending_requests[0].request_id, 7);
  assert.deepEqual(result.pending_requests[0].params, params);
  assert.equal(result.next_cursor, 1);
});

test("stream loss preserves commentary and sparse compact pages never skip retained facts", async () => {
  const runtime = started(4);
  message(runtime, "first", "first commentary"); // 1
  runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "a" }); // 2
  message(runtime, "second", "second commentary"); // 3
  for (let i = 0; i < 100; i++) runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, itemId: `i-${i % 3}`, delta: "output" });
  message(runtime, "third", "third commentary"); // 104
  for (let i = 0; i < 100; i++) runtime.recordNotification("item/reasoning/textDelta", { ...scope, delta: "thinking", contentIndex: i % 2 });
  const retained = runtime.observe("t", 0, 100)!;
  assert.deepEqual(retained.events.map((entry) => entry.cursor), [1, 3, 104, 204]);
  assert.equal(retained.cursor_floor, 0);
  assert.equal(retained.stream_lost, true);
  assert.equal(retained.facts_lost, false);
  for (const limit of [1, 2, 10]) {
    let cursor = 0;
    const seen: string[] = [];
    for (let page = 0; cursor < 204 && page < 5; page++) {
      const result = await observe(runtime, cursor, limit);
      assert.ok(result.next_cursor > cursor);
      assert.equal(result.facts_lost, undefined);
      assert.equal(result.no_change, undefined);
      seen.push(...(result.events ?? []).map((fact: Result) => fact.item_id));
      cursor = result.next_cursor;
    }
    assert.equal(cursor, 204);
    assert.deepEqual(seen, ["first", "second", "third"]);
  }
  assert.deepEqual(runtime.observe("t", 0, 100), retained);
});

test("stream-only loss stays diagnostic across repeated bounded waits and new activity", async () => {
  const runtime = started(3);
  let cursor = 0;
  for (let round = 0; round < 2; round++) {
    const cancellation = new AbortController();
    let settled = false;
    const pending = runtime.observeCompactWithWait("t", cursor, 50, 10_000, cancellation.signal)
      .then((result) => { settled = true; return result as Result; });
    try {
      // Synchronous bursts overflow storage before the waiter can scan them.
      for (let i = 0; i < 100; i++) runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, itemId: `stream-${i % 4}`, delta: "output" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "stream loss must not terminate the compact wait");
      for (let i = 0; i < 100; i++) runtime.recordNotification("item/agentMessage/delta", { ...scope, delta: "partial" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "subsequent stream loss must not create a wake loop");
      message(runtime, `wake-${round}`, "supervision wake");
      const result = await pending;
      assert.equal(result.stream_lost, true);
      assert.equal(result.cursor_lost, true);
      assert.equal(result.facts_lost, undefined);
      assert.equal(result.no_change, undefined);
      assert.equal(result.events.at(-1).item_id, `wake-${round}`);
      assert.ok(result.next_cursor > cursor);
      cursor = result.next_cursor;
    } finally { cancellation.abort(); await pending; }
  }
});

test("a stream-loss deadline returns progress once and the next quiet deadline is no_change", async (t) => {
  const runtime = started(3);
  for (let i = 0; i < 20; i++) runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "x" });
  let expired = false;
  const read = runtime.observe.bind(runtime);
  t.mock.method(performance, "now", () => expired ? 2 : 0);
  t.mock.method(runtime, "observe", (...args: Parameters<RuntimeStore["observe"]>) => {
    const result = read(...args);
    expired = true;
    return result;
  });
  const result = await observe(runtime, 0, 50, 1);
  assert.equal(result.next_cursor, 20);
  assert.equal(result.stream_lost, true);
  assert.equal(result.facts_lost, undefined);
  assert.equal(result.no_change, undefined);
  assert.equal(result.activity["item/commandExecution/outputDelta"], 3);
  expired = false;
  const quiet = await observe(runtime, result.next_cursor, 50, 1);
  assert.equal(quiet.no_change, true);
  assert.equal(quiet.stream_lost, undefined);
  assert.equal(quiet.next_cursor, 20);
});

test("facts loss wakes compact even when every retained event is normally silent", async () => {
  for (const buffered of [true, false]) {
    const runtime = started(3);
    const overflowFacts = () => {
      for (let i = 0; i < 4; i++) runtime.recordNotification("account/updated", { authMode: null, planType: null });
    };
    if (buffered) overflowFacts();
    const cancellation = new AbortController();
    const pending = runtime.observeCompactWithWait("t", 0, 50, 10_000, cancellation.signal);
    try {
      if (!buffered) overflowFacts();
      const result = await Promise.race([pending, new Promise<null>((resolve) => setImmediate(() => resolve(null)))]) as Result | null;
      assert.notEqual(result, null, "facts loss must return before waiting for another event");
      assert.equal(result!.facts_lost, true);
      assert.equal(result!.stream_lost, undefined);
      assert.equal(result!.cursor_lost, true);
      assert.equal(result!.events, undefined);
      assert.equal(result!.next_cursor, 4);
      assert.equal(result!.no_change, undefined);
    } finally { cancellation.abort(); await pending; }
  }
});

test("evicted approval events still wake compact and expose the actionable pending request", async () => {
  const runtime = started(3);
  runtime.recordServerRequest("approval", "item/commandExecution/requestApproval", { ...scope, command: "npm test" });
  for (let i = 0; i < 4; i++) runtime.recordNotification("account/updated", { authMode: null, planType: null });
  assert.equal(runtime.observe("t", 0, 100)!.events.some((entry) => entry.method.endsWith("requestApproval")), false);
  const result = await observe(runtime, runtime.currentCursor("t"), 50, 10_000);
  assert.equal(result.pending_requests[0].request_id, "approval");
  assert.equal(result.no_change, undefined);
  const claimed = runtime.claimPending("approval", { threadId: "t", turnId: "u", method: "item/commandExecution/requestApproval" });
  runtime.completePending(claimed);
  assert.deepEqual(runtime.pendingForThread("t"), []);
});

test("an evicted final behind a retained older delta respects scan and replay boundaries", async () => {
  const runtime = started(3);
  runtime.recordNotification("item/commandExecution/outputDelta", { ...scope, delta: "older output" }); // 1 stays retained
  message(runtime, "final", "FINAL", "final_answer"); // 2
  turnCompleted(runtime, "final", "FINAL"); // 3
  runtime.recordNotification("future/after-terminal", { threadId: "t" }); // 4 evicts final
  runtime.recordNotification("future/after-terminal", { threadId: "t" }); // 5 evicts terminal
  const raw = runtime.observe("t", 0, 100)!;
  assert.equal(raw.cursor_floor, 0);
  assert.deepEqual(raw.events.map((entry) => entry.cursor), [1, 4, 5]);
  assert.equal(raw.terminal?.final_result, "FINAL");
  assert.equal(raw.facts_lost, true);
  // Force an ordinary scan ceiling before the missing final's position.
  const { projectCompact } = await import("../src/observe-compact.js");
  const identity = { itemCursor: 2, terminalCursor: 3, turnId: "u", itemEvicted: true };
  const beforeAnchor = projectCompact(runtime.observe("t", 0, 1)!, 0, {}, identity) as Result;
  assert.equal(beforeAnchor.next_cursor, 1);
  assert.equal(beforeAnchor.terminal.final_result, undefined);
  assert.equal(beforeAnchor.terminal.final_result_pending, true);
  assert.equal(beforeAnchor.terminal.final_result_meta, undefined);
  const first = await observe(runtime, beforeAnchor.next_cursor, 1);
  assert.equal(first.next_cursor, 4);
  assert.equal(first.terminal.final_result, "FINAL");
  assert.equal(first.terminal.final_result_pending, undefined);
  assert.equal(first.terminal.final_result_meta.complete, true);
  const next = await observe(runtime, first.next_cursor, 1);
  assert.equal(next.next_cursor, 5);
  assert.equal(next.terminal.final_result, undefined);
  assert.equal((await observe(runtime, 0, 1)).terminal.final_result, "FINAL");
  // A caught-up observer sees the terminal immediately without replaying final text.
  const caughtUp = await observe(runtime, 5, 50, 10_000);
  assert.equal(caughtUp.terminal.status, "completed");
  assert.equal(caughtUp.terminal.final_result, undefined);
  assert.equal(caughtUp.no_change, undefined);
});
