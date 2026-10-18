import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const moduleURL = new URL('../../scripts/remote-model-probe.mjs', import.meta.url);
for (const scenario of ['success', 'login missing', 'wrong origin', 'missing tool', 'tool error', 'invalid result', 'deadline']) {
  test(`native remote acceptance ${scenario} is verified or fails closed`, async () => {
    const { remoteModels } = await import(moduleURL.href);
    const root = fs.mkdtempSync('/private/tmp/lcb-native-test-');
    const authPath = path.join(root, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: scenario === 'login missing' ? 'apikey' : 'chatgpt', tokens: { access_token: 'synthetic-oauth' } }));
    let spawned = 0, privateHome = '';
    const source = `
      const readline=require('node:readline');const calls=[];let polls=0;const scenario=${JSON.stringify(scenario)};
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const q=JSON.parse(line);if(q.id===undefined)return;
        calls.push(q.method);let result={};
        if(q.method==='thread/start'){
          if(!q.params.ephemeral||q.params.approvalPolicy!=='never'||q.params.sandbox!=='read-only')process.exit(12);
          result={thread:{id:'private-test-context'}};
        }
        if(q.method==='mcpServerStatus/list'){
          if(scenario==='deadline')return;
          polls++;result={data:[{name:'codex_apps',httpOrigin:scenario==='wrong origin'?'http://127.0.0.1':'https://chatgpt.com',runtimeStatus:scenario==='success'&&polls===1?'connecting':'connected',tools:scenario==='missing tool'?{}:{'local_codex_bridge.codex_models':{}}}]};
        }
        if(q.method==='mcpServer/tool/call'){
          if(q.params.server!=='codex_apps'||q.params.tool!=='local_codex_bridge.codex_models'||JSON.stringify(q.params.arguments)!=='{"limit":1}')process.exit(13);
          const expected=['initialize','thread/start','mcpServerStatus/list'];if(scenario==='success')expected.push('mcpServerStatus/list');expected.push('mcpServer/tool/call');
          if(JSON.stringify(calls)!==JSON.stringify(expected))process.exit(14);
          result={isError:scenario==='tool error',content:[{type:'text',text:JSON.stringify({source:'codex_app_server_model_list',data:scenario==='invalid result'?[]:[{id:'synthetic-model'}]})}]};
        }
        if(!['initialize','thread/start','mcpServerStatus/list','mcpServer/tool/call'].includes(q.method))process.exit(15);
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
      });`;
    const spawnImpl = (_cli: string, args: string[], options: any) => {
      spawned++; privateHome = options.env.CODEX_HOME;
      assert.equal(args[0], 'app-server');
      for (const name of ['OPENAI_API_KEY','LCB_VERIFY_OPENAI_API_KEY','NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','CA_BUNDLE']) assert.equal(options.env[name], undefined);
      const copied = fs.readFileSync(path.join(privateHome, 'auth.json'), 'utf8');
      assert.ok(!copied.includes('synthetic-api-key'));
      assert.equal(fs.statSync(path.join(privateHome, 'auth.json')).mode & 0o777, 0o600);
      return spawn(process.execPath, ['-e', source], options);
    };
    try {
      const options = { authPath, spawnImpl, timeoutMs: scenario === 'deadline' ? 150 : 3000, env: { OPENAI_API_KEY: 'synthetic-api-key', LCB_VERIFY_OPENAI_API_KEY: 'synthetic-api-key', NODE_TLS_REJECT_UNAUTHORIZED: '0' } };
      if (scenario === 'success') {
        const result = await remoteModels(options);
        assert.equal(result.ok, true); assert.equal(result.count, 1);
        assert.equal(result.route, 'native app-server -> codex_apps -> local_codex_bridge.codex_models');
        assert.equal(result.api_key_requested, false); assert.equal(result.api_key_written, false);
        assert.equal(result.model_turn_started, false); assert.equal(result.body_recorded, false);
        assert.ok(!JSON.stringify(result).includes('synthetic-api-key'));
        const entry = fs.readFileSync(new URL('../../deploy.sh', import.meta.url), 'utf8');
        assert.ok(!/read -r -s|\/dev\/tty|API key|Responses/.test(entry));
        assert.ok(!fs.readFileSync(moduleURL, 'utf8').includes('api.openai.com'));
      } else await assert.rejects(remoteModels(options), /login|connector|tool|result|deadline/i);
      assert.equal(spawned, scenario === 'login missing' ? 0 : 1);
      if (privateHome) assert.equal(fs.existsSync(privateHome), false, 'owned OAuth scratch directory must be removed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
