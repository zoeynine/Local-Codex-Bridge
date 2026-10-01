import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, chmodSync, rmSync, symlinkSync, existsSync, cpSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
const api = await import(new URL('../../scripts/daemon-attestation.mjs', import.meta.url).href);
const sha = (bytes: any) => createHash('sha256').update(bytes).digest('hex');
const expected = Object.fromEntries(api.MODULES.map((name: string) => [name, sha(name)]));
const snapshot = { tunnel: { pid: 11, ppid: 1, uid: 502, start: 'start tunnel' }, bridge: { pid: 22, ppid: 11, uid: 502, start: 'start bridge' }, root: '/canonical/root', socket: { path: '/private/socket', identity: 'socket-inode' } };
const response = (nonce: string) => ({ version: 1, nonce, instance_id: 'a'.repeat(64), pid: 22, uid: 502, initial_ppid: 11, start: 'start bridge', root: '/canonical/root', hook_version: api.HOOK_VERSION, loaded_sha256: { ...expected } });
test('daemon acceptance requires two fresh nonces and three unchanged OS snapshots', async () => {
  let calls = 0; const nonces: string[] = [];
  const proof = await api.verifyDaemon({ hashes: expected }, { snapshot: () => { calls++; return snapshot; }, challenge: async (_path: string, nonce: string) => { nonces.push(nonce); return response(nonce); } });
  assert.equal(calls, 3); assert.equal(new Set(nonces).size, 2);
  assert.equal(proof.scope, 'tunnel_direct_bridge_daemon'); assert.equal(Object.keys(proof.loaded_sha256).length, 19);
});
for (const field of ['nonce', 'pid', 'uid', 'initial_ppid', 'start', 'root', 'hook_version', 'instance_id', 'extra', 'missing module', 'extra module', 'hash']) {
  test(`daemon rejects ${field}`, async () => {
    await assert.rejects(api.verifyDaemon({ hashes: expected }, { snapshot: () => snapshot, challenge: async (_: string, nonce: string) => {
      const result: any = response(nonce);
      if (field === 'missing module') delete result.loaded_sha256[api.MODULES[0]];
      else if (field === 'extra module') result.loaded_sha256['dist/src/unknown.js'] = 'a'.repeat(64);
      else if (field === 'hash') result.loaded_sha256[api.MODULES[0]] = 'b'.repeat(64);
      else result[field] = 'invalid';
      return result;
    } }));
  });
}
for (const change of ['tunnel', 'bridge', 'socket', 'instance']) test(`daemon rejects ${change} replacement mid-challenge`, async () => {
  let reads = 0, challenges = 0;
  await assert.rejects(api.verifyDaemon({ hashes: expected }, {
    snapshot: () => { reads++; const value = structuredClone(snapshot); if (reads > 1 && change !== 'instance') (value as any)[change][change === 'socket' ? 'identity' : 'start'] += '-replaced'; return value; },
    challenge: async (_: string, nonce: string) => { const value = response(nonce); if (++challenges > 1 && change === 'instance') value.instance_id = 'b'.repeat(64); return value; },
  }), /replaced|instance/);
});
test('private directory rejects mode, symlink and owner mismatch', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync('/private/tmp/lcb-private-');
  try {
    api.privateDirectory(root, process.getuid!());
    assert.throws(() => api.privateDirectory(root, process.getuid!() + 1), /owner/);
    chmodSync(root, 0o755); assert.throws(() => api.privateDirectory(root, process.getuid!()), /mode/); chmodSync(root, 0o700);
    symlinkSync(root, root + '-link'); assert.throws(() => api.privateDirectory(root + '-link', process.getuid!()), /identity/);
  } finally { rmSync(root + '-link', { force: true }); rmSync(root, { recursive: true }); }
});
for (const scenario of ['oversized', 'timeout', 'cancelled', 'invalid', 'valid']) test(`private IPC ${scenario} is bounded and cleaned up`, { skip: process.platform !== 'darwin' }, async () => {
  const root = mkdtempSync('/private/tmp/lcb-ipc-'), path = join(root, 's');
  const peers = new Set<any>();
  const server = createServer({ allowHalfOpen: true }, socket => { peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); socket.on('data', () => {
    if (scenario === 'oversized') socket.end('x'.repeat(api.MAX_FRAME + 1));
    else if (scenario === 'invalid') socket.end('{}\n{}\n');
    else if (scenario === 'valid') socket.end('{}\n');
  }); });
  try {
    await new Promise<void>(resolve => server.listen(path, resolve));
    const controller = new AbortController();
    if (scenario === 'cancelled') setTimeout(() => controller.abort(), 10);
    const request = api.challengeSocket(path, 'a'.repeat(64), Date.now() + (scenario === 'timeout' ? 30 : 1000), controller.signal);
    if (scenario === 'valid') assert.deepEqual(await request, {}); else await assert.rejects(request, /oversized|deadline|cancelled|invalid frame/);
    assert.throws(() => api.challengeSocket(path, 'a'.repeat(64), Date.now() - 1), /deadline/);
  } finally { for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true }); }
});
test('daemon baseline failure stops deploy and rollback before backup, stage, build or restart', { skip: process.platform !== 'darwin' }, async () => {
  const root = mkdtempSync('/private/tmp/lcb-baseline-gate-');
  try {
    for (const name of ['production', 'candidate', 'backup/files']) { mkdirSync(join(root, name, 'dist'), { recursive: true }); writeFileSync(join(root, name, 'package.json'), 'same'); writeFileSync(join(root, name, 'dist/index.js'), 'same'); }
    const hashes = { 'package.json': sha('same'), 'dist/index.js': sha('same') };
    const baseline = JSON.stringify(hashes); writeFileSync(join(root, 'backup/baseline.json'), baseline);
    const deploy = await import(new URL('../../scripts/deploy-fix.mjs', import.meta.url).href), rollback = await import(new URL('../../scripts/rollback.mjs', import.meta.url).href);
    const ops = { verifyBaseline: async () => ({ ok: true, daemon_loaded_runtime: { ok: false } }), build: async () => assert.fail('build reached'), restart: async () => assert.fail('restart reached') };
    await assert.rejects(deploy.deploy({ production: join(root, 'production'), candidate: join(root, 'candidate'), backupRoot: join(root, 'new-backup'), changed: ['package.json'], baseline: hashes, payload: hashes }, ops), /Daemon loaded runtime proof/);
    assert.equal(existsSync(join(root, 'new-backup')), false);
    await assert.rejects(rollback.rollback({ production: join(root, 'production'), backup: join(root, 'backup'), backup_baseline_sha256: sha(baseline), expected_current: hashes, changed: ['package.json'] }, ops), /Daemon loaded runtime proof/);
  } finally { rmSync(root, { recursive: true }); }
});
test('real preloaded Bridge captures the exact merged runtime inventory in memory; disk edits cannot alter attestation; stdout stays MCP', { skip: process.platform !== 'darwin' }, async () => {
  const root = mkdtempSync('/private/tmp/lcb-daemon-'), directory = join(root, 'ipc');
  mkdirSync(directory, { mode: 0o700 });
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  cpSync(join(repository, 'dist/src'), join(root, 'dist/src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const hashes = Object.fromEntries(api.MODULES.map((name: string) => [name, sha(readFileSync(join(root, name)))]));
  const hook = fileURLToPath(new URL('../../scripts/daemon-attestation-hook.mjs', import.meta.url));
  const receipt = join(root, 'app-server-env.json'), codex = join(repository, 'test/daemon-app-server-fixture.mjs');
  const env: NodeJS.ProcessEnv = { ...process.env, LCB_DAEMON_ATTEST_DIR: directory, CODEX_EXE: codex, LOCAL_CODEX_BRIDGE_DAEMON_ENV_RECEIPT: receipt, PATH: join(realpathSync(process.execPath), '..') + ':' + process.env.PATH };
  delete env.NODE_OPTIONS; delete env.LCB_RUNTIME_PROOF_CONFIG;
  const child = spawn(process.execPath, ['--import', hook, join(root, 'dist/src/index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const closed = new Promise<void>(resolve => child.on('close', () => resolve()));
  try {
    const path = join(directory, `bridge-${child.pid}.sock`), deadline = Date.now() + 10000;
    while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(path), stderr);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolated-daemon', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codex_models', arguments: { limit: 1 } } }) + '\n');
    while (stdout.split('\n').filter(Boolean).length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(receipt), stderr);
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { node_options: false, daemon_directory: false, daemon_hook: false, proof_config: false });
    const identity = api.processIdentity(child.pid), local = { root, bridge: identity };
    const nonce = randomBytes(32).toString('hex'), first = await api.challengeSocket(path, nonce, deadline);
    api.validateResponse(first, nonce, local, hashes);
    assert.equal(first.initial_ppid, process.pid);
    const source = join(root, 'dist/src/app-server.js'); writeFileSync(source, 'DISK_CHANGED_AFTER_LOAD');
    const next = randomBytes(32).toString('hex'), second = await api.challengeSocket(path, next, deadline);
    api.validateResponse(second, next, local, hashes, first.instance_id);
    assert.equal(second.loaded_sha256['dist/src/app-server.js'], hashes['dist/src/app-server.js']);
    await assert.rejects(api.challengeSocket(path, nonce, deadline), /incomplete|invalid frame/);
    const rejected = await new Promise<number>(resolve => {
      const socket = createConnection(path); let bytes = 0;
      socket.on('connect', () => socket.end(JSON.stringify({ version: 1, nonce: randomBytes(32).toString('hex'), path: '/never-read-history-or-credential', command: 'never-execute' }) + '\n'));
      socket.on('data', data => { bytes += data.length; }); socket.on('close', () => resolve(bytes)); socket.on('error', () => {});
    }); assert.equal(rejected, 0);
    assert.equal(api.socketIdentity(directory, child.pid, process.getuid!()).path, path);
    assert.ok(spawnSync('/usr/sbin/lsof', ['-a', '-p', String(child.pid), '-U', '-Fn'], { encoding: 'utf8' }).stdout.split('\n').includes('n' + path));
    for (const line of stdout.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    const catalog = stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.id === 2);
    assert.equal(catalog.result.tools.length, 12);
    assert.equal(Object.keys(first.loaded_sha256).length, 19);
    assert.deepEqual(Object.keys(first.loaded_sha256).sort(), api.MODULES.slice().sort());
    assert.equal(stderr, '');
    // This probe is not launched by the exact Tunnel and must not pass native binding.
    await assert.rejects(api.verifyDaemon({ root, hashes, agent: `gui/${process.getuid!()}/com.openai.tunnel-client.lcb-remote`, node: realpathSync(process.execPath), hook, directory, hook_sha256: sha(readFileSync(hook)), capture_sha256: sha(readFileSync(new URL('../../scripts/runtime-load-proof.mjs', import.meta.url))) }), /Bridge child|hook|Tunnel|identity|socket|directory/);
    symlinkSync(path, join(directory, 'bridge-123.sock')); assert.throws(() => api.socketIdentity(directory, 123, process.getuid!()), /owner\/mode/);
    assert.throws(() => api.socketIdentity(directory, child.pid, process.getuid!() + 1), /owner/);
  } finally {
    child.stdin.end(); const kill = setTimeout(() => child.kill('SIGKILL'), 2000); await closed; clearTimeout(kill);
    assert.equal(existsSync(join(directory, `bridge-${child.pid}.sock`)), false);
    rmSync(root, { recursive: true });
  }
});

test('bootstrap generator freezes proposed wrapper/hooks without changing any target', { skip: process.platform !== 'darwin' }, async () => {
  const { bootstrapPlan } = await import(new URL('../../scripts/daemon-bootstrap-plan.mjs', import.meta.url).href);
  const root = mkdtempSync('/private/tmp/lcb-bootstrap-plan-'), wrapper = join(root, 'wrapper'); writeFileSync(wrapper, 'ORIGINAL');
  try {
    const plan = bootstrapPlan({ production: join(root, 'production'), wrapper, hookRoot: join(root, 'hooks'), directory: join(root, 'ipc'), node: realpathSync(process.execPath), codex: '/fixed/codex', backupRoot: join(root, 'backup'), agent: `gui/${process.getuid!()}/com.openai.tunnel-client.lcb-remote` });
    assert.equal(plan.host_modified, false); assert.equal(plan.baseline.wrapper_sha256, sha('ORIGINAL'));
    assert.equal(readFileSync(wrapper, 'utf8'), 'ORIGINAL'); assert.equal(existsSync(join(root, 'hooks')), false);
    const proposed = plan.targets.find((row: any) => row.target === wrapper);
    assert.equal(proposed.sha256, sha(proposed.proposed_bytes)); assert.match(proposed.proposed_bytes, /unset.*NODE_OPTIONS/); assert.match(proposed.proposed_bytes, /--import/);
    assert.match(plan.release_followup, /reseal a new candidate/);
  } finally { rmSync(root, { recursive: true }); }
});

test('native identity verifier binds real OS parent, child, explicit import and socket; launchctl is a labelled isolated fixture', { skip: process.platform !== 'darwin' }, async () => {
  const root = mkdtempSync('/private/tmp/lcb-os-bind-'), directory = join(root, 'ipc'), hookRoot = join(root, 'hooks');
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(hookRoot, { mode: 0o700 });
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  cpSync(join(repository, 'dist/src'), join(root, 'dist/src'), { recursive: true }); writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['daemon-attestation-hook.mjs', 'runtime-load-proof.mjs', 'daemon-attestation.mjs']) { cpSync(join(repository, 'scripts', name), join(hookRoot, name)); chmodSync(join(hookRoot, name), 0o500); }
  const hook = join(hookRoot, 'daemon-attestation-hook.mjs'), hashes = Object.fromEntries(api.MODULES.map((name: string) => [name, sha(readFileSync(join(root, name)))]));
  const env: NodeJS.ProcessEnv = { ...process.env, LCB_DAEMON_ATTEST_DIR: directory }; delete env.NODE_OPTIONS; delete env.LCB_RUNTIME_PROOF_CONFIG;
  const tunnel = spawn(process.execPath, [join(repository, 'test/daemon-tunnel-fixture.mjs'), hook, join(root, 'dist/src/index.js')], { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const closed = new Promise<void>(resolve => tunnel.on('close', () => resolve()));
  let stderr = ''; tunnel.stderr!.on('data', b => { stderr += b; });
  try {
    const pid = await new Promise<number>(resolve => tunnel.once('message', (message: any) => resolve(message.bridge_pid)));
    const path = join(directory, `bridge-${pid}.sock`), deadline = Date.now() + 15000;
    while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(existsSync(path), stderr);
    const config = { root, hashes, agent: `gui/${process.getuid!()}/com.openai.tunnel-client.lcb-remote`, node: realpathSync(process.execPath), hook, directory, hook_sha256: sha(readFileSync(hook)), capture_sha256: sha(readFileSync(join(hookRoot, 'runtime-load-proof.mjs'))), protocol_sha256: sha(readFileSync(join(hookRoot, 'daemon-attestation.mjs'))) };
    const readOS = (command: string, args: string[], end: number) => {
      if (command === '/bin/launchctl') { assert.deepEqual(args, ['print', config.agent]); return `state = running\npid = ${tunnel.pid}\n`; }
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: api.budget(end), maxBuffer: api.MAX_FRAME }); if (result.status !== 0) throw new Error('Daemon OS identity unavailable'); return result.stdout;
    };
    const native = (cfg: any, end: number) => api.nativeSnapshot(cfg, end, readOS);
    const result = await api.verifyDaemon(config, { snapshot: native, deadline });
    assert.equal(result.pid, pid); assert.equal(result.tunnel_pid, tunnel.pid); assert.equal(result.initial_ppid, tunnel.pid);
    assert.throws(() => native({ ...config, agent: 'gui/502/other' }, deadline), /exact LaunchAgent/);
    assert.throws(() => native({ ...config, node: '/wrong/node' }, deadline));
    assert.throws(() => api.nativeSnapshot(config, deadline, (command: string, args: string[], end: number) => command === '/bin/launchctl' ? `state = running\npid = ${process.pid}\n` : readOS(command, args, end)), /Bridge child|OS identity/);
    assert.throws(() => api.nativeSnapshot(config, deadline, (command: string, args: string[], end: number) => command === '/usr/sbin/lsof' ? '' : readOS(command, args, end)), /socket process ownership/);
    chmodSync(path, 0o666); assert.throws(() => native(config, deadline), /socket owner\/mode/); chmodSync(path, 0o600);
    assert.throws(() => native({ ...config, root: repository }, deadline), /Bridge child/);
    assert.throws(() => native({ ...config, hook_sha256: '0'.repeat(64) }, deadline), /hook mismatch/);
    chmodSync(hook, 0o600); assert.throws(() => native(config, deadline), /hook owner\/mode/); chmodSync(hook, 0o500);
  } finally {
    tunnel.stdin!.end(); const kill = setTimeout(() => tunnel.kill('SIGTERM'), 2000); await closed; clearTimeout(kill); rmSync(root, { recursive: true });
  }
});
