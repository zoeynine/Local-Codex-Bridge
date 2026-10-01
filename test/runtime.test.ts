import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import type { AppServerManager } from "../src/app-server.js";
import {
  MAX_OBSERVE_WAIT_MS,
  MAX_STREAMED_AGENT_TEXT_CHARS,
  RuntimeStore,
  sanitizeForTransport,
  type RuntimeObservation,
} from "../src/runtime.js";
import {
  ControlSurface,
  TOOL_DEFINITIONS,
} from "../src/tools.js";

async function within<T>(promise: Promise<T>, milliseconds = 150): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Promise did not settle within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function controlFor(runtime: RuntimeStore): ControlSurface {
  const appServer = {
    runtime,
    binaryDiagnostics: { executable: "synthetic-test", cli_version: null },
    request: async (method: string, params: { threadId: string }): Promise<unknown> => {
      assert.equal(method, "thread/read");
      return { thread: { id: params.threadId, turns: [] } };
    },
  } as unknown as AppServerManager;
  return new ControlSurface(appServer);
}

const RING_THREAD = "thread-retention";
const RING_TURN = "turn-retention";
const OUTPUT_DELTA = "item/commandExecution/outputDelta";

function appendRingDelta(runtime: RuntimeStore, index: number): void {
  runtime.recordNotification(OUTPUT_DELTA, {
    threadId: RING_THREAD,
    turnId: RING_TURN,
    itemId: `command-${index % 5}`,
    delta: `output-${index}`,
  });
}

function appendRingFact(runtime: RuntimeStore, index: number): void {
  runtime.recordNotification("warning", {
    threadId: RING_THREAD,
    turnId: RING_TURN,
    message: `fact-${index}`,
  });
}

function retainedCursors(runtime: RuntimeStore): number[] {
  return runtime.observe(RING_THREAD, 0, 100)!.events.map((event) => event.cursor);
}

test("class-aware ring keeps recent facts through large interleaved delta bursts", () => {
  const runtime = new RuntimeStore(4);
  const facts: number[] = [];
  for (let fact = 0; fact < 8; fact += 1) {
    appendRingFact(runtime, fact);
    facts.push(runtime.currentCursor(RING_THREAD));
    for (let delta = 0; delta < 300; delta += 1) {
      appendRingDelta(runtime, fact * 300 + delta);
      const observed = runtime.observe(RING_THREAD, 0, 100)!;
      assert.ok(observed.events.length <= 4);
      assert.deepEqual(
        observed.events.filter((event) => event.method !== OUTPUT_DELTA).map((event) => event.cursor),
        facts.slice(-3),
      );
      assert.equal(observed.events.at(-1)?.cursor, runtime.currentCursor(RING_THREAD));
    }
  }
  const observed = runtime.observe(RING_THREAD, 0, 100)!;
  assert.equal(observed.stream_lost, true);
  assert.equal(observed.facts_lost, true);
  assert.equal(observed.events.at(-1)?.method, OUTPUT_DELTA);
  assert.deepEqual(observed.events.at(-1)?.data, {
    threadId: RING_THREAD, turnId: RING_TURN, itemId: "command-4", delta: "output-2399",
  });
});

test("class-aware ring uses FIFO within each class and keeps the last delta through fact pressure", () => {
  const runtime = new RuntimeStore(4);
  appendRingDelta(runtime, 1);
  appendRingDelta(runtime, 2);
  appendRingDelta(runtime, 3);
  appendRingDelta(runtime, 4);
  assert.deepEqual(retainedCursors(runtime), [1, 2, 3, 4]);
  appendRingFact(runtime, 5);
  assert.deepEqual(retainedCursors(runtime), [2, 3, 4, 5]);
  appendRingFact(runtime, 6);
  assert.deepEqual(retainedCursors(runtime), [3, 4, 5, 6]);
  appendRingFact(runtime, 7);
  assert.deepEqual(retainedCursors(runtime), [4, 5, 6, 7]);
  appendRingFact(runtime, 8);
  assert.deepEqual(retainedCursors(runtime), [4, 6, 7, 8]);
  appendRingDelta(runtime, 9);
  assert.deepEqual(retainedCursors(runtime), [6, 7, 8, 9]);
});

test("unknown, malformed delta, warning, and ordinary status remain facts", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["future/outputDelta", { itemId: "unknown", delta: "ordinary output" }],
    [OUTPUT_DELTA, { itemId: "malformed", delta: 17 }],
    [OUTPUT_DELTA, { delta: "missing item identity" }],
    ["warning", { message: "ordinary output" }],
    ["thread/status/changed", { status: { type: "active", activeFlags: [] } }],
    ["item/reasoning/summaryPartAdded", { itemId: "reasoning", summaryIndex: 0 }],
    ["item/mcpToolCall/progress", { itemId: "tool", message: "ordinary output" }],
  ];
  for (const [method, params] of cases) {
    const runtime = new RuntimeStore(2);
    runtime.recordNotification(method, { threadId: RING_THREAD, turnId: RING_TURN, ...params });
    for (let index = 0; index < 20; index += 1) appendRingDelta(runtime, index);
    const observed = runtime.observe(RING_THREAD, 0, 100)!;
    assert.deepEqual(observed.events.map((event) => event.cursor), [1, 21], method);
    assert.equal(observed.events[0]?.method, method);
    assert.equal(observed.facts_lost, false, method);
    assert.equal(observed.stream_lost, true, method);
  }
});

test("only valid allowlisted pure delta shapes share stream capacity", () => {
  const itemScope = { threadId: RING_THREAD, turnId: RING_TURN, itemId: "stream" };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["item/agentMessage/delta", { ...itemScope, delta: "warning approval ERROR" }],
    ["item/plan/delta", { ...itemScope, delta: "plan" }],
    [OUTPUT_DELTA, { ...itemScope, delta: "output" }],
    ["item/fileChange/outputDelta", { ...itemScope, delta: "patch" }],
    ["item/reasoning/summaryTextDelta", { ...itemScope, delta: "summary", summaryIndex: 0 }],
    ["item/reasoning/textDelta", { ...itemScope, delta: "thinking", contentIndex: 0 }],
    ["command/exec/outputDelta", { processId: "process", stream: "stdout", deltaBase64: "eA==", capReached: false }],
    ["process/outputDelta", { processHandle: "process", stream: "stderr", deltaBase64: "eA==", capReached: false }],
  ];
  for (const [method, params] of cases) {
    const runtime = new RuntimeStore(2);
    runtime.markTurnAccepted(RING_THREAD, RING_TURN);
    appendRingFact(runtime, 0);
    for (let index = 0; index < 12; index++) runtime.recordNotification(method, params);
    const observed = runtime.observe(RING_THREAD, 0, 100)!;
    assert.deepEqual(observed.events.map((entry) => entry.cursor), [1, 13], method);
    assert.equal(observed.stream_lost, true, method);
    assert.equal(observed.facts_lost, false, method);
    assert.equal(observed.events[1]?.method, method);
    assert.deepEqual(observed.events[1]?.data, params);
    assert.equal(JSON.stringify(observed.events).includes('"streamDelta"'), false);
  }
  for (const [method, params] of cases.slice(-2)) {
    const runtime = new RuntimeStore(2);
    runtime.markTurnAccepted(RING_THREAD, RING_TURN);
    runtime.recordNotification(method, { ...params, capReached: true });
    for (let index = 0; index < 12; index++) runtime.recordNotification(method, params);
    const observed = runtime.observe(RING_THREAD, 0, 100)!;
    assert.deepEqual(observed.events.map((entry) => entry.cursor), [1, 13], `${method} cap flag is a fact`);
    assert.equal(observed.facts_lost, false);
    assert.equal((observed.events[0]?.data as Record<string, unknown>).capReached, true);
  }
  for (const capacity of [0, 1, 1.5]) assert.throws(() => new RuntimeStore(capacity), /at least 2/);
});

test("sparse raw pagination preserves internal records and reports loss over the unread suffix", () => {
  const runtime = new RuntimeStore(4);
  for (const [index, kind] of [..."FDFDDFDD"].entries()) {
    if (kind === "F") appendRingFact(runtime, index);
    else appendRingDelta(runtime, index);
  }
  assert.deepEqual(retainedCursors(runtime), [1, 3, 6, 8]);
  for (let start = 0; start <= 8; start += 1) {
    for (const limit of [1, 2, 3, 4]) {
      let cursor = start;
      const seen: number[] = [];
      for (let page = 0; page < 5; page += 1) {
        const observed = runtime.observe(RING_THREAD, cursor, limit)!;
        assert.equal(observed.cursor_floor, 0);
        assert.equal(observed.stream_lost, cursor < 7);
        assert.equal(observed.facts_lost, false);
        assert.equal(observed.cursor_lost, observed.stream_lost);
        assert.deepEqual(observed.events.map((event) => event.cursor), [1, 3, 6, 8].filter((value) => value > cursor).slice(0, limit));
        seen.push(...observed.events.map((event) => event.cursor));
        if (observed.events.length > 0) assert.equal(observed.next_cursor, observed.events.at(-1)?.cursor);
        if (!observed.has_more) break;
        assert.ok(observed.next_cursor > cursor, "a sparse page must make progress");
        cursor = observed.next_cursor;
        assert.ok(page < 4, "sparse pagination must terminate");
      }
      assert.deepEqual(seen, [1, 3, 6, 8].filter((value) => value > start));
    }
  }
  appendRingFact(runtime, 9);
  assert.deepEqual(retainedCursors(runtime), [3, 6, 8, 9]);
  assert.equal(runtime.observe(RING_THREAD, 0, 1)?.facts_lost, true);
  assert.equal(runtime.observe(RING_THREAD, 1, 1)?.facts_lost, false);
  assert.equal(runtime.observe(RING_THREAD, 1, 1)?.stream_lost, true);
  assert.equal(runtime.observe(RING_THREAD, 7, 1)?.cursor_lost, false);
});

test("small actual runtime rings satisfy retention and cursor properties for every short D/F sequence", () => {
  const length = 7;
  for (let capacity = 2; capacity <= 5; capacity += 1) {
    for (let bits = 0; bits < 2 ** length; bits += 1) {
      const runtime = new RuntimeStore(capacity);
      const facts: number[] = [];
      const deltas: number[] = [];
      for (let index = 0; index < length; index += 1) {
        if ((bits & (1 << index)) === 0) {
          appendRingFact(runtime, index);
          facts.push(index + 1);
        } else {
          appendRingDelta(runtime, index);
          deltas.push(index + 1);
        }
        assert.equal(runtime.currentCursor(RING_THREAD), index + 1);
        const retainedFacts = facts.slice(-(capacity - 1));
        const retainedDeltas = deltas.slice(-(capacity - retainedFacts.length));
        const expected = [...retainedFacts, ...retainedDeltas].sort((a, b) => a - b);
        assert.deepEqual(retainedCursors(runtime), expected, `R=${capacity}, bits=${bits}, prefix=${index + 1}`);
        assert.ok(expected.length <= capacity);
      }
      const retained = retainedCursors(runtime);
      const lastDroppedD = deltas.filter((cursor) => !retained.includes(cursor)).at(-1) ?? 0;
      const lastDroppedF = facts.filter((cursor) => !retained.includes(cursor)).at(-1) ?? 0;
      for (let start = 0; start <= length; start += 1) {
        for (let limit = 1; limit <= capacity; limit += 1) {
          let cursor = start;
          const seen: number[] = [];
          for (let page = 0; page <= capacity; page += 1) {
            const observed = runtime.observe(RING_THREAD, cursor, limit)!;
            assert.equal(observed.stream_lost, lastDroppedD > cursor);
            assert.equal(observed.facts_lost, lastDroppedF > cursor);
            assert.equal(observed.cursor_lost, lastDroppedD > cursor || lastDroppedF > cursor);
            seen.push(...observed.events.map((event) => event.cursor));
            if (!observed.has_more) break;
            assert.ok(observed.next_cursor > cursor);
            cursor = observed.next_cursor;
            assert.ok(page < capacity, "actual runtime pagination must terminate");
          }
          assert.deepEqual(seen, retained.filter((value) => value > start));
        }
      }
      assert.deepEqual(retainedCursors(runtime), retained, "observers must not mutate retention");
    }
  }
});

test("pending request remains actionable after its original fact is evicted", () => {
  const runtime = new RuntimeStore(3);
  runtime.markTurnAccepted(RING_THREAD, RING_TURN);
  runtime.recordServerRequest("approval-retained-state", "item/fileChange/requestApproval", {
    threadId: RING_THREAD, turnId: RING_TURN, itemId: "file-change",
  });
  appendRingDelta(runtime, 2);
  appendRingFact(runtime, 3);
  appendRingFact(runtime, 4);
  const observed = runtime.observe(RING_THREAD, 0, 10)!;
  assert.equal(observed.facts_lost, true);
  assert.equal(observed.events.some((event) => event.method === "item/fileChange/requestApproval"), false);
  assert.equal(observed.pending_requests.length, 1);
  const pending = runtime.claimPending("approval-retained-state", {
    threadId: RING_THREAD, turnId: RING_TURN, method: "item/fileChange/requestApproval",
  });
  assert.equal(pending.rawId, "approval-retained-state");
  runtime.completePending(pending);
  assert.deepEqual(runtime.pendingForThread(RING_THREAD), []);
  assert.throws(() => runtime.claimPending("approval-retained-state", {
    threadId: RING_THREAD, turnId: RING_TURN, method: "item/fileChange/requestApproval",
  }), /No pending/);
});

test("sanitizer redacts obvious secrets and bounds strings", () => {
  const result = sanitizeForTransport(
    {
      api_key: "abc123",
      OPENAI_API_KEY: "prefixed-secret",
      GITHUB_TOKEN: "prefixed-token",
      nested: { authorization: "Bearer secret-value", token_count: 42 },
      text: `Bearer abcdefghijklmnop OPENAI_API_KEY=also-secret ${"x".repeat(100)}`,
    },
    { maxStringChars: 30, totalCharBudget: 500 },
  ) as Record<string, unknown>;
  assert.equal(result.api_key, "[REDACTED]");
  assert.equal(result.OPENAI_API_KEY, "[REDACTED]");
  assert.equal(result.GITHUB_TOKEN, "[REDACTED]");
  assert.deepEqual((result.nested as Record<string, unknown>).token_count, 42);
  assert.equal((result.nested as Record<string, unknown>).authorization, "[REDACTED]");
  assert.match(result.text as string, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(result.text as string, /also-secret/);
  assert.match(result.text as string, /truncated/);
});

test("runtime ring uses monotonic cursors, scopes pending raw ids, and captures terminal output", () => {
  const runtime = new RuntimeStore(2);
  runtime.markTurnAccepted("thread-1", "turn-1");
  runtime.recordNotification("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress" },
  });
  runtime.recordServerRequest("raw-7", "item/fileChange/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    password: "secret",
  });
  const pending = runtime.claimPending("raw-7", {
    threadId: "thread-1",
    turnId: "turn-1",
    method: "item/fileChange/requestApproval",
  });
  assert.equal(pending.rawId, "raw-7");
  runtime.completePending(pending);
  assert.throws(
    () => runtime.claimPending(7, {
      threadId: "thread-1",
      method: "item/fileChange/requestApproval",
    }),
    /No pending/,
  );
  runtime.recordNotification("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "DONE" },
  });
  runtime.recordNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "DONE" }],
    },
  });
  const observed = runtime.observe("thread-1", 0, 10)!;
  assert.equal(observed.cursor_lost, true);
  assert.equal(observed.facts_lost, true);
  assert.equal(observed.stream_lost, false);
  assert.equal(observed.events.length, 1);
  assert.equal(observed.events[0]?.method, "turn/completed");
  assert.equal(observed.terminal?.final_result, "DONE");
  assert.equal(observed.runtime_status, "completed");
});

test("turn/completed without a usable status projects unknown", () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-unknown", "turn-unknown");

  runtime.recordNotification("turn/completed", {
    threadId: "thread-unknown",
    turn: { id: "turn-unknown", items: [] },
  });

  const observed = runtime.observe("thread-unknown", 0, 10)!;
  assert.equal(observed.runtime_status, "unknown");
  assert.equal(observed.terminal?.status, "unknown");
});

test("streamed agent text stays unchanged under its bound and retains the tail over it", () => {
  const underBound = new RuntimeStore();
  underBound.markTurnAccepted("thread-under", "turn-under");
  underBound.recordNotification("item/agentMessage/delta", {
    threadId: "thread-under",
    turnId: "turn-under",
    delta: "answer: ",
  });
  underBound.recordNotification("item/agentMessage/delta", {
    threadId: "thread-under",
    turnId: "turn-under",
    delta: "FINAL_CONCLUSION",
  });
  underBound.recordNotification("turn/completed", {
    threadId: "thread-under",
    turn: { id: "turn-under", status: "completed", items: [] },
  });
  assert.equal(
    underBound.observe("thread-under", 0, 10)?.terminal?.final_result,
    "answer: FINAL_CONCLUSION",
  );

  const overBound = new RuntimeStore();
  const conclusion = "FINAL_CONCLUSION";
  overBound.markTurnAccepted("thread-over", "turn-over");
  overBound.recordNotification("item/agentMessage/delta", {
    threadId: "thread-over",
    turnId: "turn-over",
    delta: "x".repeat(MAX_STREAMED_AGENT_TEXT_CHARS),
  });
  overBound.recordNotification("item/agentMessage/delta", {
    threadId: "thread-over",
    turnId: "turn-over",
    delta: conclusion,
  });
  overBound.recordNotification("turn/completed", {
    threadId: "thread-over",
    turn: { id: "turn-over", status: "completed", items: [] },
  });

  const retained = overBound.observe("thread-over", 0, 10)?.terminal?.final_result;
  assert.equal(retained?.length, MAX_STREAMED_AGENT_TEXT_CHARS);
  assert.equal(retained?.endsWith(conclusion), true);
  assert.equal(
    retained,
    `${"x".repeat(MAX_STREAMED_AGENT_TEXT_CHARS - conclusion.length)}${conclusion}`,
  );
});

test("terminal text tracks truncation once, partial source, message identity and exit redaction", () => {
  for (const length of [48_000, 48_001, 60_024]) {
    const runtime = new RuntimeStore(); runtime.markTurnAccepted("t", "u");
    const text = "x".repeat(length);
    runtime.recordNotification("item/completed", { threadId: "t", turnId: "u", completedAtMs: 1,
      item: { id: "f", type: "agentMessage", phase: "final_answer", text } });
    runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status: "completed", items: [] } });
    const terminal = runtime.observe("t", 0, 50)!.terminal!;
    assert.equal(terminal.final_result, text.slice(0, 48_000));
    assert.equal(terminal.final_result_meta!.observed_chars, length);
    assert.equal(terminal.final_result_meta!.truncated, length > 48_000);
    assert.equal(terminal.final_result_meta!.complete, length <= 48_000);
  }
  for (const startedItem of [false, true]) {
    const runtime = new RuntimeStore(); runtime.markTurnAccepted("t", "u");
    runtime.recordNotification("item/completed", { threadId: "t", turnId: "u", completedAtMs: 1,
      item: { id: "comment", type: "agentMessage", phase: "commentary", text: "Running the migration now." } });
    if (startedItem) runtime.recordNotification("item/started", { threadId: "t", turnId: "u", startedAtMs: 2,
      item: { id: "f", type: "agentMessage", phase: "final_answer", text: "" } });
    runtime.recordNotification("item/agentMessage/delta", { threadId: "t", turnId: "u", itemId: "f", delta: "Final: partial" });
    runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status: "interrupted", items: [] } });
    const terminal = runtime.observe("t", 0, 50)!.terminal!;
    assert.equal(terminal.final_result, "Final: partial");
    assert.equal(terminal.final_result_meta!.source_complete, false);
    assert.equal(terminal.final_result_meta!.truncated, false);
    assert.equal(terminal.final_result_meta!.complete, false);
    runtime.markTurnAccepted("t", "v");
    runtime.recordNotification("item/agentMessage/delta", { threadId: "t", turnId: "v", itemId: "g", delta: "Bearer synthetic-fixture-only" });
    runtime.markAppServerExited("fixture exit");
    assert.equal(runtime.observe("t", 0, 50)!.terminal!.final_result, "Bearer [REDACTED]");
    assert.equal(runtime.observe("t", 0, 50)!.terminal!.final_result_meta!.observed_chars, 29);
  }
});

test("an agent message with only a start preserves the preceding final text", () => {
  for (const status of ["completed", "interrupted"]) for (const emptyDelta of [false, true]) {
    const runtime = new RuntimeStore(); runtime.markTurnAccepted("t", "u");
    const text = "Done: 42/42 tests pass.";
    runtime.recordNotification("item/completed", { threadId: "t", turnId: "u", completedAtMs: 1,
      item: { id: "a", type: "agentMessage", phase: "final_answer", text } });
    runtime.recordNotification("item/started", { threadId: "t", turnId: "u", startedAtMs: 2,
      item: { id: "b", type: "agentMessage", phase: null, text: "" } });
    if (emptyDelta) runtime.recordNotification("item/agentMessage/delta", {
      threadId: "t", turnId: "u", itemId: "b", delta: "" });
    runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status, items: [] } });
    const terminal = runtime.observe("t", 0, 50)!.terminal!;
    assert.equal(terminal.status, status);
    assert.equal(terminal.final_result, text);
    assert.equal(terminal.final_result_meta!.complete, true);
    assert.equal(terminal.final_result_meta!.observed_chars, text.length);
  }
});

test("a new completed message replaces prior text even when its final text is empty", () => {
  for (const text of ["New final", ""]) {
    const runtime = new RuntimeStore(); runtime.markTurnAccepted("t", "u");
    for (const [id, content] of [["a", "Prior message"], ["b", text]]) {
      runtime.recordNotification("item/completed", { threadId: "t", turnId: "u", completedAtMs: 1,
        item: { id, type: "agentMessage", phase: "final_answer", text: content } });
    }
    runtime.recordNotification("turn/completed", { threadId: "t", turn: { id: "u", status: "completed", items: [] } });
    const terminal = runtime.observe("t", 0, 50)!.terminal!;
    assert.equal(terminal.final_result, text);
    assert.equal(terminal.final_result_meta!.complete, true);
  }
});

test("pending app-server request ids preserve typed identity and cannot be replaced while responding", () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-original", "turn-original");
  assert.equal(
    runtime.recordServerRequest(17, "item/fileChange/requestApproval", {
      threadId: "thread-original",
      turnId: "turn-original",
      marker: "original",
    }),
    "recorded",
  );
  const original = runtime.claimPending(17, {
    threadId: "thread-original",
    turnId: "turn-original",
    method: "item/fileChange/requestApproval",
  });

  assert.equal(
    runtime.recordServerRequest(17, "item/commandExecution/requestApproval", {
      threadId: "thread-duplicate",
      turnId: "turn-duplicate",
      marker: "must-not-replace",
    }),
    "duplicate",
  );
  assert.equal(
    runtime.recordServerRequest("17", "item/tool/requestUserInput", {
      threadId: "thread-string",
      turnId: "turn-string",
    }),
    "recorded",
  );
  assert.equal(runtime.hasThread("thread-duplicate"), false);
  const stillOriginal = runtime.pendingForThread("thread-original") as Array<Record<string, unknown>>;
  assert.equal(stillOriginal.length, 1);
  assert.equal(stillOriginal[0]?.request_id, 17);
  assert.equal(
    ((stillOriginal[0]?.params as Record<string, unknown>).marker),
    "original",
  );
  assert.equal(
    (runtime.pendingForThread("thread-string")[0] as Record<string, unknown>).request_id,
    "17",
  );

  runtime.releasePending(original);
  const retried = runtime.claimPending(17, {
    threadId: "thread-original",
    turnId: "turn-original",
    method: "item/fileChange/requestApproval",
  });
  runtime.releasePending(retried);

  runtime.recordNotification("serverRequest/resolved", {
    threadId: "thread-original",
    turnId: "turn-original",
    requestId: 17,
  });
  assert.equal(
    runtime.recordServerRequest(17, "item/fileChange/requestApproval", {
      threadId: "thread-reused",
      turnId: "turn-reused",
      marker: "reused",
    }),
    "recorded",
  );
  runtime.completePending(original);
  runtime.releasePending(original);
  const reused = runtime.pendingForThread("thread-reused") as Array<Record<string, unknown>>;
  assert.equal(reused.length, 1);
  assert.equal((reused[0]?.params as Record<string, unknown>).marker, "reused");
});

test("late turn acknowledgements preserve same-turn terminals but replace older terminal state", () => {
  const sameTurn = new RuntimeStore();
  sameTurn.markTurnAccepted("thread-same-terminal", "turn-terminal");
  sameTurn.recordNotification("turn/completed", {
    threadId: "thread-same-terminal",
    turn: {
      id: "turn-terminal",
      status: "completed",
      items: [{ type: "agentMessage", text: "DONE" }],
    },
  });
  sameTurn.reconcileLateMutationSuccess({
    method: "turn/start",
    threadId: "thread-same-terminal",
    turnId: "turn-terminal",
    status: "inProgress",
    timedOutAt: "2026-08-12T00:00:00.000Z",
  });
  const preserved = sameTurn.observe("thread-same-terminal", 0, 10)!;
  assert.equal(preserved.active_turn_id, null);
  assert.equal(preserved.terminal?.turn_id, "turn-terminal");
  assert.equal(
    (preserved.events.at(-1)?.data as Record<string, unknown>).reason,
    "terminal_present",
  );

  const oldTerminal = new RuntimeStore();
  oldTerminal.markTurnAccepted("thread-old-terminal", "turn-old");
  oldTerminal.recordNotification("item/completed", {
    threadId: "thread-old-terminal",
    turnId: "turn-old",
    item: { type: "agentMessage", text: "OLD_TEXT" },
  });
  oldTerminal.recordNotification("turn/completed", {
    threadId: "thread-old-terminal",
    turn: { id: "turn-old", status: "completed", items: [] },
  });
  const timeoutAfterOldTerminal = new Date(Date.now() + 1_000).toISOString();
  oldTerminal.reconcileLateMutationSuccess({
    method: "turn/start",
    threadId: "thread-old-terminal",
    turnId: "turn-new",
    status: "inProgress",
    timedOutAt: timeoutAfterOldTerminal,
  });
  const activated = oldTerminal.observe("thread-old-terminal", 0, 10)!;
  assert.equal(activated.active_turn_id, "turn-new");
  assert.equal(activated.terminal, null);
  assert.equal(
    (activated.events.at(-1)?.data as Record<string, unknown>).action,
    "turn_activated",
  );
  oldTerminal.recordNotification("turn/completed", {
    threadId: "thread-old-terminal",
    turn: { id: "turn-new", status: "completed", items: [] },
  });
  assert.equal(
    oldTerminal.observe("thread-old-terminal", 0, 20)?.terminal?.final_result,
    null,
  );

  const newerActive = new RuntimeStore();
  newerActive.markTurnAccepted("thread-newer", "turn-current");
  newerActive.reconcileLateMutationSuccess({
    method: "turn/start",
    threadId: "thread-newer",
    turnId: "turn-stale",
    status: "inProgress",
    timedOutAt: "2026-08-12T00:00:02.000Z",
  });
  assert.equal(
    newerActive.observe("thread-newer", 0, 10)?.active_turn_id,
    "turn-current",
  );

  const newerTerminal = new RuntimeStore();
  const timeoutBeforeNewerTerminal = new Date(Date.now() - 1_000).toISOString();
  newerTerminal.markTurnAccepted("thread-newer-terminal", "turn-newer");
  newerTerminal.recordNotification("turn/completed", {
    threadId: "thread-newer-terminal",
    turn: { id: "turn-newer", status: "completed", items: [] },
  });
  newerTerminal.reconcileLateMutationSuccess({
    method: "turn/start",
    threadId: "thread-newer-terminal",
    turnId: "turn-stale-different",
    status: "inProgress",
    timedOutAt: timeoutBeforeNewerTerminal,
  });
  const newerTerminalObserved = newerTerminal.observe(
    "thread-newer-terminal",
    0,
    10,
  )!;
  assert.equal(newerTerminalObserved.active_turn_id, null);
  assert.equal(newerTerminalObserved.terminal?.turn_id, "turn-newer");
  assert.equal(
    (newerTerminalObserved.events.at(-1)?.data as Record<string, unknown>).reason,
    "newer_terminal_present",
  );
});

test("observe wait defaults to immediate and buffered events bypass waiting", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-immediate", "turn-immediate");
  const control = controlFor(runtime);

  const immediate = await within(control.call("codex_observe", {
    thread_id: "thread-immediate",
    cursor: 0,
    view: "raw",
  }));
  assert.deepEqual(immediate, runtime.observe("thread-immediate", 0, 50));
  assert.deepEqual(await within(control.call("codex_observe", {
    thread_id: "thread-immediate",
    cursor: 0,
    wait_ms: 0,
    view: "raw",
  })), immediate);

  runtime.recordNotification("item/started", {
    threadId: "thread-immediate",
    turnId: "turn-immediate",
    item: { type: "commandExecution", id: "command-buffered" },
  });
  const buffered = await within(control.call("codex_observe", {
    thread_id: "thread-immediate",
    cursor: 0,
    wait_ms: MAX_OBSERVE_WAIT_MS,
    view: "raw",
  }));
  const events = (buffered as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.method, "item/started");
});

test("active observe wait wakes on an injected runtime event and otherwise times out", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-wait", "turn-wait");
  const control = controlFor(runtime);

  const waiting = control.call("codex_observe", {
    thread_id: "thread-wait",
    cursor: 0,
    wait_ms: 120_000,
  });
  runtime.recordNotification("item/started", {
    threadId: "thread-wait",
    turnId: "turn-wait",
    item: { type: "commandExecution", id: "command-wakeup" },
  });
  const woken = await within(waiting);
  const wokenEvents = (woken as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(wokenEvents.length, 1);
  assert.equal(wokenEvents[0]?.method, "item/started");

  const startedAt = performance.now();
  const timedOut = await within(control.call("codex_observe", {
    thread_id: "thread-wait",
    cursor: runtime.currentCursor("thread-wait"),
    wait_ms: 40,
  }), 500);
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 25, `observe returned too early after ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 500, `observe exceeded its bounded deadline: ${elapsed.toFixed(1)} ms`);
  assert.deepEqual(timedOut, {
    runtime_available: true,
    runtime_status: "inProgress",
    active_turn_id: "turn-wait",
    next_cursor: runtime.currentCursor("thread-wait"),
    no_change: true,
  });
});

test("observe no-change deadlines omit seen output and preserve the continuation cursor", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-quiet", "turn-quiet");
  runtime.recordNotification("item/completed", {
    threadId: "thread-quiet",
    turnId: "turn-quiet",
    item: { type: "commandExecution", id: "seen-command", aggregatedOutput: "SEEN_OUTPUT" },
  });
  const control = controlFor(runtime);
  const seen = await control.call("codex_observe", {
    thread_id: "thread-quiet",
    cursor: 0,
    view: "raw",
  }) as RuntimeObservation;
  assert.match(JSON.stringify(seen), /SEEN_OUTPUT/);

  for (let index = 0; index < 2; index += 1) {
    const quiet = await within(control.call("codex_observe", {
      thread_id: "thread-quiet",
      cursor: seen.next_cursor,
      wait_ms: 10,
      view: "raw",
    }));
    assert.deepEqual(quiet, {
      runtime_available: true,
      runtime_status: "inProgress",
      active_turn_id: "turn-quiet",
      next_cursor: seen.next_cursor,
      no_change: true,
    });
    assert.equal(runtime.currentCursor("thread-quiet"), seen.next_cursor);
  }

  const waiting = control.call("codex_observe", {
    thread_id: "thread-quiet",
    cursor: seen.next_cursor,
    wait_ms: 40,
    view: "raw",
  });
  runtime.recordNotification("item/commandExecution/outputDelta", {
    threadId: "thread-quiet",
    turnId: "turn-quiet",
    itemId: "new-command",
    delta: "NEW_OUTPUT",
  });
  const changed = await within(waiting);
  assert.deepEqual(changed, runtime.observe("thread-quiet", seen.next_cursor, 50));
  assert.match(JSON.stringify(changed), /NEW_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(changed), /SEEN_OUTPUT/);
});

test("observe waits preserve full snapshots on native and revision-only changes", async () => {
  const changes: Array<{ name: string; mutate: (runtime: RuntimeStore) => void }> = [
    {
      name: "native status event",
      mutate: (runtime) => runtime.recordNotification("thread/status/changed", {
        threadId: "thread-change",
        status: { type: "active" },
      }),
    },
    {
      name: "pending request",
      mutate: (runtime) => runtime.recordServerRequest(7, "item/fileChange/requestApproval", {
        threadId: "thread-change",
        turnId: "turn-change",
      }),
    },
    {
      name: "terminal result",
      mutate: (runtime) => runtime.recordNotification("turn/completed", {
        threadId: "thread-change",
        turn: {
          id: "turn-change",
          status: "completed",
          items: [{ type: "agentMessage", text: "NEW_FINAL_OUTPUT" }],
        },
      }),
    },
    {
      name: "turn accepted without a native event",
      mutate: (runtime) => runtime.markTurnAccepted("thread-change", "turn-next"),
    },
    {
      name: "app-server exit",
      mutate: (runtime) => runtime.markAppServerExited("test exit"),
    },
  ];
  for (const { name, mutate } of changes) {
    const runtime = new RuntimeStore();
    runtime.markTurnAccepted("thread-change", "turn-change");
    const waiting = controlFor(runtime).call("codex_observe", {
      thread_id: "thread-change",
      cursor: 0,
      wait_ms: 40,
      view: "raw",
    });
    mutate(runtime);
    assert.deepEqual(await within(waiting), runtime.observe("thread-change", 0, 50), name);
  }
});

test("observe cursor recovery and buffered pagination retain full snapshots", async () => {
  const runtime = new RuntimeStore(3);
  runtime.markTurnAccepted("thread-cursors", "turn-cursors");
  for (let index = 0; index < 3; index += 1) {
    runtime.recordNotification("item/started", {
      threadId: "thread-cursors",
      turnId: "turn-cursors",
      item: { type: "commandExecution", id: "command-" + index },
    });
  }
  const control = controlFor(runtime);
  for (const cursor of [0, 1]) {
    const observed = await within(control.call("codex_observe", {
      thread_id: "thread-cursors",
      cursor,
      limit: 1,
      wait_ms: MAX_OBSERVE_WAIT_MS,
      view: "raw",
    }));
    assert.deepEqual(observed, runtime.observe("thread-cursors", cursor, 1));
    assert.equal((observed as RuntimeObservation).cursor_lost, cursor === 0);
    assert.equal((observed as RuntimeObservation).has_more, true);
  }
});

test("cancelling one same-thread observe wait leaves the other waiter intact", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-cancel-one", "turn-cancel-one");
  const control = controlFor(runtime);
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = control.call("codex_observe", {
    thread_id: "thread-cancel-one",
    cursor: 0,
    wait_ms: 1_000,
  }, firstController.signal);
  const second = control.call("codex_observe", {
    thread_id: "thread-cancel-one",
    cursor: 0,
    wait_ms: 1_000,
  }, secondController.signal);

  firstController.abort();
  await assert.rejects(within(first), /MCP request cancelled/);

  runtime.recordNotification("item/started", {
    threadId: "thread-cancel-one",
    turnId: "turn-cancel-one",
    item: { type: "commandExecution", id: "command-after-cancel" },
  });
  const observed = await within(second);
  const events = (observed as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.method, "item/started");
});

test("observe cancellation before waiter registration settles immediately", async () => {
  const controller = new AbortController();
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-cancel-before-register", "turn-cancel-before-register");
  const control = controlFor(runtime);
  controller.abort();

  await assert.rejects(
    within(control.call("codex_observe", {
      thread_id: "thread-cancel-before-register",
      cursor: 0,
      wait_ms: 1_000,
    }, controller.signal)),
    /MCP request cancelled/,
  );
});

test("observe wait handoff cannot lose a mutation between snapshot and registration", async () => {
  class HandoffRuntimeStore extends RuntimeStore {
    #injected = false;

    override observe(
      threadId: string,
      cursor: number | undefined,
      limit: number,
    ): RuntimeObservation | null {
      const snapshot = super.observe(threadId, cursor, limit);
      if (!this.#injected && snapshot?.active_turn_id) {
        this.#injected = true;
        this.recordNotification("item/started", {
          threadId,
          turnId: snapshot?.active_turn_id,
          item: { type: "commandExecution", id: "command-handoff" },
        });
      }
      return snapshot;
    }
  }

  const runtime = new HandoffRuntimeStore();
  runtime.markTurnAccepted("thread-handoff", "turn-handoff");
  const observed = await within(
    runtime.observeWithWait("thread-handoff", 0, 10, 1_000),
  );
  assert.ok(observed && "events" in observed);
  assert.equal(observed.events.length, 1);
  assert.equal(observed.events[0]?.method, "item/started");
});

test("completed, pending, inactive, and unavailable observe states do not wait", async () => {
  const completedRuntime = new RuntimeStore();
  completedRuntime.markTurnAccepted("thread-completed", "turn-completed");
  completedRuntime.recordNotification("turn/completed", {
    threadId: "thread-completed",
    turn: { id: "turn-completed", status: "completed", items: [] },
  });
  const completed = await within(controlFor(completedRuntime).call("codex_observe", {
    thread_id: "thread-completed",
    cursor: completedRuntime.currentCursor("thread-completed"),
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal(
    ((completed as Record<string, unknown>).terminal as Record<string, unknown>).status,
    "completed",
  );

  const pendingRuntime = new RuntimeStore();
  pendingRuntime.markTurnAccepted("thread-pending", "turn-pending");
  pendingRuntime.recordServerRequest(7, "item/fileChange/requestApproval", {
    threadId: "thread-pending",
    turnId: "turn-pending",
  });
  const pending = await within(controlFor(pendingRuntime).call("codex_observe", {
    thread_id: "thread-pending",
    cursor: pendingRuntime.currentCursor("thread-pending"),
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal(
    ((pending as Record<string, unknown>).pending_requests as unknown[]).length,
    1,
  );

  const inactiveRuntime = new RuntimeStore();
  inactiveRuntime.ensureThread("thread-inactive");
  const inactive = await within(controlFor(inactiveRuntime).call("codex_observe", {
    thread_id: "thread-inactive",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal((inactive as Record<string, unknown>).active_turn_id, null);

  const unavailable = await within(controlFor(new RuntimeStore()).call("codex_observe", {
    thread_id: "thread-unavailable",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal((unavailable as Record<string, unknown>).runtime_available, false);
});

test("observe wait schema and validation preserve bounded optional semantics", async () => {
  const observeTool = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_observe");
  const properties = (observeTool?.inputSchema.properties ?? {}) as Record<string, unknown>;
  const { description: waitDescription, ...waitSchema } = properties.wait_ms as Record<string, unknown>;
  assert.deepEqual(waitSchema, {
    type: "integer",
    minimum: 0,
    maximum: 120_000,
    default: 0,
  });
  assert.match(String(waitDescription), /One bounded wait; 0 reads immediately/);
  assert.match(String(waitDescription), /facts_lost, not stream_lost alone/);
  assert.match(String(waitDescription), /not stall detection/);
  assert.match(observeTool?.description ?? "", /wait_ms is one bounded wait/);
  assert.match(observeTool?.description ?? "", /No command output alone does not mean stalled/);
  const { description: viewDescription, ...viewSchema } = properties.view as Record<string, unknown>;
  assert.deepEqual(viewSchema, {
    type: "string",
    enum: ["compact", "raw"],
    default: "compact",
  });
  assert.match(String(viewDescription), /Raw shows retained sanitized events with possible cursor gaps/);
  assert.match(String(viewDescription), /neither view restores evicted events/);

  const runtime = new RuntimeStore();
  runtime.ensureThread("thread-validation");
  const control = controlFor(runtime);
  for (const waitMs of [-1, 120_001, 1.5]) {
    await assert.rejects(
      control.call("codex_observe", {
        thread_id: "thread-validation",
        wait_ms: waitMs,
      }),
      /wait_ms must be an integer from 0 to 120000/,
    );
    await assert.rejects(
      runtime.observeWithWait("thread-validation", undefined, 50, waitMs),
      /wait_ms must be an integer from 0 to 120000/
    );
  }
  await within(control.call("codex_observe", {
    thread_id: "thread-validation",
    wait_ms: 0,
  }));
  await within(control.call("codex_observe", {
    thread_id: "thread-validation",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
});
