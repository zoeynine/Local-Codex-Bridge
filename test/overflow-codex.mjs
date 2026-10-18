import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const [log, framing] = process.argv.slice(2);
appendFileSync(log, 'spawn\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const call = JSON.parse(line);
  appendFileSync(log, JSON.stringify({ method: call.method, id: call.id }) + '\n');
  if (call.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: call.id, result: {} }) + '\n');
  } else if (call.method === 'test/overflow' || call.method === 'turn/start') {
    // Deliberately synthetic transport fault; never reads real history.
    const line = Buffer.alloc(10 * 1024 * 1024 + 1, 0x78);
    process.stdout.write(framing === 'newline' ? Buffer.concat([line, Buffer.from('\n')]) : line);
  } else if (call.id !== undefined) {
    process.stdout.write(JSON.stringify({ id: call.id, result: { data: [], nextCursor: null } }) + '\n');
  }
});
input.on('close', () => process.exit(0));
