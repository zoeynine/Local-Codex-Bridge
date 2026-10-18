// Explicit new host acceptance never rewrites historical incident identities.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { metadata, sameIdentity, canonical } from './bootstrap-method.mjs';
import { requireAcceptedIndex } from './production-index-identity.mjs';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export function validateCurrentHostAcceptance(receipt, { provenance, reseal, indexAcceptance, priorManifest }) {
  assert(receipt?.schema === 1 && receipt.task_id === 'LCB-C10-SEAL-36' && receipt.controller_acceptance?.accepted === true && receipt.controller_acceptance.scope === 'new_candidate10_only_no_deployment', 'Explicit current host acceptance required');
  const codex = receipt.codex_path;
  assert(typeof codex === 'string' && codex.endsWith('/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex') && receipt.old_sha256 === provenance.production_identity.host_code_hashes[codex] && receipt.old_sha256 === priorManifest.host_code_hashes[codex] && /^[a-f0-9]{64}$/.test(receipt.new_sha256) && receipt.old_sha256 !== receipt.new_sha256, 'Current host acceptance binary binding mismatch');
  for (const key of ['bootstrap_receipt', 'bootstrap_contract', 'host_files', 'current_index_acceptance']) assert(canonical(receipt[key]).equals(canonical(reseal[key])), 'Current host bootstrap/index binding mismatch');
  requireAcceptedIndex(receipt.production_identity, indexAcceptance.current_identity);
  assert(receipt.production === provenance.production && receipt.compatibility?.initialize_ok === true && receipt.compatibility.model_turn_started === false && receipt.compatibility.real_history_read === false && receipt.compatibility.credentials_used === false && receipt.compatibility.scratch_cleanup_recovered === true, 'Current host compatibility incomplete');
  assert(receipt.boundary?.production_modified === false && receipt.boundary.production_restart === false && receipt.boundary.candidate9_modified === false && receipt.boundary.bootstrap27_modified === false && receipt.boundary.provenance_modified === false && receipt.boundary.deployment_authorized === false && receipt.root_cause?.evidence_grade === 'inference_consistent_with_signed_application_update' && receipt.root_cause.mechanism_proven === false && receipt.root_cause.old_binary_available === false, 'Current host acceptance boundary mismatch');
  const expected = { ...priorManifest.host_code_hashes, [codex]: receipt.new_sha256 };
  assert(canonical(receipt.current_host_code_hashes).equals(canonical(expected)), 'Only the explicitly accepted Codex binary may change');
  for (const [key, identifier] of [['chatgpt', 'com.openai.codex'], ['codex_cli', 'com.openai.codex.cli']]) {
    const host = receipt.host_evidence?.[key];
    assert(host?.identifier === identifier && host.signature?.verified === true && host.signature.verification_exit_code === 0 && host.signature.team_identifier === '2DC432GLL2' && host.signature.notarization_ticket === 'stapled', 'Official signed current host evidence required');
  }
  assert(receipt.host_evidence.codex_cli.executable.path === codex && receipt.host_evidence.codex_cli.executable.sha256 === receipt.new_sha256 && /^codex-cli \d+\.\d+\.\d+/.test(receipt.host_evidence.cli_version), 'Current host version/binary mismatch');
  return expected;
}
export function verifyCurrentHostEvidence(receipt) {
  for (const key of ['chatgpt', 'codex_cli']) {
    const host = receipt.host_evidence[key];
    for (const expected of [host.info_plist, host.executable]) assert(sameIdentity(metadata(expected.path), expected) && realpathSync(expected.path) === expected.path, 'Current signed host metadata drift');
    const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', host.path], { encoding: 'utf8', timeout: 15000 });
    assert(verify.status === 0, 'Current host signature verification failed');
  }
  const version = spawnSync(receipt.codex_path, ['--version'], { encoding: 'utf8', timeout: 5000 });
  assert(version.status === 0 && version.stdout.trim() === receipt.host_evidence.cli_version, 'Current Codex version drift');
}
