import assert from "node:assert/strict";
import test from "node:test";

import { AppServerManager } from "../src/app-server.js";
import {
  exactHistoryResponse,
  historyMcpBytes,
  HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES,
  MAX_HISTORY_MCP_BYTES,
} from "../src/history.js";
import { WINDOWS_PLATFORM_POLICY } from "../src/platform.js";
import { RuntimeStore, sanitizeForTransport } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

interface Request { method: string; params: Record<string, unknown> }

class StubAppServer extends AppServerManager {
  readonly calls: Request[] = [];
  routeMetadata = true;
  historyMode: unknown = "paginated";
  constructor(readonly handler: (method: string, params: Record<string, unknown>) => unknown,
              runtime = new RuntimeStore()) {
    super(runtime, { executable: "unused-test-codex" });
  }
  override async request(method: string, params: unknown): Promise<unknown> {
    const request = { method, params: params as Record<string, unknown> };
    this.calls.push(request);
    if (method === "thread/read" && this.routeMetadata) return { thread: { id: request.params.threadId, historyMode: this.historyMode, turns: [] } };
    return this.handler(method, request.params);
  }
}

const page = (data: unknown[] = [], nextCursor: string | null = null,
              backwardsCursor: string | null = null) => ({ data, nextCursor, backwardsCursor });
const callHistory = (surface: ControlSurface, history: Record<string, unknown>) =>
  surface.call("codex_history", { thread_id: "thread-1", ...history });

test("history schema and static validation separate history from thread metadata/list", async () => {
  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_history")!.inputSchema;
  assert.deepEqual(schema.required, ["thread_id", "kind"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal((schema.oneOf as unknown[]).length, 2);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.limit!.maximum, 50);
  assert.equal(properties.cursor!.type, "string");
  assert.equal("history" in (TOOL_DEFINITIONS.find(tool => tool.name === "codex_threads")!.inputSchema.properties as object), false);
  const manager = new StubAppServer(() => { throw new Error("native call forbidden"); });
  const surface = new ControlSurface(manager);
  const invalid = [
    {}, { kind: "turns" }, { thread_id: "thread-1" },
    ...[null, "", " ", 1, "x".repeat(201)].map(thread_id => ({ thread_id, kind: "turns" })),
    ...[null, "", "unknown"].map(kind => ({ thread_id: "thread-1", kind })),
    ...[null, "", " ", 3, {}, "x".repeat(10_001)].map(cursor => ({ thread_id: "thread-1", kind: "turns", cursor })),
    ...[null, 0, 51, 1.5, "2"].map(limit => ({ thread_id: "thread-1", kind: "turns", limit })),
    ...[null, "", "sideways"].map(sort_direction => ({ thread_id: "thread-1", kind: "turns", sort_direction })),
    { thread_id: "thread-1", kind: "turns", turn_id: "turn-1" },
    { thread_id: "thread-1", kind: "turns", turn_id: null },
    { thread_id: "thread-1", kind: "items" },
    ...[null, "", " ", 4, "x".repeat(201)].map(turn_id => ({ thread_id: "thread-1", kind: "items", turn_id })),
    { thread_id: "thread-1", kind: "items", turn_id: "turn-1", limit: 21 },
    ...["history", "include_turns", "cwd", "extra"].map(key => ({ thread_id: "thread-1", kind: "turns", [key]: true })),
  ];
  for (const args of invalid) {
    await assert.rejects(surface.call("codex_history", args), /./, JSON.stringify(args));
    assert.equal(manager.calls.length, 0);
  }
  for (const args of [
    { thread_id: "thread-1", include_turns: true }, { include_turns: false },
    { thread_id: "thread-1", cwd: "D:\\work" },
    { thread_id: "thread-1", history: { kind: "turns" } },
    { thread_id: "thread-1", kind: "turns" },
  ]) {
    await assert.rejects(surface.call("codex_threads", args), /./);
    assert.equal(manager.calls.length, 0);
  }
  await assert.rejects(surface.call("codex_threads", { thread_id: "thread-1", include_turns: true }), /include_turns:true.*codex_history/);
});


test("metadata/list remain distinct and native history pages preserve cursors, order and empty/end", async () => {
  const manager = new StubAppServer((method, params) => {
    if (method === "thread/read") return { thread: { id: params.threadId, turns: [] } };
    if (method === "thread/list") return page([{ id: "thread-1" }], "list-next");
    if (method === "thread/turns/list") {
      if (params.cursor === "reverse") return page([{ id: "turn-2", items: [] }], null);
      if (params.cursor === "turn-next") return page([], "turn-next-2", "reverse");
      return page([{ id: "turn-2", items: [] }, { id: "turn-1", items: [] }], "turn-next", "reverse");
    }
    if (method === "thread/items/list") {
      if (params.cursor === "item-next") return page([{ turnId: "turn-2", item: { id: "i2", type: "agentMessage", text: "二 🌱" } }], null, "item-back");
      return page([{ turnId: "turn-2", item: { id: "i1", type: "agentMessage", text: "one" } }], "item-next");
    }
    throw new Error("unexpected native method");
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  assert.deepEqual(await surface.call("codex_threads", { thread_id: "thread-1", include_turns: false }),
    { source: "codex_app_server", mode: "read", thread: { id: "thread-1", historyMode: "paginated", turns: [] } });
  assert.deepEqual(manager.calls.at(-1), { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } });
  assert.equal((await surface.call("codex_threads", { cwd: "D:\\work", search_term: "x", cursor: "list-cursor", limit: 2 }) as Record<string, unknown>).nextCursor, "list-next");
  assert.deepEqual(manager.calls.at(-1), { method: "thread/list", params: { limit: 2, sortKey: "updated_at", sortDirection: "desc", cwd: "D:\\work", searchTerm: "x", cursor: "list-cursor" } });

  const first = await callHistory(surface, { kind: "turns" }) as Record<string, unknown>;
  assert.deepEqual(manager.calls.at(-1), { method: "thread/turns/list", params: { threadId: "thread-1", limit: 20, sortDirection: "desc", itemsView: "notLoaded" } });
  assert.deepEqual(first, { source: "codex_app_server", mode: "history", coverage: "native_persisted_history", history_mode: "paginated", kind: "turns", page_granularity: "turn", items_view: "notLoaded", thread_id: "thread-1", data: [{ id: "turn-2", items: [] }, { id: "turn-1", items: [] }], nextCursor: "turn-next", backwardsCursor: "reverse" });
  const empty = await callHistory(surface, { kind: "turns", cursor: "turn-next", limit: 50 });
  assert.deepEqual((empty as Record<string, unknown>).data, []);
  assert.equal((empty as Record<string, unknown>).nextCursor, "turn-next-2");
  const reverse = await callHistory(surface, { kind: "turns", cursor: "reverse", sort_direction: "asc" }) as Record<string, unknown>;
  assert.deepEqual(reverse.data, [{ id: "turn-2", items: [] }]);
  assert.equal(reverse.nextCursor, null);
  assert.deepEqual(manager.calls.at(-1)?.params, { threadId: "thread-1", cursor: "reverse", limit: 20, sortDirection: "asc", itemsView: "notLoaded" });

  const item1 = await callHistory(surface, { kind: "items", turn_id: "turn-2" }) as Record<string, unknown>;
  assert.deepEqual(manager.calls.at(-1), { method: "thread/items/list", params: { threadId: "thread-1", turnId: "turn-2", limit: 10, sortDirection: "asc" } });
  assert.equal(item1.nextCursor, "item-next");
  const item2 = await callHistory(surface, { kind: "items", turn_id: "turn-2", cursor: "item-next", limit: 20 }) as Record<string, unknown>;
  assert.deepEqual(item2.data, [{ turnId: "turn-2", item: { id: "i2", type: "agentMessage", text: "二 🌱" } }]);
  assert.equal(item2.nextCursor, null);
  assert.equal(item2.backwardsCursor, "item-back");
  assert.deepEqual(manager.calls.at(-1)?.params, { threadId: "thread-1", turnId: "turn-2", cursor: "item-next", limit: 20, sortDirection: "asc" });
  await callHistory(surface, { kind: "items", turn_id: "turn-2", cursor: "item-back", sort_direction: "desc" });
  assert.equal(manager.calls.at(-1)?.params.sortDirection, "desc");
  assert.equal(manager.runtime.hasThread("thread-1"), false);
});

test("stable interrupted turns retain open error information and root identity in observe and lossless history", async () => {
  // Native status stays authoritative even when an interrupted turn carries text and future error variants.
  for (const codexErrorInfo of ["tooManyDenials", "sessionBudgetExceeded", "futurePolicy", { futurePolicy: { retryable: false } }]) {
    const error = {
      message: "Native interruption detail",
      codexErrorInfo,
      additionalDetails: null,
    };
    const finalText = "Stopped with retained output.";
    const turn = {
      id: "turn-interrupted", rootTurnId: "root-turn", status: "interrupted", error,
      items: [{ id: "final-message", type: "agentMessage", phase: "final_answer", text: finalText }],
    };
    const runtime = new RuntimeStore();
    runtime.markTurnAccepted("thread-1", turn.id);
    runtime.recordNotification("turn/completed", { threadId: "thread-1", turn });
    const live = new ControlSurface({ runtime } as unknown as AppServerManager);
    for (const view of ["raw", "compact"] as const) {
      const observed = await live.call("codex_observe", { thread_id: "thread-1", cursor: 0, view }) as Record<string, unknown>;
      const terminal = observed.terminal as Record<string, unknown>;
      assert.equal(observed.runtime_status, "interrupted", view);
      assert.equal(observed.active_turn_id, null, view);
      assert.equal(terminal.status, "interrupted", view);
      assert.equal(terminal.turn_id, turn.id, view);
      assert.equal(terminal.final_result, finalText, view);
      assert.deepEqual(view === "compact" ? JSON.parse(terminal.error as string) : terminal.error, error, view);
      if (view === "compact") assert.equal(observed.events, undefined, "stable terminal shape must not become an unknown diagnostic");
      else assert.equal(((observed.events as Array<{ data: { turn: typeof turn } }>)[0]!.data.turn).rootTurnId, turn.rootTurnId);
    }

    for (const historyMode of ["paginated", "legacy"] as const) {
      const itemsView = historyMode === "paginated" ? "notLoaded" : "full";
      const nativePage = page([{ ...turn, itemsView, items: historyMode === "paginated" ? [] : turn.items }]);
      const manager = new StubAppServer((method, params) => {
        assert.equal(method, "thread/turns/list");
        assert.equal(params.itemsView, itemsView);
        return nativePage;
      });
      manager.historyMode = historyMode;
      const history = await callHistory(new ControlSurface(manager), { kind: "turns", limit: 1 }) as Record<string, unknown>;
      assert.equal(history.history_mode, historyMode);
      assert.deepEqual(history.data, nativePage.data, historyMode);
      assert.equal((history.data as Array<Record<string, unknown>>)[0]!.rootTurnId, turn.rootTurnId);
      assert.equal(history.nextCursor, nativePage.nextCursor);
      assert.equal(history.backwardsCursor, nativePage.backwardsCursor);
      assert.equal(manager.runtime.hasThread("thread-1"), false, "persisted history must not rebuild live state");
    }
  }
});

test("invalid upstream pages and upstream cursor errors never fall back to full read", async () => {
  const malformed = [null, {}, { data: null, nextCursor: null, backwardsCursor: null },
    { data: [], nextCursor: undefined, backwardsCursor: null },
    { data: [], nextCursor: null, backwardsCursor: undefined },
    { data: [], nextCursor: 4, backwardsCursor: null },
    { data: [], nextCursor: "", backwardsCursor: null },
    page([1, 2]), page([{}])];
  for (const value of malformed) {
    const manager = new StubAppServer(() => value);
    await assert.rejects(callHistory(new ControlSurface(manager), { kind: "turns", limit: 1 }), /^Error: history_upstream_invalid:/);
    assert.deepEqual(manager.calls.map((call) => call.method), ["thread/read", "thread/turns/list"]);
  }
  const invalidItem = new StubAppServer(() => page([{ turnId: "turn-1" }]));
  await assert.rejects(callHistory(new ControlSurface(invalidItem), { kind: "items", turn_id: "turn-1" }), /^Error: history_upstream_invalid:/);
  assert.deepEqual(invalidItem.calls.map((call) => call.method), ["thread/read", "thread/items/list"]);
  const manager = new StubAppServer(() => { throw new Error("native invalid cursor"); });
  await assert.rejects(callHistory(new ControlSurface(manager), { kind: "items", turn_id: "turn-1", cursor: "stale" }), /native invalid cursor/);
  assert.deepEqual(manager.calls.map((call) => call.method), ["thread/read", "thread/items/list"]);
});

test("history permits long strings without changing global sanitizer defaults or rewriting pages", () => {
  const response = { data: [{ aggregatedOutput: "x".repeat(16_007) }] };
  assert.match(JSON.stringify(sanitizeForTransport(response)), /truncated/);
  assert.strictEqual(exactHistoryResponse(response), response);
});

test("protected history rejects secret-shaped content without partial pages", async () => {
  const values = [
    { api_key: "secret" },
    { text: "Bearer abcdefghijklmnop" },
  ];
  for (const item of values) {
    const manager = new StubAppServer(() => page([{ turnId: "turn-1", item }]));
    await assert.rejects(callHistory(new ControlSurface(manager), { kind: "items", turn_id: "turn-1" }), /^Error: history_page_not_lossless:/);
    assert.deepEqual(manager.calls.map((call) => call.method), ["thread/read", "thread/items/list"]);
  }
  assert.equal(HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES, 1024);
  assert.equal(MAX_HISTORY_MCP_BYTES, 256 * 1024);
  const unicode = { source: "codex_app_server", mode: "history", data: ["🌱\n\"\\中"] };
  assert.deepEqual(exactHistoryResponse(unicode), unicode);
  const long = "中\n\"\\".repeat(60_000);
  assert.throws(() => exactHistoryResponse({ data: [long] }), /^Error: history_page_too_large:/);
});

test("MCP UTF-8 and JSON escaping byte boundary is measured from the actual structuredContent frame", () => {
  for (const character of ["\u0001", "\u0000"]) {
    const candidate = (count: number) => ({ data: Array.from({ length: 10 }, () => ({ text: character.repeat(count) })) });
    let low = 0;
    let high = 12_000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (historyMcpBytes(candidate(middle), "") + HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES <= MAX_HISTORY_MCP_BYTES) low = middle;
      else high = middle - 1;
    }
    assert.ok(low > 0 && low < 12_000);
    assert.deepEqual(exactHistoryResponse(candidate(low)), candidate(low));
    assert.throws(() => exactHistoryResponse(candidate(low + 1)), /^Error: history_page_too_large:/);
    assert.ok(historyMcpBytes(candidate(low), "x".repeat(2_000)) > MAX_HISTORY_MCP_BYTES);
  }
});

test("received oversized pages can retry the same cursor with a smaller limit", async () => {
  const manager = new StubAppServer((_method, params) => page(params.limit === 2
    ? [{ id: "turn-2", text: "中\n\"\\".repeat(60_000) }]
    : [{ id: "turn-2", text: "short" }], "same-next"));
  const surface = new ControlSurface(manager);
  await assert.rejects(callHistory(surface, { kind: "turns", cursor: "same-cursor", limit: 2 }), /^Error: history_page_too_large:/);
  const retry = await callHistory(surface, { kind: "turns", cursor: "same-cursor", limit: 1 }) as Record<string, unknown>;
  assert.equal(retry.nextCursor, "same-next");
  assert.deepEqual(manager.calls.filter(call => call.method !== "thread/read").map((call) => call.params.cursor), ["same-cursor", "same-cursor"]);
  assert.deepEqual(manager.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/read", "thread/turns/list"]);
});

test("runtime-missing observe returns metadata placeholders in compact/raw/wait and never builds runtime", async () => {
  const manager = new StubAppServer((method, params) => {
    assert.equal(method, "thread/read");
    assert.equal(params.includeTurns, false);
    return { thread: { id: "thread-1", historyMode: "paginated", turns: [{ id: "should-not-leak", items: [{ text: "secret-final" }] }] } };
  });
  manager.routeMetadata = false;
  const surface = new ControlSurface(manager);
  for (const args of [{}, { view: "raw" }, { wait_ms: 10 }, { view: "raw", wait_ms: 10 }]) {
    const observed = await surface.call("codex_observe", { thread_id: "thread-1", ...args }) as Record<string, unknown>;
    assert.equal(observed.runtime_available, false);
    assert.equal(observed.terminal, null);
    assert.equal(observed.active_turn_id, null);
    for (const field of ["active_turn_id", "terminal"]) assert.ok((observed.unavailable_live_fields as string[]).includes(field));
    for (const field of ["stream_lost", "facts_lost"]) {
      assert.equal(observed[field], false);
      assert.ok((observed.unavailable_live_fields as string[]).includes(field));
    }
    assert.deepEqual((observed.stored_thread as Record<string, unknown>).turns, []);
    assert.equal(observed.source, "codex_app_server_thread_read_metadata");
    assert.match(observed.note as string, /unknown.*codex_history/);
    assert.equal("history_cursor" in observed, false);
    assert.equal(manager.runtime.hasThread("thread-1"), false);
  }
  assert.deepEqual(manager.calls.map((call) => call.method), Array(4).fill("thread/read"));

  manager.runtime.markTurnAccepted("thread-1", "turn-live");
  for (let i = 0; i < 300; i += 1) manager.runtime.recordNotification("item/started", { threadId: "thread-1", turnId: "turn-live", item: { id: `item-${i}` } });
  const before = manager.calls.length;
  const observed = await surface.call("codex_observe", { thread_id: "thread-1", cursor: 0, view: "raw" }) as Record<string, unknown>;
  assert.equal(observed.cursor_lost, true);
  assert.equal(manager.calls.length, before);
});

test("cancelled runtime-missing observe does not publish a fabricated fallback", async () => {
  let release: ((value: unknown) => void) | undefined;
  const manager = new StubAppServer(() => new Promise<unknown>((resolve) => { release = resolve; }));
  manager.routeMetadata = false;
  const controller = new AbortController();
  const waiting = new ControlSurface(manager).call("codex_observe", {
    thread_id: "thread-1", wait_ms: 10,
  }, controller.signal);
  for (let attempt = 0; !release && attempt < 10; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(release);
  controller.abort();
  release({ thread: { id: "thread-1", turns: [] } });
  await assert.rejects(waiting, /MCP request cancelled/);
  assert.deepEqual(manager.calls.map((call) => call.method), ["thread/read"]);
  assert.equal(manager.runtime.hasThread("thread-1"), false);
});

test("legacy full-turn pages preserve native forward/reverse cursors and explicit granularity", async () => {
  const item = { id: "item-1", type: "agentMessage", text: "legacy 🌱", future: { preserved: true } };
  const manager = new StubAppServer((method, params) => {
    assert.equal(method, "thread/turns/list");
    if (params.itemsView === "notLoaded") return page([{ id: "latest", items: [] }]);
    assert.equal(params.limit, 1);
    assert.equal(params.itemsView, "full");
    if (params.cursor === "native-next") return page([{ id: "older", itemsView: "full", items: [item] }], null, "native-back");
    return page([{ id: "latest", itemsView: "full", items: [item] }], "native-next", "native-back");
  });
  manager.historyMode = "legacy";
  const surface = new ControlSurface(manager);
  const first = await callHistory(surface, { kind: "turns" }) as Record<string, unknown>;
  assert.deepEqual(first, {
    source: "codex_app_server", mode: "history", coverage: "native_persisted_history",
    history_mode: "legacy", kind: "turns", page_granularity: "turn", items_view: "full", thread_id: "thread-1",
    data: [{ id: "latest", itemsView: "full", items: [item] }], nextCursor: "native-next", backwardsCursor: "native-back",
  });
  const second = await callHistory(surface, { kind: "turns", cursor: first.nextCursor, limit: 1 }) as Record<string, unknown>;
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.data, [{ id: "older", itemsView: "full", items: [item] }]);
  await callHistory(surface, { kind: "turns", cursor: second.backwardsCursor, sort_direction: "asc" });
  assert.deepEqual(manager.calls.at(-1)?.params, { threadId: "thread-1", cursor: "native-back", limit: 1, sortDirection: "asc", itemsView: "full" });
  for (const call of manager.calls.filter(call => call.method === "thread/read")) assert.equal(call.params.includeTurns, false);
  assert.equal(manager.runtime.hasThread("thread-1"), false);

  // Mode is freshly read on every request, never inferred from a saved cursor.
  manager.historyMode = "paginated";
  const before = manager.calls.length;
  const refreshed = await callHistory(surface, { kind: "turns" }) as Record<string, unknown>;
  assert.equal(refreshed.history_mode, "paginated");
  assert.equal(refreshed.items_view, "notLoaded");
  assert.equal(manager.calls.length, before + 2);
  assert.equal(manager.calls.at(-1)?.params.itemsView, "notLoaded");
  assert.equal(manager.calls.at(-1)?.params.limit, 20);
});

test("mode-specific failures stop after metadata and unknown modes never guess or hydrate", async () => {
  const manager = new StubAppServer(() => { throw new Error("history RPC forbidden"); });
  manager.historyMode = "legacy";
  const surface = new ControlSurface(manager);
  await assert.rejects(callHistory(surface, { kind: "items", turn_id: "turn-1" }), /^Error: history_legacy_item_paging_unsupported:.*kind:'turns'/);
  await assert.rejects(callHistory(surface, { kind: "turns", limit: 2 }), /legacy.*limit:1/);
  assert.deepEqual(manager.calls.map(call => call.method), ["thread/read", "thread/read"]);
  for (const mode of [undefined, null, "unknown", {}, 1]) {
    manager.historyMode = mode;
    await assert.rejects(callHistory(surface, { kind: "turns" }), /^Error: history_upstream_invalid:/);
  }
  assert.ok(manager.calls.every(call => call.method === "thread/read" && call.params.includeTurns === false));
  assert.equal(manager.runtime.hasThread("thread-1"), false);
  manager.routeMetadata = false;
  await assert.rejects(callHistory(surface, { kind: "turns" }), /history RPC forbidden/);
  assert.equal(manager.calls.at(-1)?.method, "thread/read");
});

test("legacy oversize/redaction failures never split a full turn or retry full history", async () => {
  for (const item of [{ text: "中".repeat(100_000) }, { api_key: "fixture-secret" }]) {
    const manager = new StubAppServer(() => page([{ id: "legacy-turn", itemsView: "full", items: [item] }]));
    manager.historyMode = "legacy";
    await assert.rejects(callHistory(new ControlSurface(manager), { kind: "turns" }),
      "api_key" in item ? /^Error: history_page_not_lossless:/ : /^Error: history_page_too_large:.*legacy turn at limit:1/);
    assert.deepEqual(manager.calls.map(call => call.method), ["thread/read", "thread/turns/list"]);
    assert.equal(manager.runtime.hasThread("thread-1"), false);
  }
});

test("metadata errors and malformed metadata stop without a history RPC", async () => {
  for (const metadata of [null, {}, { thread: null }, { thread: { id: "other", historyMode: "paginated" } }]) {
    const manager = new StubAppServer(() => metadata);
    manager.routeMetadata = false;
    await assert.rejects(callHistory(new ControlSurface(manager), { kind: "turns" }), /./);
    assert.deepEqual(manager.calls.map(call => call.method), ["thread/read"]);
    assert.equal(manager.runtime.hasThread("thread-1"), false);
  }
});
