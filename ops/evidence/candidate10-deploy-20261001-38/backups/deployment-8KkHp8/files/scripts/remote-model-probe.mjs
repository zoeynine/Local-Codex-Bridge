// Existing ChatGPT OAuth only. Direct, bounded native RPC; no model turn or local MCP fallback.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
const cli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const tool = 'local_codex_bridge.codex_models';
export async function remoteModels({ authPath = '/Users/ZGH/.codex/auth.json', spawnImpl = spawn, timeoutMs = 20000, env = process.env } = {}) {
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch { throw new Error('Existing ChatGPT connector login unavailable'); }
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token) throw new Error('Existing ChatGPT connector login unavailable');
  const home = fs.mkdtempSync('/private/tmp/lcb-remote-acceptance-');
  let child, closed, exit, stderrBytes = 0;
  try {
    fs.chmodSync(home, 0o700);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: auth.tokens, last_refresh: auth.last_refresh }), { mode: 0o600 });
    const childEnv = { ...env, CODEX_HOME: home };
    for (const name of ['OPENAI_API_KEY','LCB_VERIFY_OPENAI_API_KEY','OPENAI_ADMIN_KEY','CONTROL_PLANE_API_KEY','NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','CA_BUNDLE']) delete childEnv[name];
    child = spawnImpl(cli, ['app-server', '-c', 'features.apps=true', '-c', 'cli_auth_credentials_store="file"'], { env: childEnv, stdio: ['pipe','pipe','pipe'] });
    let buffer = '', next = 0, fatal;
    const decoder = new StringDecoder('utf8'), pending = new Map();
    const fail = error => {
      fatal ??= error; buffer = '';
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fatal); }
      pending.clear();
    };
    child.stderr.on('data', b => { stderrBytes += b.length; });
    child.on('error', () => fail(new Error('Native connector start failed')));
    child.stdin.on('error', () => fail(new Error('Native connector write failed')));
    closed = new Promise(resolve => child.once('close', (code, signal) => { exit = { code, signal }; fail(new Error('Native connector closed')); resolve(exit); }));
    child.stdout.on('data', b => {
      if (fatal) return;
      if (Buffer.byteLength(buffer) + b.length > 10 * 1024 * 1024) { fail(new Error('Native connector response exceeded bounded limit')); return; }
      buffer += decoder.write(b);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { fail(new Error('Native connector protocol failure')); return; }
        const p = pending.get(message.id);
        if (p) {
          clearTimeout(p.timer); pending.delete(message.id);
          if (message.error) p.reject(new Error('Native connector RPC failed')); else p.resolve(message.result);
        } else if (message.id !== undefined) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'No interactive acceptance requests supported' } }) + '\n');
      }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      if (fatal) { reject(fatal); return; }
      const id = ++next, timer = setTimeout(() => fail(new Error('Native connector deadline: ' + method)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await request('initialize', { clientInfo: { name: 'lcb-readonly-remote-acceptance', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const started = await request('thread/start', { cwd: home, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', config: { 'features.apps': true } });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error('Native connector ephemeral context unavailable');
    let apps;
    const readyDeadline = Date.now() + timeoutMs;
    do {
      const status = await request('mcpServerStatus/list', { threadId, limit: 20, detail: 'toolsAndAuthOnly' });
      apps = status?.data?.find(s => s.name === 'codex_apps');
      if (apps?.httpOrigin && apps.httpOrigin !== 'https://chatgpt.com') throw new Error('Remote connector origin mismatch; local fallback forbidden');
      if (apps?.runtimeStatus === 'connected') break;
      if (apps && !['connecting', 'starting'].includes(apps.runtimeStatus)) throw new Error('Remote connector not connected');
      if (Date.now() >= readyDeadline) throw new Error('Remote connector readiness deadline');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, readyDeadline - Date.now())));
    } while (true);
    if (apps.httpOrigin !== 'https://chatgpt.com' || apps.toolsError || !Object.hasOwn(apps.tools ?? {}, tool)) throw new Error('Existing remote codex_apps connector/tool unavailable');
    const response = await request('mcpServer/tool/call', { threadId, server: 'codex_apps', tool, arguments: { limit: 1 } });
    if (response?.isError) throw new Error('Remote MCP tool failed');
    let result = response?.structuredContent;
    if (!result) {
      try { result = JSON.parse(response?.content?.find(c => c.type === 'text')?.text ?? '{}'); } catch { throw new Error('Remote codex_models result invalid'); }
    }
    if (result?.source !== 'codex_app_server_model_list' || !Array.isArray(result.data) || result.data.length !== 1) throw new Error('Remote codex_models result was not verified');
    if (fs.existsSync(path.join(home, 'sessions'))) throw new Error('Native connector unexpectedly persisted context');
    return { ok: true, route: 'native app-server -> codex_apps -> local_codex_bridge.codex_models', remote_origin: apps.httpOrigin, server: 'codex_apps', tool, arguments: { limit: 1 }, count: 1, source: result.source, body_recorded: false, mutation_sent: false, api_key_requested: false, api_key_written: false, model_turn_started: false };
  } finally {
    if (child && closed) {
      child.stdin.end();
      const terminate = setTimeout(() => { if (!exit) child.kill('SIGTERM'); }, 3000);
      const kill = setTimeout(() => { if (!exit) child.kill('SIGKILL'); }, 5000);
      let deadline;
      try { await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Owned native connector cleanup deadline')), 6000); })]); }
      finally { clearTimeout(terminate); clearTimeout(kill); clearTimeout(deadline); fs.rmSync(home, { recursive: true, force: true }); }
    } else fs.rmSync(home, { recursive: true, force: true });
  }
}
