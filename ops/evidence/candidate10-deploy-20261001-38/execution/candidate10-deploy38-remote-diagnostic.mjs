import fs from 'node:fs';
import {remoteModels} from '../releases/2.1.3-local.1-candidate.10/package/scripts/remote-model-probe.mjs';
import {verifyDaemon,daemonConfig} from '../releases/2.1.3-local.1-candidate.10/package/scripts/daemon-attestation.mjs';
const root='/Users/ZGH/Codex/Local-Codex-Bridge/.validation/candidate10-deploy38',records=[];
Object.assign(process.env,JSON.parse(fs.readFileSync('ops/runbooks/daemon-bootstrap-contract.current.json')).verification.environment);
const manifest=JSON.parse(fs.readFileSync('releases/2.1.3-local.1-candidate.10/package/manifest.json'));
let result;
try{result=await remoteModels({record:r=>{records.push(r);fs.writeFileSync(root+'/remote-diagnostic-ledger.json',JSON.stringify(records,null,2)+'\n',{mode:0o600});}});}catch(e){result={ok:false,error:e.message,failure_domain:e.failure_domain,verification_result:e.verification_result,rpc_error:e.rpc_error,cleanup:e.cleanup};}
const daemon=await verifyDaemon(daemonConfig(manifest.production,manifest.baseline,manifest.agent));
fs.writeFileSync(root+'/remote-diagnostic.json',JSON.stringify({result,daemon,records},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({ok:result.ok,error:result.error,rpc_error:result.rpc_error,cleanup:result.cleanup?{ok:result.cleanup.ok,error:result.cleanup.error,directory:result.cleanup.directory,child:result.cleanup.child,descendants_count:result.cleanup.descendants.length,retained_paths:result.cleanup.retained_paths,inventory_count:result.cleanup.inventory.length,open_files:result.cleanup.open_files}:null,daemon}));
