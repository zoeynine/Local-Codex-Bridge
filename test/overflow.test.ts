import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextEvent } from 'node:timers/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { AppServerManager } from '../src/app-server.js';
import { DARWIN_PLATFORM_POLICY } from '../src/platform.js';
import { ControlSurface } from '../src/tools.js';

const fixture = fileURLToPath(new URL('../../test/overflow-codex.mjs', import.meta.url));
async function setup(framing = 'newline', childError = false) {
  const directory = await mkdtemp(join(tmpdir(), 'lcb-overflow-'));
  const log = join(directory, 'calls.jsonl');
  let injected = false;
  let exit: Promise<void> | undefined;
  const manager = new AppServerManager(undefined, {
    executable: process.execPath, prefixArgs: [fixture, log, framing], requestTimeoutMs: 2000,
    platformPolicy: { ...DARWIN_PLATFORM_POLICY, hasChildExited(child) {
      const actual = child as import('node:child_process').ChildProcessWithoutNullStreams;
      exit ??= new Promise(resolve => actual.once('close', () => resolve()));
      if (childError && !injected) { injected = true; actual.emit('error', new Error('secondary synthetic child error')); }
      return DARWIN_PLATFORM_POLICY.hasChildExited(child);
    } },
  });
  return { manager, log, async exited() { assert.ok(exit); await exit; }, async cleanup() { await manager.close(); await rm(directory, { recursive: true }); } };
}

for (const framing of ['newline', 'fragmented']) {
  for (const secondaryError of [false, true]) {
    test(`first overflow fatal survives exit / child error=${secondaryError}, framing=${framing}`, { timeout: 10000 }, async () => {
      const s = await setup(framing, secondaryError);
      try {
        await assert.rejects(s.manager.request('test/overflow', {}), /JSONL line exceeded 10 MiB/);
        if (secondaryError) await assert.rejects(s.manager.ensureReady(), /JSONL line exceeded 10 MiB/);
        await s.exited();
        await assert.rejects(s.manager.ensureReady(), /JSONL line exceeded 10 MiB/);
      } finally { await s.cleanup(); }
    });
  }
  test(`overflow diagnostics bounded and buffer released, framing=${framing}`, { timeout: 10000 }, async () => {
    const s = await setup(framing);
    try {
      let failure = '';
      await assert.rejects(s.manager.request('test/overflow', {}), (error: Error) => { failure = error.message; return true; });
      assert.match(failure, /limit_bytes=10485760/);
      assert.match(failure, /observed_at_least_bytes=\d+/);
      assert.match(failure, /test\/overflow/);
      assert.ok(failure.length < 2048);
      assert.ok(!failure.includes('xxxxxxxx'));
      const diagnostics = (s.manager as unknown as { transportDiagnostics?: { buffered_bytes: number } }).transportDiagnostics;
      assert.ok(diagnostics);
      assert.equal(diagnostics.buffered_bytes, 0);
      await s.exited();
    } finally { await s.cleanup(); }
  });
}

test('overflowed mutation never replayed; only explicit safe read restarts once', { timeout: 10000 }, async () => {
  const s = await setup();
  try {
    await assert.rejects(s.manager.request('turn/start', { threadId: 'synthetic' }), /JSONL/);
    await s.exited();
    for (const method of ['turn/start', 'unknown/mutation', 'thread/resume']) {
      await assert.rejects(s.manager.request(method, {}), /unavailable/);
    }
    await assert.rejects(s.manager.respond(8, {}), /unavailable/);
    const results = await Promise.all([s.manager.request('model/list', { limit: 1 }), s.manager.request('thread/list', { limit: 1 })]);
    assert.equal(results.length, 2);
    let lines = (await readFile(s.log, 'utf8')).trim().split('\n');
    assert.equal(lines.filter(line => line === 'spawn').length, 2);
    assert.equal(lines.filter(line => line.includes('turn/start')).length, 1);
    await assert.rejects(s.manager.request('test/overflow', {}), /JSONL/);
    await nextEvent();
    await assert.rejects(s.manager.request('model/list', { limit: 1 }), /unavailable/);
    lines = (await readFile(s.log, 'utf8')).trim().split('\n');
    assert.equal(lines.filter(line => line === 'spawn').length, 2);
  } finally { await s.cleanup(); }
});

class HistoryProbe extends AppServerManager {
  calls: Array<{ method: string; params: any }> = [];
  override async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'large-history', turns: params.includeTurns ? [{ id: 'large', items: [] }] : [] } };
    return { data: [], nextCursor: null };
  }
}
test('explicit full history is rejected before sending an unbounded native request', async () => {
  const manager = new HistoryProbe();
  await assert.rejects(new ControlSurface(manager).call('codex_threads', { thread_id: 'large-history', include_turns: true }), /latest_messages|unbounded/);
  assert.equal(manager.calls.length, 0);
});
test('observe after state loss explicitly degrades to metadata without a full-history request', async () => {
  const manager = new HistoryProbe();
  const result = await new ControlSurface(manager).call('codex_observe', { thread_id: 'large-history' }) as Record<string, any>;
  assert.equal(result.history_available, false);
  assert.equal(result.terminal, null);
  assert.equal(result.compatibility.classification, 'unbounded_history_disabled');
  assert.deepEqual(manager.calls, [{ method: 'thread/read', params: { threadId: 'large-history', includeTurns: false } }]);
});
test('include_turns with bounded latest_messages uses metadata plus native item pagination', async () => {
  const manager = new HistoryProbe();
  const result = await new ControlSurface(manager).call('codex_threads', { thread_id: 'large-history', include_turns: true, latest_messages: 1 }) as Record<string, any>;
  assert.equal(result.history_available, false);
  assert.equal(result.recent_messages.available, true);
  assert.deepEqual(manager.calls, [
    { method: 'thread/read', params: { threadId: 'large-history', includeTurns: false } },
    { method: 'thread/items/list', params: { threadId: 'large-history', limit: 100, sortDirection: 'desc' } },
  ]);
});

test('30 MiB synthetic history source remains SHA-256 identical across bounded pagination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lcb-history-'));
  const file = join(directory, 'synthetic.jsonl');
  try {
    const ids = Array.from({ length: 512 }, () => randomUUID());
    const lines = ids.map((id, index) => JSON.stringify({ turnId: 'synthetic-turn-' + index, item: { id, type: index < 105 ? 'commandExecution' : 'agentMessage', text: 'synthetic-' + index + ':' + 'x'.repeat(60 * 1024) } }));
    await writeFile(file, lines.join('\n') + '\n');
    assert.ok(statSync(file).size > 30 * 1024 * 1024);
    const hash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
    const before = await hash();
    class SourceHistoryProbe extends HistoryProbe {
      sourceReads = 0;
      servedEntries = 0;
      override async request(method: string, params: any) {
        if (method === 'thread/read') return super.request(method, params);
        assert.equal(method, 'thread/items/list');
        assert.equal(params.limit, 100);
        assert.equal(params.sortDirection, 'desc');
        this.calls.push({ method, params });
        this.sourceReads++;
        const start = Number(params.cursor ?? 0);
        const data: any[] = [];
        const input = createReadStream(file), reader = createInterface({ input, crlfDelay: Infinity });
        let ordinal = 0;
        try {
          for await (const line of reader) {
            if (ordinal++ < start) continue;
            data.push(JSON.parse(line));
            if (data.length === params.limit) break;
          }
        } finally { reader.close(); input.destroy(); }
        this.servedEntries += data.length;
        const page = { data, nextCursor: start + data.length < ids.length ? String(start + data.length) : null };
        assert.ok(Buffer.byteLength(JSON.stringify(page)) < 10 * 1024 * 1024);
        return page;
      }
    }
    const manager = new SourceHistoryProbe();
    const surface = new ControlSurface(manager);
    const result = await surface.call('codex_threads', { thread_id: 'large-history', include_turns: true, latest_messages: 1 }) as Record<string, any>;
    assert.equal(result.recent_messages.pages_read, 2);
    assert.equal(result.recent_messages.messages.length, 1);
    assert.equal(result.recent_messages.messages[0].item.id, ids[105]);
    assert.equal(manager.sourceReads, 2);
    assert.equal(manager.servedEntries, 200);
    await assert.rejects(surface.call('codex_threads', { thread_id: 'large-history', include_turns: true }), /latest_messages|unbounded/);
    assert.equal(await hash(), before);
    assert.equal(manager.calls.filter(call => call.method === 'thread/read' && call.params.includeTurns).length, 0);
  } finally { await rm(directory, { recursive: true }); }
});
