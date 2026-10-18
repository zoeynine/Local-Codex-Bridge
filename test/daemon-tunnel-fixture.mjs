// Isolated OS parent fixture. No LaunchAgent, host config or remote calls.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--import', process.argv[2], process.argv[3]], { stdio: ['pipe', 'pipe', 'pipe'] });
process.send({ bridge_pid: child.pid });
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.once('close', code => { process.exitCode = code ?? 1; process.disconnect(); });
process.once('SIGTERM', () => { child.stdin.end(); });
