/** Consume only fresh boolean facts from the required shared-door browser tests.
 * The auxiliary in-memory household seeds member/session metadata; actual
 * WebAuthn ceremonies and visible controls use the same compiled app/Root door.
 * These facts do not prove push delivery, copied-key rejection or all callers. */
import {readFileSync,writeFileSync,statSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rebuildReport} from './rebuild-report.mjs';
const specs={
 passkey:{file:'passkey.json',keys:['realPasskeyRegistered','realPasskeySignin','counterIncreased','passkeyRemoved','oneTimeLinkRedeemedOnce','deviceLogout']},
 browsers:{file:'account-session.json',keys:['anotherBrowserRevoked','notificationEnabled','notificationRemoved','currentBrowserRevoked','signInScreenRestored','identityConfirmedSignedOut','oneTimeLinkMadeAndHidden']},
};
export function proofFact(value,{modifiedAt,startedAt,now=Date.now(),keys,proof}){
 if(!Number.isFinite(modifiedAt)||!Number.isFinite(now)||!Number.isFinite(Date.parse(startedAt))||modifiedAt<Date.parse(startedAt)||modifiedAt>now+5000)return{inconclusive:true,reason:'The auxiliary browser proof is not from this walkthrough execution.'};
 if(!value||value.completed!==true||keys.some(key=>typeof value[key]!=='boolean'))return{inconclusive:true,reason:'The auxiliary browser proof did not complete its required boolean facts.'};
 const failed=keys.filter(key=>value[key]!==true);
 return failed.length?{ok:false,error:'The auxiliary browser proof failed: '+failed.join(', '),proof}:{ok:true,proof};
}
export function attachSigninEvidence({out,directory,environment=process.env,now=Date.now(),required=false}){
 const file=join(out,'walkthrough.json'),run=JSON.parse(readFileSync(file,'utf8'));
 if((environment.GITHUB_SHA??null)!==(run.source?.commit??null)||(environment.GITHUB_RUN_ID??null)!==(run.source?.run??null)||(environment.GITHUB_RUN_ATTEMPT??null)!==(run.source?.attempt??null))throw Error('Sign-in evidence and walkthrough execution identities differ');
 const facts={},observations={};mkdirSync(join(out,'signin'),{recursive:true});
 for(const [name,spec]of Object.entries(specs)){
  const proof='signin/'+spec.file;
  rmSync(join(out,proof),{force:true});
  try{
   const source=join(directory,spec.file),bytes=readFileSync(source),value=JSON.parse(bytes.toString('utf8'));
   facts[name]=proofFact(value,{modifiedAt:statSync(source).mtimeMs,startedAt:run.startedAt,now,keys:spec.keys,proof});
   // Copy only the named boolean contract, never unrecognized producer fields.
   if(!facts[name].inconclusive){observations[name]=value;writeFileSync(join(out,proof),JSON.stringify({completed:value.completed,...Object.fromEntries(spec.keys.map(key=>[key,value[key]]))},null,2)+'\n');}
  }catch{facts[name]={inconclusive:true,reason:'The required auxiliary browser proof is unavailable.'};}
 }
 const domain=(name,keys)=>{
  if(!observations[name])return facts[name];
  const failed=keys.filter(key=>observations[name][key]!==true),proof=facts[name].proof;
  return failed.length?{ok:false,error:'The auxiliary browser proof failed: '+failed.join(', '),proof}:{ok:true,proof};
 };
 const described=(fact,reason)=>fact.ok===true?{...fact,reason}:fact;
 run.actions??={};
 run.actions.signinPasskey=described(domain('passkey',['realPasskeySignin','oneTimeLinkRedeemedOnce']),'Real browser virtual-WebAuthn sign-in and one-use link redemption completed against the shared identity door in a separate disposable household.');
 run.actions.signinPasskeyControls=described(domain('passkey',['passkeyRemoved']),'The passkey appeared in Account and its visible removal control removed it.');
 run.actions.signinBrowsers=described(domain('browsers',['anotherBrowserRevoked','currentBrowserRevoked','signInScreenRestored','identityConfirmedSignedOut']),'Visible Account controls listed and revoked another and the current browser, restoring the sign-in screen and confirmed null identity; pre-existing browser metadata was seeded in the isolated fixture.');
 run.actions.signinDevices=described(domain('browsers',['notificationEnabled','notificationRemoved']),'Notification controls enabled and removed the local browser subscription-port fixture; actual push delivery is not measured.');
 run.actions.signinMember=typeof run.signin?.personBrowser==='boolean'?(run.signin.personBrowser?{ok:true,reason:'The normal example-home sign-in session joins to the Alex member token and is a person browser.'}:{ok:false,error:'The example-home session did not match the expected Alex member and person-browser relation.'}):{inconclusive:true,reason:'The example-home session/member relation was not recorded.'};
 const counter=domain('passkey',['realPasskeySignin','counterIncreased']);
 run.actions.signinCounterRules=counter.ok===true?{inconclusive:true,proof:counter.proof,reason:'The real WebAuthn counter increased, but copied/lower counter rejection has not been exercised by this browser producer.'}:counter;
 const controls=[run.actions.signinPasskeyControls,run.actions.signinBrowsers,run.actions.signinDevices],failed=controls.find(row=>row.ok===false);
 run.actions.signinOwnSettings=failed??{inconclusive:true,reason:controls.some(row=>row.inconclusive)?'The own-credential controls were not completely measured.':'Own passkey, browser and notification controls were exercised; cross-member credential/device enumeration is not yet measured.'};
 run.finishedAt=new Date(now).toISOString();
 writeFileSync(file,JSON.stringify(run,null,2)+'\n');const report=rebuildReport(run,out);
 if(required&&Object.values(facts).some(fact=>fact.inconclusive))throw Error('Required sign-in browser evidence is unavailable, stale or incomplete');
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [out,directory]=process.argv.slice(2);if(!out||!directory)throw Error('Provide the walkthrough and auxiliary proof directories');
 console.log(JSON.stringify(attachSigninEvidence({out:resolve(out),directory:resolve(directory),required:true}).counts));
}
