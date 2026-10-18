// Bootstrap execution primitives. No host effects occur on import.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRuntimeProof } from './runtime-load-proof.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => Buffer.from(JSON.stringify(sort(value)) + '\n');
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value;
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
export const metadata = file => {
  const s = fs.lstatSync(file);
  return { path: file, dev: s.dev, ino: s.ino, type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other', mode: '0' + (s.mode & 0o7777).toString(8), uid: s.uid, gid: s.gid, ...(s.isFile() ? { length: s.size, sha256: sha256(fs.readFileSync(file)) } : {}) };
};
export const sameIdentity = (a, b) => ['path', 'dev', 'ino', 'type', 'mode', 'uid', 'gid', 'length', 'sha256'].every(k => a[k] === b[k]);
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

// Node exposes O_NOFOLLOW for open, but no openat/unlinkat directory-fd API.
// These path rechecks detect observed replacement; they cannot isolate a hostile
// same-UID actor replacing an ancestor in the last check-to-syscall window.
export const nativeScratchLimits = Object.freeze({ depth: 12, entries: 1024, bytes: 128 * 1024 * 1024, path_bytes: 128 * 1024, deadline_ms: 5000 });
const scratchStat = file => {
  const s = fs.lstatSync(file);
  return { path: file, dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid, mode: s.mode & 0o7777,
    type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'special',
    nlink: s.nlink, size: s.size, mtime_ms: s.mtimeMs, ctime_ms: s.ctimeMs };
};
const sameScratch = (a, b) => ['path', 'dev', 'ino', 'uid', 'gid', 'mode', 'type', ...(b.type === 'file' ? ['nlink', 'size', 'mtime_ms', 'ctime_ms'] : [])].every(k => a[k] === b[k]);
export function nativeProcessTable(deadline = Date.now() + 2000) {
  const budget = Math.min(2000, deadline - Date.now()); requireThat(budget > 0, 'scratch process deadline');
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart='], { encoding: 'utf8', timeout: budget, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  requireThat(r.status === 0 && !r.error, 'scratch process inventory unavailable');
  return r.stdout.trim().split('\n').filter(Boolean).map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/); requireThat(m, 'scratch process inventory invalid');
    return { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), start: m[4] };
  });
}
export function nativeOpenFiles(paths, deadline) {
  const budget = Math.min(2000, deadline - Date.now()); requireThat(budget > 0, 'scratch lsof deadline');
  // Exact bounded inventory, never +D (which recursively walks an unbounded tree).
  const r = spawnSync('/usr/sbin/lsof', ['-nP', '-F', 'pfn', '--', ...paths], { encoding: 'utf8', timeout: budget, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  requireThat(!r.error && r.status === 1 && !r.stdout && !r.stderr, 'scratch has open holders or lsof unavailable');
  return { ok: true, exact_paths: paths.length, holders: 0 };
}
export function ownedNativeScratch({ record = () => {}, scratchParent = '/private/tmp', invocation = randomUUID(),
  processTable = nativeProcessTable, openFiles = nativeOpenFiles, limits = nativeScratchLimits, beforeDelete = () => {} } = {}) {
  for (const key of Object.keys(nativeScratchLimits)) requireThat(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= nativeScratchLimits[key], 'scratch budget invalid');
  limits = Object.freeze({ ...limits });
  requireThat(typeof invocation === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(invocation), 'scratch invocation invalid');
  requireThat(path.isAbsolute(scratchParent) && fs.realpathSync(scratchParent) === scratchParent, 'scratch parent alias');
  const home = fs.mkdtempSync(path.join(scratchParent, 'lcb-remote-acceptance-'));
  fs.chmodSync(home, 0o700); fs.chownSync(home, process.getuid(), process.getgid());
  const root = scratchStat(home), ancestors = [];
  for (let current = path.dirname(home); ; current = path.dirname(current)) {
    const item = scratchStat(current); requireThat(item.type === 'directory' && fs.realpathSync(current) === current, 'scratch ancestor alias');
    ancestors.push(item); if (current === '/') break;
  }
  requireThat(root.type === 'directory' && root.mode === 0o700 && root.uid === process.getuid() && root.gid === process.getgid() && fs.realpathSync(home) === home && fs.readdirSync(home).length === 0, 'scratch initial ownership/empty state');
  const state = { invocation, root, ancestors, empty_before_auth: true, child: null, descendants: new Map(), process_error: null };
  const checkParents = file => {
    for (const item of ancestors) requireThat(sameScratch(scratchStat(item.path), item), 'scratch ancestor identity drift');
    requireThat(sameScratch(scratchStat(home), root) && fs.realpathSync(home) === home, 'scratch root identity drift');
    const parts = file === home ? [] : path.relative(home, path.dirname(file)).split(path.sep).filter(Boolean);
    let current = home;
    for (const part of parts) { current = path.join(current, part); const expected = inventory.find(x => x.path === current); requireThat(expected && sameScratch(scratchStat(current), expected), 'scratch nested ancestor identity drift'); }
  };
  let inventory = [], finished = false;
  const observe = () => {
    if (!state.child) return;
    try {
      const table = processTable(), child = table.find(p => p.pid === state.child.pid && p.start === state.child.start && p.uid === root.uid);
      const known = new Map(state.descendants); if (child) known.set(child.pid, child);
      let changed;
      do {
        changed = false;
        for (const p of table) if (p.uid === root.uid && known.has(p.ppid) && !known.has(p.pid)) {
          const parent = table.find(x => x.pid === p.ppid && x.start === known.get(p.ppid).start);
          if (parent) { known.set(p.pid, p); state.descendants.set(p.pid, p); changed = true; }
        }
      } while (changed);
    } catch (e) { state.process_error ??= e.message; }
  };
  record({ action: 'remote_scratch_created', invocation, directory: root, ancestors, empty_before_auth: true, limits, content_read: false, race_boundary: 'Node path identity rechecks; no fd-relative unlink; same-UID final syscall race remains' });
  return {
    home,
    auth(bytes) {
      checkParents(home);
      requireThat(fs.readdirSync(home).length === 0, 'scratch spawn prestate not empty');
      const file = path.join(home, 'auth.json'), fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const auth = scratchStat(file); requireThat(auth.type === 'file' && auth.mode === 0o600 && auth.nlink === 1 && auth.uid === root.uid && auth.gid === root.gid, 'scratch auth ownership');
      checkParents(home); requireThat(fs.readdirSync(home).join('|') === 'auth.json', 'scratch spawn prestate changed');
      record({ action: 'remote_scratch_auth', invocation, directory: root, auth, exclusive: true, content_read: false });
    },
    spawned(pid) {
      requireThat(!state.child && Number.isSafeInteger(pid) && pid > 0, 'scratch child PID');
      const child = processTable().find(p => p.pid === pid); requireThat(child && child.uid === root.uid && child.ppid === process.pid && child.start, 'scratch child PID/start unavailable');
      state.child = child; observe(); record({ action: 'remote_scratch_child', invocation, directory: root, child });
    },
    observe,
    finish(exit) {
      requireThat(!finished, 'scratch cleanup already attempted'); finished = true;
      const deadline = Date.now() + limits.deadline_ms;
      const summary = { action: 'remote_scratch_cleanup', invocation, directory: root, child: state.child, child_exit: exit,
        descendants: [...state.descendants.values()], ok: false, retained_paths: [home], deleted_paths: [], inventory: [], limits,
        content_read: false, partial: false, race_boundary: 'Node path identity rechecks; no fd-relative unlink; same-UID final syscall race remains' };
      const budget = () => requireThat(Date.now() < deadline, 'scratch cleanup deadline exceeded');
      try {
        requireThat(exit && (Number.isInteger(exit.code) || exit.signal || exit.spawn_error), 'scratch child exit unverified');
        observe(); requireThat(!state.process_error, state.process_error);
        const table = processTable(deadline), known = [state.child, ...state.descendants.values()].filter(Boolean);
        requireThat(known.every(p => !table.some(x => x.pid === p.pid && x.start === p.start && x.uid === p.uid)), 'scratch child/descendant alive');
        summary.descendants = [...state.descendants.values()];
        let bytes = 0, pathBytes = 0;
        const visit = (file, depth) => {
          budget(); requireThat(depth <= limits.depth && inventory.length < limits.entries, 'scratch inventory depth/entries exceeded');
          checkParents(file); const item = scratchStat(file);
          requireThat(['file', 'directory'].includes(item.type) && item.dev === root.dev && item.uid === root.uid && item.gid === root.gid && !(item.mode & 0o022) && !(item.mode & 0o7000) && (item.type !== 'file' || item.nlink === 1), 'scratch unsafe type/device/owner/mode/link');
          bytes += item.type === 'file' ? item.size : 0; pathBytes += Buffer.byteLength(file);
          requireThat(bytes <= limits.bytes && pathBytes <= limits.path_bytes, 'scratch inventory bytes exceeded');
          inventory.push(item);
          if (item.type === 'directory') {
            const dir = fs.opendirSync(file, { bufferSize: 1 });
            try { let entry; while ((entry = dir.readSync())) { budget(); requireThat(sameScratch(scratchStat(file), item), 'scratch directory changed during inventory'); visit(path.join(file, entry.name), depth + 1); } }
            finally { dir.closeSync(); }
          }
        };
        visit(home, 0); summary.inventory = inventory; summary.total_bytes = bytes;
        budget(); checkParents(home); summary.open_files = openFiles(inventory.map(x => x.path), deadline); requireThat(summary.open_files?.ok, 'scratch lsof verification failed');
        // Verify the complete accepted inventory before the first destructive operation.
        for (const item of inventory) { budget(); checkParents(item.path); requireThat(sameScratch(scratchStat(item.path), item), 'scratch entry identity changed'); }
        const directories = inventory.filter(x => x.type === 'directory');
        const children = dir => inventory.filter(x => path.dirname(x.path) === dir.path && x.path !== dir.path).map(x => path.basename(x.path)).sort();
        for (const dir of directories) {
          budget(); checkParents(dir.path); const actual = []; const handle = fs.opendirSync(dir.path, { bufferSize: 1 });
          try { let entry; while ((entry = handle.readSync())) { budget(); requireThat(actual.length < limits.entries, 'scratch new content'); actual.push(entry.name); } } finally { handle.closeSync(); }
          requireThat(JSON.stringify(actual.sort()) === JSON.stringify(children(dir)), 'scratch content changed after inventory');
        }
        for (const item of [...inventory].reverse()) {
          budget(); beforeDelete(item, summary.deleted_paths.length); budget(); checkParents(item.path);
          requireThat(sameScratch(scratchStat(item.path), item), 'scratch entry replaced before delete');
          if (item.type === 'directory') { const handle = fs.opendirSync(item.path, { bufferSize: 1 }); try { requireThat(handle.readSync() === null, 'scratch directory not empty'); } finally { handle.closeSync(); } fs.rmdirSync(item.path); }
          else fs.unlinkSync(item.path);
          summary.deleted_paths.push(item.path);
        }
        summary.ok = true; summary.retained_paths = [];
      } catch (e) { summary.error = e.message; summary.partial = summary.deleted_paths.length > 0; summary.inventory = inventory; }
      record(summary); return summary;
    }
  };
}

// Bind the allocated directory/config and absent receipt before spawning, then
// adopt only that child output after close. Never infer ownership from a prefix.
export function ownedProofLifecycle(record = () => {}, scratch = '/private/tmp') {
  const owned = new Map();
  return {
    create(root, hashes) {
      const proof = createRuntimeProof(root, hashes, scratch), directory = path.dirname(proof.config);
      const state = { proof, directory: metadata(directory), config: metadata(proof.config), receipt_prestate: 'absent', child: null };
      requireThat(state.directory.type === 'directory' && state.directory.mode === '0700' && state.directory.uid === process.getuid() && fs.realpathSync(directory) === directory, 'proof directory identity');
      requireThat(state.config.type === 'file' && state.config.mode === '0600' && state.config.uid === state.directory.uid && !exists(proof.receipt), 'proof config/receipt prestate');
      owned.set(proof, state); record({ action: 'proof_created', ...state, proof: { root: proof.root, expected: proof.expected, config: proof.config, receipt: proof.receipt } }); return proof;
    },
    spawned(proof, pid) {
      const state = owned.get(proof); requireThat(state && state.child === null && Number.isSafeInteger(pid) && pid > 0, 'proof child PID');
      state.child = { pid, closed: false }; record({ action: 'proof_child', directory: state.directory.path, child_pid: pid });
    },
    finish(proof, exit) {
      const state = owned.get(proof); requireThat(state, 'proof lifecycle binding');
      const result = { directory: state.directory.path, config: state.config, child: state.child ? { ...state.child, closed: true, exit } : { pid: null, closed: true, exit }, receipt: null, receipt_state: 'missing', cleanup: { ok: false, classification: 'scratch_ownership_unknown', retained_paths: [state.directory.path] } };
      try {
        requireThat(exit && (Number.isInteger(exit.code) || exit.signal || exit.spawn_error) && (!state.child || exit.spawn_error || Number.isInteger(exit.code) || exit.signal), 'proof child exit unavailable');
        requireThat(sameIdentity(metadata(state.directory.path), state.directory) && sameIdentity(metadata(proof.config), state.config), 'proof directory/config drift');
        const bound = JSON.parse(fs.readFileSync(proof.config, 'utf8'));
        requireThat(canonical(bound).equals(canonical(proof)), 'proof exact config binding');
        const names = fs.readdirSync(state.directory.path);
        requireThat(names.every(n => n === 'config.json' || n === 'loaded.json'), 'unknown proof content');
        if (exists(proof.receipt)) {
          const receipt = metadata(proof.receipt);
          requireThat(receipt.type === 'file' && receipt.mode === '0600' && receipt.uid === state.directory.uid && receipt.gid === state.config.gid && receipt.length <= 65536 && fs.realpathSync(proof.receipt) === proof.receipt && state.child, 'proof receipt ownership');
          let body; try { body = JSON.parse(fs.readFileSync(proof.receipt, 'utf8')); } catch {}
          if (body) {
            requireThat(Object.keys(body).sort().join('|') === 'failure|loaded|pid|root' && body.pid === state.child.pid && body.root === proof.root && body.loaded && typeof body.loaded === 'object' && !Array.isArray(body.loaded) && typeof body.failure === 'boolean', 'proof receipt child/config mismatch');
            result.receipt_state = body.failure || exit.code !== 0 ? 'failed' : Object.keys(proof.expected).every(k => body.loaded[k] === proof.expected[k]) ? 'complete' : 'partial';
          } else result.receipt_state = 'partial';
          result.receipt = receipt;
        }
        record({ action: 'proof_final_identity', ...result });
        // Validate every identity before any unlink, then check again at unlink.
        if (result.receipt) { requireThat(sameIdentity(metadata(proof.receipt), result.receipt), 'proof receipt changed'); fs.unlinkSync(proof.receipt); }
        requireThat(sameIdentity(metadata(proof.config), state.config), 'proof config changed'); fs.unlinkSync(proof.config);
        requireThat(sameIdentity(metadata(state.directory.path), state.directory) && fs.readdirSync(state.directory.path).length === 0, 'proof directory changed'); fs.rmdirSync(state.directory.path);
        result.cleanup = { ok: true, classification: 'owned_scratch_removed', retained_paths: [] };
      } catch (e) { result.cleanup.error = e.message; }
      record({ action: 'proof_cleanup', ...result }); owned.delete(proof); return result;
    }
  };
}

export async function gate(record, name, operation) {
  requireThat(record.gates[name] === 'not_run', 'gate already attempted');
  try { const result = await operation(); record.gates[name] = 'passed'; return result; }
  catch (e) {
    if (e.failure_domain === 'scratch_cleanup' && e.verification_result?.ok) {
      record.gates[name] = 'passed'; record.failure_domain = 'scratch_cleanup';
      (record.verification_results ??= {})[name] = e.verification_result;
      (record.scratch_cleanup ??= []).push(e.cleanup);
    } else { record.gates[name] = 'failed'; record.failed_gate = name; }
    throw e;
  }
}

// The LaunchAgent/Tunnel authority survives a missing or crashed Bridge child.
export function tunnelSnapshot({ agent, uid, tunnelProgram, plist }, readOS) {
  requireThat(agent === `gui/${uid}/com.openai.tunnel-client.lcb-remote`, 'exact agent required');
  const launch = readOS('/bin/launchctl', ['print', agent]);
  const pid = Number(launch.match(/^\s*pid = (\d+)$/m)?.[1]);
  requireThat(pid > 0 && /^\s*state = running$/m.test(launch) && launch.match(/^\s*program = (.+)$/m)?.[1] === tunnelProgram && launch.match(/^\s*path = (.+)$/m)?.[1] === plist, 'exact LaunchAgent/Tunnel unavailable');
  const match = readOS('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=']).trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  requireThat(match && Number(match[1]) === pid && Number(match[3]) === uid, 'Tunnel OS identity');
  return { agent, tunnel: { pid, ppid: Number(match[2]), uid: Number(match[3]), start: match[4] }, runs: Number(launch.match(/^\s*runs = (\d+)$/m)?.[1]) };
}

export async function restartForRollback({ applyRestart, readTunnel, restoreGuard, kick }) {
  restoreGuard(); const before = readTunnel();
  return { restart_before: before, ...(applyRestart ? { restart: await kick() } : {}) };
}

export async function verifyRollbackAttempt({ record, applyRestart, originalBefore, restartBefore, baseline, readIdentity, verifyLive, remoteModels, restoreGuard, deadline }) {
  let first, live;
  await gate(record, 'exact_tunnel', async () => {
    baseline(); first = readIdentity();
    if (applyRestart) requireThat(first.tunnel.pid !== restartBefore.tunnel.pid && first.tunnel.start !== restartBefore.tunnel.start, 'rollback replacement');
    else requireThat(canonical(first).equals(canonical(originalBefore)), 'old preflight instance');
  });
  await gate(record, 'health', async () => {
    live = await verifyLive(); record.health = live;
    requireThat(live.healthz?.ok && live.readyz?.ok && live.control_plane?.ok && live.control_plane.pid === first.tunnel.pid, 'rollback service health');
  });
  await gate(record, 'wrapper', async () => requireThat(live.wrapper?.ok, 'rollback wrapper failed'));
  try { await gate(record, 'remote', async () => { const value = await remoteModels(); record.remote_codex_models = value; requireThat(value.ok, 'rollback remote'); }); }
  catch (error) {
    if (error.failure_domain !== 'scratch_cleanup' || !error.verification_result?.ok) throw error;
    record.remote_codex_models = error.verification_result;
  }
  await gate(record, 'final_identity', async () => {
    const final = readIdentity(); requireThat(canonical(first).equals(canonical(final)), 'rollback service unstable');
    baseline(); restoreGuard(); requireThat(Date.now() < deadline, 'rollback deadline'); record.identity = final;
  });
  record.ok = true; return record;
}
