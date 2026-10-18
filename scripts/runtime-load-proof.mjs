// Verification-only hook: inspect the bytes Node actually loads, never mutate Bridge code.
// https://nodejs.org/api/module.html#moduleregisterhooksoptions
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Shared synchronous capture: hashes nextLoad's source, never a later disk read.
export function captureRuntimeLoads(root, onLoad) {
  return registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith('file:')) {
      const name = relative(root, fileURLToPath(url));
      if (name.startsWith('dist/src/') && name.endsWith('.js')) onLoad(name, result.source == null ? null : hash(result.source));
    }
    return result;
  } });
}
export function createRuntimeProof(root, hashes, scratch = '/private/tmp') {
  const directory = mkdtempSync(join(scratch, 'lcb-runtime-proof-'));
  const proof = { root: realpathSync(root), expected: Object.fromEntries(Object.entries(hashes).filter(([name]) => name.startsWith('dist/src/') && name.endsWith('.js'))), receipt: join(directory, 'loaded.json'), config: join(directory, 'config.json') };
  writeFileSync(proof.config, JSON.stringify(proof), { mode: 0o600 });
  return proof;
}
export function readRuntimeProof(proof, pid) {
  let receipt; try { receipt = JSON.parse(readFileSync(proof.receipt, 'utf8')); } catch { throw new Error('Probe loaded runtime proof missing'); }
  if (receipt.pid !== pid || receipt.root !== proof.root || receipt.failure || !receipt.loaded['dist/src/index.js'] || !receipt.loaded['dist/src/app-server.js']) throw new Error('Probe loaded runtime proof mismatch');
  for (const [name, digest] of Object.entries(receipt.loaded)) if (proof.expected[name] !== digest) throw new Error('Probe loaded runtime proof byte mismatch');
  return { ok: true, pid, root: proof.root, loaded_sha256: receipt.loaded, body_recorded: false };
}
if (process.env.LCB_RUNTIME_PROOF_CONFIG) {
  const proof = JSON.parse(readFileSync(process.env.LCB_RUNTIME_PROOF_CONFIG, 'utf8'));
  delete process.env.LCB_RUNTIME_PROOF_CONFIG;
  const receipt = { pid: process.pid, root: proof.root, loaded: {}, failure: false };
  const save = () => writeFileSync(proof.receipt, JSON.stringify(receipt), { mode: 0o600 });
  save();
  captureRuntimeLoads(proof.root, (name, digest) => {
    if (proof.expected[name] !== digest) { receipt.failure = true; save(); throw new Error('Loaded runtime byte mismatch; body omitted'); }
    receipt.loaded[name] = digest; save();
  });
}
