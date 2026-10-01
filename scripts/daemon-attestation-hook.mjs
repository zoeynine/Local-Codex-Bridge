// Preload ONLY the Bridge: node --import TRUSTED_HOOK ROOT/dist/src/index.js.
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, realpathSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureRuntimeLoads } from './runtime-load-proof.mjs';
import { HOOK_VERSION, MAX_FRAME, MODULES, privateDirectory, processIdentity } from './daemon-attestation.mjs';
const directory = process.env.LCB_DAEMON_ATTEST_DIR;
delete process.env.LCB_DAEMON_ATTEST_DIR; delete process.env.LCB_DAEMON_ATTEST_HOOK;
if (!directory || process.env.NODE_OPTIONS || process.env.LCB_RUNTIME_PROOF_CONFIG) throw new Error('Daemon explicit preload configuration required');
const entry = realpathSync(process.argv[1]);
const root = realpathSync(join(dirname(entry), '../..'));
if (entry !== join(root, 'dist/src/index.js')) throw new Error('Daemon entry mismatch');
privateDirectory(directory, process.getuid());
const identity = processIdentity(process.pid), instanceId = randomBytes(32).toString('hex'), loaded = Object.create(null);
captureRuntimeLoads(root, (name, digest) => {
  if (!MODULES.includes(name) || !digest) throw new Error('Daemon loaded source rejected');
  loaded[name] = digest;
});
const path = join(directory, `bridge-${process.pid}.sock`);
if (Buffer.byteLength(path) > 100) throw new Error('Daemon socket path too long');
// No stale-path deletion; an existing socket/path is an identity conflict.
const peers = new Set();
const seen = new Set();
let socketId;
const server = createServer({ allowHalfOpen: true }, socket => {
  if (peers.size >= 4) { socket.destroy(); return; }
  peers.add(socket); socket.setTimeout(1000, () => socket.destroy());
  socket.on('error', () => socket.destroy()); socket.on('close', () => peers.delete(socket));
  let bytes = Buffer.alloc(0);
  socket.on('data', chunk => { if (bytes.length + chunk.length > 256) { socket.destroy(); return; } bytes = Buffer.concat([bytes, chunk]); });
  socket.on('end', () => {
    try {
      if (bytes.length > 256 || bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) throw new Error();
      const request = JSON.parse(bytes.subarray(0, -1).toString('utf8'));
      if (!request || Object.keys(request).sort().join('|') !== 'nonce|version' || request.version !== 1 || typeof request.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(request.nonce) || seen.has(request.nonce)) throw new Error();
      if (seen.size >= 256) seen.delete(seen.values().next().value); seen.add(request.nonce);
      const response = JSON.stringify({ version: 1, nonce: request.nonce, instance_id: instanceId, pid: identity.pid, uid: identity.uid, initial_ppid: identity.ppid, start: identity.start, root, hook_version: HOOK_VERSION, loaded_sha256: loaded }) + '\n';
      if (Buffer.byteLength(response) > MAX_FRAME) throw new Error();
      socket.end(response);
    } catch { socket.destroy(); }
  });
});
server.on('error', () => { process.stderr.write('local-codex-bridge: daemon attestation unavailable\n'); process.exitCode = 1; });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, () => { chmodSync(path, 0o600); const stat = lstatSync(path); socketId = `${stat.dev}:${stat.ino}`; resolve(); }); });
server.unref();
process.once('exit', () => {
  for (const peer of peers) peer.destroy();
  try { const stat = lstatSync(path); if (stat.isSocket() && `${stat.dev}:${stat.ino}` === socketId) unlinkSync(path); } catch {}
});
