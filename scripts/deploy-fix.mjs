// Manifest-scoped deployment. No git mutations, history writes, or broad process control.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, cpSync, renameSync, unlinkSync, readlinkSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyLive } from './verify-fix-live.mjs';
import { remoteModels } from './remote-model-probe.mjs';
import { safePackagePath } from './verify-package.mjs';
import { verifyDaemon, daemonConfig } from './daemon-attestation.mjs';
const production = process.env.LCB_PRODUCTION_ROOT;
const agent = process.env.LCB_LAUNCH_AGENT;
const candidate = fileURLToPath(new URL('../', import.meta.url));
const trustVerifier = process.env.LCB_TRUST_VERIFIER;
const allowedChanged = new Set(['package.json', 'src/app-server.ts', 'src/tools.ts', 'test/runtime.test.ts', 'test/tools.test.ts', 'test/compatibility.test.ts', 'test/overflow.test.ts', 'test/overflow-codex.mjs', 'test/deploy-fix.test.ts', 'test/remote-probe.test.ts', 'scripts/deploy-fix.mjs', 'scripts/remote-model-probe.mjs', 'scripts/verify-fix-live.mjs', 'scripts/validate-fix.mjs', 'scripts/verify-package.mjs', 'scripts/runtime-load-proof.mjs']);
allowedChanged.add('package-lock.json');
allowedChanged.add('src/version.ts');
for (const name of ['scripts/rollback.mjs', 'scripts/daemon-attestation.mjs', 'scripts/daemon-attestation-hook.mjs', 'scripts/daemon-bootstrap-plan.mjs', 'test/daemon-attestation.test.ts', 'test/daemon-tunnel-fixture.mjs', 'test/daemon-app-server-fixture.mjs']) allowedChanged.add(name);
export function targetedRestart(agent, run) {
  if (!/^gui\/\d+\/com\.openai\.tunnel-client\.lcb-remote$/.test(agent ?? '')) throw new Error('Unexpected LaunchAgent target');
  return run('/bin/launchctl', ['kickstart', '-k', agent]);
}
export function externalTrustPath(candidate, verifier) {
  const pkg = realpathSync(candidate), trusted = realpathSync(verifier);
  if (trusted === pkg || trusted.startsWith(pkg + '/')) throw new Error('Trust verifier must be physically outside release package');
  return trusted;
}
export const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
// Receipts contain only fixed classifications and explicitly projected scalars.
export function errorClassification(error) {
  const message = String(error?.message ?? error ?? '');
  if (['deadline', 'daemon_runtime_unverified', 'control_plane_unready', 'app_server_initialization_exit_1', 'jsonl_overflow', 'transport_failure', 'history_verification_failed', 'remote_route_failed', 'verification_failed'].includes(message)) return message;
  if (/deadline|timeout|timed out|ETIMEDOUT/i.test(message)) return 'deadline';
  if (/daemon|loaded.*instance|loaded.*runtime|runtime.*proof/i.test(message)) return 'daemon_runtime_unverified';
  if (/control.plane/i.test(message)) return 'control_plane_unready';
  if (/app_server_initialization_exit_1/.test(message)) return 'app_server_initialization_exit_1';
  if (/JSONL|jsonl_overflow/.test(message)) return 'jsonl_overflow';
  if (/transport/i.test(message)) return 'transport_failure';
  if (/history/i.test(message)) return 'history_verification_failed';
  if (/remote/i.test(message)) return 'remote_route_failed';
  return 'verification_failed';
}
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const gate = value => ({ state: value == null ? 'not_run' : value.ok === true ? 'passed' : 'failed', ...(value?.error ? { error_classification: errorClassification(value.error) } : {}) });
export function verificationSummary(result = {}) {
  const summary = { ok: result.ok === true, body_recorded: false, healthz: { ...gate(result.healthz), status: number(result.healthz?.status) }, readyz: { ...gate(result.readyz), status: number(result.readyz?.status) }, control_plane: { ...gate(result.control_plane), pid: number(result.control_plane?.pid) }, wrapper: gate(result.wrapper), history: gate(result.candidate_history), probe_loaded_runtime: gate(result.wrapper?.probe_loaded_runtime), daemon_loaded_runtime: gate(result.daemon_loaded_runtime), remote_codex_models: gate(result.remote_codex_models) };
  if (result.error) summary.error_classification = errorClassification(result.error);
  return summary;
}
export const verificationPolicy = Object.freeze({ window_ms: 90000, max_attempts: 18, retry_interval_ms: 5000 });
export async function verifyWithRetries(phase, ops, policy = verificationPolicy) {
  const now = ops.now ?? Date.now, sleep = ops.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now(), deadline = started + policy.window_ms;
  for (let attempt = 1; attempt <= policy.max_attempts && now() < deadline; attempt++) {
    let result;
    try { result = await ops.verify({ deadline }); } catch (error) { result = { ok: false, error: errorClassification(error) }; }
    const elapsed = now() - started;
    const accepted = result.ok === true && elapsed < policy.window_ms;
    ops.onAttempt?.({ phase: phase === 'rollback' ? 'rollback' : 'deployed', attempt, elapsed_ms: Math.max(0, Math.trunc(elapsed)), ...verificationSummary({ ...result, ok: accepted }) });
    if (accepted) return result;
    if (attempt < policy.max_attempts && now() < deadline) await sleep(Math.min(policy.retry_interval_ms, deadline - now()));
  }
  throw new Error('Deployment verification deadline');
}
export function requireDaemonRuntime(result) {
  // Probe module bytes are not evidence for the long-lived Tunnel Bridge child.
  if (result?.ok !== true) throw new Error('Deployment health verification failed');
  if (result?.daemon_loaded_runtime?.ok !== true) throw new Error('Daemon loaded runtime proof missing');
}
export function deploymentRuntimeReadiness(proof) {
  return proof?.ok === true ? { deployment_ready: true } : { deployment_ready: false, blocker: 'daemon_bootstrap_required' };
}
export function requireDeploymentRuntimeReadiness(proof) {
  if (!deploymentRuntimeReadiness(proof).deployment_ready) throw new Error('daemon_bootstrap_required; production mutation not started');
}
export function checkHashes(root, map, label) {
  for (const [name, expected] of Object.entries(map)) {
    const file = safePackagePath(root, name);
    if ((existsSync(file) ? hashFile(file) : null) !== expected) throw new Error(`${label} mismatch: ${name}`);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`Symlink target disallowed: ${name}`);
  }
}
function checkLinks(root, map, label) {
  for (const [name, link] of Object.entries(map ?? {})) {
    const file = safePackagePath(root, name, true);
    if (!lstatSync(file).isSymbolicLink() || readlinkSync(file) !== link || !resolve(dirname(file), link).startsWith(resolve(root) + '/')) throw new Error(`${label} symlink mismatch: ${name}`);
  }
}
export function validateChanged(config) {
  if (!Array.isArray(config.changed) || new Set(config.changed).size !== config.changed.length) throw new Error('Invalid changed paths');
  for (const name of config.changed) {
    if (!allowedChanged.has(name) || !Object.hasOwn(config.baseline, name) || !Object.hasOwn(config.payload, name) || !/^[a-f0-9]{64}$/.test(config.payload[name])) throw new Error('Disallowed changed path: ' + name);
    safePackagePath(config.production, name); safePackagePath(config.candidate, name);
  }
}
function atomicFile(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = target + '.lcb-stage-' + process.pid;
  cpSync(source, temp, { force: false, errorOnExist: true });
  renameSync(temp, target);
}
export function nativeSwap(first, second) {
  // macOS renameatx_np(RENAME_SWAP) exchanges existing directories atomically.
  const code = 'import ctypes,sys\nlib=ctypes.CDLL(None,use_errno=True)\nfn=lib.renameatx_np\nfn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nr=fn(-2,sys.argv[1].encode(),-2,sys.argv[2].encode(),2)\nif r: raise OSError(ctypes.get_errno(), "atomic directory exchange failed")\n';
  const result = spawnSync('/usr/bin/python3', ['-c', code, first, second], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error('Atomic swap failed; no non-atomic fallback: ' + (result.error?.code ?? result.status));
}
export async function deploy(config, ops) {
  validateChanged(config);
  checkHashes(config.production, config.baseline, 'baseline');
  checkHashes(config.candidate, config.payload, 'payload');
  checkLinks(config.production, config.baseline_links, 'baseline');
  checkLinks(config.candidate, config.payload_links, 'payload');
  if (ops.identity) ops.identity();
  requireDaemonRuntime(await ops.verifyBaseline());
  mkdirSync(config.backupRoot, { recursive: true, mode: 0o700 });
  const backup = mkdtempSync(join(config.backupRoot, 'deployment-'));
  const restore = join(backup, 'files');
  mkdirSync(restore);
  for (const name of config.changed) if (existsSync(join(config.production, name))) {
    mkdirSync(dirname(join(restore, name)), { recursive: true });
    cpSync(join(config.production, name), join(restore, name));
  }
  cpSync(join(config.production, 'dist'), join(restore, 'dist'), { recursive: true });
  const backupHashes = Object.fromEntries(Object.entries(config.baseline).filter(([name, hash]) => hash !== null && (name.startsWith('dist/') || config.changed.includes(name))));
  checkHashes(restore, backupHashes, 'backup');
  writeFileSync(join(backup, 'baseline.json'), JSON.stringify(config.baseline, null, 2));
  const build = await ops.build(backup);
  // Detect drift during the build and test window, before touching production.
  checkHashes(config.production, config.baseline, 'baseline');
  checkHashes(config.candidate, config.payload, 'payload');
  checkLinks(config.production, config.baseline_links, 'baseline');
  checkLinks(config.candidate, config.payload_links, 'payload');
  if (ops.identity) ops.identity();
  validateChanged(config);
  const stageRoot = mkdtempSync(join(dirname(config.production), '.lcb-dist-stage-'));
  const stage = join(stageRoot, 'dist');
  cpSync(build?.runtimePath ?? join(config.candidate, 'dist'), stage, { recursive: true });
  const installed = [];
  let swapped = false;
  let restartAttempted = false;
  const verificationAttempts = [];
  const recordAttempt = row => {
    if (verificationAttempts.length >= verificationPolicy.max_attempts * 2) return;
    // Re-project even adapter-provided attempts; never persist arbitrary fields.
    const gates = Object.fromEntries(['healthz', 'readyz', 'control_plane', 'wrapper', 'history', 'probe_loaded_runtime', 'daemon_loaded_runtime', 'remote_codex_models'].map(name => [name, { state: ['passed', 'failed', 'not_run'].includes(row[name]?.state) ? row[name].state : 'not_run', ...(row[name]?.error_classification ? { error_classification: errorClassification(row[name].error_classification) } : {}), ...(name === 'healthz' || name === 'readyz' ? { status: number(row[name]?.status) } : {}), ...(name === 'control_plane' ? { pid: number(row[name]?.pid) } : {}) }]));
    verificationAttempts.push({ phase: row.phase === 'rollback' ? 'rollback' : 'deployed', attempt: number(row.attempt), elapsed_ms: number(row.elapsed_ms), ok: row.ok === true, body_recorded: false, ...gates, ...(row.error_classification ? { error_classification: errorClassification(row.error_classification) } : {}) });
    writeFileSync(join(backup, 'verification-attempts.json'), JSON.stringify(verificationAttempts, null, 2), { mode: 0o600 });
  };
  try {
    for (const name of config.changed) { validateChanged(config); atomicFile(safePackagePath(config.candidate, name), safePackagePath(config.production, name)); installed.push(name); }
    ops.swap(join(config.production, 'dist'), stage);
    swapped = true;
    restartAttempted = true;
    await ops.restart();
    const verification = await ops.verify('deployed', recordAttempt);
    requireDaemonRuntime(verification);
    const result = { deployed: true, backup, priorRuntime: stage, verification: verificationSummary(verification), verification_attempts: verificationAttempts };
    writeFileSync(join(backup, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const rollbackErrors = [];
    if (swapped) try { ops.swap(join(config.production, 'dist'), stage); } catch (e) { rollbackErrors.push('runtime rollback: ' + e.message); }
    for (const name of installed.reverse()) try {
      const original = safePackagePath(restore, name), target = safePackagePath(config.production, name);
      if (existsSync(original)) atomicFile(original, target);
      else unlinkSync(target); // Only new files installed by this invocation.
    } catch (e) { rollbackErrors.push('file rollback: ' + e.message); }
    // A nonzero/timeout may already have replaced the daemon. Restore bytes, then restart
    // exactly the same target once, without escalation or permission bypass.
    try { checkHashes(config.production, config.baseline, 'restored baseline'); } catch (e) { rollbackErrors.push('restored bytes: ' + e.message); }
    if (restartAttempted && rollbackErrors.length === 0) try { await ops.restart(); } catch (e) { rollbackErrors.push('rollback restart uncertain: ' + e.message); }
    let rollbackHealth;
    if (restartAttempted) try {
      rollbackHealth = await ops.verify('rollback', recordAttempt);
      if (rollbackHealth?.ok !== true) throw new Error('Rollback health verification failed');
      requireDaemonRuntime(rollbackHealth);
    } catch (e) { rollbackErrors.push('rollback runtime unverified: ' + e.message); }
    const manualRecoveryRequired = rollbackErrors.length > 0;
    writeFileSync(join(backup, 'result.json'), JSON.stringify({ deployed: false, error_classification: errorClassification(error), restart_attempted: restartAttempted, rolled_back: !manualRecoveryRequired, manual_recovery_required: manualRecoveryRequired, rollbackErrors: rollbackErrors.map(errorClassification), rollbackHealth: rollbackHealth ? verificationSummary(rollbackHealth) : undefined, verification_attempts: verificationAttempts }, null, 2), { mode: 0o600 });
    throw new Error(error.message + (manualRecoveryRequired ? '; MANUAL_RECOVERY_REQUIRED; ' + rollbackErrors.join('; ') : '; rollback completed') + '; backup=' + backup);
  }
}
async function main() {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Requires macOS and Node.js 24+');
  if (!production || !/^gui\/\d+\/com\.openai\.tunnel-client\.lcb-remote$/.test(agent ?? '') || !trustVerifier) throw new Error('Explicit LCB_PRODUCTION_ROOT, LCB_LAUNCH_AGENT and external LCB_TRUST_VERIFIER required');
  const trustedPath = externalTrustPath(candidate, trustVerifier);
  const { verifyAnchoredPackage } = await import(pathToFileURL(trustedPath).href);
  verifyAnchoredPackage(candidate);
  const manifest = JSON.parse(readFileSync(join(candidate, 'manifest.json')));
  if (manifest.production !== production || manifest.agent !== agent) throw new Error('Target identity mismatch');
  const identity = () => {
    verifyAnchoredPackage(candidate);
    validateChanged({ ...manifest, candidate });
    for (const [path, hash] of Object.entries(manifest.host_code_hashes)) if (hashFile(path) !== hash) throw new Error('Host runtime identity changed: ' + path);
    const head = spawnSync('/usr/bin/git', ['-C', production, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim() !== manifest.git_head || hashFile(join(production, '.git/index')) !== manifest.git_index_hash) throw new Error('Production git identity changed');
  };
  identity();
  checkHashes(production, manifest.baseline, 'baseline');
  checkHashes(candidate, manifest.payload, 'payload');
  checkLinks(production, manifest.baseline_links, 'baseline');
  checkLinks(candidate, manifest.payload_links, 'payload');
  // Read-only check mode does not restart or probe production write access.
  let baselineDaemon;
  try { baselineDaemon = await verifyDaemon(daemonConfig(production, manifest.baseline, agent)); } catch { baselineDaemon = { ok: false, error: 'daemon_runtime_unverified' }; }
  if (process.argv.includes('--check')) { console.log(JSON.stringify({ ok: true, mode: 'check', production, changed: manifest.changed, agent, daemon_loaded_runtime: gate(baselineDaemon), ...deploymentRuntimeReadiness(baselineDaemon) })); return; }
  requireDeploymentRuntimeReadiness(baselineDaemon);
  const run = (command, args, timeout = 15000) => {
    const childEnv = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH };
    delete childEnv.LCB_VERIFY_OPENAI_API_KEY; delete childEnv.OPENAI_API_KEY;
    const r = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: childEnv });
    if (r.status !== 0) throw new Error(`${command} failed (${r.error?.code ?? r.status}); no bypass attempted`);
    return r;
  };
  const baselineHealth = await verifyLive({ wrapper: true });
  if (!baselineHealth.ok) throw new Error('Baseline health failed; deployment not started');
  const remoteBefore = await remoteModels();
  let restartBefore;
  const instance = (deadline = Infinity) => {
    const budget = Math.min(15000, deadline - Date.now());
    if (budget <= 0) throw new Error('Daemon identity deadline');
    const read = run('/bin/launchctl', ['print', agent], budget);
    const pid = Number(read.stdout.match(/^\s*pid = (\d+)$/m)?.[1]);
    if (!pid || !/^\s*state = running$/m.test(read.stdout)) throw new Error('Target LaunchAgent running instance unverified');
    return { pid };
  };
  const ops = {
    identity,
    verifyBaseline: async () => ({ ok: true, daemon_loaded_runtime: await verifyDaemon(daemonConfig(production, manifest.baseline, agent)) }),
    build: async backup => {
      const result = run(process.execPath, [join(candidate, 'scripts/validate-fix.mjs'), '--isolated', '--output', backup], 120000);
      writeFileSync(join(backup, 'validation.log'), result.stdout + result.stderr);
      const validation = JSON.parse(result.stdout.trim());
      const runtimePath = join(validation[0].cwd, 'dist');
      const builtHashes = Object.fromEntries(Object.entries(manifest.payload).filter(([name]) => name.startsWith('dist/')).map(([name, hash]) => [name.slice(5), hash]));
      checkHashes(runtimePath, builtHashes, 'fresh build');
      return { runtimePath };
    },
    swap: nativeSwap,
    restart: async () => { restartBefore = instance(); targetedRestart(agent, run); },
    verify: async (phase, onAttempt) => {
      const result = await verifyWithRetries(phase, { onAttempt, verify: async ({ deadline }) => {
        const result = await verifyLive({ wrapper: true, history: phase !== 'rollback', candidate: production, deadline, runtimeProof: { root: production, hashes: phase === 'rollback' ? manifest.baseline : manifest.payload } });
        if (result.ok) try {
          const running = instance(deadline);
          if (!restartBefore || running.pid === restartBefore.pid || result.control_plane.pid !== running.pid || result.wrapper.probe_loaded_runtime?.ok !== true) throw new Error('Replaced daemon / probe runtime identity unverified');
          result.daemon_loaded_runtime = await verifyDaemon(daemonConfig(production, phase === 'rollback' ? manifest.baseline : manifest.payload, agent), { deadline });
          if (result.daemon_loaded_runtime.tunnel_pid !== running.pid) throw new Error('Daemon Tunnel identity mismatch');
          result.remote_codex_models = await remoteModels({ deadline });
          if (instance(deadline).pid !== running.pid) throw new Error('Running instance changed during acceptance');
          const acceptedDaemon = await verifyDaemon(daemonConfig(production, phase === 'rollback' ? manifest.baseline : manifest.payload, agent), { deadline });
          if (acceptedDaemon.instance_id !== result.daemon_loaded_runtime.instance_id || acceptedDaemon.pid !== result.daemon_loaded_runtime.pid) throw new Error('Daemon Bridge replaced during remote acceptance');
        } catch (error) { result.ok = false; result.error = errorClassification(error); }
        return result;
      } });
      requireDaemonRuntime(result);
      return result;
    },
  };
  if (!process.env.LCB_BACKUP_ROOT) throw new Error('Explicit LCB_BACKUP_ROOT required');
  const result = await deploy({ ...manifest, candidate, backupRoot: resolve(process.env.LCB_BACKUP_ROOT) }, ops);
  result.remote_before = remoteBefore;
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ deployed: false, error: error.message })); process.exitCode = 1; });
