// This dependency-free verifier is also frozen OUTSIDE the package as its trust root.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve, sep, posix, dirname } from 'node:path';
export function safePackagePath(root, name, allowLeafLink = false) {
  if (typeof name !== 'string' || !name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || posix.normalize(name) !== name || name === '.' || name.split('/').includes('..')) throw new Error('Unsafe manifest path');
  const base = realpathSync(root), file = resolve(base, name);
  if (!file.startsWith(base + sep)) throw new Error('Unsafe manifest path');
  let current = base;
  const parts = name.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat; try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink() && !(allowLeafLink && i === parts.length - 1)) throw new Error('Symlink path disallowed: ' + name);
  }
  return file;
}
export function verifyPackage(root, frozenRootSha256) {
  if (!/^[a-f0-9]{64}$/.test(frozenRootSha256)) throw new Error('Frozen root hash unavailable');
  const bytes = readFileSync(safePackagePath(root, 'package-manifest.json'));
  const sha = value => createHash('sha256').update(value).digest('hex');
  if (sha(bytes) !== frozenRootSha256) throw new Error('Frozen package-manifest root hash mismatch');
  const manifest = JSON.parse(bytes);
  if ('package-manifest.json' in manifest.files || 'package-manifest.json' in manifest.links) throw new Error('Self-referencing package manifest disallowed');
  const files = new Set(Object.keys(manifest.files)), links = new Set(Object.keys(manifest.links));
  for (const name of files) {
    const file = safePackagePath(root, name);
    if (!lstatSync(file).isFile() || sha(readFileSync(file)) !== manifest.files[name]) throw new Error('Sealed package mismatch: ' + name);
  }
  for (const name of links) {
    const file = safePackagePath(root, name, true), target = readlinkSync(file);
    if (target !== manifest.links[name] || !resolve(dirname(file), target).startsWith(realpathSync(root) + sep)) throw new Error('Sealed package symlink mismatch: ' + name);
  }
  function walk(relative = '') {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const name = posix.join(relative, entry.name);
      if (name === 'package-manifest.json') continue;
      if (entry.isDirectory()) walk(name);
      else if (entry.isSymbolicLink() ? !links.has(name) : !files.has(name)) throw new Error('Unsealed package file: ' + name);
    }
  }
  walk();
  return { ok: true, root_sha256: frozenRootSha256, files: files.size, links: links.size };
}
