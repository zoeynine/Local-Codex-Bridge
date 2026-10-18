import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runBootstrap } from '../scripts/daemon-bootstrap-executor.mjs';
import { metadata, sha256, canonical } from '../scripts/bootstrap-method.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executor = path.join(repo, 'scripts/daemon-bootstrap-executor.mjs');
const head = '1'.repeat(40);
// Real executor entry point and real filesystem, with only OS/service commands
// and read-only service gates isolated. No production/host pathname enters it.
function fixture() {
  const root = fs.mkdtempSync('/private/tmp/lcb-bootstrap-executor-test-');
  // /private/tmp inherits wheel on macOS; this owned fixture must model staff.
  fs.chownSync(root, process.getuid(), process.getgid());
  const savedEnv = { ...process.env }, real = Object.fromEntries(['renameSync', 'fsyncSync', 'lstatSync', 'writeFileSync', 'readFileSync'].map(k => [k, fs[k]]));
  const spawn = childProcess.spawnSync;
  const write = (name, bytes, mode = 0o600) => { fs.writeFileSync(name, bytes, { mode }); return name; };
  const dir = name => { fs.mkdirSync(name, { mode: 0o700 }); return name; };
  const production = dir(path.join(root, 'production')); dir(path.join(production, '.git')); dir(path.join(production, 'dist'));
  write(path.join(production, '.git/index'), 'index'); write(path.join(production, 'dist/index.js'), 'frozen runtime'); write(path.join(production, 'package.json'), '{"version":"fixture"}');
  const wrapper = path.join(root, 'wrapper'), originalBytes = Buffer.alloc(385, 65), proposed = 'proposed wrapper\n'; write(wrapper, originalBytes, 0o700);
  const backupRoot = dir(path.join(root, 'backups')), run = path.join(root, 'run'), hooks = path.join(root, 'hooks');
  const hookSource = write(path.join(root, 'source.mjs'), 'frozen hook\n');
  const trust = write(path.join(root, 'trust.mjs'), 'export const verifyAnchoredPackage=()=>({ok:true,files:128,links:0});\n');
  const gates = write(path.join(root, 'gates.mjs'), 'export const verifyLive=async()=>({ok:true,healthz:{ok:true},readyz:{ok:true},control_plane:{ok:true,pid:Number(process.env.LCB_FIXTURE_PID)},wrapper:{ok:true}});export const remoteModels=async({record})=>{if(process.env.LCB_FIXTURE_CLEANUP_FAIL){const cleanup={action:"remote_scratch_cleanup",directory:{path:"/synthetic/retained"},ok:false,partial:true,retained_paths:["/synthetic/retained"]};record(cleanup);throw Object.assign(new Error("scratch cleanup failed"),{failure_domain:"scratch_cleanup",verification_result:{ok:true},cleanup});}return {ok:true,cleanup:{ok:true}};};export const daemonConfig=()=>({});export const verifyDaemon=async()=>({pid:93,start:"new Bridge",instance_id:"fixture",tunnel_pid:Number(process.env.LCB_FIXTURE_PID)});\n');
  const source = file => ({ source: file, sha256: sha256(fs.readFileSync(file)), byte_length: fs.statSync(file).size });
  const original = { ...metadata(wrapper), byte_length: 385, bytes: originalBytes.toString(), state: 'present' };
  const c = {
    executor: { path: executor, sha256: sha256(fs.readFileSync(executor)), dependencies: [source(path.join(repo, 'scripts/bootstrap-method.mjs'))] },
    backup: { root: backupRoot, prestate: metadata(backupRoot) },
    live_prestate: { original_wrapper: original, production_git_head: head, production_git_index_sha256: sha256('index'), production_dist_sha256: { 'dist/index.js': sha256('frozen runtime') }, unchanged_host_code_sha256: {}, parent_directories: [metadata(root)], absent_paths: [run, hooks, path.join(run, 'attest'), path.join(hooks, 'hook.mjs')] },
    scope: { production, agent: 'gui/502/com.openai.tunnel-client.lcb-remote', host_target_allowlist: [run, hooks, wrapper] },
    service_identity: { agent: 'gui/502/com.openai.tunnel-client.lcb-remote', uid: 502, tunnelProgram: path.join(root, 'tunnel'), plist: path.join(root, 'agent.plist'), old_bridge_command: `${process.execPath} ${production}/dist/src/index.js` },
    release_anchor: { archive: write(path.join(root, 'archive'), 'archive'), archive_sha256: sha256('archive'), manifest: write(path.join(root, 'release-manifest'), 'release'), manifest_sha256: sha256('release'), trust_verifier: trust, trust_verifier_sha256: sha256(fs.readFileSync(trust)), candidate: root },
    targets: [
      ...[run, hooks, path.join(run, 'attest')].map(target => ({ type: 'directory', target, prestate: { path: target, state: 'absent' } })),
      { type: 'file', target: path.join(hooks, 'hook.mjs'), ...source(hookSource), mode: '0500', prestate: { state: 'absent' } },
      { type: 'file', target: wrapper, sha256: sha256(proposed), byte_length: Buffer.byteLength(proposed), mode: '0700', proposed_bytes: proposed, prestate: original }
    ],
    rollback: { directory_cleanup_order: [path.join(run, 'attest'), hooks, run] },
    verification: { frozen_modules: [source(gates)], environment: { LCB_NODE: fs.realpathSync(process.execPath), LCB_DAEMON_ATTEST_HOOK: path.join(hooks, 'hook.mjs'), LCB_FIXTURE_PID: '91' }, modules: { verifyLive: gates, daemon: gates, remoteModels: gates }, baseline_modules: {}, max_attempts: 1 }
  };
  const contractPath = write(path.join(root, 'contract.json'), canonical(c));
  const invocation = 'bootstrap-20260929T010203004Z-' + 'a'.repeat(32), backup = dir(path.join(backupRoot, invocation));
  const ledgerPath = write(path.join(backup, 'owned-targets.jsonl'), Buffer.concat([canonical({ ...metadata(backupRoot), invocation, action: 'preserved_backup_root', created_by_this_invocation: false }), canonical({ ...metadata(backup), invocation, action: 'backup_invocation', created_by_this_invocation: true })]));
  write(path.join(backup, 'verification-attempts.jsonl'), ''); write(path.join(backup, 'contract.json'), canonical(c)); write(path.join(backup, 'original-wrapper.bin'), originalBytes);
  const manifest = { invocation_id: invocation, execution_git_head: head, contract_sha256: sha256(canonical(c)), executor: c.executor, backup_invocation_directory_identity: metadata(backup), ownership_ledger_identity: metadata(ledgerPath), backup_wrapper_sha256_and_length: metadata(path.join(backup, 'original-wrapper.bin')), preflight: { production_version: 'fixture' } };
  assert.equal(manifest.ownership_ledger_identity.gid, 20);
  const args = { phase: 'execute', contractPath, contractHash: sha256(canonical(c)), head, backupPath: backup, manifestHash: sha256(canonical(manifest)) };
  write(path.join(backup, 'manifest.json'), canonical(manifest)); write(path.join(backup, 'manifest.sha256'), args.manifestHash + '\n');
  let kicks = 0, newService = false;
  childProcess.spawnSync = (file, argv) => {
    assert.ok(['/usr/bin/git', '/bin/ps', '/bin/launchctl'].includes(file), `unexpected command ${file}`);
    let stdout;
    const pid = newService ? 92 : 91, bridge = newService ? 93 : 94, start = newService ? 'new Tunnel' : 'old Tunnel';
    if (file === '/usr/bin/git') stdout = argv.at(-1) === 'HEAD' ? head : '';
    if (file === '/bin/launchctl') {
      if (argv[0] === 'kickstart') { kicks++; newService = fs.readFileSync(wrapper).toString() === proposed; process.env.LCB_FIXTURE_PID = newService ? '92' : '91'; stdout = ''; }
      else stdout = `state = running\npid = ${pid}\nruns = 1\nprogram = ${c.service_identity.tunnelProgram}\npath = ${c.service_identity.plist}\n`;
    }
    if (file === '/bin/ps') {
      if (argv[0] === '-axo') stdout = `${bridge} ${pid}`;
      else if (argv.at(-1) === 'command=') stdout = newService ? `${c.verification.environment.LCB_NODE} --import ${c.verification.environment.LCB_DAEMON_ATTEST_HOOK} ${production}/dist/src/index.js` : c.service_identity.old_bridge_command;
      else stdout = argv[1] === String(pid) ? `${pid} 1 502 ${start}` : `${bridge} ${pid} 502 ${newService ? 'new Bridge' : 'old Bridge'}`;
    }
    return { status: 0, stdout, stderr: '' };
  };
  syncBuiltinESMExports();
  return { root, c, args, wrapper, backup, ledgerPath, manifest, originalBytes, real, get kicks() { return kicks; }, write,
    refreezeManifest() { const bytes = canonical(manifest); write(path.join(backup, 'manifest.json'), bytes); args.manifestHash = sha256(bytes); write(path.join(backup, 'manifest.sha256'), args.manifestHash + '\n'); },
    cleanup() {
      Object.assign(fs, real); childProcess.spawnSync = spawn; syncBuiltinESMExports();
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv);
      // This exact mkdtemp fixture is owned by this test; never a host path.
      fs.rmSync(root, { recursive: true });
    }
  };
}

test('real runBootstrap execute reads frozen manifest and legal prepared ledger before guard and reaches success', async () => {
  const f = fixture();
  try { const result = await runBootstrap(f.args); assert.equal(result.status, 'bootstrapped', JSON.stringify(result)); assert.equal(f.kicks, 1); assert.equal(result.host_target_mutations, undefined); assert.equal(fs.readFileSync(f.wrapper, 'utf8'), 'proposed wrapper\n'); }
  finally { f.cleanup(); }
});

test('native preflight cleanup failure preserves RPC PASS and partial residual before any bootstrap target or restart', async () => {
  const f = fixture();
  try {
    process.env.LCB_FIXTURE_CLEANUP_FAIL = '1';
    const result = await runBootstrap(f.args);
    assert.equal(result.status, 'blocked'); assert.equal(f.kicks, 0); assert.equal(result.mutations.length, 0);
    assert.equal(result.scratch_cleanup.ok, false); assert.deepEqual(result.scratch_cleanup.retained[0].retained_paths, ['/synthetic/retained']);
    assert.equal(result.native_cleanup_failure.rpc.ok, true); assert.equal(result.native_cleanup_failure.cleanup.partial, true);
    assert.deepEqual(fs.readFileSync(f.wrapper), f.originalBytes);
    for (const file of f.c.live_prestate.absent_paths) assert.equal(fs.existsSync(file), false);
    const records = fs.readFileSync(f.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.at(-1).partial, true); assert.equal(records.at(-1).ok, false);
  } finally { f.cleanup(); }
});

test('prepare binds native preflight evidence outside scratch and retains exactly two initial ledger records', async () => {
  const f = fixture();
  try {
    const result = await runBootstrap({ ...f.args, phase: 'prepare' });
    assert.equal(result.status, 'prepared', JSON.stringify(result)); assert.equal(f.kicks, 0); assert.equal(result.target_mutations, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.backup, 'manifest.json')));
    const evidence = manifest.native_preflight_evidence;
    assert.equal(path.dirname(evidence.path), result.backup); assert.equal(evidence.mode, '0600');
    assert.equal(sha256(fs.readFileSync(evidence.path)), evidence.sha256);
    assert.equal(manifest.preflight.native_preflight.cleanup.ok, true);
    assert.equal(fs.readFileSync(path.join(result.backup, 'owned-targets.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.deepEqual(fs.readFileSync(f.wrapper), f.originalBytes);
    f.write(evidence.path, '{}\n');
    const rejected = await runBootstrap({ ...f.args, backupPath: result.backup, manifestHash: result.manifest_sha256 });
    assert.equal(rejected.status, 'blocked'); assert.equal(rejected.host_target_mutations, false); assert.match(rejected.error_classification, /native preflight evidence/); assert.equal(f.kicks, 0);
  } finally { f.cleanup(); }
});

test('prepare fails closed on native preflight cleanup before creating invocation backup', async () => {
  const f = fixture();
  try {
    process.env.LCB_FIXTURE_CLEANUP_FAIL = '1';
    const before = fs.readdirSync(f.c.backup.root);
    const result = await runBootstrap({ ...f.args, phase: 'prepare' });
    assert.equal(result.status, 'blocked'); assert.equal(result.host_target_mutations, false); assert.equal(f.kicks, 0); assert.equal(result.backup, null);
    assert.equal(result.verification_result.ok, true); assert.equal(result.scratch_cleanup.ok, false);
    assert.deepEqual(fs.readdirSync(f.c.backup.root), before);
    assert.deepEqual(fs.readFileSync(f.wrapper), f.originalBytes);
  } finally { f.cleanup(); }
});

for (const scenario of ['external manifest digest', 'frozen directory identity', 'recreated directory with self-authorizing ledger', 'ledger self authorization', 'ledger file replacement']) test(`execute rejects ${scenario} before target mutation or service command`, async () => {
  const f = fixture(); let ledgerReads = 0;
  try {
    if (scenario === 'external manifest digest') f.write(path.join(f.backup, 'manifest.json'), '{}\n');
    if (scenario === 'frozen directory identity') { f.manifest.backup_invocation_directory_identity.ino++; f.refreezeManifest(); }
    if (scenario === 'recreated directory with self-authorizing ledger') {
      const moved = f.backup + '-old'; fs.renameSync(f.backup, moved); fs.mkdirSync(f.backup, { mode: 0o700 });
      for (const name of fs.readdirSync(moved)) f.write(path.join(f.backup, name), fs.readFileSync(path.join(moved, name)));
      const rows = fs.readFileSync(f.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse); Object.assign(rows[1], metadata(f.backup)); f.write(f.ledgerPath, rows.map(x => canonical(x)).join(''));
    }
    if (scenario === 'ledger self authorization') { const rows = fs.readFileSync(f.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse); rows[1].ino++; f.write(f.ledgerPath, rows.map(x => canonical(x)).join('')); }
    if (scenario === 'ledger file replacement') { fs.renameSync(f.ledgerPath, path.join(f.backup, 'old-ledger')); f.write(f.ledgerPath, fs.readFileSync(path.join(f.backup, 'old-ledger'))); }
    fs.readFileSync = (file, ...rest) => { if (file === f.ledgerPath) ledgerReads++; return f.real.readFileSync(file, ...rest); };
    const result = await runBootstrap(f.args); assert.equal(result.status, 'blocked'); assert.equal(result.host_target_mutations, false); assert.equal(f.kicks, 0);
    assert.deepEqual(fs.readFileSync(f.wrapper), f.originalBytes); for (const target of f.c.live_prestate.absent_paths) assert.equal(fs.existsSync(target), false);
    if (scenario !== 'ledger self authorization') assert.equal(ledgerReads, 0);
  } finally { f.cleanup(); }
});

for (const failure of ['fsync', 'readback', 'record']) test(`post-wrapper-rename ${failure} failure restores exact original wrapper and retains unknown directory content`, async () => {
  const f = fixture(); let afterRename = false, injected = false; const renames = [];
  const unknown = path.join(f.root, 'run/attest/unknown');
  const fail = () => { injected = true; f.real.writeFileSync(unknown, 'preserve'); throw new Error(`injected post-rename ${failure}`); };
  fs.renameSync = (from, to) => { const result = f.real.renameSync(from, to); renames.push({ from, to }); if (to === f.wrapper && !injected) afterRename = true; return result; };
  fs.fsyncSync = fd => { if (failure === 'fsync' && afterRename && !injected) fail(); return f.real.fsyncSync(fd); };
  fs.lstatSync = (...args) => { if (failure === 'readback' && afterRename && !injected && args[0] === f.wrapper) fail(); return f.real.lstatSync(...args); };
  fs.writeFileSync = (file, bytes, ...rest) => { if (failure === 'record' && afterRename && !injected && String(bytes).includes('"action":"replace"')) fail(); return f.real.writeFileSync(file, bytes, ...rest); };
  try {
    const result = await runBootstrap(f.args); assert.equal(injected, true); assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.equal(result.rollback.old_service_restored, true); assert.equal(result.rollback.wrapper_restored, true); assert.equal(result.rollback.cleanup_incomplete, true); assert.equal(result.rollback.rolled_back, false); assert.equal(f.kicks, 0);
    assert.deepEqual(fs.readFileSync(f.wrapper), f.originalBytes); assert.equal(fs.readFileSync(unknown, 'utf8'), 'preserve');
    assert.equal(fs.existsSync(path.join(f.root, 'hooks')), false); assert.equal(renames.filter(x => x.to === f.wrapper).length, 2);
    assert.deepEqual(renames.map(x => x.to), [path.join(f.root, 'hooks/hook.mjs'), f.wrapper, f.wrapper]);
    const records = fs.readFileSync(f.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse), intent = records.find(x => x.action === 'replacement_intent' && x.destination === f.wrapper);
    assert.equal(intent.stage.sha256, sha256('proposed wrapper\n')); assert.ok(intent.stage.dev >= 0 && intent.stage.ino > 0); assert.equal(intent.expected_prior.sha256, sha256(f.originalBytes));
  } finally { f.cleanup(); }
});

test('post-rename unknown wrapper identity blocks restore without overwriting unknown bytes', async () => {
  const f = fixture(); let injected = false;
  fs.renameSync = (from, to) => { const result = f.real.renameSync(from, to); if (to === f.wrapper && !injected) { injected = true; f.real.writeFileSync(f.wrapper, 'unknown content'); } return result; };
  try {
    const result = await runBootstrap(f.args); assert.equal(result.status, 'blocked'); assert.equal(result.rollback.manual_recovery_required, true); assert.equal(f.kicks, 0); assert.equal(fs.readFileSync(f.wrapper, 'utf8'), 'unknown content');
  } finally { f.cleanup(); }
});
