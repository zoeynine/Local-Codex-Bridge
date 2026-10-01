// One-shot metadata-only recovery of the exact review39-owned scratch root.
// Reuses candidate10's reviewed limits, process/lsof checks and leaf semantics.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256, nativeScratchLimits, nativeProcessTable, nativeOpenFiles } from '../../../releases/2.1.3-local.1-candidate.10/package/scripts/bootstrap-method.mjs';
import { productionIndexIdentity } from '../../../releases/2.1.3-local.1-candidate.10/package/scripts/production-index-identity.mjs';

const repo = '/Users/ZGH/Codex/Local-Codex-Bridge';
const evidence = path.dirname(fileURLToPath(import.meta.url));
const rootPath = '/private/tmp/lcb-remote-acceptance-AMOFm4';
const expected = { dev: 16777233, ino: 348749538, uid: 502, gid: 20, mode: 0o700, entries: 311, bytes: 12023077,
  metadata_sha256: '26793905c3ae0682d95f512d6f9d4d2e95c20ebd8ffbaa8f597260c244421c08' };
const check = (condition, message) => { if (!condition) throw new Error(message); };
const stat = file => { const s = fs.lstatSync(file); return { path: file, dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid,
  mode: s.mode & 0o7777, type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'special',
  nlink: s.nlink, size: s.size, mtime_ms: s.mtimeMs, ctime_ms: s.ctimeMs }; };
const same = (a, b) => ['path', 'dev', 'ino', 'uid', 'gid', 'mode', 'type', ...(b.type === 'file' ? ['nlink', 'size', 'mtime_ms', 'ctime_ms'] : [])].every(k => a[k] === b[k]);
const save = (name, value) => { const fd = fs.openSync(path.join(evidence, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
const hash = file => sha256(fs.readFileSync(file));
const command = args => { const r = spawnSync('/usr/bin/git', ['-C', repo, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 2000 }); check(!r.error && r.status === 0, 'read-only source Git unavailable'); return r.stdout.trim(); };
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'releases/2.1.3-local.1-candidate.10/package/manifest.json')));
const prior = JSON.parse(fs.readFileSync(path.join(repo, 'ops/evidence/candidate10-deploy-20261001-38/closeout.json')));
const protectedFiles = [...new Set([...Object.keys(manifest.baseline), ...manifest.changed, ...Object.keys(prior.daemon.loaded_sha256)])].sort();
const productionState = () => ({ root: manifest.production,
  files: protectedFiles.map(relative => { const file = path.join(manifest.production, relative); return { ...stat(file), sha256: hash(file) }; }),
  host_files: Object.keys(manifest.host_code_hashes).sort().map(file => ({ ...stat(file), sha256: hash(file) })),
  index: productionIndexIdentity(manifest.production),
  processes: nativeProcessTable().filter(p => [prior.daemon.pid, prior.daemon.tunnel_pid].includes(p.pid)) });

const result = { schema: 1, task_id: 'LCB-C10-SCRATCH-40', status: 'retained', content_read: false, expected,
  root: rootPath, deleted_entries: 0, deleted_paths: [], root_absent: false, partial: false,
  production_unchanged: false, source_head: command(['rev-parse', 'HEAD']),
  boundaries: { credential_body_read: false, history_body_read: false, prefix_scan: false, other_roots_touched: false,
    production_writes: false, service_restarts: 0, kill_sent: false, recursive_rm: false, pushed: false },
  race_boundary: 'Node path identity rechecks; no fd-relative unlink; same-UID final syscall race remains',
  execution: { role: 'difficult', requested_model: 'gpt-6.1-sol', requested_effort: 'high', effective_model: 'unknown', usage: 'unknown',
    selection_reason: 'single writer exact review39-owned scratch cleanup', attempts: 1 },
  find_wheel: { phase: 1, decision: 'reuse', sources: ['ops/find-wheel.md#Native scratch cleanup (LCB-SCRATCH-FIX-25)',
      'releases/2.1.3-local.1-candidate.10/package/scripts/bootstrap-method.mjs', 'https://nodejs.org/api/fs.html#file-system-flags',
      'https://raw.githubusercontent.com/lsof-org/lsof/master/Lsof.8'],
    scope: 'one-shot operational recovery and metadata evidence; no runtime feature',
    applicability: 'existing reviewed bounded metadata-only leaf cleanup directly applies',
    costs: { development: 'reuse reviewed method with exact adoption guard', launch: 'no dependency or paid service added', growth: 'no new runtime or supplier lock-in', usage: 'unknown' } },
  task_store: { target: repo, readback: 'state database does not exist; initialize/create first', initialized: false },
  timestamp: new Date().toISOString() };

let before, inventory = [], ancestors = [], deadline;
try {
  check(process.execPath === '/opt/homebrew/Cellar/node/26.3.1/bin/node' && process.version === 'v26.3.1', 'wrong Node runtime');
  const review = JSON.parse(fs.readFileSync(path.join(evidence, 'review39-input.json')));
  check(review.directory.path === rootPath && ['dev', 'ino', 'uid', 'gid', 'mode'].every(k => review.directory[k] === expected[k]), 'review39 exact root mismatch');
  check(review.child.pid === 46659 && review.child.uid === expected.uid && review.descendants.length === 28, 'review39 process input incomplete');
  check(new Set([review.child, ...review.descendants].map(p => p.pid)).size === 29 && [review.child, ...review.descendants].every(p => p.uid === expected.uid), 'review39 process identities invalid');
  check(review.ancestors.length === 3 && review.ancestors.every((a, i) => a.path === ['/private/tmp', '/private', '/'][i]), 'review39 ancestors input incomplete');
  result.review39_input_sha256 = hash(path.join(evidence, 'review39-input.json'));
  before = productionState(); save('production-before.json', before);
  result.sealed_method_sha256 = hash(path.join(repo, 'releases/2.1.3-local.1-candidate.10/package/scripts/bootstrap-method.mjs'));
  deadline = Date.now() + nativeScratchLimits.deadline_ms;
  const budget = () => check(Date.now() < deadline, 'scratch cleanup deadline exceeded');
  const root = stat(rootPath);
  check(root.type === 'directory' && ['dev', 'ino', 'uid', 'gid', 'mode'].every(k => root[k] === expected[k]) && fs.realpathSync(rootPath) === rootPath, 'scratch root identity drift');
  ancestors = review.ancestors.map(a => { const live = stat(a.path); check(same(live, a) && fs.realpathSync(a.path) === a.path, 'scratch ancestor identity drift'); return live; });
  const checkParents = file => {
    for (const item of ancestors) check(same(stat(item.path), item), 'scratch ancestor identity drift');
    check(same(stat(rootPath), root) && fs.realpathSync(rootPath) === rootPath, 'scratch root identity drift');
    const parts = file === rootPath ? [] : path.relative(rootPath, path.dirname(file)).split(path.sep).filter(Boolean);
    let current = rootPath;
    for (const part of parts) { current = path.join(current, part); const accepted = inventory.find(x => x.path === current); check(accepted && same(stat(current), accepted), 'scratch nested ancestor identity drift'); }
  };
  let bytes = 0, pathBytes = 0, maxDepth = 0;
  const visit = (file, depth) => {
    budget(); check(depth <= nativeScratchLimits.depth && inventory.length < nativeScratchLimits.entries, 'scratch inventory depth/entries exceeded');
    checkParents(file); const item = stat(file);
    check(['file', 'directory'].includes(item.type) && item.dev === root.dev && item.uid === root.uid && item.gid === root.gid && !(item.mode & 0o022) && !(item.mode & 0o7000) && (item.type !== 'file' || item.nlink === 1), 'scratch unsafe type/device/owner/mode/link');
    bytes += item.type === 'file' ? item.size : 0; pathBytes += Buffer.byteLength(file); maxDepth = Math.max(maxDepth, depth);
    check(bytes <= nativeScratchLimits.bytes && pathBytes <= nativeScratchLimits.path_bytes, 'scratch inventory bytes exceeded'); inventory.push(item);
    if (item.type === 'directory') {
      const observed = [], dir = fs.opendirSync(file, { bufferSize: 1 });
      try { let entry; while ((entry = dir.readSync())) { budget(); check(same(stat(file), item), 'scratch directory changed during inventory'); check(observed.length < nativeScratchLimits.entries, 'scratch directory entries exceeded'); observed.push(entry.name); } } finally { dir.closeSync(); }
      // review39 froze DFS in readdirSync order. Bound enumeration first, then preserve that exact digest convention.
      const names = fs.readdirSync(file); check(JSON.stringify(names.toSorted()) === JSON.stringify(observed.toSorted()), 'scratch directory members changed during inventory');
      for (const name of names) { budget(); check(same(stat(file), item), 'scratch directory changed during inventory'); visit(path.join(file, name), depth + 1); }
    }
  };
  visit(rootPath, 0);
  result.inventory_digest = sha256(JSON.stringify(inventory));
  check(inventory.length === expected.entries && bytes === expected.bytes && result.inventory_digest === expected.metadata_sha256, 'review39 frozen metadata inventory drift');
  result.precheck = { ok: true, entries: inventory.length, bytes, path_bytes: pathBytes, max_depth: maxDepth, limits: nativeScratchLimits,
    type_owner_mode_device_nlink: 'PASS', root_identity: 'PASS', ancestor_identity: 'PASS', frozen_digest_match: true };
  save('freeze.json', { schema: 1, task_id: result.task_id, root, ancestors, inventory, metadata_sha256: result.inventory_digest,
    digest_encoding: 'SHA256 UTF-8 JSON.stringify(inventory), DFS readdirSync order, no newline', bytes, path_bytes: pathBytes, max_depth: maxDepth,
    ancestor_provenance: 'recovery-time live freeze; creation-time ancestors were not persisted by review39',
    child: review.child, descendants: review.descendants, content_read: false, frozen_at: new Date().toISOString() });
  budget();
  const table = nativeProcessTable(deadline), known = [review.child, ...review.descendants];
  // Any absent PID proves the recorded PID/UID/start identity absent too; exact start strings were not supplied.
  // Conservatively refuse all PID reuse, so missing exact start strings cannot weaken the exit check.
  check(known.every(p => !table.some(x => x.pid === p.pid)), 'scratch known process PID reused');
  result.process_lsof = { child_pid: review.child.pid, descendants: review.descendants.length, known_identity_absent: true, known_pids_absent: true,
    identity_proof: 'all 29 PIDs absent unconditionally; therefore no matching PID/UID/start exists',
    exact_start_strings: 'not available in controller supplement; only recorded range supplied',
    open_files: nativeOpenFiles(inventory.map(x => x.path), deadline) };
  budget(); checkParents(rootPath);
  for (const item of inventory) { budget(); checkParents(item.path); check(same(stat(item.path), item), 'scratch entry identity changed'); }
  const children = dir => inventory.filter(x => x.path !== dir && path.dirname(x.path) === dir).map(x => path.basename(x.path)).sort();
  const readNames = dir => { const actual = [], handle = fs.opendirSync(dir, { bufferSize: 1 }); try { let entry; while ((entry = handle.readSync())) { budget(); check(actual.length < nativeScratchLimits.entries, 'scratch new content'); actual.push(entry.name); } } finally { handle.closeSync(); } return actual.sort(); };
  for (const item of inventory.filter(x => x.type === 'directory')) { budget(); checkParents(item.path); check(JSON.stringify(readNames(item.path)) === JSON.stringify(children(item.path)), 'scratch content changed after inventory'); }
  save('precheck.json', { precheck: result.precheck, process_lsof: result.process_lsof, inventory_digest: result.inventory_digest, recorded_at: new Date().toISOString() });
  // Exactly one reverse inventory pass. Each leaf checks ancestry and identity immediately before its syscall.
  for (const item of [...inventory].reverse()) {
    budget(); checkParents(item.path); check(same(stat(item.path), item), 'scratch entry replaced before delete');
    if (item.type === 'directory') { const handle = fs.opendirSync(item.path, { bufferSize: 1 }); try { check(handle.readSync() === null, 'scratch directory not empty'); } finally { handle.closeSync(); } fs.rmdirSync(item.path); }
    else fs.unlinkSync(item.path);
    result.deleted_paths.push(item.path); result.deleted_entries = result.deleted_paths.length;
  }
  try { fs.lstatSync(rootPath); throw new Error('scratch root still present after cleanup'); } catch (e) { check(e.code === 'ENOENT', 'scratch root absence unverified'); }
  result.root_absent = true; result.status = 'cleaned';
} catch (error) {
  result.error = error.message; result.partial = result.deleted_entries > 0;
  result.status = 'retained';
}
try { const after = productionState(); save('production-after.json', after); result.production_unchanged = before !== undefined && JSON.stringify(before) === JSON.stringify(after);
  check(result.production_unchanged, 'production/host/process/index baseline drift');
} catch (error) { result.production_error = error.message; }
result.completed_at = new Date().toISOString();
save('result.json', result);
console.log(JSON.stringify({ task_id: result.task_id, status: result.status, error: result.error, inventory_digest: result.inventory_digest,
  precheck: result.precheck, process_lsof: result.process_lsof, deleted_entries: result.deleted_entries, root_absent: result.root_absent,
  partial: result.partial, production_unchanged: result.production_unchanged, evidence }));
process.exitCode = result.status === 'cleaned' && result.production_unchanged ? 0 : 1;
