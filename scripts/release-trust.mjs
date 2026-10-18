// This function produces a dependency-free runner to freeze outside the release.
export function trustedRunnerSource(verifierSource, frozenRoot) {
  if (!/^[a-f0-9]{64}$/.test(frozenRoot)) throw new Error('Frozen package root required');
  return verifierSource + `
import { spawnSync as trustedSpawn } from 'node:child_process';
import { fileURLToPath as trustedFileURL } from 'node:url';
export const verifyAnchoredPackage = root => verifyPackage(root, '${frozenRoot}');
if (process.argv[1] === trustedFileURL(import.meta.url)) {
  try {
    const packageRoot = process.argv[2];
    const verification = verifyAnchoredPackage(packageRoot);
    const action = process.argv[3] ?? '--verify';
    if (action === '--verify') console.log(JSON.stringify(verification));
    else {
      if (!['--check', '--deploy', '--rollback'].includes(action)) throw new Error('Unknown trusted operation');
      const args = action === '--rollback' ? [process.argv[4]] : action === '--check' ? ['--check'] : [];
      if (action === '--rollback' && !args[0]) throw new Error('Frozen rollback contract path required');
      const childEnv = { ...process.env, LCB_TRUST_VERIFIER: trustedFileURL(import.meta.url), LCB_NODE: process.execPath };
      for (const key of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'LCB_VERIFY_OPENAI_API_KEY', 'CONTROL_PLANE_API_KEY']) delete childEnv[key];
      const entry = join(realpathSync(packageRoot), 'scripts', action === '--rollback' ? 'rollback.mjs' : 'deploy-fix.mjs');
      const result = trustedSpawn(process.execPath, [entry, ...args], { env: childEnv, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
    }
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
`;
}
