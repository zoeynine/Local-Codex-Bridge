import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, cpSync, symlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const deployURL = new URL('../../scripts/deploy-fix.mjs', import.meta.url);
const hash = (text) => createHash('sha256').update(text).digest('hex');
for (const scenario of ['success', 'baseline mismatch', 'payload mismatch', 'restart denied', 'restart nonzero', 'restart timeout', 'rollback restart timeout', 'rollback missing load proof', 'rollback health fails', 'unhealthy', 'build fails', 'fresh build', 'remote fails']) {
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
            const events = [];
            const built = join(root, 'built');
            mkdirSync(built);
            writeFileSync(join(built, 'index.js'), 'fresh-runtime');
            if (scenario === 'baseline mismatch')
                writeFileSync(join(production, 'package.json'), 'user-change');
            if (scenario === 'payload mismatch')
                writeFileSync(join(candidate, 'package.json'), 'tampered');
            const ops = {
                build: async () => { events.push('build'); if (scenario === 'build fails')
                    throw new Error('build fails'); if (scenario === 'fresh build')
                    return { runtimePath: built }; },
                swap: (a, b) => { events.push('swap'); const temp = a + '.test-swap'; renameSync(a, temp); renameSync(b, a); renameSync(temp, b); },
                restart: async () => {
                    events.push('restart');
                    const attempt = events.filter(e => e === 'restart').length;
                    if (['restart denied', 'restart nonzero', 'restart timeout'].includes(scenario) && attempt === 1)
                        throw new Error(scenario);
                    if (scenario === 'rollback restart timeout')
                        throw new Error(scenario);
                },
                verify: async (phase) => {
                    events.push('verify');
                    if (scenario === 'unhealthy' && phase !== 'rollback')
                        throw new Error('unhealthy');
                    if (['rollback missing load proof', 'rollback health fails'].includes(scenario) && phase !== 'rollback')
                        throw new Error(scenario);
                    if (scenario === 'rollback health fails' && phase === 'rollback')
                        throw new Error('rollback health fails');
                    if (scenario === 'remote fails' && phase !== 'rollback')
                        throw new Error('remote fails');
                    if (scenario === 'rollback missing load proof' && phase === 'rollback')
                        return { ok: true };
                    return { ok: true, loaded_instance: { ok: true, pid: 123, loaded_sha256: hash('old-runtime') } };
                },
            };
            if (scenario === 'success' || scenario === 'fresh build') {
                const result = await deploy(config, ops);
                assert.equal(result.deployed, true);
                assert.equal(readFileSync(join(production, 'package.json'), 'utf8'), 'new');
                assert.equal(readFileSync(join(production, 'dist/index.js'), 'utf8'), scenario === 'fresh build' ? 'fresh-runtime' : 'new-runtime');
                assert.equal(readFileSync(join(result.backup, 'files/package.json'), 'utf8'), 'old');
                assert.equal(readFileSync(join(result.backup, 'files/dist/index.js'), 'utf8'), 'old-runtime');
            }
            else {
                await assert.rejects(deploy(config, ops), new RegExp(scenario === 'unhealthy' ? 'unhealthy' : scenario));
                assert.equal(readFileSync(join(production, 'package.json'), 'utf8'), scenario === 'baseline mismatch' ? 'user-change' : 'old');
                assert.equal(readFileSync(join(production, 'dist/index.js'), 'utf8'), 'old-runtime');
                if (scenario.includes('mismatch'))
                    assert.deepEqual(events, []);
                if (scenario.startsWith('restart ') || scenario.startsWith('rollback '))
                    assert.equal(events.filter(e => e === 'restart').length, 2);
                if (scenario === 'unhealthy')
                    assert.equal(events.filter(e => e === 'restart').length, 2);
                if (scenario.startsWith('rollback ')) {
                    const receipt = JSON.parse(readFileSync(join(config.backupRoot, (await import('node:fs')).readdirSync(config.backupRoot)[0], 'result.json'), 'utf8'));
                    assert.equal(receipt.manual_recovery_required, true);
                    assert.equal(receipt.rolled_back, false);
                }
            }
        }
        finally {
            rmSync(root, { recursive: true });
        }
    });
}
for (const changed of ['../outside.txt', '/private/tmp/outside.txt', 'src/../package.json', './package.json', 'package.json/child', 'src//tools.ts', 'scripts/not-allowed.mjs', 'C:\\outside.txt']) {
    test(`changed path ${JSON.stringify(changed)} is rejected before backup/build/write`, async () => {
        const { deploy } = await import(deployURL.href);
        const root = mkdtempSync(join(tmpdir(), 'lcb-path-boundary-'));
        try {
            const production = join(root, 'production'), candidate = join(root, 'candidate');
            for (const dir of [production, candidate]) {
                mkdirSync(join(dir, 'dist'), { recursive: true });
                writeFileSync(join(dir, 'package.json'), 'same');
                writeFileSync(join(dir, 'dist/index.js'), 'same');
            }
            const events = [];
            const config = { production, candidate, backupRoot: join(root, 'backups'), baseline: { 'package.json': hash('same'), 'dist/index.js': hash('same') }, payload: { 'package.json': hash('same'), 'dist/index.js': hash('same') }, changed: [changed] };
            await assert.rejects(deploy(config, { build: async () => { events.push('build'); throw new Error('build reached'); } }), /changed path|Unsafe manifest path/);
            assert.deepEqual(events, []);
            assert.equal(existsSync(config.backupRoot), false);
        }
        finally {
            rmSync(root, { recursive: true });
        }
    });
}
test('whitelisted changed path cannot traverse a symlink parent', async () => {
    const { deploy } = await import(deployURL.href);
    const root = mkdtempSync(join(tmpdir(), 'lcb-parent-boundary-'));
    try {
        const production = join(root, 'production'), candidate = join(root, 'candidate'), outside = join(root, 'outside');
        for (const dir of [production, candidate, outside])
            mkdirSync(dir);
        writeFileSync(join(outside, 'tools.ts'), 'old');
        symlinkSync(outside, join(production, 'src'));
        mkdirSync(join(candidate, 'src'));
        writeFileSync(join(candidate, 'src/tools.ts'), 'new');
        const config = { production, candidate, backupRoot: join(root, 'backups'), baseline: { 'src/tools.ts': hash('old') }, payload: { 'src/tools.ts': hash('new') }, changed: ['src/tools.ts'] };
        await assert.rejects(deploy(config, {}), /symlink|Symlink/);
        assert.equal(readFileSync(join(outside, 'tools.ts'), 'utf8'), 'old');
        assert.equal(existsSync(config.backupRoot), false);
    }
    finally {
        rmSync(root, { recursive: true });
    }
});
for (const mutation of ['package-manifest.json', 'manifest.json', 'deploy.sh', 'rehash payload and manifests']) {
    test(`formal --check rejects ${mutation} tampering`, () => {
        const packageRoot = '/Users/ZGH/Documents/Codex/2026-09-17/yt/lcb-incident-20260928/deploy-package';
        const root = mkdtempSync('/private/tmp/lcb-seal-test-');
        try {
            cpSync(packageRoot, root, { recursive: true, verbatimSymlinks: true });
            const check = () => spawnSync('/bin/bash', [join(root, 'deploy.sh'), '--check'], { encoding: 'utf8', timeout: 15000 });
            assert.equal(check().status, 0, 'Untampered package must pass the same formal entry');
            if (mutation === 'rehash payload and manifests') {
                appendFileSync(join(root, 'src/tools.ts'), '\n// mirror tampering\n');
                const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
                const packageManifest = JSON.parse(readFileSync(join(root, 'package-manifest.json'), 'utf8'));
                manifest.payload['src/tools.ts'] = hash(readFileSync(join(root, 'src/tools.ts'), 'utf8'));
                writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
                packageManifest.files['src/tools.ts'] = manifest.payload['src/tools.ts'];
                packageManifest.files['manifest.json'] = hash(readFileSync(join(root, 'manifest.json'), 'utf8'));
                writeFileSync(join(root, 'package-manifest.json'), JSON.stringify(packageManifest));
            }
            else
                appendFileSync(join(root, mutation), '\n');
            const rejected = check();
            assert.notEqual(rejected.status, 0, 'Every sealed package byte must be anchored, not self-rehashable');
        }
        finally {
            rmSync(root, { recursive: true });
        }
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
        const first = run();
        assert.equal(first.status, 0, first.stderr);
        const receipt = JSON.parse(readFileSync(proof.receipt, 'utf8'));
        assert.equal(readRuntimeProof(proof, receipt.pid).ok, true);
        assert.throws(() => readRuntimeProof(proof, receipt.pid + 1), /instance proof/);
        writeFileSync(join(root, 'dist/src/index.js'), "console.log('different version');\n");
        assert.notEqual(run().status, 0);
        assert.throws(() => readRuntimeProof(proof, receipt.pid), /instance proof/);
    }
    finally {
        rmSync(root, { recursive: true });
    }
});
