import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkHashes, hashFile, nativeSwap, targetedRestart, validateChanged, externalTrustPath, requireDaemonRuntime, requireDeploymentRuntimeReadiness, verifyWithRetries, verificationSummary } from './deploy-fix.mjs';
import { safePackagePath } from './verify-package.mjs';
import { verifyLive } from './verify-fix-live.mjs';
import { remoteModels } from './remote-model-probe.mjs';
import { verifyDaemon, daemonConfig } from './daemon-attestation.mjs';
export async function rollback(config, ops) {
  const source = join(config.backup, 'files');
  const baselineFile = join(config.backup, 'baseline.json');
  const baselineBytes = readFileSync(baselineFile);
  if (!/^[a-f0-9]{64}$/.test(config.backup_baseline_sha256 ?? '') || createHash('sha256').update(baselineBytes).digest('hex') !== config.backup_baseline_sha256) throw new Error('Frozen backup baseline digest mismatch');
  const old = JSON.parse(baselineBytes);
  const payload = Object.fromEntries(config.changed.map(name => [name, old[name] ?? '0'.repeat(64)]));
  validateChanged({ production: config.production, candidate: source, baseline: config.expected_current, payload, changed: config.changed });
  checkHashes(config.production, config.expected_current, 'current rollback baseline');
  const restoreHashes = Object.fromEntries(Object.entries(old).filter(([name]) => name.startsWith('dist/') || config.changed.includes(name)));
  checkHashes(source, restoreHashes, 'backup');
  if (ops.identity) ops.identity();
  requireDaemonRuntime(await ops.verifyBaseline());
  const stageRoot = mkdtempSync(join(dirname(config.production), '.lcb-rollback-stage-'));
  const stage = join(stageRoot, 'dist');
  cpSync(join(source, 'dist'), stage, { recursive: true });
  try {
    for (const name of config.changed) {
      const target = safePackagePath(config.production, name);
      if (old[name] === null || !(name in old)) { if (existsSync(target)) unlinkSync(target); }
      else { const tmp = target + '.rollback-' + process.pid; mkdirSync(dirname(target), { recursive: true }); cpSync(safePackagePath(source, name), tmp, { errorOnExist: true, force: false }); renameSync(tmp, target); }
    }
    ops.swap(join(config.production, 'dist'), stage);
    checkHashes(config.production, old, 'restored baseline');
    await ops.restart();
    const verification = await ops.verify(old);
    if (verification?.ok !== true) throw new Error('Rollback health verification failed');
    requireDaemonRuntime(verification);
    const receipt = { rolled_back: true, backup: config.backup, displaced_runtime: stage, verification: verificationSummary(verification) };
    writeFileSync(join(stageRoot, 'rollback-receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    writeFileSync(join(stageRoot, 'rollback-receipt.json'), JSON.stringify({ rolled_back: false, manual_recovery_required: true }));
    throw new Error('MANUAL_RECOVERY_REQUIRED; explicit rollback incomplete; receipt=' + join(stageRoot, 'rollback-receipt.json'));
  }
}
async function main() {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  if (!process.env.LCB_TRUST_VERIFIER) throw new Error('External trusted runner required');
  const { verifyAnchoredPackage } = await import(pathToFileURL(externalTrustPath(packageRoot, process.env.LCB_TRUST_VERIFIER)).href);
  verifyAnchoredPackage(packageRoot);
  const contract = process.argv[2], anchor = process.env.LCB_ROLLBACK_CONTRACT_SHA256;
  if (!contract || !/^[a-f0-9]{64}$/.test(anchor ?? '')) throw new Error('Frozen external rollback contract required');
  const contractBytes = readFileSync(contract);
  if (createHash('sha256').update(contractBytes).digest('hex') !== anchor) throw new Error('Frozen external rollback contract required');
  const config = JSON.parse(contractBytes);
  requireDeploymentRuntimeReadiness(await verifyDaemon(daemonConfig(config.production, config.expected_current, config.agent)));
  const run = (cmd, args, timeout = 10000) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout }); if (r.status !== 0) throw new Error('Target command failed'); return r; };
  const instance = (deadline = Infinity) => { const budget = Math.min(10000, deadline - Date.now()); if (budget <= 0) throw new Error('Daemon identity deadline'); const r = run('/bin/launchctl', ['print', config.agent], budget); const pid = Number(r.stdout.match(/^\s*pid = (\d+)$/m)?.[1]); if (!pid) throw new Error('LaunchAgent running identity missing'); return pid; };
  let previous;
  const receipt = await rollback(config, {
    identity: () => { for (const [path, hash] of Object.entries(config.host_code_hashes ?? {})) if (hashFile(path) !== hash) throw new Error('Host identity changed'); },
    verifyBaseline: async () => ({ ok: true, daemon_loaded_runtime: await verifyDaemon(daemonConfig(config.production, config.expected_current, config.agent)) }),
    swap: nativeSwap,
    restart: async () => { previous = instance(); targetedRestart(config.agent, run); },
    verify: async old => {
      const result = await verifyWithRetries('rollback', { verify: async ({ deadline }) => {
        const result = await verifyLive({ wrapper: true, deadline, runtimeProof: { root: config.production, hashes: old } });
        if (result.ok && result.wrapper.probe_loaded_runtime?.ok && instance(deadline) !== previous) {
          result.daemon_loaded_runtime = await verifyDaemon(daemonConfig(config.production, old, config.agent), { deadline });
          if (result.daemon_loaded_runtime.tunnel_pid !== instance(deadline)) throw new Error('Daemon Tunnel identity mismatch');
          result.remote_codex_models = await remoteModels({ deadline });
          if (result.daemon_loaded_runtime.tunnel_pid !== instance(deadline)) throw new Error('Daemon instance replaced during remote acceptance');
          const acceptedDaemon = await verifyDaemon(daemonConfig(config.production, old, config.agent), { deadline });
          if (acceptedDaemon.instance_id !== result.daemon_loaded_runtime.instance_id || acceptedDaemon.pid !== result.daemon_loaded_runtime.pid) throw new Error('Daemon Bridge replaced during remote acceptance');
        } else result.ok = false;
        return result;
      } });
      requireDaemonRuntime(result);
      return result;
    },
  });
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ rolled_back: false, error: error.message })); process.exitCode = 1; });
