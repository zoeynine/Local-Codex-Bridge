import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRuntimeProof, readRuntimeProof } from './runtime-load-proof.mjs';
import { fileURLToPath } from 'node:url';
const healthFile = '/Users/ZGH/Library/Application Support/lcb-remote-tunnel/health.url';
const cli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const historyId = '01a0aea5-ab02-78a3-ab96-d7859c1ecd24';
const rollout = '/Users/ZGH/.codex/sessions/2026/09/17/rollout-2026-09-17T17-14-47-01a0aea5-ab02-78a3-ab96-d7859c1ecd24.jsonl';
const streamHash = async file => { const hash = createHash('sha256'); for await (const b of createReadStream(file)) hash.update(b); return hash.digest('hex'); };
async function mcp(command, args, history, environment = {}, runtimeProof) {
  const childEnv = { ...process.env, ...environment, CODEX_EXE: cli };
  delete childEnv.LCB_VERIFY_OPENAI_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.LCB_RUNTIME_PROOF_CONFIG;
  delete childEnv.NODE_OPTIONS;
  const proof = runtimeProof ? createRuntimeProof(runtimeProof.root, runtimeProof.hashes) : null;
  if (proof) { childEnv.LCB_RUNTIME_PROOF_CONFIG = proof.config; childEnv.NODE_OPTIONS = '--import=' + fileURLToPath(new URL('./runtime-load-proof.mjs', import.meta.url)); }
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
  let buffer = Buffer.alloc(0), next = 0, stderrBytes = 0, protocolError = false;
  const pending = new Map();
  child.stderr.on('data', b => { stderrBytes += b.length; });
  const fail = () => { protocolError = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('MCP transport failure')); } pending.clear(); };
  child.on('error', fail);
  const exit = new Promise(resolve => child.once('close', (code, signal) => { fail(); resolve({ code, signal }); }));
  child.stdout.on('data', b => {
    buffer = Buffer.concat([buffer, b]);
    if (buffer.length > 10 * 1024 * 1024) { buffer = Buffer.alloc(0); fail(); return; }
    while (buffer.includes(10)) {
      const end = buffer.indexOf(10), line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      try { const message = JSON.parse(line.toString('utf8')); const p = pending.get(message.id); if (p) { clearTimeout(p.timer); pending.delete(message.id); p.resolve(message); } else if (message.id !== undefined) fail(); } catch { fail(); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response deadline')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, arguments_) => {
    const response = await request('tools/call', { name, arguments: arguments_ });
    if (response.error || response.result?.isError) {
      const text = response.result?.content?.[0]?.text ?? '';
      const classification = /exited unexpectedly.*code=1/.test(text) ? 'app_server_initialization_exit_1' : /JSONL line exceeded/.test(text) ? 'jsonl_overflow' : 'tool_failure';
      throw new Error('MCP ' + name + ' failed; classification=' + classification + '; body omitted');
    }
    return JSON.parse(response.result.content[0].text);
  };
  const summary = { ok: false, body_recorded: false, mutation_sent: false };
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lcb-minimal-fix-readonly', version: '1' } });
    if (!initialized.result || initialized.error) throw new Error('initialize failed');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalog = await request('tools/list', {});
    if (catalog.result?.tools?.length !== 8) throw new Error('tool catalog mismatch');
    const models = await call('codex_models', { limit: 1 });
    if (!Array.isArray(models.data) || models.data.length !== 1) throw new Error('model read failed');
    summary.initialize = true; summary.tools = 8; summary.models = 1;
    if (history) {
      const size = statSync(rollout).size, before = await streamHash(rollout);
      const rejected = await request('tools/call', { name: 'codex_threads', arguments: { thread_id: historyId, include_turns: true } });
      if (rejected.result?.isError !== true || !/latest_messages/.test(rejected.result.content?.[0]?.text ?? '')) throw new Error('Unbounded history was not rejected');
      const recent = await call('codex_threads', { thread_id: historyId, include_turns: true, latest_messages: 1 });
      if (recent.thread?.id !== historyId || recent.history_available !== false || recent.recent_messages?.available !== true || recent.recent_messages.messages.length > 1) throw new Error('Bounded native history regression failed');
      const observed = await call('codex_observe', { thread_id: historyId });
      if (observed.terminal !== null || observed.history_available !== false) throw new Error('Observe metadata degradation failed');
      const after = await streamHash(rollout);
      if (before !== after) throw new Error('History file changed during read-only regression');
      summary.history = { thread_id: historyId, bytes: size, sha256_before: before, sha256_after: after, unbounded_rejected: true, available: true, count: recent.recent_messages.messages.length, pages: recent.recent_messages.pages_read, observe_metadata_only: true };
    }
    if (proof) summary.runtime_proof = readRuntimeProof(proof, child.pid);
    summary.ok = true;
  } catch (error) { summary.error = error.message; }
  finally { child.stdin.end(); const deadline = setTimeout(() => child.kill('SIGTERM'), 5000); summary.exit = await exit; clearTimeout(deadline); summary.stderr_bytes = stderrBytes; if (summary.exit.code !== 0 || buffer.length) summary.ok = false; }
  return summary;
}
export async function verifyLive(options = {}) {
  const result = { timestamp: new Date().toISOString(), production_modified: false };
  try {
    const base = readFileSync(healthFile, 'utf8').trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(base)) throw new Error('Unexpected health URL');
    for (const name of ['healthz', 'readyz']) { const r = await fetch(base.replace(/\/$/, '') + '/' + name, { signal: AbortSignal.timeout(5000) }); result[name] = { ok: r.status === 200, status: r.status }; await r.body?.cancel(); }
    const poll = spawnSync('/Users/ZGH/.local/bin/tunnel-client', ['health', '--url-file', healthFile, '--pid-file', '/Users/ZGH/Library/Application Support/lcb-remote-tunnel/daemon.pid', '--require-control-plane-poll', '--json'], { encoding: 'utf8', timeout: 10000 });
    let health; try { health = JSON.parse(poll.stdout); } catch {}
    result.control_plane = { ok: poll.status === 0 && health?.control_plane_poll?.ok === true, pid: health?.process?.pid, last_poll: health?.control_plane_poll?.value };
    if (options.wrapper) result.wrapper = await mcp('/Users/ZGH/.local/bin/lcb-remote-stdio', [], false, options.environment, options.runtimeProof);
    if (options.history) result.candidate_history = await mcp(process.execPath, [join(options.candidate, 'dist/src/index.js')], true, options.environment);
    result.ok = result.healthz.ok && result.readyz.ok && result.control_plane.ok && (!options.wrapper || result.wrapper.ok) && (!options.history || result.candidate_history.ok);
  } catch (error) { result.ok = false; result.error = error.message; }
  return result;
}
