import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readRuntimeProof } from './runtime-load-proof.mjs';
import { ownedProofLifecycle } from './bootstrap-method.mjs';
import { fileURLToPath } from 'node:url';
const healthFile = process.env.LCB_HEALTH_URL_FILE;
const cli = process.env.CODEX_EXE;
const historyId = process.env.LCB_TEST_HISTORY_ID;
const rollout = process.env.LCB_TEST_HISTORY_FILE;
const streamHash = async (file, deadline) => { const hash = createHash('sha256'); for await (const b of createReadStream(file)) { remaining(deadline, 5000); hash.update(b); } return hash.digest('hex'); };
const remaining = (deadline, cap) => {
  const ms = Math.min(cap, (deadline ?? Infinity) - Date.now());
  if (ms <= 0) throw new Error('Verification deadline');
  return Math.max(1, Math.trunc(ms));
};
async function mcp(command, args, history, environment = {}, runtimeProof, deadline) {
  const childEnv = { ...process.env, ...environment, CODEX_EXE: cli };
  delete childEnv.LCB_VERIFY_OPENAI_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.LCB_RUNTIME_PROOF_CONFIG;
  delete childEnv.NODE_OPTIONS;
  const lifecycle = runtimeProof ? ownedProofLifecycle(runtimeProof.record, runtimeProof.scratch) : null;
  const proof = lifecycle ? lifecycle.create(runtimeProof.root, runtimeProof.hashes) : null;
  if (proof) {
    childEnv.LCB_RUNTIME_PROOF_CONFIG = proof.config;
    // Host bootstrap wrapper chooses its fixed explicit --import proof hook.
    if (command === process.execPath) args = ['--import', fileURLToPath(new URL('./runtime-load-proof.mjs', import.meta.url)), ...args];
  }
  let budget, child;
  try { budget = remaining(deadline, 45000); child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv }); }
  catch (error) { return { ok: false, error: 'MCP start/deadline failed', runtime_proof_cleanup: proof ? lifecycle.finish(proof, { code: null, signal: null, spawn_error: true }) : undefined }; }
  if (proof && child.pid) lifecycle.spawned(proof, child.pid);
  const lifetime = setTimeout(() => child.kill('SIGKILL'), budget);
  let buffer = Buffer.alloc(0), next = 0, stderrBytes = 0, protocolError = false;
  const pending = new Map();
  child.stderr.on('data', b => { stderrBytes += b.length; });
  const fail = () => { protocolError = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('MCP transport failure')); } pending.clear(); };
  child.on('error', fail);
  child.stdin.on('error', fail);
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response deadline')); }, remaining(deadline, 10000));
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
      if (!historyId || !rollout || process.env.LCB_ALLOW_HISTORY_VERIFICATION !== '1') throw new Error('Explicit isolated history fixture authorization required');
      const size = statSync(rollout).size, before = await streamHash(rollout, deadline);
      const rejected = await request('tools/call', { name: 'codex_threads', arguments: { thread_id: historyId, include_turns: true } });
      if (rejected.result?.isError !== true || !/latest_messages/.test(rejected.result.content?.[0]?.text ?? '')) throw new Error('Unbounded history was not rejected');
      const recent = await call('codex_threads', { thread_id: historyId, include_turns: true, latest_messages: 1 });
      if (recent.thread?.id !== historyId || recent.history_available !== false || recent.recent_messages?.available !== true || recent.recent_messages.messages.length > 1) throw new Error('Bounded native history regression failed');
      const observed = await call('codex_observe', { thread_id: historyId });
      if (observed.terminal !== null || observed.history_available !== false) throw new Error('Observe metadata degradation failed');
      const after = await streamHash(rollout, deadline);
      if (before !== after) throw new Error('History file changed during read-only regression');
      summary.history = { thread_id: historyId, bytes: size, sha256_before: before, sha256_after: after, unbounded_rejected: true, available: true, count: recent.recent_messages.messages.length, pages: recent.recent_messages.pages_read, observe_metadata_only: true };
    }
    summary.ok = true;
  } catch (error) { summary.error = error.message; }
  finally {
    child.stdin.end(); const cleanup = setTimeout(() => child.kill('SIGKILL'), Math.max(1, Math.min(5000, (deadline ?? Infinity) - Date.now())));
    summary.exit = await exit; clearTimeout(cleanup); clearTimeout(lifetime); summary.stderr_bytes = stderrBytes;
    if (summary.exit.code !== 0 || buffer.length) summary.ok = false;
    if (proof) {
      try { summary.probe_loaded_runtime = { ...readRuntimeProof(proof, child.pid), scope: 'short_lived_wrapper_probe', daemon_bound: false }; }
      catch (error) { summary.ok = false; summary.error ??= error.message; }
      summary.verification_ok = summary.ok;
      summary.runtime_proof_cleanup = lifecycle.finish(proof, { ...summary.exit, ...(!child.pid ? { spawn_error: true } : {}) });
      if (summary.runtime_proof_cleanup.receipt_state !== 'complete') { summary.verification_ok = false; summary.ok = false; }
      if (!summary.runtime_proof_cleanup.cleanup.ok) summary.ok = false;
    }
  }
  return summary;
}
export async function verifyLive(options = {}) {
  const result = { timestamp: new Date().toISOString(), production_modified: false };
  try {
    if (!healthFile || !cli || !process.env.LCB_TUNNEL_CLIENT || !process.env.LCB_PID_FILE || (options.wrapper && !process.env.LCB_STDIO_WRAPPER)) throw new Error('Explicit host verification paths required');
    const base = readFileSync(healthFile, 'utf8').trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(base)) throw new Error('Unexpected health URL');
    for (const name of ['healthz', 'readyz']) {
      try { const r = await fetch(base.replace(/\/$/, '') + '/' + name, { signal: AbortSignal.timeout(remaining(options.deadline, 5000)) }); result[name] = { ok: r.status === 200, status: r.status }; await r.body?.cancel(); }
      catch { result[name] = { ok: false, error: 'Health request deadline or transport failure' }; }
    }
    const poll = spawnSync(process.env.LCB_TUNNEL_CLIENT, ['health', '--url-file', healthFile, '--pid-file', process.env.LCB_PID_FILE, '--require-control-plane-poll', '--json'], { encoding: 'utf8', timeout: remaining(options.deadline, 10000), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    let health; try { health = JSON.parse(poll.stdout); } catch {}
    result.control_plane = { ok: poll.status === 0 && health?.control_plane_poll?.ok === true, pid: Number.isSafeInteger(health?.process?.pid) ? health.process.pid : undefined };
    if (!result.control_plane.ok) result.control_plane.error = poll.error?.code === 'ETIMEDOUT' ? 'Control plane deadline' : 'Control plane unready';
    // Do not repeatedly spawn expensive probes while the outer control plane is unready.
    if (result.healthz.ok && result.readyz.ok && result.control_plane.ok) {
      if (options.wrapper) result.wrapper = await mcp(process.env.LCB_STDIO_WRAPPER, [], false, options.environment, options.runtimeProof, options.deadline);
      if (options.history) result.candidate_history = await mcp(process.execPath, [join(options.candidate, 'dist/src/index.js')], true, options.environment, undefined, options.deadline);
    }
    result.ok = result.healthz.ok && result.readyz.ok && result.control_plane.ok && (!options.wrapper || result.wrapper?.ok === true) && (!options.history || result.candidate_history?.ok === true);
  } catch (error) { result.ok = false; result.error = error.message; }
  return result;
}
