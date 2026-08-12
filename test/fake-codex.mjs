#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import readline from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") {
  process.exit(64);
}

if (process.env.LOCAL_CODEX_BRIDGE_FAKE_PID_FILE) {
  writeFileSync(process.env.LOCAL_CODEX_BRIDGE_FAKE_PID_FILE, `${process.pid}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

if (process.env.LOCAL_CODEX_BRIDGE_FAKE_STUBBORN_SHUTDOWN === "1") {
  process.on("SIGTERM", () => {
    // Exercise Bridge escalation to SIGKILL without affecting normal fixtures.
  });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let threadCounter = 0;
let turnCounter = 0;
let currentThread = "thread-1";
let currentTurn = "turn-1";
let threadlessParentId;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    threadCounter += 1;
    currentThread = `thread-${threadCounter}`;
    const policyType = {
      "read-only": "readOnly",
      "workspace-write": "workspaceWrite",
      "danger-full-access": "dangerFullAccess",
    }[message.params.sandbox];
    send({
      id: message.id,
      result: {
        thread: { id: currentThread, cwd: message.params.cwd },
        ...(policyType ? { sandbox: { type: policyType } } : {}),
      },
    });
    return;
  }
  if (message.method === "thread/resume") {
    currentThread = message.params.threadId;
    send({ id: message.id, result: { thread: { id: currentThread } } });
    return;
  }
  if (message.method === "turn/start") {
    turnCounter += 1;
    currentThread = message.params.threadId;
    currentTurn = `turn-${turnCounter}`;
    send({ id: message.id, result: { turn: { id: currentTurn, status: "inProgress", items: [] } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: currentThread, turn: { id: currentTurn, status: "inProgress" } } });
      send({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: currentThread,
          turnId: currentTurn,
          itemId: "item-1",
          command: ["/bin/ls"],
          api_key: "must-redact",
        },
      });
    }, 10);
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    setTimeout(() => {
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted", items: [] } } });
    }, 5);
    return;
  }
  if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [{ id: "stored-thread", cwd: "/tmp/local-codex-bridge" }], nextCursor: null, backwardsCursor: null } });
    return;
  }
  if (message.method === "thread/read") {
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          status: { type: "notLoaded" },
          turns: message.params.includeTurns
            ? [{ id: "stored-turn", status: "completed", items: [{ type: "agentMessage", text: "STORED_OK" }] }]
            : [],
        },
      },
    });
    return;
  }
  if (message.method === "test/exit") {
    process.exit(23);
  }
  if (message.method === "test/environment") {
    send({
      id: message.id,
      result: {
        controlPlaneApiKeyPresent: Object.hasOwn(process.env, "CONTROL_PLANE_API_KEY"),
        preservedProbe: process.env.LOCAL_CODEX_BRIDGE_ENV_PROBE ?? null,
      },
    });
    return;
  }
  if (message.method === "test/threadless") {
    threadlessParentId = message.id;
    send({
      id: "threadless-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: null },
    });
    return;
  }
  if (message.id === "threadless-1" && message.error) {
    send({
      id: threadlessParentId,
      result: { clientErrorId: message.id, clientError: message.error },
    });
    threadlessParentId = undefined;
    return;
  }
  if (message.id === "approval-1" && message.result) {
    send({ method: "serverRequest/resolved", params: { threadId: currentThread, turnId: currentTurn, requestId: "approval-1" } });
    send({ method: "item/completed", params: { threadId: currentThread, turnId: currentTurn, item: { type: "agentMessage", text: "FAKE_FINAL" } } });
    send({ method: "turn/completed", params: { threadId: currentThread, turn: { id: currentTurn, status: "completed", items: [{ type: "agentMessage", text: "FAKE_FINAL" }] } } });
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});

lines.on("close", () => {
  if (process.env.LOCAL_CODEX_BRIDGE_FAKE_STUBBORN_SHUTDOWN === "1") {
    setInterval(() => undefined, 60_000);
    return;
  }
  process.exit(0);
});
