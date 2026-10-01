import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const repo='/Users/ZGH/Codex/Local-Codex-Bridge',source=repo+'/.validation/candidate10-deploy38',target=repo+'/ops/evidence/candidate10-deploy-20261001-38';
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const closeout=JSON.parse(fs.readFileSync(source+'/closeout.json'));if(closeout.state!=='deployed')throw Error('Expected complete production acceptance');
fs.mkdirSync(target,{mode:0o700});fs.mkdirSync(target+'/execution',{mode:0o700});
const files=fs.readdirSync(source).filter(n=>fs.lstatSync(source+'/'+n).isFile());
for(const name of files){if(!/\.(json|stdout|stderr)$/.test(name))throw Error('Unexpected evidence file');fs.copyFileSync(source+'/'+name,target+'/'+name,fs.constants.COPYFILE_EXCL);}
const scripts=['candidate10-deploy38.mjs','candidate10-deploy38-remote-diagnostic.mjs','candidate10-deploy38-retry.mjs','candidate10-deploy38-closeout.mjs','candidate10-deploy38-collect.mjs'];
for(const name of scripts)fs.copyFileSync(repo+'/.validation/'+name,target+'/execution/'+name,fs.constants.COPYFILE_EXCL);
// Archive complete allowlisted code/dist backups; native scratch/history/auth never enter evidence.
const backups=['deployment-8mQXxL','deployment-8KkHp8'];fs.mkdirSync(target+'/backups',{mode:0o700});
for(const name of backups)fs.cpSync(repo+'/deployment-backups/candidate10-deploy38/'+name,target+'/backups/'+name,{recursive:true,errorOnExist:true,force:false,filter:(s)=>{if(fs.lstatSync(s).isSymbolicLink())throw Error('Unexpected backup link');return true;}});
const inventory=[];
function walk(directory,relative=''){for(const name of fs.readdirSync(directory)){const file=path.join(directory,name),rel=path.posix.join(relative,name),s=fs.lstatSync(file);if(s.isDirectory())walk(file,rel);else{if(!s.isFile())throw Error('Unexpected evidence object');inventory.push({path:rel,bytes:s.size,sha256:sha(file)});}}}
walk(target);fs.writeFileSync(target+'/evidence-inventory.json',JSON.stringify({schema:1,task_id:closeout.task_id,files:inventory,complete_backup_archived:true,real_history_body_recorded:false,credential_body_recorded:false,timestamp:new Date().toISOString()},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({evidence:target,files:inventory.length,bytes:inventory.reduce((s,f)=>s+f.bytes,0),status:closeout.status}));
