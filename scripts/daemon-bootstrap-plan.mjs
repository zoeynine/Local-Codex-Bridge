// Generates a reviewable plan. Never writes host files or restarts.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function bootstrapPlan(config) {
  for (const key of ['production', 'wrapper', 'hookRoot', 'directory', 'node', 'codex', 'backupRoot']) if (typeof config[key] !== 'string' || resolve(config[key]) !== config[key] || /[\x00-\x1f]/.test(config[key])) throw new Error('Bootstrap absolute target required');
  if (!/^gui\/\d+\/com\.openai\.tunnel-client\.lcb-remote$/.test(config.agent)) throw new Error('Bootstrap exact LaunchAgent required');
  if (realpathSync(config.node) !== config.node) throw new Error('Bootstrap canonical Node required');
  const hook = join(config.hookRoot, 'daemon-attestation-hook.mjs'), capture = join(config.hookRoot, 'runtime-load-proof.mjs');
  const files = ['daemon-attestation-hook.mjs', 'runtime-load-proof.mjs', 'daemon-attestation.mjs'].map(name => ({ source: fileURLToPath(new URL(name, import.meta.url)), target: join(config.hookRoot, name), mode: '0500', sha256: sha(readFileSync(new URL(name, import.meta.url))) }));
  const wrapper = `#!/bin/sh\nset -eu\nunset CONTROL_PLANE_API_KEY OPENAI_ADMIN_KEY NODE_OPTIONS\nexport CODEX_EXE=${quote(config.codex)}\nif [ -n "\${LCB_RUNTIME_PROOF_CONFIG:-}" ]; then\n  unset LCB_DAEMON_ATTEST_DIR LCB_DAEMON_ATTEST_HOOK\n  exec ${quote(config.node)} --import ${quote(capture)} ${quote(join(config.production, 'dist/src/index.js'))}\nfi\nexport LCB_DAEMON_ATTEST_DIR=${quote(config.directory)}\nexec ${quote(config.node)} --import ${quote(hook)} ${quote(join(config.production, 'dist/src/index.js'))}\n`;
  return { schema: 1, task_id: 'LCB-DAEMON-13', claim: 'bootstrap_contract_candidate_not_executed', production: config.production, agent: config.agent,
    targets: [...files, { target: config.wrapper, mode: '0755', sha256: sha(wrapper), proposed_bytes: wrapper }, { target: config.hookRoot, mode: '0700', type: 'directory' }, { target: config.directory, mode: '0700', type: 'directory' }],
    baseline: { wrapper_sha256: sha(readFileSync(config.wrapper)), canonical_node: realpathSync(config.node), expected_preexisting_hooks: 'absent_or_stop_and_review', production_dist: 'frozen_baseline_no_change', launchagent: 'no_change' },
    backup: { root: config.backupRoot, mode: '0700', contents: ['original_wrapper_bytes_mode_owner_sha256', 'target_absence_inventory', 'production_dist_hashes', 'exact_tunnel_and_bridge_os_identity'], rule: 'freeze_backup_hash_before_any_target_write' },
    apply: ['independently_verify_candidate_and_external_runner_hashes', 'verify_wrapper_baseline_and_absent_hook_targets', 'create_private_directories_without_symlinks', 'install_three_frozen_hook_files_atomically', 'atomic_wrapper_replace_preserve_owner', 'exact_target_kickstart_once', 'read_only_remote_codex_models_limit_1_to_establish_real_bridge', 'verify_baseline_daemon_nine_module_hashes_and_health_wrapper_remote_gates'],
    rollback: ['restore_exact_original_wrapper_bytes_owner_mode_atomically', 'exact_target_kickstart_once', 'verify_original_wrapper_hash_and_existing_service_health_control_plane_wrapper_remote', 'remove_only_this_invocation_owned_hook_files_and_empty_directories_after_new_bridge_exit', 'original_wrapper_has_no_attestation_so_report_old_service_restored_separately_from_daemon_attestation'],
    verification: { environment: { LCB_NODE: config.node, LCB_DAEMON_ATTEST_HOOK: hook, LCB_DAEMON_ATTEST_DIR: config.directory }, daemon: 'launchctl_exact_tunnel_direct_bridge_os_identity_before_after_two_fresh_nonces_nine_loaded_sha256', wrapper: 'explicit_node_import_no_NODE_OPTIONS_in_app_server', stdout: 'MCP_only_eight_tools', deadline_ms: 90000 },
    release_followup: 'candidate.7 freezes prebootstrap host hashes; after authorized bootstrap, freeze independently reviewed host hashes including all three external hook files and wrapper and reseal a new candidate before --deploy. Do not overwrite candidate.7 or relax identity checks.', host_modified: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(bootstrapPlan(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2)); }
  catch { console.error('Bootstrap contract input invalid; host unchanged'); process.exitCode = 1; }
}
