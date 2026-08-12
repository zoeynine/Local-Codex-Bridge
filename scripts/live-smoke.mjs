import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const configuredSmokeCwd = process.env.SMOKE_CWD || projectRoot;
const execFileAsync = promisify(execFile);

if (process.platform !== "darwin") {
  throw new Error(`The macOS live smoke requires Darwin, not ${process.platform}.`);
}

if (!process.env.CODEX_EXE) {
  throw new Error("Set CODEX_EXE to a Codex executable before running the live smoke test.");
}
if (!isAbsolute(configuredSmokeCwd)) {
  throw new Error("SMOKE_CWD must be an absolute POSIX path on macOS.");
}
const smokeCwd = resolve(configuredSmokeCwd);

const smokeInstructions = {
  first:
    "Read-only smoke: run /bin/sleep 6, then read package.json without modifying anything, and finish with exactly V2_SMOKE_OK.",
  staged:
    "Read-only staged smoke: use the command tool to run exactly /bin/sh -c '/bin/sleep 15; /usr/bin/head -n 1 package.json'. Do not modify anything. Only after the command finishes, answer V2_UNSTEERED.",
  interrupted:
    "Read-only interruption smoke: use the command tool to run exactly /bin/sleep 30. Do not modify anything. Only after the command finishes, answer V2_INTERRUPT_MISSED.",
};
const expectedApprovalCommands = new Set([
  "/bin/sh -c '/bin/sleep 15; /usr/bin/head -n 1 package.json'",
  "/bin/zsh -lc \"/bin/sh -c '/bin/sleep 15; /usr/bin/head -n 1 package.json'\"",
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const checkpointDirectory = mkdtempSync(join(tmpdir(), "local-codex-bridge-live-checkpoint-"));
const smokeEnvironment = {
  ...process.env,
  LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR: checkpointDirectory,
};

async function descendantProcessIds(rootPid) {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="]);
  const byParent = new Map();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = byParent.get(parentPid) ?? [];
    children.push(pid);
    byParent.set(parentPid, children);
  }
  const descendants = [];
  const pending = [...(byParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    descendants.push(pid);
    pending.push(...(byParent.get(pid) ?? []));
  }
  return descendants;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function approvalSafetyError(request) {
  if (request.method !== "item/commandExecution/requestApproval") {
    return `unexpected approval method ${String(request.method)}`;
  }
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return "approval params are not an object";
  }
  if (!expectedApprovalCommands.has(params.command)) {
    return "approval command did not exactly match an expected read-only smoke command";
  }
  if (
    params.cwd != null &&
    (
      typeof params.cwd !== "string" ||
      !isAbsolute(params.cwd) ||
      resolve(params.cwd) !== smokeCwd
    )
  ) {
    return "approval cwd did not exactly match the smoke workspace";
  }
  if (params.additionalPermissions != null) {
    return "approval requested additional permissions";
  }
  if (params.networkApprovalContext != null) {
    return "approval requested network access";
  }
  if (
    params.proposedNetworkPolicyAmendments != null &&
    (
      !Array.isArray(params.proposedNetworkPolicyAmendments) ||
      params.proposedNetworkPolicyAmendments.length > 0
    )
  ) {
    return "approval proposed network policy amendments";
  }
  return null;
}

async function assertProcessesExited(pids, label) {
  const deadline = Date.now() + 5_000;
  let live = pids.filter(processExists);
  while (live.length > 0 && Date.now() < deadline) {
    await delay(100);
    live = pids.filter(processExists);
  }
  if (live.length > 0) {
    throw new Error(`${label} left descendant processes running: ${live.join(", ")}`);
  }
}

class Session {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.child = spawn(process.execPath, [entry], {
      cwd: projectRoot,
      env: smokeEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8_000);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const key = `${typeof message.id}:${String(message.id)}`;
      const waiter = this.pending.get(key);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pending.delete(key);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = 180_000) {
    const id = this.nextId++;
    const key = `number:${id}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for MCP ${method}`)),
        timeoutMs,
      );
      this.pending.set(key, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "v2-live-smoke", version: "1.0.0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async call(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error(`${name} returned no text content`);
    const parsed = JSON.parse(text);
    if (result.isError) throw new Error(`${name}: ${parsed.error || text}`);
    return parsed;
  }

  async close(signal = null) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return { code: this.child.exitCode, signal: this.child.signalCode };
    }
    if (signal) this.child.kill(signal);
    else this.child.stdin.end();
    return await new Promise((resolve, reject) => {
      let forced = false;
      const forceTimer = setTimeout(() => {
        forced = true;
        this.child.kill("SIGKILL");
      }, 10_000);
      const hardTimer = setTimeout(() => {
        this.child.off("exit", onExit);
        reject(new Error(
          `V2 did not exit after SIGKILL following ${signal ?? "stdin EOF"}. ` +
          `stderr: ${this.stderr}`,
        ));
      }, 12_000);
      const onExit = (code, exitSignal) => {
        clearTimeout(forceTimer);
        clearTimeout(hardTimer);
        if (forced) {
          reject(new Error(
            `V2 required SIGKILL after ${signal ?? "stdin EOF"} ` +
            `(code=${String(code)}, signal=${String(exitSignal)}). stderr: ${this.stderr}`,
          ));
          return;
        }
        resolve({ code, signal: exitSignal });
      };
      this.child.once("exit", onExit);
    });
  }
}

function assertCleanBridgeExit(exit, label) {
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(
      `${label} exited unexpectedly (code=${String(exit.code)}, signal=${String(exit.signal)})`,
    );
  }
}

async function closeSession(session, label, signal = null) {
  const descendants =
    session.child.exitCode === null && session.child.signalCode === null
      ? await descendantProcessIds(session.child.pid)
      : [];
  assertCleanBridgeExit(await session.close(signal), label);
  await assertProcessesExited(descendants, `${label} shutdown`);
}

async function observeToTerminal(session, threadId, initialCursor = 0, onObserved = null) {
  let cursor = initialCursor;
  let eventCount = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const observed = await session.call("codex_observe", {
      thread_id: threadId,
      cursor,
      limit: 100,
    });
    eventCount += observed.events.length;
    cursor = observed.next_cursor;
    if (onObserved) await onObserved(observed);
    if (observed.terminal) return { observed, eventCount };
    await delay(400);
  }
  throw new Error(`Timed out observing ${threadId}`);
}

function lastPersistedAgentMessage(readResult) {
  const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
  const items = Array.isArray(turns.at(-1)?.items) ? turns.at(-1).items : [];
  return items
    .filter((item) => item?.type === "agentMessage" && typeof item.text === "string")
    .at(-1)?.text ?? null;
}

const summary = {};
let first;
try {
  first = new Session();
  await first.initialize();
  const startedAt = Date.now();
  const started = await first.call("codex_turn", {
    cwd: smokeCwd,
    sandbox: "read-only",
    approval_policy: "never",
    text: smokeInstructions.first,
  });
  const acceptedMs = Date.now() - startedAt;
  const immediate = await first.call("codex_observe", {
    thread_id: started.thread_id,
    cursor: 0,
    limit: 100,
  });
  if (immediate.terminal) {
    throw new Error("codex_turn did not demonstrably return before terminal completion");
  }
  const finished = await observeToTerminal(first, started.thread_id, 0);
  if (!String(finished.observed.terminal.final_result).includes("V2_SMOKE_OK")) {
    throw new Error("First live turn did not produce V2_SMOKE_OK");
  }
  summary.first_turn = {
    thread_id: started.thread_id,
    turn_id: started.turn_id,
    accepted_ms: acceptedMs,
    returned_before_completion: true,
    observed_events: finished.eventCount,
    terminal_status: finished.observed.terminal.status,
  };
  const checkpoint = await first.call("codex_checkpoint", {
    action: "update",
    thread_id: started.thread_id,
    original_goal: "Verify the macOS V2.1.2 Bridge lifecycle.",
    original_constraints: "Read-only real Codex work; no production Tunnel changes.",
    original_acceptance: "Checkpoint persists across a Bridge restart and remains bounded.",
    current_understanding: "The first native turn completed through the macOS Bridge.",
    current_decision: "Restart the Bridge and re-read both native history and checkpoint state.",
    acceptance_status: "First live turn accepted; restart recovery remains.",
    next_step: "Close through EOF and start a fresh Bridge process.",
  });
  if (checkpoint.operation !== "initialized") {
    throw new Error("Live checkpoint did not initialize");
  }
  await closeSession(first, "EOF V2 process");
  first = null;

  const second = new Session();
  try {
    await second.initialize();
    const listed = await second.call("codex_threads", {
      cwd: smokeCwd,
      limit: 100,
    });
    if (!listed.data.some((thread) => thread.id === started.thread_id)) {
      throw new Error("Restarted app-server thread/list did not find the smoke thread");
    }
    const read = await second.call("codex_threads", {
      thread_id: started.thread_id,
      include_turns: true,
    });
    if (!String(lastPersistedAgentMessage(read)).includes("V2_SMOKE_OK")) {
      throw new Error("Restarted app-server thread/read did not recover the stored final answer");
    }
    const recovered = await second.call("codex_observe", {
      thread_id: started.thread_id,
      limit: 20,
    });
    if (recovered.runtime_available !== false || recovered.live_state_reconstructable !== false) {
      throw new Error("Restart recovery did not use the thread/read fallback");
    }
    if (!String(recovered.terminal?.final_result).includes("V2_SMOKE_OK")) {
      throw new Error("Restart recovery did not recover the stored final answer");
    }
    summary.restart_recovery = {
      runtime_available: recovered.runtime_available,
      live_state_reconstructable: recovered.live_state_reconstructable,
      source: recovered.source,
      terminal_status: recovered.terminal.status,
      listed_after_restart: true,
      read_after_restart: true,
    };
    const recoveredCheckpoint = await second.call("codex_checkpoint", {
      action: "read",
      thread_id: started.thread_id,
    });
    if (
      recoveredCheckpoint.found !== true ||
      recoveredCheckpoint.checkpoint?.original?.original_goal !==
        "Verify the macOS V2.1.2 Bridge lifecycle."
    ) {
      throw new Error("Restarted Bridge did not recover the checkpoint");
    }
    summary.checkpoint = {
      initialized: true,
      recovered_after_restart: true,
      source: recoveredCheckpoint.source,
    };

    const staged = await second.call("codex_turn", {
      cwd: smokeCwd,
      sandbox: "read-only",
      approval_policy: "untrusted",
      text: smokeInstructions.staged,
    });
    let stagedState = null;
    let pendingApproval = null;
    let commandObserved = false;
    let stagedCursor = 0;
    const commandDeadline = Date.now() + 8_000;
    while (Date.now() < commandDeadline && !commandObserved) {
      stagedState = await second.call("codex_observe", {
        thread_id: staged.thread_id,
        cursor: stagedCursor,
        limit: 100,
      });
      if (stagedState.terminal) {
        throw new Error("Staged turn completed before a command was observable");
      }
      stagedCursor = stagedState.next_cursor;
      pendingApproval = stagedState.pending_requests.find(
        (request) => request.method === "item/commandExecution/requestApproval",
      );
      commandObserved = Boolean(pendingApproval) || stagedState.events.some(
        (event) => event.method.includes("commandExecution") ||
          (event.method === "item/started" && event.data?.item?.type === "commandExecution"),
      );
      if (!commandObserved) await delay(150);
    }
    const steered = await second.call("codex_steer", {
      thread_id: staged.thread_id,
      expected_turn_id: staged.turn_id,
      text: "For this same active turn, keep the current read-only command unchanged, but finish with exactly V2_STEERED_OK instead of V2_UNSTEERED. Do not run another command or modify files.",
    });
    if (steered.turn_id !== staged.turn_id) {
      throw new Error("turn/steer changed the turn id");
    }
    if (!pendingApproval) {
      const approvalDeadline = Date.now() + 2_000;
      while (Date.now() < approvalDeadline && !pendingApproval) {
        const afterSteer = await second.call("codex_observe", {
          thread_id: staged.thread_id,
          cursor: stagedCursor,
          limit: 100,
        });
        stagedCursor = afterSteer.next_cursor;
        pendingApproval = afterSteer.pending_requests.find(
          (request) => request.method === "item/commandExecution/requestApproval",
        );
        if (!pendingApproval) await delay(100);
      }
    }
    let approvalResponded = false;
    let respondedApprovalKey = null;
    const respondToExpectedApproval = async (request) => {
      const key = `${typeof request.request_id}:${String(request.request_id)}`;
      if (key === respondedApprovalKey) return;
      const safetyError = approvalSafetyError(request);
      if (safetyError || respondedApprovalKey !== null) {
        await second.call("codex_respond", {
          request_id: request.request_id,
          thread_id: request.thread_id,
          turn_id: request.turn_id,
          method: request.method,
          decision: "decline",
        });
        throw new Error(
          safetyError ?? "Staged turn requested more than one command approval",
        );
      }
      await second.call("codex_respond", {
        request_id: request.request_id,
        thread_id: request.thread_id,
        turn_id: request.turn_id,
        method: request.method,
        decision: "accept",
      });
      approvalResponded = true;
      respondedApprovalKey = key;
    };
    if (pendingApproval) await respondToExpectedApproval(pendingApproval);
    const steerFinished = await observeToTerminal(
      second,
      staged.thread_id,
      0,
      async (observed) => {
        for (const request of observed.pending_requests) {
          if (!String(request.method).toLowerCase().includes("approval")) continue;
          await respondToExpectedApproval(request);
        }
      },
    );
    if (!String(steerFinished.observed.terminal.final_result).includes("V2_STEERED_OK")) {
      throw new Error("Steered turn did not produce V2_STEERED_OK");
    }
    if (!approvalResponded) {
      throw new Error("Staged turn did not exercise codex_respond against a real approval");
    }
    summary.steer = {
      thread_id: staged.thread_id,
      start_turn_id: staged.turn_id,
      steer_turn_id: steered.turn_id,
      same_turn: true,
      observed_events: steerFinished.eventCount,
      terminal_status: steerFinished.observed.terminal.status,
      staged_command_observed: commandObserved,
      approval_responded: approvalResponded,
    };

    const interrupted = await second.call("codex_turn", {
      cwd: smokeCwd,
      sandbox: "read-only",
      approval_policy: "never",
      text: smokeInstructions.interrupted,
    });
    let interruptCursor = 0;
    let commandStarted = false;
    const interruptDeadline = Date.now() + 30_000;
    while (Date.now() < interruptDeadline && !commandStarted) {
      const observed = await second.call("codex_observe", {
        thread_id: interrupted.thread_id,
        cursor: interruptCursor,
        limit: 100,
        wait_ms: 1_000,
      });
      interruptCursor = observed.next_cursor;
      commandStarted = observed.events.some(
        (event) => event.method === "item/started" &&
          event.data?.item?.type === "commandExecution",
      );
      if (observed.terminal) {
        throw new Error("Interruption smoke completed before codex_interrupt");
      }
    }
    if (!commandStarted) {
      throw new Error("Interruption smoke did not expose a running command");
    }
    await second.call("codex_interrupt", {
      thread_id: interrupted.thread_id,
      turn_id: interrupted.turn_id,
    });
    const interruptedFinished = await observeToTerminal(second, interrupted.thread_id, 0);
    const interruptedStatus = String(interruptedFinished.observed.terminal.status).toLowerCase();
    if (!interruptedStatus.includes("interrupt") && !interruptedStatus.includes("cancel")) {
      throw new Error(`Interrupted turn ended with unexpected status ${interruptedStatus}`);
    }
    summary.interrupt = {
      thread_id: interrupted.thread_id,
      turn_id: interrupted.turn_id,
      command_started: true,
      terminal_status: interruptedFinished.observed.terminal.status,
    };

    await closeSession(second, "SIGINT V2 process", "SIGINT");
    summary.shutdown = {
      eof: { bridge_exited: true, descendants_exited: true },
      sigint: { bridge_exited: true, descendants_exited: true },
    };
  } finally {
    if (second.child.exitCode === null && second.child.signalCode === null) {
      await closeSession(second, "Second V2 process");
    }
  }
} finally {
  if (first) await closeSession(first, "First V2 process cleanup");
  rmSync(checkpointDirectory, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
