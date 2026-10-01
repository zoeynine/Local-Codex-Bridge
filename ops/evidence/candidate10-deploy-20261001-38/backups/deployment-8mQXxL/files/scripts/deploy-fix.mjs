// Incident-scoped deployment. No git mutations, history writes, or broad process control.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, cpSync, renameSync, unlinkSync, readlinkSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyLive } from './verify-fix-live.mjs';
import { remoteModels } from './remote-model-probe.mjs';
import { safePackagePath } from './verify-package.mjs';
const production = '/Users/ZGH/.local/share/local-codex-bridge';
const agent = 'gui/502/com.openai.tunnel-client.lcb-remote';
const candidate = fileURLToPath(new URL('../', import.meta.url));
const trustVerifier = '/Users/ZGH/Documents/Codex/2026-09-17/yt/lcb-incident-20260928/deploy-trust/verify-package.mjs';
const allowedChanged = new Set(['package.json', 'src/app-server.ts', 'src/tools.ts', 'test/runtime.test.ts', 'test/tools.test.ts', 'test/compatibility.test.ts', 'test/overflow.test.ts', 'test/overflow-codex.mjs', 'test/deploy-fix.test.ts', 'test/remote-probe.test.ts', 'scripts/deploy-fix.mjs', 'scripts/remote-model-probe.mjs', 'scripts/verify-fix-live.mjs', 'scripts/validate-fix.mjs', 'scripts/verify-package.mjs', 'scripts/runtime-load-proof.mjs']);
export const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
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
  try {
    for (const name of config.changed) { validateChanged(config); atomicFile(safePackagePath(config.candidate, name), safePackagePath(config.production, name)); installed.push(name); }
    ops.swap(join(config.production, 'dist'), stage);
    swapped = true;
    restartAttempted = true;
    await ops.restart();
    const verification = await ops.verify('deployed');
    const result = { deployed: true, backup, priorRuntime: stage, verification };
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
      rollbackHealth = await ops.verify('rollback');
      if (rollbackHealth?.ok !== true || rollbackHealth?.loaded_instance?.ok !== true) throw new Error('Old loaded instance proof missing');
    } catch (e) { rollbackErrors.push('rollback runtime unverified: ' + e.message); }
    const manualRecoveryRequired = rollbackErrors.length > 0;
    writeFileSync(join(backup, 'result.json'), JSON.stringify({ deployed: false, error: error.message, restart_attempted: restartAttempted, rolled_back: !manualRecoveryRequired, manual_recovery_required: manualRecoveryRequired, rollbackErrors, rollbackHealth }, null, 2));
    throw new Error(error.message + (manualRecoveryRequired ? '; MANUAL_RECOVERY_REQUIRED; ' + rollbackErrors.join('; ') : '; rollback completed') + '; backup=' + backup);
  }
}
async function main() {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Requires macOS and Node.js 24+');
  const { verifyAnchoredPackage } = await import(pathToFileURL(trustVerifier).href);
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
  if (process.argv.includes('--check')) { console.log(JSON.stringify({ ok: true, mode: 'check', production, changed: manifest.changed, agent })); return; }
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
  const instance = () => {
    const read = run('/bin/launchctl', ['print', agent]);
    const pid = Number(read.stdout.match(/^\s*pid = (\d+)$/m)?.[1]);
    if (!pid || !/^\s*state = running$/m.test(read.stdout)) throw new Error('Target LaunchAgent running instance unverified');
    return { pid };
  };
  const ops = {
    identity,
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
    restart: async () => { restartBefore = instance(); run('/bin/launchctl', ['kickstart', '-k', agent]); },
    verify: async phase => {
      const deadline = Date.now() + 45000;
      do {
        const result = await verifyLive({ wrapper: true, history: phase !== 'rollback', candidate: production, runtimeProof: { root: production, hashes: phase === 'rollback' ? manifest.baseline : manifest.payload } });
        if (result.ok) {
          const running = instance();
          if (!restartBefore || running.pid === restartBefore.pid || result.control_plane.pid !== running.pid || result.wrapper.runtime_proof?.ok !== true) throw new Error('Replaced daemon / loaded Bridge instance unverified');
          result.remote_codex_models = await remoteModels();
          if (instance().pid !== running.pid) throw new Error('Running instance changed during acceptance');
          result.loaded_instance = { ...result.wrapper.runtime_proof, tunnel_pid: running.pid, replaced_tunnel_pid: restartBefore.pid };
          return result;
        }
        // Poll readiness with a deadline, never assume a fixed delay means success.
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      throw new Error('Deployment health/wrapper/history verification failed');
    },
  };
  const result = await deploy({ ...manifest, candidate, backupRoot: join(dirname(trustVerifier), '../deployment-backups') }, ops);
  result.remote_before = remoteBefore;
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ deployed: false, error: error.message })); process.exitCode = 1; });
