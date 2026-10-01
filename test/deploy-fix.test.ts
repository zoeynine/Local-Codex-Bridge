import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, cpSync, symlinkSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
const deployURL = new URL('../../scripts/deploy-fix.mjs', import.meta.url);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
for (const scenario of ['success', 'baseline mismatch', 'payload mismatch', 'restart denied', 'restart nonzero', 'restart timeout', 'rollback restart timeout', 'rollback missing load proof', 'rollback health fails', 'unhealthy', 'build fails', 'fresh build', 'remote fails', 'swap fails']) {
  test(`deployment ${scenario} preserves baseline or rolls back`, async () => {
    assert.ok(existsSync(deployURL), 'Safe deployment implementation must exist');
    const { deploy } = await import(deployURL.href);
    const root = mkdtempSync(join(tmpdir(), 'lcb-deploy-test-'));
    try {
      const production = join(root, 'production');
      const candidate = join(root, 'candidate');
      for (const path of [production, candidate]) {
        mkdirSync(join(path, 'dist'), { recursive: true });
        writeFileSync(join(path, 'package.json'), path === production ? 'old' : 'new');
        writeFileSync(join(path, 'dist/index.js'), path === production ? 'old-runtime' : 'new-runtime');
      }
      const config = {
        production, candidate, backupRoot: join(root, 'backups'),
        baseline: { 'package.json': hash('old'), 'dist/index.js': hash('old-runtime') },
        payload: { 'package.json': hash('new'), 'dist/index.js': hash('new-runtime') },
        changed: ['package.json'],
      };
      const events: string[] = [];
      const built = join(root, 'built');
      mkdirSync(built);
      writeFileSync(join(built, 'index.js'), 'fresh-runtime');
      if (scenario === 'baseline mismatch') writeFileSync(join(production, 'package.json'), 'user-change');
      if (scenario === 'payload mismatch') writeFileSync(join(candidate, 'package.json'), 'tampered');
      const ops = {
        verifyBaseline: async () => ({ ok: true, daemon_loaded_runtime: { ok: true } }),
        build: async () => { events.push('build'); if (scenario === 'build fails') throw new Error('build fails'); if (scenario === 'fresh build') return { runtimePath: built }; },
        swap: (a: string, b: string) => { events.push('swap'); if (scenario === 'swap fails') throw new Error('swap fails'); const temp = a + '.test-swap'; renameSync(a, temp); renameSync(b, a); renameSync(temp, b); },
        restart: async () => {
          events.push('restart');
          const attempt = events.filter(e => e === 'restart').length;
          if (['restart denied', 'restart nonzero', 'restart timeout'].includes(scenario) && attempt === 1) throw new Error(scenario);
          if (scenario === 'rollback restart timeout') throw new Error(scenario);
        },
        verify: async (phase?: string) => {
          events.push('verify');
          if (scenario === 'unhealthy' && phase !== 'rollback') throw new Error('unhealthy');
          if (['rollback missing load proof', 'rollback health fails'].includes(scenario) && phase !== 'rollback') throw new Error(scenario);
          if (scenario === 'rollback health fails' && phase === 'rollback') throw new Error('rollback health fails');
          if (scenario === 'remote fails' && phase !== 'rollback') throw new Error('remote fails');
          if (scenario === 'rollback missing load proof' && phase === 'rollback') return { ok: true };
          return { ok: true, daemon_loaded_runtime: { ok: true, pid: 123, loaded_sha256: hash('old-runtime') } };
        },
      };
      if (scenario === 'success' || scenario === 'fresh build') {
        const result = await deploy(config, ops);
        assert.equal(result.deployed, true);
        assert.equal(readFileSync(join(production, 'package.json'), 'utf8'), 'new');
        assert.equal(readFileSync(join(production, 'dist/index.js'), 'utf8'), scenario === 'fresh build' ? 'fresh-runtime' : 'new-runtime');
        assert.equal(readFileSync(join(result.backup, 'files/package.json'), 'utf8'), 'old');
        assert.equal(readFileSync(join(result.backup, 'files/dist/index.js'), 'utf8'), 'old-runtime');
      } else {
        await assert.rejects(deploy(config, ops), new RegExp(scenario === 'unhealthy' ? 'unhealthy' : scenario));
        assert.equal(readFileSync(join(production, 'package.json'), 'utf8'), scenario === 'baseline mismatch' ? 'user-change' : 'old');
        assert.equal(readFileSync(join(production, 'dist/index.js'), 'utf8'), 'old-runtime');
        if (scenario.includes('mismatch')) assert.deepEqual(events, []);
        if (scenario.startsWith('restart ') || scenario.startsWith('rollback ')) assert.equal(events.filter(e => e === 'restart').length, 2);
        if (scenario === 'unhealthy') assert.equal(events.filter(e => e === 'restart').length, 2);
        if (scenario.startsWith('rollback ')) {
          const receipt = JSON.parse(readFileSync(join(config.backupRoot, (await import('node:fs')).readdirSync(config.backupRoot)[0]!, 'result.json'), 'utf8'));
          assert.equal(receipt.manual_recovery_required, true);
          assert.equal(receipt.rolled_back, false);
        }
      }
    } finally { rmSync(root, { recursive: true }); }
  });
}

for (const changed of ['../outside.txt', '/private/tmp/outside.txt', 'src/../package.json', './package.json', 'package.json/child', 'src//tools.ts', 'scripts/not-allowed.mjs', 'C:\\outside.txt']) {
  test(`changed path ${JSON.stringify(changed)} is rejected before backup/build/write`, async () => {
    const { deploy } = await import(deployURL.href);
    const root = mkdtempSync(join(tmpdir(), 'lcb-path-boundary-'));
    try {
      const production = join(root, 'production'), candidate = join(root, 'candidate');
      for (const dir of [production, candidate]) { mkdirSync(join(dir, 'dist'), { recursive: true }); writeFileSync(join(dir, 'package.json'), 'same'); writeFileSync(join(dir, 'dist/index.js'), 'same'); }
      const events: string[] = [];
      const config = { production, candidate, backupRoot: join(root, 'backups'), baseline: { 'package.json': hash('same'), 'dist/index.js': hash('same') }, payload: { 'package.json': hash('same'), 'dist/index.js': hash('same') }, changed: [changed] };
      await assert.rejects(deploy(config, { build: async () => { events.push('build'); throw new Error('build reached'); } }), /changed path|Unsafe manifest path/);
      assert.deepEqual(events, []);
      assert.equal(existsSync(config.backupRoot), false);
    } finally { rmSync(root, { recursive: true }); }
  });
}

test('whitelisted changed path cannot traverse a symlink parent', async () => {
  const { deploy } = await import(deployURL.href);
  const root = mkdtempSync(join(tmpdir(), 'lcb-parent-boundary-'));
  try {
    const production = join(root, 'production'), candidate = join(root, 'candidate'), outside = join(root, 'outside');
    for (const dir of [production, candidate, outside]) mkdirSync(dir);
    writeFileSync(join(outside, 'tools.ts'), 'old');
    symlinkSync(outside, join(production, 'src'));
    mkdirSync(join(candidate, 'src')); writeFileSync(join(candidate, 'src/tools.ts'), 'new');
    const config = { production, candidate, backupRoot: join(root, 'backups'), baseline: { 'src/tools.ts': hash('old') }, payload: { 'src/tools.ts': hash('new') }, changed: ['src/tools.ts'] };
    await assert.rejects(deploy(config, {}), /symlink|Symlink/);
    assert.equal(readFileSync(join(outside, 'tools.ts'), 'utf8'), 'old');
    assert.equal(existsSync(config.backupRoot), false);
  } finally { rmSync(root, { recursive: true }); }
});

test('targeted restart uses only the frozen LaunchAgent label and kickstart', async () => {
  const { targetedRestart } = await import(deployURL.href);
  const calls: unknown[] = [];
  targetedRestart('gui/123/com.openai.tunnel-client.lcb-remote', (...args: unknown[]) => calls.push(args));
  assert.deepEqual(calls, [['/bin/launchctl', ['kickstart', '-k', 'gui/123/com.openai.tunnel-client.lcb-remote']]]);
  for (const wrong of ['system/com.openai.tunnel-client.lcb-remote', 'gui/123/com.other', 'gui/123/com.openai.tunnel-client.lcb-remote;killall']) assert.throws(() => targetedRestart(wrong, () => assert.fail('must not execute')), /Unexpected/);
});

test('external trust verifier cannot be an alias to a package-owned file', async () => {
  const { externalTrustPath } = await import(deployURL.href);
  const root = mkdtempSync(join(tmpdir(), 'lcb-trust-alias-'));
  try {
    const pkg = join(root, 'package'); mkdirSync(pkg);
    writeFileSync(join(pkg, 'verify.mjs'), '// untrusted package-owned verifier');
    const alias = join(root, 'external-looking.mjs'); symlinkSync(join(pkg, 'verify.mjs'), alias);
    assert.throws(() => externalTrustPath(pkg, alias), /physically outside/);
    const trusted = join(root, 'trusted.mjs'); writeFileSync(trusted, '// external anchor');
    assert.equal(externalTrustPath(pkg, trusted), (await import('node:fs')).realpathSync(trusted));
  } finally { rmSync(root, { recursive: true }); }
});

for (const scenario of ['success', 'drift', 'missing load proof', 'backup baseline tampered', 'backup payload tampered']) {
  test(`explicit rollback ${scenario} remains frozen and proves old loaded runtime`, async () => {
    const { rollback } = await import(new URL('../../scripts/rollback.mjs', import.meta.url).href);
    const root = mkdtempSync(join(tmpdir(), 'lcb-explicit-rollback-'));
    try {
      const production = join(root, 'production'), backup = join(root, 'backup');
      mkdirSync(join(production, 'dist'), { recursive: true });
      mkdirSync(join(backup, 'files/dist'), { recursive: true });
      writeFileSync(join(production, 'package.json'), scenario === 'drift' ? 'user-change' : 'new');
      writeFileSync(join(production, 'dist/index.js'), 'new-runtime');
      writeFileSync(join(backup, 'files/package.json'), 'old');
      writeFileSync(join(backup, 'files/dist/index.js'), 'old-runtime');
      writeFileSync(join(backup, 'baseline.json'), JSON.stringify({ 'package.json': hash('old'), 'dist/index.js': hash('old-runtime') }));
      const frozenBaseline = hash(readFileSync(join(backup, 'baseline.json'), 'utf8'));
      if (scenario.startsWith('backup ')) writeFileSync(join(backup, 'files/package.json'), 'evil');
      if (scenario === 'backup baseline tampered') writeFileSync(join(backup, 'baseline.json'), JSON.stringify({ 'package.json': hash('evil'), 'dist/index.js': hash('old-runtime') }));
      let restarts = 0;
      const config = { production, backup, backup_baseline_sha256: frozenBaseline, changed: ['package.json'], expected_current: { 'package.json': hash('new'), 'dist/index.js': hash('new-runtime') } };
      const ops = { verifyBaseline: async () => ({ ok: true, daemon_loaded_runtime: { ok: true } }), swap: (a: string, b: string) => { const tmp = a + '.swap'; renameSync(a, tmp); renameSync(b, a); renameSync(tmp, b); }, restart: async () => { restarts++; }, verify: async () => scenario === 'missing load proof' ? { ok: true } : { ok: true, daemon_loaded_runtime: { ok: true } } };
      if (scenario === 'success') { assert.equal((await rollback(config, ops)).rolled_back, true); assert.equal(restarts, 1); }
      else {
        const error = scenario === 'drift' ? /current rollback baseline mismatch/ : scenario === 'backup baseline tampered' ? /Frozen backup baseline digest mismatch/ : scenario === 'backup payload tampered' ? /backup mismatch/ : /MANUAL_RECOVERY_REQUIRED/;
        await assert.rejects(rollback(config, ops), error);
        if (scenario === 'drift' || scenario.startsWith('backup ')) assert.equal(restarts, 0);
      }
      assert.equal(readFileSync(join(production, 'package.json'), 'utf8'), scenario === 'drift' ? 'user-change' : scenario.startsWith('backup ') ? 'new' : 'old');
    } finally { rmSync(root, { recursive: true }); }
  });
}

for (const mutation of ['package-manifest.json', 'manifest.json', 'deploy.sh', 'scripts/deploy-fix.mjs', 'scripts/rollback.mjs', 'rehash payload and manifests']) {
  test(`trusted deploy and rollback entry rejects ${mutation} tampering`, async () => {
    const { trustedRunnerSource } = await import(new URL('../../scripts/release-trust.mjs', import.meta.url).href);
    const root = mkdtempSync('/private/tmp/lcb-seal-test-');
    const trustRoot = mkdtempSync('/private/tmp/lcb-trust-test-');
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'src/tools.ts'), '// synthetic source\n');
      writeFileSync(join(root, 'deploy.sh'), '#!/bin/bash\nexit 0\n');
      writeFileSync(join(root, 'scripts/deploy-fix.mjs'), "console.log('sealed-deploy-stub');\n");
      writeFileSync(join(root, 'scripts/rollback.mjs'), "console.log('sealed-rollback-stub');\n");
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({ payload: { 'src/tools.ts': hash('// synthetic source\n') } }));
      const files = Object.fromEntries(['src/tools.ts', 'deploy.sh', 'manifest.json', 'scripts/deploy-fix.mjs', 'scripts/rollback.mjs'].map(name => [name, hash(readFileSync(join(root, name), 'utf8'))]));
      writeFileSync(join(root, 'package-manifest.json'), JSON.stringify({ files, links: {} }));
      const frozen = hash(readFileSync(join(root, 'package-manifest.json'), 'utf8'));
      const verifier = readFileSync(new URL('../../scripts/verify-package.mjs', import.meta.url), 'utf8');
      const anchor = join(trustRoot, 'verify.mjs');
      writeFileSync(anchor, trustedRunnerSource(verifier, frozen));
      const check = (action = '--check') => spawnSync(process.execPath, [anchor, root, action, 'synthetic-contract'], { encoding: 'utf8', timeout: 15000 });
      assert.equal(check().status, 0, 'Untampered package must pass the trusted deploy entry');
      assert.equal(check('--rollback').status, 0, 'Untampered package must pass the trusted rollback entry');
      if (mutation === 'rehash payload and manifests') {
        appendFileSync(join(root, 'src/tools.ts'), '\n// mirror tampering\n');
        const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
        const packageManifest = JSON.parse(readFileSync(join(root, 'package-manifest.json'), 'utf8'));
        manifest.payload['src/tools.ts'] = hash(readFileSync(join(root, 'src/tools.ts'), 'utf8'));
        writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
        packageManifest.files['src/tools.ts'] = manifest.payload['src/tools.ts'];
        packageManifest.files['manifest.json'] = hash(readFileSync(join(root, 'manifest.json'), 'utf8'));
        writeFileSync(join(root, 'package-manifest.json'), JSON.stringify(packageManifest));
      } else if (mutation === 'deploy.sh') writeFileSync(join(root, mutation), '#!/bin/bash\necho malicious-success\nexit 0\n');
      else appendFileSync(join(root, mutation), '\n');
      for (const action of ['--check', '--rollback']) {
        const rejected = check(action);
        assert.notEqual(rejected.status, 0, 'All sealed bytes must be anchored before any entry executes');
        assert.ok(!rejected.stdout.includes('stub') && !rejected.stdout.includes('malicious-success'));
      }
    } finally { rmSync(root, { recursive: true }); rmSync(trustRoot, { recursive: true }); }
  });
}

test('actual Node module load proves old runtime bytes and rejects replacement bytes', async () => {
  const proofURL = new URL('../../scripts/runtime-load-proof.mjs', import.meta.url);
  assert.ok(existsSync(proofURL), 'Rollback acceptance must attest actual loaded module bytes');
  const { createRuntimeProof, readRuntimeProof } = await import(proofURL.href);
  const root = mkdtempSync('/private/tmp/lcb-load-proof-');
  try {
    mkdirSync(join(root, 'dist/src'), { recursive: true });
    writeFileSync(join(root, 'dist/src/index.js'), "import './app-server.js'; console.log('ready');\n");
    writeFileSync(join(root, 'dist/src/app-server.js'), 'export const oldRuntime = true;\n');
    const baseline = Object.fromEntries(['dist/src/index.js', 'dist/src/app-server.js'].map(name => [name, hash(readFileSync(join(root, name), 'utf8'))]));
    const proof = createRuntimeProof(root, baseline, root);
    const run = () => spawnSync(process.execPath, ['--import', proofURL.pathname, join(root, 'dist/src/index.js')], { encoding: 'utf8', env: { ...process.env, LCB_RUNTIME_PROOF_CONFIG: proof.config }, timeout: 10000 });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(readFileSync(proof.receipt, 'utf8'));
    assert.equal(readRuntimeProof(proof, receipt.pid).ok, true);
    assert.throws(() => readRuntimeProof(proof, receipt.pid + 1), /runtime proof/);
    writeFileSync(join(root, 'dist/src/index.js'), "console.log('different version');\n");
    assert.notEqual(run().status, 0);
    assert.throws(() => readRuntimeProof(proof, receipt.pid), /runtime proof/);
  } finally { rmSync(root, { recursive: true }); }
});

test('control-plane 35-second timeout can recover after the former 45-second window', async () => {
  const { verifyWithRetries } = await import(deployURL.href);
  let clock = 0, calls = 0;
  const attempts: any[] = [];
  const result = await verifyWithRetries('deployed', {
    now: () => clock, sleep: async (ms: number) => { clock += ms; }, onAttempt: (row: any) => attempts.push(row),
    verify: async () => {
      calls++;
      if (calls === 1) { clock += 35000; return { ok: false, healthz: { ok: true, status: 200 }, readyz: { ok: true, status: 200 }, control_plane: { ok: false, error: 'Control plane deadline' } }; }
      clock += 10000;
      return { ok: true, healthz: { ok: true, status: 200 }, readyz: { ok: true, status: 200 }, control_plane: { ok: true, pid: 12 }, wrapper: { ok: true, probe_loaded_runtime: { ok: true } }, candidate_history: { ok: true } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(clock, 50000);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].control_plane.error_classification, 'deadline');
  assert.equal(attempts[0].wrapper.state, 'not_run');
  assert.equal(attempts[1].history.state, 'passed');
});

for (const scenario of ['persistent timeouts', 'sensitive failure', 'probe is not daemon']) {
  test(`failure receipt retains bounded redacted diagnostics: ${scenario}`, async () => {
    const { deploy, verifyWithRetries } = await import(deployURL.href);
    const root = mkdtempSync(join(tmpdir(), 'lcb-diagnostic-test-'));
    try {
      const production = join(root, 'production'), candidate = join(root, 'candidate');
      for (const path of [production, candidate]) { mkdirSync(join(path, 'dist'), { recursive: true }); writeFileSync(join(path, 'package.json'), path === production ? 'old' : 'new'); writeFileSync(join(path, 'dist/index.js'), path === production ? 'old-runtime' : 'new-runtime'); }
      const config = { production, candidate, backupRoot: join(root, 'backups'), changed: ['package.json'], baseline: { 'package.json': hash('old'), 'dist/index.js': hash('old-runtime') }, payload: { 'package.json': hash('new'), 'dist/index.js': hash('new-runtime') } };
      let restarts = 0, deployedClock = 0;
      const secret = 'SENSITIVE_HISTORY_PROTOCOL_CREDENTIAL_BODY_SENTINEL';
      const ops = {
        verifyBaseline: async () => ({ ok: true, daemon_loaded_runtime: { ok: true } }),
        build: async () => {}, restart: async () => { restarts++; },
        swap: (a: string, b: string) => { const tmp = a + '.swap'; renameSync(a, tmp); renameSync(b, a); renameSync(tmp, b); },
        verify: async (phase: string, onAttempt: any) => {
          if (phase === 'rollback') {
            const result = { ok: true, daemon_loaded_runtime: scenario === 'probe is not daemon' ? { ok: false } : { ok: true }, wrapper: { ok: true, probe_loaded_runtime: { ok: true, secret } }, control_plane: { ok: true, pid: 12 } };
            return verifyWithRetries(phase, { onAttempt, verify: async () => result });
          }
          if (scenario === 'probe is not daemon') return verifyWithRetries(phase, { onAttempt, verify: async () => ({ ok: true, wrapper: { ok: true, probe_loaded_runtime: { ok: true } }, loaded_instance: { ok: true }, daemon_loaded_runtime: { ok: false } }) });
          return verifyWithRetries(phase, {
            onAttempt, now: () => deployedClock, sleep: async (ms: number) => { deployedClock += ms; },
            verify: async ({ deadline }: { deadline: number }) => {
              deployedClock = Math.min(deployedClock + 35000, deadline);
              return { ok: false, healthz: { ok: true, status: 200 }, readyz: { ok: true, status: 200 }, control_plane: { ok: false, error: 'Control plane deadline: ' + secret, response: secret }, wrapper: { ok: false, error: secret, protocol: secret }, candidate_history: { ok: false, error: secret, history: { messages: [secret] } }, error: secret, credentials: secret };
            },
          });
        },
      };
      await assert.rejects(deploy(config, ops), scenario === 'probe is not daemon' ? /MANUAL_RECOVERY_REQUIRED/ : /rollback completed/);
      assert.equal(restarts, 2);
      assert.equal(readFileSync(join(production, 'package.json'), 'utf8'), 'old');
      assert.equal(readFileSync(join(production, 'dist/index.js'), 'utf8'), 'old-runtime');
      const backup = join(config.backupRoot, readdirSync(config.backupRoot)[0]!);
      const raw = readFileSync(join(backup, 'result.json'), 'utf8');
      const diagnosticRaw = readFileSync(join(backup, 'verification-attempts.json'), 'utf8');
      for (const text of [raw, diagnosticRaw]) { assert.ok(!text.includes(secret)); assert.ok(!text.includes('messages')); assert.ok(!text.includes('credentials')); assert.ok(!text.includes('loaded_instance')); }
      const receipt = JSON.parse(raw), attempts = receipt.verification_attempts;
      assert.deepEqual(JSON.parse(diagnosticRaw), attempts);
      assert.equal(receipt.rolled_back, scenario !== 'probe is not daemon');
      assert.equal(receipt.manual_recovery_required, scenario === 'probe is not daemon');
      if (scenario !== 'probe is not daemon') {
        assert.equal(deployedClock, 90000);
        assert.equal(attempts.filter((a: any) => a.phase === 'deployed').length, 3);
        assert.equal(attempts[0].control_plane.error_classification, 'deadline');
        assert.equal(attempts[0].wrapper.state, 'failed');
        assert.equal(attempts[0].history.state, 'failed');
        assert.equal(attempts[2].elapsed_ms, 90000);
      } else assert.equal(attempts[0].probe_loaded_runtime.state, 'passed');
      assert.equal(attempts.at(-1).phase, 'rollback');
      assert.ok(attempts.length <= 36);
    } finally { rmSync(root, { recursive: true }); }
  });
}

test('retry attempt count is bounded even for immediately failing gates', async () => {
  const { verifyWithRetries, verificationPolicy } = await import(deployURL.href);
  let clock = 0, attempts = 0;
  await assert.rejects(verifyWithRetries('deployed', { now: () => clock, sleep: async (ms: number) => { clock += ms; }, verify: async () => ({ ok: false }), onAttempt: () => { attempts++; } }), /deadline/);
  assert.equal(attempts, verificationPolicy.max_attempts);
  assert.equal(clock, 85000);
});

test('unavailable daemon attestation blocks the production entry before mutation', async () => {
  const { deploymentRuntimeReadiness, requireDeploymentRuntimeReadiness, requireDaemonRuntime } = await import(deployURL.href);
  assert.deepEqual(deploymentRuntimeReadiness(), { deployment_ready: false, blocker: 'daemon_bootstrap_required' });
  assert.throws(() => requireDeploymentRuntimeReadiness(), /daemon_bootstrap_required; production mutation not started/);
  assert.throws(() => requireDaemonRuntime({ ok: true, loaded_instance: { ok: true }, wrapper: { probe_loaded_runtime: { ok: true } } }), /Daemon loaded runtime proof missing/);
  assert.throws(() => requireDaemonRuntime({ ok: false, daemon_loaded_runtime: { ok: true } }), /health verification failed/);
});

test('a gate reporting success at the exact deadline is rejected', async () => {
  const { verifyWithRetries } = await import(deployURL.href);
  let clock = 0;
  await assert.rejects(verifyWithRetries('deployed', { now: () => clock, verify: async () => { clock = 90000; return { ok: true }; } }), /deadline/);
});

test('live verification projects control-plane output and skips probes while unready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lcb-live-diagnostic-'));
  const server = createServer((request, response) => { response.writeHead(request.url === '/healthz' ? 503 : 200); response.end('SENSITIVE_HEALTH_BODY'); });
  const names = ['LCB_HEALTH_URL_FILE', 'CODEX_EXE', 'LCB_TUNNEL_CLIENT', 'LCB_PID_FILE', 'LCB_STDIO_WRAPPER'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const health = join(root, 'health-url'), tunnel = join(root, 'fake-tunnel.mjs');
    writeFileSync(health, `http://127.0.0.1:${address.port}`);
    writeFileSync(tunnel, `#!${process.execPath}\nconsole.log(JSON.stringify({ process:{pid:123}, control_plane_poll:{ok:false,value:'SENSITIVE_POLL_BODY'}, credentials:'SENSITIVE_CREDENTIAL_BODY' })); process.exitCode=1;\n`, { mode: 0o700 });
    Object.assign(process.env, { LCB_HEALTH_URL_FILE: health, CODEX_EXE: '/synthetic/unused-codex', LCB_TUNNEL_CLIENT: tunnel, LCB_PID_FILE: join(root, 'unused-pid'), LCB_STDIO_WRAPPER: '/synthetic/must-not-spawn' });
    const { verifyLive } = await import(new URL('../../scripts/verify-fix-live.mjs?diagnostic-fixture', import.meta.url).href);
    const result = await verifyLive({ wrapper: true, history: true, deadline: Date.now() + 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.healthz.status, 503);
    assert.equal(result.readyz.status, 200);
    assert.equal(result.control_plane.pid, 123);
    assert.equal(result.control_plane.error, 'Control plane unready');
    assert.equal(result.wrapper, undefined);
    assert.equal(result.candidate_history, undefined);
    assert.ok(!JSON.stringify(result).includes('SENSITIVE_'));
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
});
