import { spawnSync } from 'node:child_process';
import { writeFileSync, cpSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Validation requires Node.js 24+');
const root = fileURLToPath(new URL('../', import.meta.url));
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(output, { recursive: true });
let testRoot = root;
if (process.argv.includes('--isolated')) {
  testRoot = mkdtempSync(tmpdir() + '/lcb-validation-');
  cpSync(root, testRoot, { recursive: true });
  // The Documents file provider adds FinderInfo to copied app bundles; it is not source code.
  spawnSync('/usr/bin/xattr', ['-d', 'com.apple.FinderInfo', testRoot + '/Start Mac Codex Bridge.app']);
}
const red = process.argv.includes('--red');
const deployRed = process.argv.includes('--red-deploy');
const commands = deployRed ? [['npm', ['run', 'build']], [process.execPath, ['--test', '--test-reporter=tap', 'dist/test/deploy-fix.test.js']]] : red ? [['npm', ['run', 'build']], [process.execPath, ['--test', '--test-reporter=tap', 'dist/test/overflow.test.js']]] : [
  ['npm', ['run', 'typecheck']], ['npm', ['test']], [process.execPath, ['--test', '--test-reporter=tap', 'dist/test/overflow.test.js']], [process.execPath, ['--test', '--test-reporter=tap', 'dist/test/deploy-fix.test.js', 'dist/test/remote-probe.test.js']],
];
const results = commands.map(([command, args], index) => {
  const result = spawnSync(command, args, { cwd: testRoot, env: { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH }, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const path = output + `/${deployRed ? 'deploy-red' : red ? 'red' : 'green'}-${index}.log`;
  writeFileSync(path, result.stdout + result.stderr, { mode: 0o600 });
  return { command, args, cwd: testRoot, status: result.status, error: result.error?.message, log: path, summary: (result.stdout.match(/^[#ℹ] (tests|pass|fail|skipped|cancelled).*$/gm) ?? []) };
});
writeFileSync(output + `/${deployRed ? 'deploy-red' : red ? 'red' : 'green'}-results.json`, JSON.stringify({ timestamp: new Date().toISOString(), node: process.version, results }, null, 2) + '\n');
console.log(JSON.stringify(results));
process.exitCode = red || deployRed ? (results[0].status === 0 && results[1].status === 1 ? 0 : 1) : (results.every(result => result.status === 0) ? 0 : 1);
