// Build output is sealed; the immutable verifier and frozen root live outside it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trustedRunnerSource } from './release-trust.mjs';
import { productionIndexIdentity, requireAcceptedIndex } from './production-index-identity.mjs';
import { verifyDaemon, daemonConfig } from './daemon-attestation.mjs';
import { validateCurrentHostAcceptance, verifyCurrentHostEvidence } from './current-host-acceptance.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
const out = resolve(process.argv[2] ?? join(root, 'releases', version));
const trust = resolve(process.argv[3] ?? join(root, 'releases', 'trust', version));
const pkg = join(out, 'package');
if (existsSync(out) || existsSync(trust)) throw new Error('Release and trust paths must be new; immutable outputs are never overwritten');
if (trust === pkg || trust.startsWith(pkg + '/')) throw new Error('External trust path required');
const git = args => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); if (r.status !== 0) throw new Error('Git inventory failed'); return r.stdout.trim(); };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child) + '\n';
const provenance = JSON.parse(readFileSync(join(root, 'incidents/2026-09-28-jsonl-overflow/provenance.json')));
// A reseal accepts only an explicitly frozen, independently accepted bootstrap.
// Historical incident provenance and already sealed candidates remain immutable.
let reseal;
let indexAcceptance, sealDaemon, hostAcceptance, acceptedHostHashes;
if (process.argv[4]) {
  const inputBytes = readFileSync(resolve(process.argv[4]));
  if (!/^[a-f0-9]{64}$/.test(process.argv[5] ?? '') || sha(inputBytes) !== process.argv[5]) throw new Error('Frozen reseal input digest required');
  reseal = JSON.parse(inputBytes);
  if (reseal.schema !== 1 || reseal.review.verdict !== 'BOOTSTRAP_ACCEPTED' || reseal.review.task_id !== 'LCB-BOOTSTRAP-REVIEW-28') throw new Error('Independent bootstrap acceptance required');
  const reference = ref => {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '') || !ref.path || resolve(root, ref.path) !== join(root, ref.path) || !resolve(root, ref.path).startsWith(root)) throw new Error('Invalid reseal evidence reference');
    const bytes = readFileSync(join(root, ref.path));
    if (sha(bytes) !== ref.sha256) throw new Error('Reseal evidence digest mismatch');
    return JSON.parse(bytes);
  };
  const receipt = reference(reseal.bootstrap_receipt), contract = reference(reseal.bootstrap_contract);
  if (receipt.task_id !== 'LCB-BOOTSTRAP-27' || receipt.contract_sha256 !== reseal.bootstrap_contract.sha256 || receipt.production.modified !== false || receipt.scratch_cleanup.ok !== true || receipt.scratch_cleanup.retained.length !== 0 || !Object.values(receipt.acceptance.gates).every(state => state === 'passed')) throw new Error('Bootstrap acceptance gates incomplete');
  if (receipt.production.git_head !== provenance.baseline_head || receipt.production.index_sha256 !== provenance.production_identity.git_index_hash) throw new Error('Reseal production provenance mismatch');
  if (JSON.stringify(reseal.host_files) !== JSON.stringify(receipt.new_host_hashes) || Object.keys(reseal.host_files).length !== 4) throw new Error('Reseal host metadata differs from receipt');
  for (const [path, expected] of Object.entries(reseal.host_files)) {
    const target = contract.targets.find(row => row.target === path && row.type === 'file');
    if (!target || target.sha256 !== expected.sha256 || target.mode !== expected.mode || target.uid !== expected.uid || target.gid !== expected.gid) throw new Error('Reseal host contract mismatch');
    const stat = lstatSync(path);
    const actual = { dev: stat.dev, gid: stat.gid, ino: stat.ino, length: stat.size, mode: '0' + (stat.mode & 0o7777).toString(8), path, sha256: sha(readFileSync(path)), type: stat.isFile() && !stat.isSymbolicLink() ? 'file' : 'other', uid: stat.uid };
    if (JSON.stringify(actual) !== JSON.stringify(expected) || realpathSync(path) !== path) throw new Error('Reseal live host identity mismatch');
  }
  if (reseal.current_index_acceptance) {
    indexAcceptance = reference(reseal.current_index_acceptance);
    if (indexAcceptance.schema !== 1 || indexAcceptance.task_id !== 'LCB-C9-SEAL-31' || indexAcceptance.evidence_source !== 'controller_supplied_independent_review' || indexAcceptance.review.verdict !== 'GO_FOR_NEW_CANDIDATE9_WITH_EXPLICIT_CURRENT_INDEX_ACCEPTANCE' || indexAcceptance.controller_acceptance.accepted !== true || indexAcceptance.production !== provenance.production || indexAcceptance.historical_index_sha256 !== provenance.production_identity.git_index_hash || indexAcceptance.current_identity.head !== provenance.baseline_head || indexAcceptance.boundary.root_cause !== 'unknown' || indexAcceptance.boundary.old_index_binary_available !== false) throw new Error('Explicit current index acceptance required');
    if (canonical(indexAcceptance) !== readFileSync(join(root, reseal.current_index_acceptance.path), 'utf8') || canonical(reseal) !== inputBytes.toString('utf8')) throw new Error('Canonical current index acceptance and reseal bytes required');
    for (const key of ['bootstrap_receipt', 'bootstrap_contract', 'host_files']) if (canonical(indexAcceptance[key]) !== canonical(reseal[key])) throw new Error('Current index acceptance bootstrap binding mismatch');
    if (indexAcceptance.historical_provenance.sha256 !== sha(readFileSync(join(root, indexAcceptance.historical_provenance.path))) || indexAcceptance.candidate8.sha256 !== sha(readFileSync(join(root, indexAcceptance.candidate8.path)))) throw new Error('Historical acceptance binding mismatch');
    requireAcceptedIndex(productionIndexIdentity(provenance.production), indexAcceptance.current_identity);
    sealDaemon = await verifyDaemon(daemonConfig(provenance.production, provenance.production_files_before, provenance.production_identity.agent));
    if (sealDaemon.ok !== true) throw new Error('Seal daemon deployment readiness unavailable');
    requireAcceptedIndex(productionIndexIdentity(provenance.production), indexAcceptance.current_identity);
  }
  if (reseal.current_host_acceptance) {
    hostAcceptance = reference(reseal.current_host_acceptance);
    if (!indexAcceptance || canonical(hostAcceptance) !== readFileSync(join(root, reseal.current_host_acceptance.path), 'utf8')) throw new Error('Canonical host acceptance and accepted index required');
    const priorRelease = reference(hostAcceptance.candidate9_release);
    const priorManifest = reference(hostAcceptance.candidate9_manifest);
    if (priorRelease.manifest_sha256 !== hostAcceptance.candidate9_manifest.sha256 || priorRelease.source_commit !== priorManifest.source_commit) throw new Error('Prior candidate9 manifest binding mismatch');
    const probe = reference(hostAcceptance.initialize_probe);
    if (probe.compatibility.protocol_error !== null || probe.compatibility.methods_sent.join('|') !== 'initialize|initialized' || probe.compatibility.model_turn_started !== false || probe.compatibility.credentials_used !== false || probe.compatibility.real_history_read !== false || canonical(probe.chatgpt) !== canonical(hostAcceptance.host_evidence.chatgpt) || canonical(probe.codex_cli) !== canonical(hostAcceptance.host_evidence.codex_cli)) throw new Error('Current host initialize evidence mismatch');
    const recovery = reference(hostAcceptance.scratch_cleanup_recovery);
    if (recovery.task_id !== hostAcceptance.task_id || recovery.ok !== true || recovery.content_read !== false || recovery.retained_paths.length !== 0) throw new Error('Current host scratch cleanup recovery incomplete');
    acceptedHostHashes = validateCurrentHostAcceptance(hostAcceptance, { provenance, reseal, indexAcceptance, priorManifest });
    verifyCurrentHostEvidence(hostAcceptance);
    for (const [path, expected] of Object.entries(acceptedHostHashes)) if (sha(readFileSync(path)) !== expected) throw new Error('Accepted current host live hash mismatch');
  }
  for (const [path, expected] of Object.entries(receipt.unchanged_host_code_sha256)) if (provenance.production_identity.host_code_hashes[path] !== expected || sha(readFileSync(path)) !== (acceptedHostHashes?.[path] ?? expected)) throw new Error('Unchanged host baseline mismatch');
}
const incidentAllowlist = new Set(['incidents/2026-09-28-jsonl-overflow/README.md', 'incidents/2026-09-28-jsonl-overflow/provenance.json', 'incidents/2026-09-28-jsonl-overflow/acceptance-matrix.json', 'incidents/2026-09-28-jsonl-overflow/local-validation.json', 'incidents/2026-09-28-jsonl-overflow/historical-acceptance.json']);
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean).filter(name => !name.startsWith('releases/') && (!name.startsWith('incidents/') || incidentAllowlist.has(name)));
mkdirSync(pkg, { recursive: true }); mkdirSync(trust, { recursive: true, mode: 0o700 });
if (realpathSync(trust).startsWith(realpathSync(pkg) + '/') || realpathSync(trust) === realpathSync(pkg)) throw new Error('External trust path must be physically outside package');
for (const name of tracked) { mkdirSync(dirname(join(pkg, name)), { recursive: true }); cpSync(join(root, name), join(pkg, name), { verbatimSymlinks: true }); }
cpSync(join(root, 'dist'), join(pkg, 'dist'), { recursive: true });
const changed = [...provenance.live_changed.map(row => row.path), 'package-lock.json', 'src/version.ts', 'scripts/rollback.mjs', 'scripts/daemon-attestation.mjs', 'scripts/daemon-attestation-hook.mjs', 'scripts/daemon-bootstrap-plan.mjs', 'test/daemon-attestation.test.ts', 'test/daemon-tunnel-fixture.mjs', 'test/daemon-app-server-fixture.mjs'];
const payload = {}, links = {};
function walk(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name, file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file, name + '/');
    else if (entry.isFile()) payload[name] = sha(readFileSync(file));
    else throw new Error('Release symlinks or nonregular files disallowed: ' + name);
  }
}
walk(pkg);
const manifest = { version, claim: 'candidate', source_commit: git(['rev-parse', 'HEAD']), upstream_commit: provenance.baseline_head, production: provenance.production, agent: provenance.production_identity.agent, git_head: provenance.baseline_head, git_index_hash: provenance.production_identity.git_index_hash, host_code_hashes: provenance.production_identity.host_code_hashes, changed, baseline: { ...provenance.production_files_before }, payload, baseline_links: {}, payload_links: {} };
if (reseal) {
  manifest.host_code_hashes = { ...manifest.host_code_hashes, ...Object.fromEntries(Object.entries(reseal.host_files).map(([path, identity]) => [path, identity.sha256])) };
  if (hostAcceptance) { manifest.host_code_hashes = acceptedHostHashes; manifest.current_host_acceptance = reseal.current_host_acceptance; }
  manifest.host_code_metadata = reseal.host_files;
  manifest.bootstrap_acceptance = { ...reseal, reseal_input_sha256: process.argv[5] };
  if (indexAcceptance) {
    manifest.git_index_hash = indexAcceptance.current_identity.index_sha256;
    manifest.current_index_acceptance = reseal.current_index_acceptance;
    manifest.deployment_ready_at_seal = sealDaemon.ok === true;
  }
}
for (const name of changed) if (!(name in manifest.baseline)) manifest.baseline[name] = null;
writeFileSync(join(pkg, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
payload['manifest.json'] = sha(readFileSync(join(pkg, 'manifest.json')));
const sealed = JSON.stringify({ version, files: payload, links }, null, 2) + '\n';
writeFileSync(join(pkg, 'package-manifest.json'), sealed);
const rootHash = sha(sealed);
const verifier = readFileSync(join(root, 'scripts/verify-package.mjs'), 'utf8');
const anchor = trustedRunnerSource(verifier, rootHash);
writeFileSync(join(trust, 'verify-package.mjs'), anchor, { mode: 0o500 });
const checked = spawnSync(process.execPath, [join(trust, 'verify-package.mjs'), pkg], { encoding: 'utf8' });
if (checked.status !== 0) throw new Error('Candidate seal verification failed');
const archive = join(out, `local-codex-bridge-${version}.tar.gz`);
const tar = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', out, 'package'], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
if (tar.status !== 0) throw new Error('Archive creation failed');
const receipt = { version, claim: 'candidate', source_commit: manifest.source_commit, package: pkg, archive, archive_sha256: sha(readFileSync(archive)), manifest_sha256: sha(readFileSync(join(pkg, 'manifest.json'))), package_root_sha256: rootHash, trust_verifier: join(trust, 'verify-package.mjs'), trust_verifier_sha256: sha(anchor), production_modified: false, sealed_files: Object.keys(payload).length };
if (indexAcceptance) { receipt.current_index_acceptance = reseal.current_index_acceptance; receipt.deployment_ready = sealDaemon.ok === true; receipt.daemon_at_seal = sealDaemon; }
if (hostAcceptance) receipt.current_host_acceptance = reseal.current_host_acceptance;
writeFileSync(join(out, 'release.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
