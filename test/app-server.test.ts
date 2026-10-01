import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AppServerManager,
  createSerializedWriter,
  writeWithBackpressure,
} from "../src/app-server.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";
import { WINDOWS_PLATFORM_POLICY } from "../src/platform.js";

const fakeCodex = fileURLToPath(new URL("../../test/fake-codex.mjs", import.meta.url));
const timeoutCodex = fileURLToPath(new URL("../../test/timeout-codex.mjs", import.meta.url));
const pendingWriteCodex = fileURLToPath(new URL("../../test/pending-write-codex.mjs", import.meta.url));
const lateResponseCodex = fileURLToPath(new URL("../../test/late-response-codex.mjs", import.meta.url));
const duplicateRequestCodex = fileURLToPath(new URL("../../test/duplicate-request-codex.mjs", import.meta.url));

test("history response above 10 MiB remains a fatal app-server inbound limitation", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 5_000,
  });
  try {
    await assert.rejects(
      new ControlSurface(manager).call("codex_history", {
        thread_id: "thread-big", kind: "turns", cursor: "oversized-inbound", limit: 1,
      }),
      /app-server JSONL line exceeded 10 MiB/,
    );
    // Let the fixture exit after protocol failure; it must not replace the cause.
    await delay(100);
    await assert.rejects(manager.request("thread/resume", { threadId: "thread-big", excludeTurns: true }),
      /unavailable and will not be auto-restarted: app-server JSONL line exceeded 10 MiB/);
    const metadata = await manager.request("thread/read", { threadId: "thread-big", includeTurns: false });
    assert.ok(metadata);
    assert.equal(manager.transportDiagnostics.recovery_used, true);
  } finally {
    await manager.close();
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RejectingResponseManager extends AppServerManager {
  lastResponseId: string | number | undefined;

  override async respond(id: string | number, _result: unknown): Promise<void> {
    this.lastResponseId = id;
    throw new Error("synthetic app-server response write failure");
  }
}

class CapturingResponseManager extends AppServerManager {
  readonly responses: Array<{ id: string | number; result: unknown }> = [];

  override async respond(id: string | number, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }
}

class ControlledBackpressureSink extends EventEmitter {
  writable = true;
  writableEnded = false;
  destroyed = false;
  readonly chunks: string[] = [];
  #callback: ((error?: Error | null) => void) | null = null;

  write(
    chunk: string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): boolean {
    this.chunks.push(chunk);
    this.#callback = callback;
    return false;
  }

  completeWrite(error?: Error): void {
    const callback = this.#callback;
    if (!callback) {
      throw new Error("No controlled write is pending");
    }
    this.#callback = null;
    callback(error);
  }
}

test("control surface starts asynchronously, steers the same turn, uses raw request id, and observes final", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
  });
  const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  try {
    const started = await control.call("codex_turn", {
      text: "read only",
      cwd: "D:\\Bridge",
      sandbox: "read-only",
      approval_policy: "never",
    }) as Record<string, unknown>;
    assert.equal(started.accepted, true);
    assert.equal(started.thread_id, "thread-1");
    assert.equal(started.turn_id, "turn-1");

    const steered = await control.call("codex_steer", {
      thread_id: "thread-1",
      expected_turn_id: "turn-1",
      text: "read another file",
    }) as Record<string, unknown>;
    assert.equal(steered.turn_id, "turn-1");

    await delay(30);
    const active = await control.call("codex_observe", {
      thread_id: "thread-1",
      cursor: 0,
    }) as Record<string, unknown>;
    const pending = active.pending_requests as Array<Record<string, unknown>>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request_id, "approval-1");
    assert.equal((pending[0]?.params as Record<string, unknown>).api_key, "[REDACTED]");

    const responded = await control.call("codex_respond", {
      request_id: "approval-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      method: "item/commandExecution/requestApproval",
      decision: "decline",
    }) as Record<string, unknown>;
    assert.equal(responded.request_id, "approval-1");
    await assert.rejects(
      control.call("codex_respond", {
        request_id: "approval-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        method: "item/commandExecution/requestApproval",
        decision: "decline",
      }),
      /No pending/,
    );

    await delay(30);
    let cursor = active.next_cursor as number;
    let observedFinal: string | undefined;
    for (let attempt = 0; attempt < 10 && observedFinal === undefined; attempt += 1) {
      const completed = await control.call("codex_observe", {
        thread_id: "thread-1", cursor,
      }) as Record<string, unknown>;
      assert.equal(completed.runtime_status, "completed");
      const events = (completed.events ?? []) as Array<Record<string, unknown>>;
      const message = events.find((entry) => entry.type === "message");
      observedFinal = (message?.text ?? (completed.terminal as Record<string, unknown>)?.final_result) as string | undefined;
      const next = completed.next_cursor as number;
      if (next === cursor) break;
      cursor = next;
    }
    assert.equal(observedFinal, "FAKE_FINAL");
  } finally {
    await manager.close();
  }
});

test("Codex child environment removes only the Tunnel control-plane secret", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    environment: {
      ...process.env,
      CONTROL_PLANE_API_KEY: "synthetic-test-value",
      LOCAL_CODEX_BRIDGE_ENV_PROBE: "preserved",
    },
    requestTimeoutMs: 2_000,
  });
  try {
    assert.deepEqual(await manager.request("test/environment", {}), {
      controlPlaneApiKeyPresent: false,
      preservedProbe: "preserved",
    });
  } finally {
    await manager.close();
  }
});

test("unexpected app-server death is latched and never auto-restarted", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
  });
  try {
    await assert.rejects(manager.request("test/exit", {}), /exited unexpectedly/);
    await assert.rejects(manager.request("thread/list", {}), /will not be auto-restarted/);
  } finally {
    await manager.close();
  }
});

test("failed app-server response write restores the original pending request", async () => {
  const manager = new RejectingResponseManager();
  const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  manager.runtime.markTurnAccepted("thread-restore", "turn-restore");
  manager.runtime.recordServerRequest(41, "item/fileChange/requestApproval", {
    threadId: "thread-restore",
    turnId: "turn-restore",
  });

  try {
    await assert.rejects(
      control.call("codex_respond", {
        request_id: 41,
        thread_id: "thread-restore",
        turn_id: "turn-restore",
        method: "item/fileChange/requestApproval",
        decision: "decline",
      }),
      /synthetic app-server response write failure/,
    );
    assert.equal(manager.lastResponseId, 41);
    const pending = manager.runtime.pendingForThread("thread-restore") as Array<Record<string, unknown>>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request_id, 41);
  } finally {
    await manager.close();
  }
});

test("codex_respond maps network allow/deny and preserves distinct stable and legacy decisions", async () => {
  const manager = new CapturingResponseManager();
  const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  const command = "item/commandExecution/requestApproval";
  const cases: Array<{ method: string; input: Record<string, unknown>; decision: unknown }> = [];
  for (const action of ["allow", "deny"]) {
    const amendment = { host: "api.example.com", action };
    cases.push({ method: command, input: { network_policy_amendment: amendment },
      decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } } });
  }
  for (const method of [command, "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"]) {
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) {
      const legacy: Record<string, unknown> = {
        accept: "approved", acceptForSession: "approved_for_session",
        decline: { denied: { rejection: "declined by MCP client" } }, cancel: "abort",
      };
      cases.push({ method, input: { decision }, decision: method.startsWith("item/") ? decision : legacy[decision] });
    }
  }
  for (const method of [command, "execCommandApproval"]) {
    cases.push({ method, input: { execpolicy_amendment: ["npm", "test"] },
      decision: method === command
        ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } }
        : { approved_execpolicy_amendment: { proposed_execpolicy_amendment: ["npm", "test"] } } });
  }
  manager.runtime.markTurnAccepted("thread-network", "turn-network");
  try {
    for (const [id, current] of cases.entries()) {
      manager.runtime.recordServerRequest(id, current.method, { threadId: "thread-network", turnId: "turn-network" });
      await control.call("codex_respond", {
        request_id: id, thread_id: "thread-network", turn_id: "turn-network", method: current.method, ...current.input,
      });
      assert.deepEqual(manager.responses.at(-1), { id, result: { decision: current.decision } });
      assert.deepEqual(manager.runtime.pendingForThread("thread-network"), []);
    }
  } finally {
    await manager.close();
  }
});

test("codex_respond rejects invalid network amendments before claiming pending requests", async (t) => {
  const command = "item/commandExecution/requestApproval";
  const valid = { host: "api.example.com", action: "allow" };
  const cases: Array<{ name: string; method?: string; input: Record<string, unknown>; error: RegExp }> = [];
  for (const [name, amendment, error] of [
    ["missing host", { action: "allow" }, /host must be a non-empty string/],
    ["empty host", { host: "", action: "allow" }, /host must be a non-empty string/],
    ["blank host", { host: "  ", action: "allow" }, /host must be a non-empty string/],
    ["non-string host", { host: 7, action: "allow" }, /host must be a non-empty string/],
    ["missing action", { host: valid.host }, /requires action/],
    ["invalid action", { host: valid.host, action: "accept" }, /action must be one of: allow, deny/],
    ["non-string action", { host: valid.host, action: true }, /action must be one of: allow, deny/],
    ["extra property", { ...valid, persist: true }, /Unknown argument field: persist/],
    ["null amendment", null, /network_policy_amendment must be an object/],
    ["array amendment", [], /network_policy_amendment must be an object/],
    ["string amendment", "allow", /network_policy_amendment must be an object/],
  ] as const) {
    cases.push({ name, input: { network_policy_amendment: amendment }, error });
  }
  for (const method of ["item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval",
    "item/tool/requestUserInput", "item/permissions/requestApproval", "future/requestApproval"]) {
    cases.push({ name: `wrong method ${method}`, method, input: { network_policy_amendment: valid },
      error: /valid only for item\/commandExecution\/requestApproval|Unsupported app-server request method/ });
  }
  for (const [selector, value] of Object.entries({ decision: "accept", execpolicy_amendment: ["npm"],
    answers: {}, permissions: {}, response: {}, scope: "session" })) {
    cases.push({ name: `conflicting ${selector}`, input: { network_policy_amendment: valid, [selector]: value },
      error: /Provide exactly one|permissions and scope are valid only/ });
  }
  for (const current of cases) {
    await t.test(current.name, async (t) => {
      const manager = new CapturingResponseManager();
      const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
      const method = current.method ?? command;
      manager.runtime.markTurnAccepted("thread-network", "turn-network");
      manager.runtime.recordServerRequest(41, method, { threadId: "thread-network", turnId: "turn-network" });
      const before = manager.runtime.pendingForThread("thread-network");
      const claim = t.mock.method(manager.runtime, "claimPending");
      try {
        await assert.rejects(control.call("codex_respond", {
          request_id: 41, thread_id: "thread-network", turn_id: "turn-network", method, ...current.input,
        }), current.error);
        assert.equal(claim.mock.callCount(), 0);
        assert.deepEqual(manager.responses, []);
        assert.deepEqual(manager.runtime.pendingForThread("thread-network"), before);
      } finally {
        await manager.close();
      }
    });
  }
});

test("failed network amendment response write retains the same pending request", async () => {
  const manager = new RejectingResponseManager();
  const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  const method = "item/commandExecution/requestApproval";
  manager.runtime.markTurnAccepted("thread-network", "turn-network");
  manager.runtime.recordServerRequest(41, method, { threadId: "thread-network", turnId: "turn-network" });
  const before = manager.runtime.pendingForThread("thread-network");
  try {
    await assert.rejects(control.call("codex_respond", {
      request_id: 41, thread_id: "thread-network", turn_id: "turn-network", method,
      network_policy_amendment: { host: "api.example.com", action: "deny" },
    }), /synthetic app-server response write failure/);
    assert.equal(manager.lastResponseId, 41);
    assert.deepEqual(manager.runtime.pendingForThread("thread-network"), before);
    const pending = manager.runtime.claimPending(41, { threadId: "thread-network", turnId: "turn-network", method });
    manager.runtime.releasePending(pending);
  } finally {
    await manager.close();
  }
});

test("codex_respond sends exact stable permission responses including an empty grant", async () => {
  const manager = new CapturingResponseManager();
  const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  manager.runtime.markTurnAccepted("thread-permissions", "turn-permissions");
  manager.runtime.recordServerRequest("permissions-session", "item/permissions/requestApproval", {
    threadId: "thread-permissions",
    turnId: "turn-permissions",
    permissions: { network: true, fileSystem: true },
  });
  manager.runtime.recordServerRequest("permissions-empty", "item/permissions/requestApproval", {
    threadId: "thread-permissions",
    turnId: "turn-permissions",
    permissions: { network: true },
  });

  try {
    await control.call("codex_respond", {
      request_id: "permissions-session",
      thread_id: "thread-permissions",
      turn_id: "turn-permissions",
      method: "item/permissions/requestApproval",
      permissions: { network: true },
      scope: "session",
    });
    await control.call("codex_respond", {
      request_id: "permissions-empty",
      thread_id: "thread-permissions",
      turn_id: "turn-permissions",
      method: "item/permissions/requestApproval",
      permissions: {},
    });

    assert.deepEqual(manager.responses, [
      {
        id: "permissions-session",
        result: { permissions: { network: true }, scope: "session" },
      },
      {
        id: "permissions-empty",
        result: { permissions: {} },
      },
    ]);
    assert.deepEqual(manager.runtime.pendingForThread("thread-permissions"), []);
  } finally {
    await manager.close();
  }
});

test("codex_respond rejects malformed or mixed permission contracts without claiming pending requests", async (t) => {
  const cases: Array<{ name: string; extra: Record<string, unknown>; error: RegExp }> = [
    {
      name: "missing permissions",
      extra: { decision: "decline" },
      error: /requires permissions/,
    },
    {
      name: "mixed approval decision",
      extra: { permissions: {}, decision: "decline" },
      error: /accepts only permissions and optional scope/,
    },
    {
      name: "permissions is not an object",
      extra: { permissions: [] },
      error: /permissions must be an object/,
    },
    {
      name: "invalid scope",
      extra: { permissions: {}, scope: "global" },
      error: /scope must be one of: turn, session/,
    },
  ];

  for (const [index, current] of cases.entries()) {
    await t.test(current.name, async () => {
      const manager = new CapturingResponseManager();
      const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
      const requestId = `permissions-malformed-${index}`;
      manager.runtime.markTurnAccepted("thread-permissions-bad", "turn-permissions-bad");
      manager.runtime.recordServerRequest(requestId, "item/permissions/requestApproval", {
        threadId: "thread-permissions-bad",
        turnId: "turn-permissions-bad",
      });
      try {
        await assert.rejects(
          control.call("codex_respond", {
            request_id: requestId,
            thread_id: "thread-permissions-bad",
            turn_id: "turn-permissions-bad",
            method: "item/permissions/requestApproval",
            ...current.extra,
          }),
          current.error,
        );
        assert.deepEqual(manager.responses, []);
        assert.equal(manager.runtime.pendingForThread("thread-permissions-bad").length, 1);
      } finally {
        await manager.close();
      }
    });
  }
});

test("codex_respond rejects permission fields on other approval contracts", async () => {
  const manager = new CapturingResponseManager();
  const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  manager.runtime.markTurnAccepted("thread-mixed", "turn-mixed");
  manager.runtime.recordServerRequest("mixed-permissions", "item/fileChange/requestApproval", {
    threadId: "thread-mixed",
    turnId: "turn-mixed",
  });
  try {
    await assert.rejects(
      control.call("codex_respond", {
        request_id: "mixed-permissions",
        thread_id: "thread-mixed",
        turn_id: "turn-mixed",
        method: "item/fileChange/requestApproval",
        permissions: {},
      }),
      /permissions and scope are valid only for item\/permissions\/requestApproval/,
    );
    assert.deepEqual(manager.responses, []);
    assert.equal(manager.runtime.pendingForThread("thread-mixed").length, 1);
  } finally {
    await manager.close();
  }
});

test("threadless app-server server request receives an explicit JSON-RPC error", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
  });
  try {
    const result = await manager.request("test/threadless", {}) as Record<string, unknown>;
    assert.equal(result.clientErrorId, "threadless-1");
    assert.deepEqual(result.clientError, {
      code: -32601,
      message: "Unsupported app-server request without thread context",
    });
    const listed = await manager.request("thread/list", {}) as Record<string, unknown>;
    assert.equal(Array.isArray(listed.data), true);
  } finally {
    await manager.close();
  }
});

test("mutating app-server acknowledgement timeouts report unknown outcome without retry", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [timeoutCodex],
    requestTimeoutMs: 20,
  });
  try {
    for (const method of ["thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt", "thread/goal/set", "thread/goal/clear", "thread/queue/add", "thread/queue/update", "thread/queue/delete", "thread/queue/reorder"]) {
      await assert.rejects(
        manager.request(method, {}),
        (error: unknown) => {
          assert.match(String(error), /acknowledgement timed out/);
          assert.match(String(error), /operation outcome is UNKNOWN/);
          assert.match(String(error), /Re-observe or read before retrying/);
          return true;
        },
      );
    }
    await assert.rejects(
      manager.request("thread/list", {}),
      /Codex app-server request timed out: thread\/list/,
    );
    await assert.rejects(manager.request("thread/goal/get", {}), /Codex app-server request timed out: thread\/goal\/get/);
    await assert.rejects(manager.request("thread/queue/list", {}), /Codex app-server request timed out: thread\/queue\/list/);
    for (const method of ["thread/search", "thread/searchOccurrences"]) {
      await assert.rejects(manager.request(method, {}), error => {
        assert.match(String(error), /Codex app-server request timed out:/);
        assert.doesNotMatch(String(error), /UNKNOWN|possibly accepted/); return true;
      });
    }
    const count = await manager.request("test/count", {}) as Record<string, unknown>;
    // App-server startup sends initialize plus the initialized notification.
    assert.equal(count.requestCount, 19);
  } finally {
    await manager.close();
  }
});

test("mutating timeout stays UNKNOWN while the native write remains pending", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [pendingWriteCodex],
    requestTimeoutMs: 25,
  });
  try {
    await assert.rejects(
      manager.request("turn/start", { payload: "x".repeat(2_000_000) }),
      (error: unknown) => {
        assert.match(String(error), /acknowledgement timed out/);
        assert.match(String(error), /operation outcome is UNKNOWN/);
        assert.doesNotMatch(String(error), /Codex app-server request timed out: turn\/start/);
        return true;
      },
    );
    await delay(250);
    assert.deepEqual(await manager.request("test/after", {}), { after: true });
  } finally {
    await manager.close();
  }
});

test("late turn/start responses reconcile conservatively around native notifications", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 30,
  });
  try {
    const threadIds = [
      "thread-no-notification",
      "thread-native-started",
      "thread-native-terminal",
    ];
    await Promise.all(threadIds.map(async (threadId) => {
      await assert.rejects(
        manager.request("turn/start", { threadId, input: [] }),
        /operation outcome is UNKNOWN/,
      );
    }));
    await delay(170);

    const noNotification = manager.runtime.observe("thread-no-notification", 0, 10)!;
    assert.equal(noNotification.active_turn_id, "turn-thread-no-notification");
    assert.equal(
      (noNotification.events.at(-1)?.data as Record<string, unknown>).action,
      "turn_activated",
    );

    const nativeStarted = manager.runtime.observe("thread-native-started", 0, 10)!;
    assert.equal(nativeStarted.active_turn_id, "turn-thread-native-started");
    assert.equal(
      (nativeStarted.events.at(-1)?.data as Record<string, unknown>).reason,
      "turn_already_active",
    );

    const nativeTerminal = manager.runtime.observe("thread-native-terminal", 0, 10)!;
    assert.equal(nativeTerminal.active_turn_id, null);
    assert.equal(nativeTerminal.terminal?.turn_id, "turn-thread-native-terminal");
    assert.equal(nativeTerminal.terminal?.final_result, "TERMINAL");
    assert.equal(
      (nativeTerminal.events.at(-1)?.data as Record<string, unknown>).reason,
      "terminal_present",
    );

    const state = await manager.request("test/state", {}) as Record<string, unknown>;
    assert.equal(state.turnStart, 3);
  } finally {
    await manager.close();
  }
});

test("late thread/start and thread/resume become observable without a follow-on turn", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 30,
  });
  const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  try {
    await assert.rejects(
      control.call("codex_turn", { text: "new thread", cwd: "D:\\Bridge" }),
      /operation outcome is UNKNOWN/,
    );
    await assert.rejects(
      control.call("codex_turn", {
        text: "resume thread",
        thread_id: "thread-resume-late",
      }),
      /operation outcome is UNKNOWN/,
    );
    await delay(170);

    assert.equal(manager.runtime.observe("late-thread-1", 0, 10)?.runtime_status, "idle");
    assert.equal(manager.runtime.observe("thread-resume-late", 0, 10)?.runtime_status, "idle");
    const state = await manager.request("test/state", {}) as Record<string, unknown>;
    assert.equal(state.threadStart, 1);
    assert.equal(state.threadResume, 1);
    assert.equal(state.turnStart, 0);
    assert.equal(state.turnInterrupt, 0);
  } finally {
    await manager.close();
  }
});

test("late steer and interrupt acknowledgements are observable without lifecycle mutation", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 30,
  });
  manager.runtime.markTurnAccepted("thread-steer-late", "turn-steer-late");
  manager.runtime.markTurnAccepted("thread-interrupt-late", "turn-interrupt-late");
  manager.runtime.markTurnAccepted("thread-steer-error", "turn-steer-error");
  try {
    await Promise.all([
      assert.rejects(
        manager.request("turn/steer", {
          threadId: "thread-steer-late",
          expectedTurnId: "turn-steer-late",
          input: [],
        }),
        /operation outcome is UNKNOWN/,
      ),
      assert.rejects(
        manager.request("turn/interrupt", {
          threadId: "thread-interrupt-late",
          turnId: "turn-interrupt-late",
        }),
        /operation outcome is UNKNOWN/,
      ),
      assert.rejects(
        manager.request("turn/steer", {
          threadId: "thread-steer-error",
          expectedTurnId: "turn-steer-error",
          input: [],
          testLateError: true,
        }),
        /operation outcome is UNKNOWN/,
      ),
    ]);
    await delay(170);

    for (const [threadId, turnId] of [
      ["thread-steer-late", "turn-steer-late"],
      ["thread-interrupt-late", "turn-interrupt-late"],
    ] as const) {
      const observed = manager.runtime.observe(threadId, 0, 10)!;
      assert.equal(observed.active_turn_id, turnId);
      assert.equal(
        (observed.events.at(-1)?.data as Record<string, unknown>).reason,
        "late_success_no_lifecycle_change",
      );
    }
    const errored = manager.runtime.observe("thread-steer-error", 0, 10)!;
    assert.equal(errored.active_turn_id, "turn-steer-error");
    const errorData = errored.events.at(-1)?.data as Record<string, unknown>;
    assert.equal(errorData.reason, "late_error");
    assert.doesNotMatch(
      JSON.stringify(errorData.error),
      /FAKE_FIXTURE_SECRET_1234567890/,
    );
    assert.match(JSON.stringify(errorData.error), /REDACTED/);

    const state = await manager.request("test/state", {}) as Record<string, unknown>;
    assert.equal(state.turnSteer, 2);
    assert.equal(state.turnInterrupt, 1);
  } finally {
    await manager.close();
  }
});

test("late response retention expires, evicts oldest entries, and consumes unscoped errors", async () => {
  const expiring = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 20,
    lateResponseTtlMs: 35,
  });
  try {
    await assert.rejects(
      expiring.request("thread/start", { testThreadId: "thread-expired" }),
      /operation outcome is UNKNOWN/,
    );
    await delay(170);
    assert.equal(expiring.runtime.hasThread("thread-expired"), false);
  } finally {
    await expiring.close();
  }

  const capped = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 20,
    lateResponseTtlMs: 500,
    lateResponseLimit: 2,
  });
  try {
    await Promise.all(["thread-cap-1", "thread-cap-2", "thread-cap-3"].map(async (threadId) => {
      await assert.rejects(
        capped.request("thread/start", { testThreadId: threadId }),
        /operation outcome is UNKNOWN/,
      );
    }));
    await delay(170);
    assert.equal(capped.runtime.hasThread("thread-cap-1"), false);
    assert.equal(capped.runtime.hasThread("thread-cap-2"), true);
    assert.equal(capped.runtime.hasThread("thread-cap-3"), true);

    await assert.rejects(
      capped.request("thread/start", {
        testThreadId: "thread-after-error",
        testLateError: true,
      }),
      /operation outcome is UNKNOWN/,
    );
    await delay(180);
    assert.equal(capped.runtime.hasThread("thread-after-error"), false);
  } finally {
    await capped.close();
  }
});

test("duplicate app-server request ids fail the protocol without an ambiguous response", async () => {
  const logPath = fileURLToPath(new URL(
    `../../test/.duplicate-request-${process.pid}-${Date.now()}.log`,
    import.meta.url,
  ));
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [duplicateRequestCodex, logPath],
    requestTimeoutMs: 2_000,
  });
  try {
    await assert.rejects(
      manager.request("test/duplicate", {}),
      /protocol anomaly: duplicate outstanding number request id/,
    );
    assert.equal(manager.runtime.hasThread("thread-duplicate"), false);
    const original = manager.runtime.observe("thread-original", 0, 10)!;
    const stringTyped = manager.runtime.observe("thread-string", 0, 10)!;
    assert.equal(original.events[0]?.method, "item/fileChange/requestApproval");
    assert.equal(
      ((original.events[0]?.data as Record<string, unknown>).params as Record<string, unknown>).marker,
      "original",
    );
    assert.equal(stringTyped.events[0]?.method, "item/tool/requestUserInput");
    assert.equal(
      (stringTyped.events[0]?.data as Record<string, unknown>).request_id,
      "17",
    );
  } finally {
    await manager.close();
  }
  try {
    const childLog = await readFile(logPath, "utf8");
    assert.match(childLog, /stdin-closed/);
    assert.doesNotMatch(childLog, /ambiguous-response/);
  } finally {
    await rm(logPath, { force: true });
  }
});

test("unsupported elicitation requests remain observable and are never answered", async () => {
  const manager = new RejectingResponseManager();
  const control = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
  manager.runtime.markTurnAccepted("thread-unknown", "turn-unknown");
  manager.runtime.recordServerRequest("future-1", "mcpServer/elicitation/request", {
    threadId: "thread-unknown",
    turnId: "turn-unknown",
    api_key: "must-redact",
    detail: "keep this pending",
  });
  try {
    await assert.rejects(
      control.call("codex_respond", {
        request_id: "future-1",
        thread_id: "thread-unknown",
        turn_id: "turn-unknown",
        method: "mcpServer/elicitation/request",
        response: { guessed: true },
      }),
      /Unsupported app-server request method: mcpServer\/elicitation\/request; pending request remains observable/,
    );
    assert.equal(manager.lastResponseId, undefined);
    const observed = manager.runtime.observe("thread-unknown", 0, 10);
    const pending = observed?.pending_requests as Array<Record<string, unknown>>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request_id, "future-1");
    assert.equal(pending[0]?.method, "mcpServer/elicitation/request");
    assert.equal(pending[0]?.thread_id, "thread-unknown");
    assert.equal(pending[0]?.turn_id, "turn-unknown");
    assert.equal((pending[0]?.params as Record<string, unknown>).api_key, "[REDACTED]");
  } finally {
    await manager.close();
  }
});

test("codex_respond metadata does not advertise generic future-method responses", () => {
  const respondTool = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_respond");
  assert.match(respondTool?.description ?? "", /original typed request id and exact method, thread, and turn scope when applicable/);
  assert.match(respondTool?.description ?? "", /Unsupported methods fail locally and remain pending/);
  assert.doesNotMatch(respondTool?.description ?? "", /elicitation/i);
  const response = (respondTool?.inputSchema.properties as Record<string, unknown>).response as Record<string, unknown>;
  assert.match(response.description as string, /unsupported methods remain pending/);
});

test("serialized app-server writes preserve order and wait for drain", async () => {
  const sink = new ControlledBackpressureSink();
  const write = createSerializedWriter((chunk) =>
    writeWithBackpressure(sink as unknown as Writable, chunk),
  );
  let firstResolved = false;
  const first = write("first\n").then(() => {
    firstResolved = true;
  });
  const second = write("second\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sink.chunks, ["first\n"]);
  sink.completeWrite();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResolved, false);
  assert.deepEqual(sink.chunks, ["first\n"]);
  sink.emit("drain");
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResolved, true);
  assert.deepEqual(sink.chunks, ["first\n", "second\n"]);
  sink.completeWrite();
  sink.emit("drain");
  await second;
});

test("app-server stream writes reject on error or close and the chain recovers", async () => {
  const errorSink = new ControlledBackpressureSink();
  const errorWrite = writeWithBackpressure(
    errorSink as unknown as Writable,
    "error\n",
  );
  const errorAssertion = assert.rejects(errorWrite, /synthetic stream failure/);
  errorSink.emit("error", new Error("synthetic stream failure"));
  await errorAssertion;

  const closedSink = new ControlledBackpressureSink();
  const closedWrite = writeWithBackpressure(
    closedSink as unknown as Writable,
    "closed\n",
  );
  const closeAssertion = assert.rejects(closedWrite, /stdin closed during write/);
  closedSink.emit("close");
  await closeAssertion;

  let attempts = 0;
  const recoveringWrite = createSerializedWriter(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("synthetic queued failure");
    }
  });
  await assert.rejects(recoveringWrite("first\n"), /synthetic queued failure/);
  await recoveringWrite("second\n");
  assert.equal(attempts, 2);
});
