// Read-only Git index evidence. Git commands disable optional index refreshes.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
export function parseIndex(bytes) {
  if (bytes.length < 32 || bytes.toString('ascii', 0, 4) !== 'DIRC' || bytes.readUInt32BE(4) !== 2) throw new Error('Expected DIRC v2 index');
  if (digest('sha1', bytes.subarray(0, -20)) !== bytes.subarray(-20).toString('hex')) throw new Error('Index checksum mismatch');
  let offset = 12;
  const entries = [], extensions = [], trees = [];
  for (let i = 0; i < bytes.readUInt32BE(8); i++) {
    const start = offset;
    if (offset + 62 > bytes.length - 20) throw new Error('Truncated index entry');
    const mode = bytes.readUInt32BE(offset + 24).toString(8), oid = bytes.subarray(offset + 40, offset + 60).toString('hex'), flags = bytes.readUInt16BE(offset + 60);
    offset += 62;
    let extendedFlags = null;
    if (flags & 0x4000) { extendedFlags = bytes.readUInt16BE(offset); offset += 2; }
    const end = bytes.indexOf(0, offset);
    if (end < offset || end >= bytes.length - 20) throw new Error('Missing index path terminator');
    const path = bytes.toString('utf8', offset, end);
    offset = start + Math.ceil((end + 1 - start) / 8) * 8;
    entries.push({ path, mode, oid, stage: (flags >> 12) & 3, flags, extendedFlags });
  }
  let treeDigest = null;
  while (offset < bytes.length - 20) {
    if (offset + 8 > bytes.length - 20) throw new Error('Truncated index extension');
    const tag = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32BE(offset + 4);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (payload.length !== length || offset + 8 + length > bytes.length - 20) throw new Error('Truncated index extension payload');
    extensions.push({ tag, length, sha256: digest('sha256', payload) });
    if (tag !== 'TREE' || treeDigest !== null) throw new Error('Unexpected index extension');
    treeDigest = digest('sha256', payload);
    let cursor = 0;
    function node(parent) {
      const nul = payload.indexOf(0, cursor), line = payload.indexOf(10, nul + 1);
      if (nul < cursor || line < nul) throw new Error('Invalid TREE node');
      const component = payload.toString('utf8', cursor, nul), path = parent ? parent + '/' + component : component;
      const match = payload.toString('ascii', nul + 1, line).match(/^(\d+) (\d+)$/);
      if (!match || line + 21 > payload.length) throw new Error('Invalid TREE counts');
      const entry_count = Number(match[1]), subtree_count = Number(match[2]), oid = payload.subarray(line + 1, line + 21).toString('hex');
      cursor = line + 21; trees.push({ path, entry_count, subtree_count, oid });
      for (let i = 0; i < subtree_count; i++) node(path);
    }
    node('');
    if (cursor !== payload.length) throw new Error('Unexpected TREE trailing bytes');
    offset += 8 + length;
  }
  if (offset !== bytes.length - 20 || treeDigest === null) throw new Error('Index layout mismatch');
  return { version: 2, checksum_valid: true, entries, extensions, trees, index_sha256: digest('sha256', bytes), entry_identity_sha256: digest('sha256', JSON.stringify(entries)), tree_cache_sha256: treeDigest };
}
export function productionIndexIdentity(root) {
  const git = args => {
    const r = spawnSync('/usr/bin/git', ['-C', root, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (r.status !== 0) throw new Error('Read-only production Git identity unavailable');
    return r.stdout;
  };
  const bytes = readFileSync(join(root, '.git/index')), parsed = parseIndex(bytes);
  const head = git(['rev-parse', 'HEAD']).trim(), head_tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  const headEntries = new Map(git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map(row => {
    const match = row.match(/^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/);
    if (!match) throw new Error('Unsupported HEAD entry');
    return [match[3], { mode: match[1], oid: match[2] }];
  }));
  const headTrees = new Map(git(['ls-tree', '-r', '-d', '-z', 'HEAD']).split('\0').filter(Boolean).map(row => {
    const match = row.match(/^\d+ tree ([a-f0-9]{40})\t([\s\S]+)$/);
    if (!match) throw new Error('Unsupported HEAD tree');
    return [match[2], match[1]];
  })); headTrees.set('', head_tree);
  if (headEntries.size !== parsed.entries.length || parsed.entries.some(row => row.stage !== 0 || (row.flags & 0xc000) !== 0 || row.extendedFlags !== null || headEntries.get(row.path)?.mode !== row.mode || headEntries.get(row.path)?.oid !== row.oid)) throw new Error('Production index entries differ from HEAD');
  if (headTrees.size !== parsed.trees.length || parsed.trees.some(row => headTrees.get(row.path) !== row.oid)) throw new Error('Production index TREE differs from HEAD');
  if (git(['diff-index', '--cached', '--name-status', 'HEAD']).trim() !== '') throw new Error('Production cached diff is not empty');
  if (digest('sha256', readFileSync(join(root, '.git/index'))) !== parsed.index_sha256 || git(['rev-parse', 'HEAD']).trim() !== head) throw new Error('Production index changed during readback');
  return { head, head_tree, index_sha256: parsed.index_sha256, entry_identity_sha256: parsed.entry_identity_sha256, tree_cache_sha256: parsed.tree_cache_sha256, version: parsed.version, entries: parsed.entries.length, stage_zero: true, special_flags: 0, checksum_valid: true, tree_nodes: parsed.trees.length, extensions: parsed.extensions, entries_match_head: true, trees_match_head: true, cached_diff_empty: true };
}
export function requireAcceptedIndex(actual, expected) {
  for (const key of ['head', 'head_tree', 'index_sha256', 'entry_identity_sha256', 'tree_cache_sha256']) if (actual[key] !== expected[key]) throw new Error('Accepted production index identity mismatch: ' + key);
  if (actual.entries !== 59 || actual.tree_nodes !== 14) throw new Error('Accepted production index inventory mismatch');
}
