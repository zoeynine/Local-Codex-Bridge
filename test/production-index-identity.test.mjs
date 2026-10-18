import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseIndex, requireAcceptedIndex } from '../scripts/production-index-identity.mjs';
function fixture(change = () => {}) {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8);
  const entry = Buffer.alloc(64); entry.writeUInt32BE(0o100644, 24); entry.fill(1, 40, 60); entry.writeUInt16BE(1, 60); entry.write('a', 62);
  const tree = Buffer.concat([Buffer.from('\0' + '1 0\n'), Buffer.alloc(20, 2)]), extension = Buffer.alloc(8); extension.write('TREE'); extension.writeUInt32BE(tree.length, 4);
  const body = Buffer.concat([header, entry, extension, tree]); change(body);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
test('index parser checks checksum and reports absent extended flags as null', () => {
  const parsed = parseIndex(fixture());
  assert.deepEqual(parsed.entries, [{ path: 'a', mode: '100644', oid: '01'.repeat(20), stage: 0, flags: 1, extendedFlags: null }]);
  assert.equal(parsed.trees.length, 1);
  const corrupt = fixture(); corrupt[63] ^= 1;
  assert.throws(() => parseIndex(corrupt), /checksum mismatch/);
});
test('unsupported version and malformed TREE are rejected', () => {
  assert.throws(() => parseIndex(fixture(body => body.writeUInt32BE(4, 4))), /DIRC v2/);
  assert.throws(() => parseIndex(fixture(body => body[85] = 120)), /TREE/);
});
test('accepted identity rejects exact binary drift even with matching semantic digests', () => {
  const accepted = { head: 'h', head_tree: 't', index_sha256: 'i', entry_identity_sha256: 'e', tree_cache_sha256: 'c', entries: 59, tree_nodes: 14 };
  requireAcceptedIndex(accepted, accepted);
  assert.throws(() => requireAcceptedIndex({ ...accepted, index_sha256: 'different' }, accepted), /index_sha256/);
  assert.throws(() => requireAcceptedIndex({ ...accepted, entries: 58 }, accepted), /inventory/);
});
