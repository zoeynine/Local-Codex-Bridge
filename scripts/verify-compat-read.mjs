// Read-only RPC verification against an opaque snapshot, never a user JSONL parser.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppServerManager } from "../dist/src/app-server.js";
import { ControlSurface } from "../dist/src/tools.js";
import { sanitizeForTransport } from "../dist/src/runtime.js";

const [sourceHome, threadId, ...executables] = process.argv.slice(2);
if (!sourceHome || !threadId || !executables.length) throw new Error("Usage: verify-compat-read.mjs CODEX_HOME THREAD_ID CLI...");
const root = path.resolve(".compat-verification");
mkdirSync(root, { recursive: true, mode: 0o700 });
const originalDb = new DatabaseSync(path.join(sourceHome, "state_5.sqlite"), { readOnly: true });
const row = originalDb.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId);
originalDb.close();
if (!row?.rollout_path) throw new Error("Target missing in native metadata database");
const originalPath = row.rollout_path;
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const before = { sha256: digest(originalPath), size: statSync(originalPath).size };
const summary = { thread_id: threadId, isolation: "copied native metadata DB, target-only native history DB, and opaque rollout bytes; no credentials/config copied; RPC allowlist initialize, initialized, thread/read, thread/turns/list, thread/items/list", original_rollout_before: before, candidates: [] };
for (const [index, executable] of executables.entries()) {
  const home = mkdtempSync(path.join(root, `home-${index}-`));
  const databasePath = path.join(home, "state_5.sqlite");
  const backup = spawnSync("/usr/bin/sqlite3", ["-readonly", path.join(sourceHome, "state_5.sqlite"), `.backup '${databasePath.replaceAll("'", "''")}'`], { encoding: "utf8" });
  if (backup.status !== 0) throw new Error(`Metadata snapshot failed: ${backup.stderr}`);
  const relativeRollout = path.relative(sourceHome, originalPath);
  if (relativeRollout.startsWith("..") || path.isAbsolute(relativeRollout)) throw new Error("Rollout outside source home");
  const snapshotRollout = path.join(home, relativeRollout);
  mkdirSync(path.dirname(snapshotRollout), { recursive: true, mode: 0o700 });
  copyFileSync(originalPath, snapshotRollout);
  const db = new DatabaseSync(databasePath);
  db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(snapshotRollout, threadId);
  db.close();
  // Paginated history lives in a separate native DB, not the rollout JSONL.
  const historySource = new DatabaseSync(path.join(sourceHome, "thread_history_1.sqlite"), { readOnly: true });
  const historySnapshot = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  historySource.exec("BEGIN");
  const schema = historySource.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all();
  for (const entry of schema) {
    historySnapshot.exec(entry.sql);
    if (entry.type !== "table") continue;
    const columns = historySource.prepare(`PRAGMA table_info("${entry.name}")`).all().map(column => column.name);
    const rows = historySource.prepare(`SELECT * FROM "${entry.name}"${columns.includes("thread_id") ? " WHERE thread_id = ?" : ""}`).all(...(columns.includes("thread_id") ? [threadId] : []));
    const insert = historySnapshot.prepare(`INSERT INTO "${entry.name}" VALUES (${columns.map(() => "?").join(",")})`);
    for (const record of rows) insert.run(...columns.map(column => record[column]));
  }
  historySource.exec("COMMIT");
  historySource.close();
  historySnapshot.close();
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home }, timeout: 5000 }).stdout.trim();
  const manager = new AppServerManager(undefined, { executable, environment: { ...process.env, CODEX_HOME: home }, requestTimeoutMs: 20000 });
  const request = manager.request.bind(manager);
  manager.request = (method, params) => {
    if (!["thread/read", "thread/turns/list", "thread/items/list"].includes(method)) throw new Error(`Verification forbids ${method}`);
    return request(method, params);
  };
  const candidate = { executable, version, reads: [] };
  try {
    for (const includeTurns of [false, true]) {
      try {
        const result = await manager.request("thread/read", { threadId, includeTurns });
        candidate.reads.push({ includeTurns, success: true, returned_thread_id: result?.thread?.id, cliVersion: result?.thread?.cliVersion, historyMode: result?.thread?.historyMode, path_is_snapshot: result?.thread?.path === snapshotRollout, turns: result?.thread?.turns?.length ?? null, snapshot_sha256: digest(snapshotRollout) });
      } catch (error) {
        candidate.reads.push({ includeTurns, success: false, error: error.message });
      }
    }
    for (const method of ["thread/turns/list", "thread/items/list"]) {
      try {
        const result = await manager.request(method, { threadId, limit: 5, sortDirection: "desc", ...(method === "thread/turns/list" ? { itemsView: "full" } : {}) });
        candidate.reads.push({ method, success: true, count: result.data?.length, nextCursor: result.nextCursor, entries: result.data?.map(entry => ({ id: entry.id, turnId: entry.turnId, type: entry.item?.type, keys: Object.keys(entry) })) });
        if (method === "thread/items/list") {
          const messages = [];
          let page = result;
          const cursors = new Set();
          for (let pages = 0; pages < 20; pages++) {
            for (const entry of page.data ?? []) {
              if (["userMessage", "agentMessage"].includes(entry.item?.type) && messages.length < 5) messages.push(entry);
            }
            if (messages.length === 5 || !page.nextCursor) break;
            if (cursors.has(page.nextCursor)) throw new Error("Native history cursor cycle");
            cursors.add(page.nextCursor);
            page = await manager.request(method, { threadId, limit: 100, sortDirection: "desc", cursor: page.nextCursor });
          }
          if (messages.length !== 5) throw new Error("Latest five messages not available within bounded native paging");
          const sourceHistory = new DatabaseSync(path.join(sourceHome, "thread_history_1.sqlite"), { readOnly: true });
          const expected = sourceHistory.prepare("SELECT item_id, turn_id FROM thread_items WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT 5").all(threadId);
          sourceHistory.close();
          const identitiesMatch = JSON.stringify(messages.map(entry => [entry.item.id, entry.turnId])) === JSON.stringify(expected.map(entry => [entry.item_id, entry.turn_id]));
          if (!identitiesMatch) throw new Error("Native latest messages differ from read-only native history index");
          const artifact = path.join(root, `latest-five-${index}.json`);
          writeFileSync(artifact, `${JSON.stringify(sanitizeForTransport({ thread_id: threadId, source: "codex_app_server_thread_items_list", order: "newest_first", messages }), null, 2)}\n`, { mode: 0o600 });
          candidate.latest_five = { count: messages.length, identities_match_native_index: identitiesMatch, artifact, sha256: digest(artifact), item_ids: messages.map(entry => entry.item.id), turn_ids: messages.map(entry => entry.turnId) };
        }
      } catch (error) {
        candidate.reads.push({ method, success: false, error: error.message });
      }
    }
    // Exercise the patched public surface, without printing transcript contents.
    const surface = new ControlSurface(manager);
    for (const name of ["codex_threads", "codex_observe"]) {
      try {
        const result = await surface.call(name, { thread_id: threadId, ...(name === "codex_threads" ? { include_turns: true } : {}) });
        candidate.reads.push({ tool: name, success: true, history_available: result.history_available ?? null, diagnostic: result.compatibility ?? null, terminal_present: !!result.terminal });
      } catch (error) {
        candidate.reads.push({ tool: name, success: false, error: error.message });
      }
    }
  } finally {
    await manager.close();
  }
  summary.candidates.push(candidate);
}
summary.original_rollout_after = { sha256: digest(originalPath), size: statSync(originalPath).size };
summary.original_rollout_unchanged = JSON.stringify(before) === JSON.stringify(summary.original_rollout_after);
writeFileSync(path.join(root, "read-evidence.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
if (!summary.original_rollout_unchanged) process.exitCode = 1;
