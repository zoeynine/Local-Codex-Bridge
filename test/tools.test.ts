import assert from "node:assert/strict";
import test from "node:test";

import { AppServerManager } from "../src/app-server.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

const TEST_CWD = "/tmp/local-codex-bridge-work";
const TEST_SHARED_CWD = "/tmp/local-codex-bridge-shared";

interface CapturedRequest {
  method: string;
  params: unknown;
}

class StubAppServerManager extends AppServerManager {
  readonly requests: CapturedRequest[] = [];

  constructor(
    private readonly handleRequest: (method: string, params: unknown) => unknown,
  ) {
    super(new RuntimeStore(), { executable: "unused-test-codex" });
  }

  override async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.handleRequest(method, params);
  }
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function propertySchema(toolName: string, propertyName: string): Record<string, unknown> {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === toolName);
  assert.ok(tool, `missing tool definition ${toolName}`);
  const properties = object(tool.inputSchema.properties);
  return object(properties[propertyName]);
}

test("codex_turn forwards each requested raw sandbox and the exact returned native policy", async (t) => {
  const cases = [
    {
      requested: "read-only",
      policy: { type: "readOnly" },
    },
    {
      requested: "workspace-write",
      policy: {
        type: "workspaceWrite",
        writableRoots: [TEST_CWD, TEST_SHARED_CWD],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: true,
      },
    },
    {
      requested: "danger-full-access",
      policy: { type: "dangerFullAccess" },
    },
  ] as const;

  for (const { requested, policy } of cases) {
    await t.test(requested, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method === "thread/start") {
          return { thread: { id: `thread-${requested}` }, sandbox: policy };
        }
        if (method === "turn/start") {
          return { turn: { id: `turn-${requested}`, status: "inProgress" } };
        }
        throw new Error(`unexpected request ${method}`);
      });
      const surface = new ControlSurface(manager);

      await surface.call("codex_turn", {
        text: "test turn",
        cwd: TEST_CWD,
        sandbox: requested,
      });

      assert.equal(manager.requests.length, 2);
      assert.equal(manager.requests[0]?.method, "thread/start");
      assert.deepEqual(object(manager.requests[0]?.params), {
        cwd: TEST_CWD,
        sandbox: requested,
        serviceName: "local-codex-bridge",
      });
      assert.equal(manager.requests[1]?.method, "turn/start");
      const turnParams = object(manager.requests[1]?.params);
      assert.strictEqual(turnParams.sandboxPolicy, policy);
      assert.deepEqual(turnParams.sandboxPolicy, policy);
    });
  }
});

test("codex_turn uses the newly resolved policy when the same thread changes sandbox", async () => {
  const workspacePolicy = {
    type: "workspaceWrite",
    writableRoots: [TEST_CWD],
    networkAccess: false,
  };
  const readOnlyPolicy = { type: "readOnly" };
  let turnNumber = 0;
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/start") {
      return { thread: { id: "thread-shared" }, sandbox: workspacePolicy };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-shared" }, sandbox: readOnlyPolicy };
    }
    if (method === "turn/start") {
      turnNumber += 1;
      return { turn: { id: `turn-${turnNumber}`, status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager);

  await surface.call("codex_turn", {
    text: "first",
    cwd: TEST_CWD,
    sandbox: "workspace-write",
  });
  await surface.call("codex_turn", {
    text: "second",
    thread_id: "thread-shared",
    sandbox: "read-only",
  });

  assert.deepEqual(manager.requests.map((request) => request.method), [
    "thread/start",
    "turn/start",
    "thread/resume",
    "turn/start",
  ]);
  assert.strictEqual(object(manager.requests[1]?.params).sandboxPolicy, workspacePolicy);
  assert.deepEqual(object(manager.requests[2]?.params), {
    threadId: "thread-shared",
    sandbox: "read-only",
  });
  assert.strictEqual(object(manager.requests[3]?.params).sandboxPolicy, readOnlyPolicy);
});

test("codex_turn omits turn-level sandboxPolicy when sandbox was not requested", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/start") {
      return {
        thread: { id: "thread-default" },
        sandbox: { type: "workspaceWrite", writableRoots: [TEST_CWD] },
      };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-default", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager);

  await surface.call("codex_turn", { text: "default sandbox", cwd: TEST_CWD });

  assert.equal("sandbox" in object(manager.requests[0]?.params), false);
  assert.equal("sandboxPolicy" in object(manager.requests[1]?.params), false);
});

test("codex_turn fails closed before turn/start for unusable returned sandbox policies", async (t) => {
  const invalidPolicies: Array<{ name: string; includeSandbox: boolean; value?: unknown }> = [
    { name: "missing", includeSandbox: false },
    { name: "non-object", includeSandbox: true, value: "workspaceWrite" },
    { name: "array", includeSandbox: true, value: [{ type: "workspaceWrite" }] },
    { name: "missing discriminator", includeSandbox: true, value: {} },
    { name: "unknown discriminator", includeSandbox: true, value: { type: "futurePolicy" } },
    { name: "mismatched discriminator", includeSandbox: true, value: { type: "readOnly" } },
  ];

  for (const invalid of invalidPolicies) {
    await t.test(invalid.name, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method !== "thread/start") {
          throw new Error(`unexpected request ${method}`);
        }
        return {
          thread: { id: "thread-invalid" },
          ...(invalid.includeSandbox ? { sandbox: invalid.value } : {}),
        };
      });
      const surface = new ControlSurface(manager);

      await assert.rejects(
        surface.call("codex_turn", {
          text: "must not start",
          cwd: TEST_CWD,
          sandbox: "workspace-write",
        }),
        /sandbox/,
      );
      assert.deepEqual(manager.requests.map((request) => request.method), ["thread/start"]);
    });
  }
});

test("public tool schemas expose the same string bounds already enforced at runtime", () => {
  const expected: Array<[string, string, number]> = [
    ["codex_threads", "thread_id", 200],
    ["codex_threads", "cwd", 1_000],
    ["codex_threads", "cursor", 10_000],
    ["codex_turn", "thread_id", 200],
    ["codex_turn", "cwd", 1_000],
    ["codex_observe", "thread_id", 200],
    ["codex_steer", "thread_id", 200],
    ["codex_steer", "expected_turn_id", 200],
    ["codex_respond", "thread_id", 200],
    ["codex_respond", "turn_id", 200],
    ["codex_respond", "method", 300],
    ["codex_interrupt", "thread_id", 200],
    ["codex_interrupt", "turn_id", 200],
  ];

  for (const [tool, property, maxLength] of expected) {
    assert.equal(
      propertySchema(tool, property).maxLength,
      maxLength,
      `${tool}.${property}`,
    );
  }
});
