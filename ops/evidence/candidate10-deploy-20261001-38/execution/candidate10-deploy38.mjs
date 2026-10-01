import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const repo='/Users/ZGH/Codex/Local-Codex-Bridge', node='/opt/homebrew/Cellar/node/26.3.1/bin/node';
const task='LCB-C10-DEPLOY-38', pkg=path.join(repo,'releases/2.1.3-local.1-candidate.10/package');
const trust=path.join(repo,'releases/trust/2.1.3-local.1-candidate.10/verify-package.mjs');
const runRoot=path.join(repo,'.validation/candidate10-deploy38');
fs.mkdirSync(runRoot,{mode:0o700});
const save=(name,value)=>fs.writeFileSync(path.join(runRoot,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const requireThat=(v,m)=>{if(!v)throw Error(m);};
const cmd=(file,args,env=process.env)=>{const r=spawnSync(file,args,{env,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});requireThat(r.status===0,'command failed: '+file);return r.stdout;};
const reviewedHead='e4728ca4fff8c76427f26759bb172ecf75e9577a';
const frozen={archive:'03e1f75f7024d0bdb80102c7325862b2d321a20b5b69a2890d965e80e13f2ff3',manifest:'dd45b60129840fb8196991f7a8863fbd2ff83ddc01ed20ffbbc0dc1d89882506',root:'6341e54b4098646fff029b9007d716922f388f83afbe438ebc29787cb3c8b1a5',trust:'dbe5de61daa22388bc2364aa94bee11c216f37e3ab771515ab882846f44764cf'};
const sourceGuard=()=>{requireThat(cmd('/usr/bin/git',['-C',repo,'rev-parse','HEAD']).trim()===reviewedHead,'source HEAD drift');requireThat(cmd('/usr/bin/git',['-C',repo,'status','--porcelain']).trim()==='','source dirty');};
sourceGuard();
requireThat(process.execPath===node&&process.version==='v26.3.1','wrong Node');
requireThat(sha(trust)===frozen.trust&&sha(path.join(pkg,'manifest.json'))===frozen.manifest&&sha(path.join(pkg,'package-manifest.json'))===frozen.root&&sha(path.join(repo,'releases/2.1.3-local.1-candidate.10/local-codex-bridge-2.1.3-local.1.tar.gz'))===frozen.archive,'sealed bytes drift');
// The verified external runner is the first executable package entry.
const externalVerify=JSON.parse(cmd(node,[trust,pkg,'--verify']));
const manifest=JSON.parse(fs.readFileSync(path.join(pkg,'manifest.json')));
const contract=JSON.parse(fs.readFileSync(path.join(repo,'ops/runbooks/daemon-bootstrap-contract.current.json')));
Object.assign(process.env,contract.verification.environment,{LCB_BACKUP_ROOT:path.join(repo,'deployment-backups/candidate10-deploy38')});
const externalCheck=JSON.parse(cmd(node,[trust,pkg,'--check']));
requireThat(externalCheck.deployment_ready===true,'daemon not ready');
const { checkHashes }=await import(path.join(pkg,'scripts/deploy-fix.mjs'));
const { verifyDaemon,daemonConfig }=await import(path.join(pkg,'scripts/daemon-attestation.mjs'));
const { productionIndexIdentity }=await import(path.join(pkg,'scripts/production-index-identity.mjs'));
const { metadata,sameIdentity }=await import(path.join(pkg,'scripts/bootstrap-method.mjs'));
const { verifyLive }=await import(path.join(pkg,'scripts/verify-fix-live.mjs'));
const { remoteModels }=await import(path.join(pkg,'scripts/remote-model-probe.mjs'));
const productionGuard=(hashes=manifest.baseline)=>{checkHashes(manifest.production,hashes,'production');for(const [file,h]of Object.entries(manifest.host_code_hashes))requireThat(sha(file)===h,'host drift');const index=productionIndexIdentity(manifest.production);requireThat(index.head===manifest.git_head&&index.index_sha256===manifest.git_index_hash,'production Git drift');for(const [file,m]of Object.entries(contract.targets.filter(t=>t.type==='file').reduce((a,t)=>{const input=JSON.parse(fs.readFileSync(path.join(repo,'ops/runbooks/candidate10-reseal-input.json')));if(input.host_files[t.target])a[t.target]=input.host_files[t.target];return a;},{})))requireThat(sameIdentity(metadata(file),m),'bootstrap host metadata drift');return index;};
const beforeIndex=productionGuard(),beforeDaemon=await verifyDaemon(daemonConfig(manifest.production,manifest.baseline,manifest.agent));
save('preflight.json',{task,reviewed_head:reviewedHead,frozen,external_verify:externalVerify,external_check:externalCheck,index:beforeIndex,daemon:beforeDaemon,hosts:Object.keys(manifest.host_code_hashes).map(metadata),timestamp:new Date().toISOString(),review37:{source:'controller handoff; no repository review file',verdict:'GO_FOR_SCOPED_CANDIDATE10_DEPLOYMENT',conditions:['exact candidate10 and external verifier Node26','live production baseline HEAD/index hosts daemon before mutation','explicit backup allowlist atomic dist exchange exact kickstart','new isolated synthetic fixture only','candidate loaded daemon remote scratch cleanup or rollback proof','preserve five initialize historical cleanup audit limitations']},find_wheel:{phase:1,decision:'reuse',sources:['.validation/stagee-20260928/prepare-fixture.mjs','ops/find-wheel.md','candidate10 sealed deploy/verify/rollback'],scope:'operational fixture and evidence only; no runtime implementation',development:'adapt current isolated synthetic fixture method',launch:'existing local dependencies no new paid service',growth:'reuse bounded native history and deployment operations',usage:'unknown'}});
// Fresh synthetic-only history. Schema/migrations are metadata; no real thread rows or bodies.
const home=fs.mkdtempSync(path.join(runRoot,'history-home-'));fs.chmodSync(home,0o700);
const id=randomUUID(),now=Date.now(),timestamp=new Date(now).toISOString();
const rollout=path.join(home,'sessions','2026','10','01',`rollout-${timestamp.slice(0,19).replaceAll(':','-')}-${id}.jsonl`);
fs.mkdirSync(path.dirname(rollout),{recursive:true,mode:0o700});
const rows=[{timestamp,type:'session_meta',payload:{id,timestamp,cwd:home,originator:'lcb-c10-deploy38-synthetic',cli_version:'0.0.0',source:'cli',model_provider:'openai',history_mode:'paginated'}}],items=[];
for(let i=0;i<512;i++){const text=`candidate10-deploy38-synthetic-${i}:`+'x'.repeat(60*1024),item={id:randomUUID(),type:'agentMessage',text,phase:'final_answer'};items.push(item);rows.push({timestamp,type:'response_item',payload:{type:'message',id:item.id,role:'assistant',content:[{type:'output_text',text}],phase:'final_answer'}});}
fs.writeFileSync(rollout,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600,flag:'wx'});
for(const file of ['state_5.sqlite','thread_history_1.sqlite']){
 const source=new DatabaseSync('/Users/ZGH/.codex/'+file,{readOnly:true}),target=new DatabaseSync(path.join(home,file));
 for(const row of source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())target.exec(row.sql);
 const insertMigration=target.prepare('INSERT INTO _sqlx_migrations VALUES (?,?,?,?,?,?)');for(const r of source.prepare('SELECT version,description,installed_on,success,checksum,execution_time FROM _sqlx_migrations').all())insertMigration.run(r.version,r.description,r.installed_on,r.success,r.checksum,r.execution_time);
 if(file==='state_5.sqlite')target.prepare('INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,has_user_event,created_at_ms,updated_at_ms,history_mode,preview) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,rollout,Math.floor(now/1000),Math.floor(now/1000),'cli','openai',home,'Candidate10 isolated synthetic history',JSON.stringify({type:'read-only'}),'never',1,now,now,'paginated','Candidate10 synthetic');
 else {const turn='synthetic-turn';target.prepare('INSERT INTO thread_turns(thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,final_agent_item_id,rollout_end_ordinal) VALUES(?,?,?,?,?,?,?,?)').run(id,turn,1,'completed',now,now,items.at(-1).id,512);const insert=target.prepare('INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type,updated_at_ordinal) VALUES(?,?,?,?,?,?,?,?)');target.exec('BEGIN');items.forEach((item,i)=>insert.run(id,turn,item.id,i+1,now,JSON.stringify(item),item.type,i+1));target.exec('COMMIT');target.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)').run(id,fs.statSync(rollout).size,rows.length);}
 for(const row of source.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all())target.exec(row.sql);target.close();source.close();fs.chmodSync(path.join(home,file),0o600);
}
const fixture={home,thread_id:id,file:rollout,bytes:fs.statSync(rollout).size,sha256:sha(rollout),synthetic:true,real_history_rows_read:false,credentials_copied:false,model_turn_started:false};save('fixture.json',fixture);
Object.assign(process.env,{CODEX_HOME:home,LCB_TEST_HISTORY_ID:id,LCB_TEST_HISTORY_FILE:rollout,LCB_ALLOW_HISTORY_VERIFICATION:'1'});
// verifyLive reads fixed env on import; re-import in an independent process after fixture vars exist.
const env=process.env;
const historyPreflightCode=`const {verifyLive}=await import(${JSON.stringify(path.join(pkg,'scripts/verify-fix-live.mjs'))});const r=await verifyLive({wrapper:true,history:true,candidate:${JSON.stringify(pkg)},deadline:Date.now()+60000});console.log(JSON.stringify(r));process.exitCode=r.ok?0:1;`;
const hp=spawnSync(node,['--input-type=module','-e',historyPreflightCode],{env,encoding:'utf8',timeout:75000,maxBuffer:1024*1024});fs.writeFileSync(path.join(runRoot,'history-preflight.stdout'),hp.stdout,{mode:0o600});fs.writeFileSync(path.join(runRoot,'history-preflight.stderr'),hp.stderr,{mode:0o600});requireThat(hp.status===0,'synthetic history preflight failed; no deployment');
sourceGuard();productionGuard();requireThat(sha(rollout)===fixture.sha256,'fixture drift');await verifyDaemon(daemonConfig(manifest.production,manifest.baseline,manifest.agent));
save('invocation.json',{task,node,argv:[trust,pkg,'--deploy'],environment:{...contract.verification.environment,LCB_BACKUP_ROOT:env.LCB_BACKUP_ROOT,CODEX_HOME:home,LCB_TEST_HISTORY_ID:id,LCB_TEST_HISTORY_FILE:rollout,LCB_ALLOW_HISTORY_VERIFICATION:'1'},reviewed_head:reviewedHead,frozen,allowlist:manifest.changed,rollback:'sealed deploy automatic restore manifest baseline, atomic dist exchange, exact restart, full daemon+remote verification; explicit future rollback binds backup baseline and candidate expected hashes',timestamp:new Date().toISOString()});
const child=spawn(node,[trust,pkg,'--deploy'],{env,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';const out=fs.createWriteStream(path.join(runRoot,'deploy.stdout'),{mode:0o600,flags:'wx'}),err=fs.createWriteStream(path.join(runRoot,'deploy.stderr'),{mode:0o600,flags:'wx'});child.stdout.on('data',b=>{stdout+=b;out.write(b);});child.stderr.on('data',b=>{stderr+=b;err.write(b);});
const exit=await new Promise(r=>child.once('close',(code,signal)=>{out.end();err.end();r({code,signal});}));
let deployReceipt;try{deployReceipt=JSON.parse(stdout.trim());}catch{}
save('exit.json',{...exit,deployed:deployReceipt?.deployed===true,fixture_unchanged:sha(rollout)===fixture.sha256,body_recorded:false});
console.log(JSON.stringify({task,run_root:runRoot,exit,deployed:deployReceipt?.deployed===true,backup:deployReceipt?.backup,stderr_classification:stderr.includes('MANUAL_RECOVERY_REQUIRED')?'MANUAL_RECOVERY_REQUIRED':stderr.includes('rollback completed')?'rollback_completed':stderr?'deployment_failed':null}));
