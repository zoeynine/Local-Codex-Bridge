// Read-only live currentness snapshot; never prepares backups or restarts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { metadata, sha256, tunnelSnapshot } from './bootstrap-method.mjs';
export function readBootstrapPrestate(contract) {
  const run = (file, args) => {
    const result = spawnSync(file, args, { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error('Read-only currentness command unavailable'); return result.stdout;
  };
  const original = contract.live_prestate.original_wrapper, production = contract.scope.production;
  const service = contract.service_identity ?? { agent: contract.scope.agent, uid: contract.scope.uid, tunnelProgram: '/Users/ZGH/.local/bin/lcb-remote-tunnel', plist: '/Users/ZGH/Library/LaunchAgents/com.openai.tunnel-client.lcb-remote.plist', old_bridge_command: `/opt/homebrew/bin/node ${production}/dist/src/index.js` };
  const tunnel = tunnelSnapshot(service, run);
  const childRows = run('/bin/ps', ['-axo', 'pid=,ppid=']).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number)).filter(row => row[1] === tunnel.tunnel.pid);
  const bridges = childRows.filter(([pid]) => run('/bin/ps', ['-p', String(pid), '-o', 'command=']).trim() === service.old_bridge_command);
  if (bridges.length !== 1) throw new Error('Original direct Bridge identity unavailable');
  const m = run('/bin/ps', ['-p', String(bridges[0][0]), '-o', 'pid=,ppid=,uid=,lstart=']).trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!m || Number(m[2]) !== tunnel.tunnel.pid || Number(m[3]) !== contract.scope.uid) throw new Error('Original Bridge parent/UID mismatch');
  const bridge = { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), start: m[4], command: service.old_bridge_command };
  const dist = {};
  const walk = rel => {
    for (const entry of fs.readdirSync(path.join(production, rel), { withFileTypes: true })) {
      const name = path.posix.join(rel, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Production dist symlink');
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) dist[name] = sha256(fs.readFileSync(path.join(production, name)));
      else throw new Error('Production dist unknown type');
    }
  }; walk('dist');
  const absent = contract.live_prestate.absent_paths.filter(file => file !== contract.backup.root);
  for (const file of absent) { try { fs.lstatSync(file); throw new Error('Bootstrap absence drift'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  return {
    service_identity: service, original_wrapper: { ...metadata(original.path), state: 'present', byte_length: fs.statSync(original.path).size, bytes: fs.readFileSync(original.path, 'utf8'), bytes_encoding: 'UTF-8' },
    backup_root: { ...metadata(contract.backup.root), state: 'present', created_by_this_invocation: false },
    parent_directories: contract.live_prestate.parent_directories.map(x => ({ ...metadata(x.path), state: 'present' })), absent_paths: absent,
    tunnel: { pid: tunnel.tunnel.pid, start: tunnel.tunnel.start, runs: tunnel.runs }, bridge,
    production_git_head: run('/usr/bin/git', ['-C', production, 'rev-parse', 'HEAD']).trim(), production_git_index_sha256: sha256(fs.readFileSync(path.join(production, '.git/index'))),
    production_dist_sha256: dist, production_version: JSON.parse(fs.readFileSync(path.join(production, 'package.json'))).version,
    host_code_sha256: Object.fromEntries(Object.keys(contract.live_prestate.host_code_sha256).map(file => [file, sha256(fs.readFileSync(file))])),
    unchanged_host_code_sha256: Object.fromEntries(Object.keys(contract.live_prestate.unchanged_host_code_sha256).map(file => [file, sha256(fs.readFileSync(file))])),
    canonical_node: fs.realpathSync(contract.verification.environment.LCB_NODE), current_uid: process.getuid(), current_gid: process.getgid()
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(readBootstrapPrestate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
