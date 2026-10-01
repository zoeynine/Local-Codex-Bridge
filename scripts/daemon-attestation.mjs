// Private local attestation protocol, not an MCP tool or a command service.
import { createConnection } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
export const HOOK_VERSION = 'lcb-daemon-attestation/1';
export const MAX_FRAME = 32768;
export const MODULES = Object.freeze(['app-server', 'checkpoint', 'compact-descriptors', 'compact-schema', 'compact-shape', 'exact-json', 'goal', 'history', 'index', 'mcp', 'observe-compact', 'platform', 'queue', 'redaction', 'runtime', 'search', 'tools', 'ux-projection', 'version'].map(name => `dist/src/${name}.js`));
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...expected].sort().join('|');
const positive = n => Number.isSafeInteger(n) && n > 0;
export function privateDirectory(directory, uid) {
  if (!directory || resolve(directory) !== directory || realpathSync(directory) !== directory) throw new Error('Daemon private directory identity');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) throw new Error('Daemon private directory owner/mode');
  return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
}
export function socketIdentity(directory, pid, uid) {
  const directoryId = privateDirectory(directory, uid), path = join(directory, `bridge-${pid}.sock`), stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) throw new Error('Daemon socket owner/mode');
  return { path, identity: `${directoryId}:${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}` };
}
export function budget(deadline, cap = 5000) {
  const ms = Math.min(cap, deadline - Date.now());
  if (ms <= 0) throw new Error('Daemon attestation deadline');
  return Math.max(1, Math.floor(ms));
}
function command(file, args, deadline) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: budget(deadline), killSignal: 'SIGKILL', maxBuffer: MAX_FRAME });
  if (result.status !== 0) throw new Error('Daemon OS identity unavailable');
  return result.stdout;
}
export function processIdentity(pid, deadline = Date.now() + 5000) {
  if (!positive(pid)) throw new Error('Daemon PID invalid');
  const text = command('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart='], deadline).trim();
  const match = text.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match || Number(match[1]) !== pid) throw new Error('Daemon process missing');
  return { pid, ppid: Number(match[2]), uid: Number(match[3]), start: match[4] };
}
export function nativeSnapshot(config, deadline, readOS = command) {
  const uid = process.getuid();
  if (config.agent !== `gui/${uid}/com.openai.tunnel-client.lcb-remote`) throw new Error('Daemon exact LaunchAgent required');
  const launch = readOS('/bin/launchctl', ['print', config.agent], deadline);
  const tunnelPid = Number(launch.match(/^\s*pid = (\d+)$/m)?.[1]);
  if (!positive(tunnelPid) || !/^\s*state = running$/m.test(launch)) throw new Error('Daemon Tunnel unready');
  const tunnel = processIdentity(tunnelPid, deadline);
  if (tunnel.uid !== uid) throw new Error('Daemon Tunnel UID mismatch');
  const root = realpathSync(config.root), hook = realpathSync(config.hook), node = realpathSync(config.node);
  if ([root, hook, node].some(path => /\s/.test(path))) throw new Error('Daemon executable paths ambiguous');
  if (hook !== config.hook || node !== config.node) throw new Error('Daemon executable symlink');
  privateDirectory(dirname(hook), uid);
  const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const file of [hook, join(hook, '..', 'runtime-load-proof.mjs'), join(hook, '..', 'daemon-attestation.mjs')]) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o500 || realpathSync(file) !== file) throw new Error('Daemon trusted hook owner/mode');
  }
  if (digest(hook) !== config.hook_sha256 || digest(join(hook, '..', 'runtime-load-proof.mjs')) !== config.capture_sha256 || digest(join(hook, '..', 'daemon-attestation.mjs')) !== config.protocol_sha256) throw new Error('Daemon trusted hook mismatch');
  const children = readOS('/bin/ps', ['-axo', 'pid=,ppid='], deadline).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number)).filter(row => row[1] === tunnelPid);
  const expectedCommand = `${node} --import ${hook} ${join(root, 'dist/src/index.js')}`;
  const bridges = children.filter(([pid]) => readOS('/bin/ps', ['-p', String(pid), '-o', 'command='], deadline).trim() === expectedCommand);
  if (bridges.length !== 1) throw new Error('Daemon direct Bridge child unavailable');
  const bridge = processIdentity(bridges[0][0], deadline);
  if (bridge.ppid !== tunnel.pid || bridge.uid !== uid) throw new Error('Daemon parent/UID mismatch');
  const socket = socketIdentity(config.directory, bridge.pid, uid);
  const sockets = readOS('/usr/sbin/lsof', ['-a', '-p', String(bridge.pid), '-U', '-Fn'], deadline).split('\n');
  if (!sockets.includes('n' + socket.path)) throw new Error('Daemon socket process ownership missing');
  return { tunnel, bridge, socket, root };
}
export function challengeSocket(path, nonce, deadline, signal) {
  const timeout = budget(deadline);
  return new Promise((resolveChallenge, reject) => {
    let bytes = Buffer.alloc(0), finished = false;
    const socket = createConnection(path);
    const finish = (error, response) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
      error ? reject(error) : resolveChallenge(response);
    };
    const abort = () => finish(new Error('Daemon attestation cancelled'));
    const timer = setTimeout(() => finish(new Error('Daemon attestation deadline')), timeout);
    socket.on('error', () => finish(new Error('Daemon attestation transport')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.on('connect', () => socket.end(JSON.stringify({ version: 1, nonce }) + '\n'));
    socket.on('data', chunk => {
      if (bytes.length + chunk.length > MAX_FRAME) { finish(new Error('Daemon attestation oversized')); return; }
      bytes = Buffer.concat([bytes, chunk]);
    });
    socket.on('end', () => {
      try {
        if (bytes.length === 0 || bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) throw new Error();
        finish(null, JSON.parse(bytes.subarray(0, -1).toString('utf8')));
      } catch { finish(new Error('Daemon attestation invalid frame')); }
    });
    socket.on('close', () => { if (!finished) finish(new Error('Daemon attestation incomplete')); });
  });
}
export function validateResponse(response, nonce, snapshot, expected, priorInstance) {
  if (!keys(response, ['version', 'nonce', 'instance_id', 'pid', 'uid', 'initial_ppid', 'start', 'root', 'hook_version', 'loaded_sha256'])) throw new Error('Daemon attestation schema');
  if (response.version !== 1 || response.nonce !== nonce || typeof response.instance_id !== 'string' || !/^[a-f0-9]{64}$/.test(response.instance_id) || (priorInstance && response.instance_id !== priorInstance)) throw new Error('Daemon attestation freshness/instance');
  const { bridge, root } = snapshot;
  if (response.pid !== bridge.pid || response.uid !== bridge.uid || response.initial_ppid !== bridge.ppid || response.start !== bridge.start || response.root !== root || response.hook_version !== HOOK_VERSION) throw new Error('Daemon attestation process/root mismatch');
  if (!keys(response.loaded_sha256, MODULES)) throw new Error('Daemon loaded module inventory');
  for (const name of MODULES) if (!/^[a-f0-9]{64}$/.test(expected[name] ?? '') || response.loaded_sha256[name] !== expected[name]) throw new Error('Daemon loaded module hash mismatch');
}
export async function verifyDaemon(config, options = {}) {
  const deadline = options.deadline ?? Date.now() + 5000, snapshot = options.snapshot ?? nativeSnapshot, challenge = options.challenge ?? challengeSocket;
  if (options.signal?.aborted) throw new Error('Daemon attestation cancelled');
  const before = snapshot(config, deadline);
  const nonce = randomBytes(32).toString('hex');
  const response = await challenge(before.socket.path, nonce, deadline, options.signal);
  validateResponse(response, nonce, before, config.hashes);
  const after = snapshot(config, deadline);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Daemon instance replaced during challenge');
  // A second fresh challenge binds instance_id, avoiding a persisted old receipt.
  const secondNonce = randomBytes(32).toString('hex');
  validateResponse(await challenge(after.socket.path, secondNonce, deadline, options.signal), secondNonce, after, config.hashes, response.instance_id);
  if (JSON.stringify(after) !== JSON.stringify(snapshot(config, deadline))) throw new Error('Daemon instance replaced during challenge');
  budget(deadline);
  return { ok: true, scope: 'tunnel_direct_bridge_daemon', tunnel_pid: before.tunnel.pid, pid: response.pid, uid: response.uid, initial_ppid: response.initial_ppid, start: response.start, instance_id: response.instance_id, root: response.root, hook_version: response.hook_version, loaded_sha256: response.loaded_sha256, body_recorded: false };
}
export function daemonConfig(root, hashes, agent) {
  return { root, hashes, agent, node: process.env.LCB_NODE ?? process.execPath, hook: process.env.LCB_DAEMON_ATTEST_HOOK, directory: process.env.LCB_DAEMON_ATTEST_DIR,
    hook_sha256: createHash('sha256').update(readFileSync(new URL('./daemon-attestation-hook.mjs', import.meta.url))).digest('hex'), capture_sha256: createHash('sha256').update(readFileSync(new URL('./runtime-load-proof.mjs', import.meta.url))).digest('hex'), protocol_sha256: createHash('sha256').update(readFileSync(new URL('./daemon-attestation.mjs', import.meta.url))).digest('hex') };
}
