import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCurrentHostAcceptance } from '../scripts/current-host-acceptance.mjs';
const read = p => JSON.parse(readFileSync(new URL('../' + p, import.meta.url)));
const receipt = read('ops/evidence/candidate10-seal-20261001-36/current-host-acceptance.json');
const reseal = read('ops/runbooks/candidate10-reseal-input.json');
const provenance = read('incidents/2026-09-28-jsonl-overflow/provenance.json');
const indexAcceptance = read('ops/evidence/candidate9-seal-20260929-31/current-index-acceptance.json');
const priorManifest = { host_code_hashes: { ...receipt.current_host_code_hashes, [receipt.codex_path]: receipt.old_sha256 } };
const validate = r => validateCurrentHostAcceptance(r, { provenance, reseal, indexAcceptance, priorManifest });
test('explicit current host acceptance preserves old provenance and changes only Codex', () => {
  assert.deepEqual(validate(receipt), receipt.current_host_code_hashes);
  assert.equal(provenance.production_identity.host_code_hashes[receipt.codex_path], receipt.old_sha256);
});
for (const [name, change] of [
  ['missing controller acceptance', r => { r.controller_acceptance.accepted = false; }],
  ['old binary hash mismatch', r => { r.old_sha256 = 'a'.repeat(64); }],
  ['unrelated host override', r => { r.current_host_code_hashes['/unrelated'] = 'a'.repeat(64); }],
  ['unsigned current host', r => { r.host_evidence.codex_cli.signature.verified = false; }],
  ['foreign signing team', r => { r.host_evidence.chatgpt.signature.team_identifier = 'OTHER'; }],
  ['unaccepted index', r => { r.production_identity.index_sha256 = 'a'.repeat(64); }],
  ['bootstrap receipt mismatch', r => { r.bootstrap_receipt.sha256 = 'a'.repeat(64); }],
  ['cleanup not recovered', r => { r.compatibility.scratch_cleanup_recovered = false; }],
  ['model turn', r => { r.compatibility.model_turn_started = true; }],
  ['deployment scope expansion', r => { r.boundary.deployment_authorized = true; }],
  ['unproven mechanism promoted to proof', r => { r.root_cause.mechanism_proven = true; }],
]) test('reject ' + name, () => { const r = structuredClone(receipt); change(r); assert.throws(() => validate(r)); });
