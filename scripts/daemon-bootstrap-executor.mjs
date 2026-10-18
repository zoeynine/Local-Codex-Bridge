import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function runBootstrap({ contractPath, contractHash, head, phase, backupPath, manifestHash }) {
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (!/^[a-f0-9]{40}$/.test(head ?? '') || !/^[a-f0-9]{64}$/.test(contractHash ?? '') || !path.isAbsolute(contractPath ?? '')) throw new Error('Externally frozen contract/head required');
const selfPath = fileURLToPath(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])) : value;
const canonical = value => Buffer.from(JSON.stringify(sort(value))+'\n');
const assert = (ok,why) => { if(!ok) throw new Error(why); };
const contractBytes=fs.readFileSync(contractPath), c=JSON.parse(contractBytes);
assert(hash(contractBytes)===contractHash && canonical(c).equals(contractBytes),'contract digest/canonical drift');
assert(c.executor.path===selfPath && hash(fs.readFileSync(selfPath))===c.executor.sha256,'reviewed executor drift');
for(const source of [...c.executor.dependencies,...c.verification.frozen_modules])assert(hash(fs.readFileSync(source.source))===source.sha256 && fs.statSync(source.source).size===source.byte_length,'dependency drift before import');
const original=c.live_prestate.original_wrapper, wrapper=c.targets.find(t=>t.target===original.path);
Object.assign(process.env,c.verification.environment);
for(const k of ['NODE_OPTIONS','OPENAI_API_KEY','LCB_VERIFY_OPENAI_API_KEY','CONTROL_PLANE_API_KEY','OPENAI_ADMIN_KEY','LCB_RUNTIME_PROOF_CONFIG']) delete process.env[k];
const {gate,tunnelSnapshot,restartForRollback,verifyRollbackAttempt}=await import(pathToFileURL(path.join(repo,'scripts/bootstrap-method.mjs')));
const production=c.scope.production, agent=c.scope.agent;
const stageName = target => path.join(path.dirname(target),`.lcb-bootstrap-${invocation}-${path.basename(target)}.tmp`);
let backup, invocation, manifestDigest, manifest, ledger=[], mutated=false, replaced=false, wrapperReplacement, applyRestart=false, rollbackRestart=false;
let verifyLive,verifyDaemon,daemonConfig,remoteModels;
const ownedProofPids=new Set();
const retainedScratch=new Map();
const pendingProofRecords=[];
const proofRecord = record => {
  if(record.child?.pid)ownedProofPids.add(record.child.pid);
  const directory=typeof record.directory==='string'?record.directory:record.directory?.path;
  if(record.action==='proof_cleanup'||record.action==='remote_scratch_cleanup'){
    const result=record.cleanup??record;
    if(result.ok)retainedScratch.delete(directory);else retainedScratch.set(directory,{path:directory,classification:'scratch_ownership_unknown',retained_paths:result.retained_paths});
  }
  if(backup)append('owned-targets.jsonl',{invocation,...record});else pendingProofRecords.push(record);
};
const remoteGate = options => remoteModels({...options,record:proofRecord});
const tunnelOnly = (deadline=Date.now()+15000) => tunnelSnapshot(c.service_identity, (file,args) => run(file,args,deadline));
const meta = file => {
  const s=fs.lstatSync(file);
  return {path:file,dev:s.dev,ino:s.ino,type:s.isFile()?'file':s.isDirectory()?'directory':s.isSocket()?'socket':s.isSymbolicLink()?'symlink':'other',mode:'0'+(s.mode&0o7777).toString(8),uid:s.uid,gid:s.gid,...(s.isFile()?{length:s.size}: {})};
};
const identify = file => ({...meta(file),...(fs.lstatSync(file).isFile()?{sha256:hash(fs.readFileSync(file))}: {})});
const absent = file => { try {fs.lstatSync(file);return false;} catch(e){if(e.code==='ENOENT')return true;throw e;} };
const fsyncDir = dir => {const fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);} };
const ancestors = file => {
  let current='/';
  for(const part of file.split('/').filter(Boolean)){
    current=path.join(current,part);
    if(absent(current))break;
    assert(!fs.lstatSync(current).isSymbolicLink() && fs.realpathSync(current)===current,'ancestor alias: '+current);
  }
};
const sameMeta = (a,b) => ['path','dev','ino','type','mode','uid','gid'].every(k=>a[k]===b[k]);
const sameOwned = (a,b) => sameMeta(a,b) && (a.type!=='file'||a.sha256===b.sha256 && a.length===b.length);
const checkFile = (file,digest,len,mode) => {
  ancestors(file); const x=identify(file);
  assert(x.type==='file' && x.uid===502 && x.gid===20 && (!mode||x.mode===mode) && (!digest||x.sha256===digest) && (len==null||x.length===len),'file identity: '+file); return x;
};
const run = (file,args,deadline=Date.now()+15000) => {
  const budget=Math.min(15000,deadline-Date.now()); assert(budget>0,'deadline');
  const r=spawnSync(file,args,{encoding:'utf8',timeout:budget,killSignal:'SIGKILL',maxBuffer:1024*1024});
  assert(r.status===0 && !r.error,'command failed: '+path.basename(file)); return r.stdout;
};
const osIdentity = (pid,deadline) => {
  const m=run('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,uid=,lstart='],deadline).trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  assert(m,'OS identity'); return {pid:Number(m[1]),ppid:Number(m[2]),uid:Number(m[3]),start:m[4]};
};
const native = (kind,deadline=Date.now()+15000) => {
  const service=tunnelOnly(deadline), pid=service.tunnel.pid;
  const expected=kind==='old'?c.service_identity.old_bridge_command:process.env.LCB_NODE+' --import '+process.env.LCB_DAEMON_ATTEST_HOOK+' '+production+'/dist/src/index.js';
  const children=run('/bin/ps',['-axo','pid=,ppid='],deadline).trim().split('\n').map(x=>x.trim().split(/\s+/).map(Number)).filter(x=>x[1]===pid);
  const bridges=children.filter(([child])=>run('/bin/ps',['-p',String(child),'-o','command='],deadline).trim()===expected);
  assert(bridges.length===1,'unique direct Bridge'); const bridge=osIdentity(bridges[0][0],deadline);
  assert(bridge.uid===502 && bridge.ppid===pid,'Bridge UID/parent');
  return {...service,bridge,bridge_command:expected};
};
const baseline = (kind) => {
  assert(sameMeta(meta(c.backup.root),c.backup.prestate) && fs.realpathSync(c.backup.root)===c.backup.root,'preserved backup root drift');
  assert(run('/usr/bin/git',['-C',repo,'rev-parse','HEAD'],undefined).trim()===head,'repo HEAD drift');
  assert(run('/usr/bin/git',['-C',repo,'status','--porcelain'],undefined).trim()==='','repo dirty');
  assert(run('/usr/bin/git',['-C',production,'rev-parse','HEAD']).trim()===c.live_prestate.production_git_head,'production HEAD drift');
  assert(hash(fs.readFileSync(path.join(production,'.git/index')))===c.live_prestate.production_git_index_sha256,'production index drift');
  const diskDist={};
  const walk = (rel) => {for(const x of fs.readdirSync(path.join(production,rel),{withFileTypes:true})){const next=path.posix.join(rel,x.name); if(x.isDirectory())walk(next);else {assert(x.isFile()&&!x.isSymbolicLink(),'dist type');diskDist[next]=hash(fs.readFileSync(path.join(production,next)));}}};
  walk('dist'); assert(canonical(diskDist).equals(canonical(c.live_prestate.production_dist_sha256)),'complete production dist drift');
  for(const [file,digest] of Object.entries(c.live_prestate.unchanged_host_code_sha256))assert(hash(fs.readFileSync(file))===digest,'host hash drift: '+file);
  for(const expected of c.live_prestate.parent_directories)assert(sameMeta(meta(expected.path),expected),'preserved parent drift: '+expected.path);
  if(kind==='old') {const x=checkFile(original.path,original.sha256,original.byte_length,original.mode);assert(fs.readFileSync(original.path).equals(Buffer.from(original.bytes)),'original bytes');if(!mutated)assert(sameMeta(x,original),'original inode drift');}
  else {checkFile(wrapper.target,wrapper.sha256,wrapper.byte_length,wrapper.mode);for(const t of c.targets.filter(t=>t.type==='file'&&t!==wrapper))checkFile(t.target,t.sha256,t.byte_length,t.mode);for(const t of c.targets.filter(t=>t.type==='directory'))assert(sameMeta(meta(t.target),ledger.find(x=>x.path===t.target)),'owned dir drift');}
};
const frozenSources = async () => {
  assert(c.executor.path===selfPath && hash(fs.readFileSync(selfPath))===c.executor.sha256,'reviewed executor drift');
  for(const t of c.executor.dependencies)assert(hash(fs.readFileSync(t.source))===t.sha256 && fs.statSync(t.source).size===t.byte_length,'executor dependency drift');
  assert(hash(fs.readFileSync(contractPath))===contractHash,'contract changed');
  assert(fs.realpathSync(process.env.LCB_NODE)===process.env.LCB_NODE,'Node canonical path');
  for(const file of [c.release_anchor.archive,c.release_anchor.manifest,c.release_anchor.trust_verifier])ancestors(file);
  assert(hash(fs.readFileSync(c.release_anchor.archive))===c.release_anchor.archive_sha256,'archive drift');
  assert(hash(fs.readFileSync(c.release_anchor.manifest))===c.release_anchor.manifest_sha256,'release manifest drift');
  assert(hash(fs.readFileSync(c.release_anchor.trust_verifier))===c.release_anchor.trust_verifier_sha256,'trust verifier drift');
  const trust=await import(pathToFileURL(c.release_anchor.trust_verifier));
  const verified=trust.verifyAnchoredPackage(c.release_anchor.candidate);
  assert(verified.ok && verified.files===128 && verified.links===0,'candidate anchor');
  for(const t of [...c.targets.filter(t=>t.source),...c.verification.frozen_modules])assert(hash(fs.readFileSync(t.source))===t.sha256 && fs.statSync(t.source).size===t.byte_length,'frozen source drift');
  assert(hash(Buffer.from(wrapper.proposed_bytes))===wrapper.sha256 && Buffer.byteLength(wrapper.proposed_bytes)===wrapper.byte_length,'proposed wrapper drift');
  return verified;
};
const append = (name,entry) => {
  const fd=fs.openSync(path.join(backup,name),fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW);
  try{fs.writeFileSync(fd,canonical(entry));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
};
const record = entry => {const x={invocation,created_by_this_invocation:true,...entry};ledger.push(x);append('owned-targets.jsonl',x);};
const exclusive = (file,bytes,mode=0o600) => {
  assert(absent(file),'exclusive target exists: '+file);ancestors(path.dirname(file));
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);
  try{fs.writeFileSync(fd,bytes);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  assert(meta(file).uid===502 && meta(file).gid===20,'exclusive owner');fsyncDir(path.dirname(file));return identify(file);
};
const mkdir = (dir,withLedger=false) => {
  ancestors(path.dirname(dir));assert(absent(dir),'directory unexpectedly present: '+dir);
  fs.mkdirSync(dir,{mode:0o700}); fsyncDir(path.dirname(dir)); const x=meta(dir);
  assert(x.mode==='0700'&&x.uid===502&&x.gid===20&&fs.realpathSync(dir)===dir,'created directory metadata');
  if(withLedger)record(x); return x;
};
const restoreGuard = () => {
  assert(sameMeta(meta(c.backup.root),c.backup.prestate),'backup root identity drift');
  const ownedDirectory=ledger.find(x=>x.path===backup && x.action==='backup_invocation');
  assert(ownedDirectory?.created_by_this_invocation===true && sameMeta(ownedDirectory,manifest.backup_invocation_directory_identity) && sameMeta(meta(backup),manifest.backup_invocation_directory_identity),'backup invocation identity drift');
  assert(sameMeta(meta(path.join(backup,'owned-targets.jsonl')),manifest.ownership_ledger_identity),'backup ledger identity drift');
  assert(hash(fs.readFileSync(path.join(backup,'manifest.json')))===manifestDigest,'frozen manifest mismatch');
  assert(hash(fs.readFileSync(path.join(backup,'contract.json')))===contractHash,'frozen contract mismatch');
  if(manifest.native_preflight_evidence)assert(sameOwned(identify(manifest.native_preflight_evidence.path),manifest.native_preflight_evidence) && manifest.native_preflight_evidence.path===path.join(backup,'native-preflight.json'),'native preflight evidence identity drift');
  const bytes=fs.readFileSync(path.join(backup,'original-wrapper.bin'));
  assert(sameOwned(identify(path.join(backup,'original-wrapper.bin')),manifest.backup_wrapper_sha256_and_length),'backup wrapper identity drift');
  assert(hash(bytes)===original.sha256&&bytes.length===385&&bytes.equals(Buffer.from(original.bytes)),'frozen wrapper mismatch');
  assert(fs.readFileSync(path.join(backup,'manifest.sha256'),'utf8')===manifestDigest+'\n','frozen digest file mismatch');
};
const replace = (target,bytes,mode,expectedPrior) => {
  const staging=stageName(target); const st=exclusive(staging,bytes,parseInt(mode,8)); record({...st,action:'stage'});
  assert(st.sha256===hash(bytes)&&st.length===bytes.length&&st.mode===mode,'staging verify');
  if(expectedPrior)assert(sameOwned(identify(target),expectedPrior),'replacement target drift');else assert(absent(target),'absent target race');
  // Persist the recovery identity before rename; post-rename readback is not its authority.
  const intent={action:'replacement_intent',destination:target,stage:st,expected_prior:expectedPrior??{path:target,state:'absent'}};
  record(intent);
  if(target===original.path && bytes.equals(Buffer.from(wrapper.proposed_bytes)))wrapperReplacement={...st,path:target};
  assert(sameOwned(identify(staging),st),'replacement stage drift');
  fs.renameSync(staging,target);
  if(target===original.path)replaced=true;
  ledger.push({invocation,created_by_this_invocation:true,...st,path:target,action:'replace_pending',staging});
  fsyncDir(path.dirname(target));
  const installed=identify(target);assert(sameMeta({...st,path:target},installed)&&installed.sha256===st.sha256,'rename identity');record({...installed,action:'replace',staging});return installed;
};
const loadGates = async () => {
  ({verifyLive}=await import(pathToFileURL(c.verification.modules.verifyLive)));
  ({verifyDaemon,daemonConfig}=await import(pathToFileURL(c.verification.modules.daemon)));
  ({remoteModels}=await import(pathToFileURL(c.verification.modules.remoteModels)));
};
const errorClass = error => String(error?.message??error).slice(0,180);
const preflight = async () => {
  assert(process.getuid()===502 && process.getgid()===20,'uid/gid');
  for(const file of [...c.scope.host_target_allowlist,c.backup.root])ancestors(file);
  for(const file of c.live_prestate.absent_paths)assert(absent(file),'preflight absence drift: '+file);
  baseline('old');const anchored=await frozenSources();const before=native('old');
  const health=await verifyLive({wrapper:true,deadline:Date.now()+90000});
  assert(health.ok&&health.control_plane.pid===before.tunnel.pid,'original service health/control/wrapper');
  // Real native RPC + child close + owned scratch cleanup must succeed before
  // creating backup evidence or touching any bootstrap target.
  const native_preflight=await remoteGate({deadline:Date.now()+90000});
  assert(native_preflight.ok && native_preflight.cleanup?.ok && retainedScratch.size===0,'native preflight RPC/scratch cleanup');
  const after=native('old');assert(canonical(before).equals(canonical(after)),'original service identity instability');
  baseline('old');return {ok:true,anchor:anchored,health,native_preflight,identity:after,baseline_daemon_attestation:'unavailable',production_version:JSON.parse(fs.readFileSync(path.join(production,'package.json'))).version};
};
const prepare = async () => {
  await frozenSources();await loadGates();const pre=await preflight();
  invocation='bootstrap-'+new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomBytes(16).toString('hex');
  assert(/^bootstrap-\d{8}T\d{9}Z-[a-f0-9]{32}$/.test(invocation),'invocation format');
  const backupRoot=meta(c.backup.root);assert(sameMeta(backupRoot,c.backup.prestate) && fs.realpathSync(c.backup.root)===c.backup.root,'preserved backup root drift');backup=path.join(c.backup.root,invocation);const backupDir=mkdir(backup);
  exclusive(path.join(backup,'owned-targets.jsonl'),Buffer.alloc(0));exclusive(path.join(backup,'verification-attempts.jsonl'),Buffer.alloc(0));
  append('owned-targets.jsonl',{invocation,...backupRoot,action:'preserved_backup_root',created_by_this_invocation:false});record({...backupDir,action:'backup_invocation'});
  // Preflight lifecycle evidence is outside CODEX_HOME and does not change the
  // exactly-two-record prepared ownership ledger required by execute.
  const preflightEvidence=exclusive(path.join(backup,'native-preflight.json'),canonical({records:pendingProofRecords,result:pre.native_preflight}));
  exclusive(path.join(backup,'contract.json'),contractBytes);exclusive(path.join(backup,'original-wrapper.bin'),fs.readFileSync(original.path));
  manifest={schema:3,invocation_id:invocation,contract_sha256:contractHash,candidate7_frozen_anchor:c.release_anchor,refreshed_at:new Date().toISOString(),execution_git_head:head,backup_invocation_directory_identity:backupDir,ownership_ledger_identity:meta(path.join(backup,'owned-targets.jsonl')),uid:502,gid:20,
    original_wrapper_bytes_sha256_length_mode_uid_gid_dev_ino:identify(original.path),backup_wrapper_sha256_and_length:identify(path.join(backup,'original-wrapper.bin')),
    all_target_prestates_including_absent_parent_run:c.targets.map(t=>t.prestate),backup_root_prestate_and_created_by_this_invocation:{prestate:c.backup.prestate,current:backupRoot,created_by_this_invocation:false},
    preserved_parent_directory_identity:c.live_prestate.parent_directories,production_dist_hashes:c.live_prestate.production_dist_sha256,production_git_head_index_sha256:{head:c.live_prestate.production_git_head,index_sha256:c.live_prestate.production_git_index_sha256},
    unchanged_host_code_hashes:c.live_prestate.unchanged_host_code_sha256,exact_launchagent_tunnel_direct_bridge_os_identity:pre.identity,install_source_hashes_lengths:c.targets.filter(t=>t.source).map(t=>({source:t.source,sha256:t.sha256,length:t.byte_length})),
    proposed_wrapper_hash_length_mode_uid_gid:{sha256:wrapper.sha256,length:wrapper.byte_length,mode:wrapper.mode,uid:502,gid:20},preflight:pre,native_preflight_evidence:preflightEvidence,executor:{path:selfPath,sha256:hash(fs.readFileSync(selfPath))}};
  const bytes=canonical(manifest);exclusive(path.join(backup,'manifest.json'),bytes);manifestDigest=hash(bytes);exclusive(path.join(backup,'manifest.sha256'),Buffer.from(manifestDigest+'\n'));fsyncDir(backup);
  restoreGuard();baseline('old');for(const t of c.targets)if(t.prestate.state==='absent')assert(absent(t.target),'freeze target absence');
  return {status:'prepared',invocation,backup,contract_sha256:contractHash,manifest_sha256:manifestDigest,executor_sha256:manifest.executor.sha256,preflight:pre,target_mutations:0};
};
const delay = async (ms,deadline) => {const remaining=deadline-Date.now();if(remaining>0)await new Promise(r=>setTimeout(r,Math.min(ms,remaining)));};
const kick = () => {
  const r=spawnSync('/bin/launchctl',['kickstart','-k',agent],{encoding:'utf8',timeout:15000,killSignal:'SIGKILL',maxBuffer:32768});
  return {command:['/bin/launchctl','kickstart','-k',agent],status:r.status,signal:r.signal,error:r.error?.code??null,stdout_bytes:Buffer.byteLength(r.stdout??''),stderr_bytes:Buffer.byteLength(r.stderr??'')};
};
const attemptRecord = value => append('verification-attempts.jsonl',{...value,contract_sha256:contractHash,manifest_sha256:manifestDigest});
const acceptNew = async (deadline,before) => {
  const started=Date.now();
  for(let attempt=1;attempt<=c.verification.max_attempts && Date.now()<deadline;attempt++){
    const rec={phase:'apply',attempt,elapsed_ms:Date.now()-started,gates:{health:'not_run',wrapper:'not_run',establish_remote:'not_run',exact_tunnel:'not_run',daemon:'not_run',remote:'not_run',daemon_after:'not_run',final_identity:'not_run'},scratch_cleanup:[]};
    try{
      let live;
      await gate(rec,'health',async()=>{live=await verifyLive({wrapper:true,runtimeProof:{root:production,hashes:c.verification.baseline_modules,record:proofRecord},deadline});rec.healthz=live.healthz;rec.readyz=live.readyz;rec.control_plane=live.control_plane;rec.wrapper=live.wrapper;if(live.wrapper?.runtime_proof_cleanup)rec.scratch_cleanup.push(live.wrapper.runtime_proof_cleanup.cleanup);assert(live.healthz?.ok&&live.readyz?.ok&&live.control_plane?.ok,'new health failed');});
      await gate(rec,'wrapper',async()=>assert(live.wrapper?.verification_ok ?? live.wrapper?.ok,'new wrapper failed'));
      if(rec.scratch_cleanup.some(x=>!x.ok)){rec.failure_domain='scratch_cleanup';throw new Error('owned scratch cleanup failed');}
      await gate(rec,'establish_remote',async()=>{const value=await remoteGate({deadline});rec.remote_establishment=value;assert(value.ok,'remote establishment');});
      let snapshot;await gate(rec,'exact_tunnel',async()=>{snapshot=native('new',deadline);assert(snapshot.tunnel.pid!==before.tunnel.pid&&snapshot.tunnel.start!==before.tunnel.start&&live.control_plane.pid===snapshot.tunnel.pid,'new Tunnel replacement');});
      let proof;await gate(rec,'daemon',async()=>{proof=await verifyDaemon(daemonConfig(production,c.verification.baseline_modules,agent),{deadline});rec.daemon_loaded_runtime=proof;assert(proof.tunnel_pid===snapshot.tunnel.pid,'daemon tunnel mismatch');});
      await gate(rec,'remote',async()=>{const value=await remoteGate({deadline});rec.remote_codex_models=value;assert(value.ok,'remote gate');});
      await gate(rec,'daemon_after',async()=>{const second=await verifyDaemon(daemonConfig(production,c.verification.baseline_modules,agent),{deadline});rec.daemon_after=second;assert(['pid','start','instance_id','tunnel_pid'].every(k=>proof[k]===second[k]),'daemon stability after remote');});
      await gate(rec,'final_identity',async()=>{const final=native('new',deadline);assert(canonical(snapshot).equals(canonical(final)),'final identity stability');baseline('new');await frozenSources();restoreGuard();assert(Date.now()<deadline,'acceptance deadline');rec.identity=final;});
      rec.ok=true;attemptRecord(rec);return rec;
    }catch(e){rec.ok=false;rec.error_classification=errorClass(e);rec.failure_domain??=e.message.includes('scratch')?'scratch_cleanup':'verification_gate';attemptRecord(rec);if(rec.failure_domain==='scratch_cleanup')throw e;await delay(5000,deadline);}
  }throw new Error('new service shared acceptance window failed');
};
const cleanupOwned = () => {
  for(const pid of ownedProofPids){let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}assert(!alive,'owned probe still alive');}
  for(const x of ledger.filter(x=>x.type==='file'&&!x.path.startsWith(c.backup.root)&&x.path!==original.path).reverse()){
    if(absent(x.path))continue;assert(sameOwned(identify(x.path),x),'cleanup owned file drift: '+x.path);fs.unlinkSync(x.path);fsyncDir(path.dirname(x.path));append('owned-targets.jsonl',{invocation,action:'owned_unlink',path:x.path});
  }
  const retained=[...retainedScratch.keys()];
  for(const dir of c.rollback.directory_cleanup_order){if(absent(dir))continue;const x=ledger.find(x=>x.path===dir&&x.type==='directory');assert(x&&sameMeta(meta(dir),x),'cleanup owned directory drift');if(fs.readdirSync(dir).length){retained.push(dir);continue;}fs.rmdirSync(dir);fsyncDir(path.dirname(dir));append('owned-targets.jsonl',{invocation,action:'owned_rmdir',path:dir});}
  return retained;
};
const rollback = async (before) => {
  restoreGuard();const result={attempted:true};
  if(replaced){const own=wrapperReplacement;assert(own&&sameOwned(identify(original.path),own),'rollback wrapper ownership');replace(original.path,fs.readFileSync(path.join(backup,'original-wrapper.bin')),original.mode,own);result.wrapper_restored=true;}
  else checkFile(original.path,original.sha256,385,'0700');
  Object.assign(result,await restartForRollback({applyRestart,readTunnel:()=>tunnelOnly(),restoreGuard:()=>{restoreGuard();baseline('old');},kick:()=>{rollbackRestart=true;return kick();}}));
  if(applyRestart)assert(result.restart.status===0,'rollback restart uncertain');
  const deadline=Date.now()+90000;let restored;
  for(let attempt=1;attempt<=18&&Date.now()<deadline;attempt++){
    const rec={phase:'rollback',attempt,gates:{exact_tunnel:'not_run',health:'not_run',wrapper:'not_run',remote:'not_run',final_identity:'not_run'},scratch_cleanup:[]};
    try{
      await verifyRollbackAttempt({record:rec,applyRestart,originalBefore:before,restartBefore:result.restart_before,baseline:()=>baseline('old'),readIdentity:()=>native('old',deadline),verifyLive:()=>verifyLive({wrapper:true,deadline}),remoteModels:()=>remoteGate({deadline}),restoreGuard,deadline});
      attemptRecord(rec);restored=rec;break;
    }catch(e){rec.ok=false;rec.error_classification=errorClass(e);rec.failure_domain=e.message.includes('scratch')?'scratch_cleanup':'verification_gate';attemptRecord(rec);if(rec.failure_domain==='scratch_cleanup')throw e;await delay(5000,deadline);}}
  assert(restored,'MANUAL_RECOVERY_REQUIRED: old service unverified');result.old_service_restored=true;result.baseline_daemon_attestation='unavailable';result.verification=restored;
  result.retained_paths=cleanupOwned();result.cleanup_incomplete=result.retained_paths.length>0;result.rolled_back=!result.cleanup_incomplete;return result;
};
const execute = async () => {
  backup=backupPath;manifestDigest=manifestHash;assert(/^\/[\s\S]+$/.test(backup??'')&&/^[a-f0-9]{64}$/.test(manifestDigest??''),'external invocation args');
  ancestors(backup);const manifestBytes=fs.readFileSync(path.join(backup,'manifest.json'));
  assert(hash(manifestBytes)===manifestDigest,'external frozen manifest mismatch');
  manifest=JSON.parse(manifestBytes);assert(canonical(manifest).equals(manifestBytes),'manifest canonical drift');invocation=manifest.invocation_id;
  assert(/^bootstrap-\d{8}T\d{9}Z-[a-f0-9]{32}$/.test(invocation) && backup===path.join(c.backup.root,invocation) && manifest.execution_git_head===head && manifest.contract_sha256===contractHash,'invocation path/head/contract');
  assert(sameMeta(meta(c.backup.root),c.backup.prestate) && sameMeta(meta(backup),manifest.backup_invocation_directory_identity),'frozen backup invocation identity drift');
  const ledgerPath=path.join(backup,'owned-targets.jsonl');assert(sameMeta(meta(ledgerPath),manifest.ownership_ledger_identity) && manifest.ownership_ledger_identity.path===ledgerPath && manifest.ownership_ledger_identity.type==='file' && manifest.ownership_ledger_identity.mode==='0600' && manifest.ownership_ledger_identity.uid===502 && manifest.ownership_ledger_identity.gid===20,'frozen backup ledger identity drift');
  ledger=fs.readFileSync(ledgerPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert(ledger.length===2 && ledger.every(x=>x.invocation===invocation) && ledger[0].action==='preserved_backup_root' && ledger[0].created_by_this_invocation===false && sameMeta(ledger[0],c.backup.prestate) && ledger[1].action==='backup_invocation' && ledger[1].created_by_this_invocation===true && sameMeta(ledger[1],manifest.backup_invocation_directory_identity),'illegal prepared ownership ledger');
  assert(hash(fs.readFileSync(selfPath))===manifest.executor.sha256,'executor drift');restoreGuard();await frozenSources();await loadGates();
  let receipt={schema:2,task_id:'LCB-BOOTSTRAP-21',status:'blocked',contract_sha256:contractHash,manifest_sha256:manifestDigest,invocation,backup,production_modified:false,candidate_deployed:false,execution_record:{effective_model:'unknown',requested_model:'gpt-6-sol',requested_effort:'high',requested_role:'difficult',attempts:1,usage:'unknown'}};
  let before;
  try{
    for(const t of c.targets)if(t.prestate.state==='absent')assert(absent(t.target),'apply absence drift');baseline('old');await frozenSources();before=native('old');
    const live=await verifyLive({wrapper:true,deadline:Date.now()+90000});assert(live.ok&&live.control_plane.pid===before.tunnel.pid,'apply original preflight');
    const nativePreflight=await remoteGate({deadline:Date.now()+90000});assert(nativePreflight.ok&&nativePreflight.cleanup?.ok&&retainedScratch.size===0,'apply native preflight RPC/scratch cleanup');
    assert(canonical(native('old')).equals(canonical(before)),'apply old identity');receipt.preflight={ok:true,health:live,native_preflight:nativePreflight,identity:before};restoreGuard();baseline('old');
    for(const t of c.targets)if(t.prestate.state==='absent')assert(absent(t.target),'first write absence');
    mutated=true;for(const t of c.targets.filter(t=>t.type==='directory'))mkdir(t.target,true);
    for(const t of c.targets.filter(t=>t.source))replace(t.target,fs.readFileSync(t.source),t.mode);
    baseline('old');await frozenSources();restoreGuard();const currentOriginal=identify(original.path);assert(sameMeta(currentOriginal,original),'wrapper original inode');
    replace(wrapper.target,Buffer.from(wrapper.proposed_bytes),wrapper.mode,currentOriginal);
    baseline('new');restoreGuard();await frozenSources();receipt.restart_before=native('old');applyRestart=true;receipt.restart=kick();const deadline=Date.now()+90000;receipt.acceptance_deadline=new Date(deadline).toISOString();assert(receipt.restart.status===0,'apply kickstart uncertain');
    receipt.validation=await acceptNew(deadline,receipt.restart_before);receipt.status='bootstrapped';receipt.old_production_version=manifest.preflight.production_version;
    receipt.new_host_hashes=Object.fromEntries(c.targets.filter(t=>t.type==='file').map(t=>[t.target,identify(t.target)]));receipt.attestation=receipt.validation.daemon_loaded_runtime;receipt.remote_route=receipt.validation.remote_codex_models;
    receipt.rollback={attempted:false};receipt.next_action='independent bootstrap review, then reseal new candidate with new host hashes before authorized candidate deploy';
  }catch(e){receipt.failure=errorClass(e);if(e.failure_domain==='scratch_cleanup')receipt.native_cleanup_failure={rpc:e.verification_result??null,cleanup:e.cleanup,rpc_error:e.rpc_error??null};if(mutated){try{receipt.rollback=await rollback(before);receipt.status=receipt.rollback.rolled_back?'rolled_back':'blocked';}catch(re){receipt.rollback={attempted:true,error_classification:errorClass(re),manual_recovery_required:true};receipt.status='blocked';}}}
  receipt.scratch_cleanup={ok:retainedScratch.size===0,retained:[...retainedScratch.values()]};
  receipt.mutations=ledger.filter(x=>typeof x.path==='string'&&!x.path.startsWith(c.backup.root)&&!x.action?.startsWith('scratch'));receipt.apply_restart_attempted=applyRestart;receipt.rollback_restart_attempted=rollbackRestart;receipt.completed_at=new Date().toISOString();
  exclusive(path.join(backup,'result.json'),canonical(receipt));return receipt;
};
try{if(phase==='prepare')return await prepare();if(phase==='execute')return await execute();throw new Error('explicit phase required');}
catch(e){return {status:'blocked',error_classification:errorClass(e),backup:backup??null,host_target_mutations:mutated,verification_result:e.verification_result??null,scratch_cleanup:{ok:retainedScratch.size===0,retained:[...retainedScratch.values()]},native_preflight_records:pendingProofRecords};}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [phase,contractPath,contractHash,head,backupPath,manifestHash]=process.argv.slice(2);
    const result=await runBootstrap({phase,contractPath,contractHash,head,backupPath,manifestHash});
    console.log(JSON.stringify(result));if(result.status==='blocked')process.exitCode=1;
  } catch(e){console.log(JSON.stringify({status:'blocked',error_classification:String(e.message).slice(0,180),host_target_mutations:false}));process.exitCode=1;}
}
