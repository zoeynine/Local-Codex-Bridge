// Read-only public MCP verification against an existing isolated target snapshot.
// Persist identities and hashes only; never print or save message bodies.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [snapshotArgument, threadId, executable] = process.argv.slice(2);
if (!snapshotArgument || !threadId || !executable) throw new Error("Usage: verify-latest-mcp.mjs SNAPSHOT_HOME THREAD_ID CLI");
const root = path.resolve(".compat-verification");
const snapshot = path.resolve(snapshotArgument);
assert.ok(snapshot.startsWith(`${root}${path.sep}home-`), "Only existing isolated verification snapshots are allowed");
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const metadata = new DatabaseSync(path.join(snapshot, "state_5.sqlite"), { readOnly: true });
const row = metadata.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId);
metadata.close();
assert.ok(row?.rollout_path?.startsWith(`${snapshot}${path.sep}`), "Target rollout must be inside snapshot");
const snapshotBefore = hash(row.rollout_path);
const source = new DatabaseSync(path.join(snapshot, "thread_history_1.sqlite"), { readOnly: true });
const expected = source.prepare("SELECT item_id, turn_id, item_type FROM thread_items WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT 5").all(threadId);
source.close();
assert.equal(expected.length, 5, "Snapshot must contain five native messages");

const child = spawn(process.execPath, [path.resolve("dist/src/index.js")], {
  env: { ...process.env, CODEX_HOME: snapshot, CODEX_EXE: executable },
  stdio: ["pipe", "pipe", "pipe"],
});
// Drain diagnostics without printing them or transcript-bearing RPC errors.
child.stderr.resume();
let buffer = "";
let protocolError;
let nextId = 0;
const pending = new Map();
const fail = error => {
  protocolError = error;
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
  pending.clear();
};
child.on("error", () => fail(new Error("MCP child failed to spawn")));
const exited = new Promise(resolve => child.once("exit", (code, signal) => {
  fail(new Error("MCP child exited before pending response"));
  resolve({ code, signal });
}));
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const response = JSON.parse(line);
      assert.equal(response.jsonrpc, "2.0");
      const waiter = pending.get(response.id);
      assert.ok(waiter, "Unexpected MCP response");
      pending.delete(response.id);
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    } catch { fail(new Error("Invalid MCP stdout protocol")); }
  }
});
const request = (method, params) => {
  assert.ok(["initialize", "tools/list", "tools/call"].includes(method));
  if (protocolError) return Promise.reject(protocolError);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 25000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
};
let evidence;
try {
  const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "latest-messages-verification", version: "1" } });
  assert.ok(!initialized.error, "MCP initialize failed");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request("tools/list", {});
  assert.ok(!listed.error, "MCP tools/list failed");
  assert.equal(listed.result.tools.length, 8);
  const tool = listed.result.tools.find(entry => entry.name === "codex_threads");
  assert.equal(tool?.inputSchema.properties.latest_messages.maximum, 100);
  const args = { thread_id: threadId, latest_messages: 5 };
  const response = await request("tools/call", { name: "codex_threads", arguments: args });
  assert.ok(!response.error && response.result?.isError !== true, "MCP latest_messages tools/call failed");
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.thread.id, threadId);
  const recent = result.recent_messages;
  assert.equal(recent.thread_id, threadId);
  assert.equal(recent.available, true);
  assert.equal(recent.complete, true);
  assert.equal(recent.order, "newest_first");
  assert.equal(recent.messages.length, 5);
  const identities = recent.messages.map(entry => ({ item_id: entry.item.id, turn_id: entry.turnId, item_type: entry.item.type }));
  // Use boolean assertion so failure diagnostics cannot include message bodies.
  assert.ok(JSON.stringify(identities) === JSON.stringify(expected), "Latest-five identity/order differs from snapshot native index");
  assert.equal(new Set(identities.map(entry => entry.item_id)).size, 5);
  evidence = {
    generated_at: new Date().toISOString(), method: "tools/call", tool: "codex_threads", arguments: args,
    transport: "JSON-RPC stdio through built dist/src/index.js and official app-server",
    executable, node_version: process.version, snapshot_home: snapshot,
    source: recent.source, order: recent.order, count: identities.length,
    available: recent.available, complete: recent.complete, pages_read: recent.pages_read,
    identities_match_native_snapshot_index: true, identities,
    snapshot_rollout_sha256_before: snapshotBefore,
    snapshot_rollout_sha256_after: hash(row.rollout_path),
    deployed: false, message_bodies_recorded: false,
  };
  assert.equal(evidence.snapshot_rollout_sha256_after, snapshotBefore);
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const exit = await exited;
  clearTimeout(timer);
  assert.equal(exit.code, 0, "MCP child failed clean EOF shutdown");
}
assert.equal(buffer, "", "MCP stdout must end at a JSONL boundary");
const artifact = path.join(root, "latest-mcp-evidence.json");
writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ artifact, sha256: hash(artifact), ...evidence }));
