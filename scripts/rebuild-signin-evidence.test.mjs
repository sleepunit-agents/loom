import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {accountProof,accountProofContext} from './rebuild-account-proof.mjs';
import {proofFact,attachSigninEvidence,main} from './rebuild-signin-evidence.mjs';
const passkey={completed:true,realPasskeyRegistered:true,realPasskeySignin:true,counterIncreased:true,copiedCounterRejected:true,noSessionAfterCopiedCounter:true,restoredCounterSignin:true,passkeyRemoved:true,oneTimeLinkRedeemedOnce:true,deviceLogout:true};
const browsers={completed:true,anotherBrowserRevoked:true,notificationEnabled:true,notificationDispatched:true,servedWorkerDisplayed:true,privateWordsExcluded:true,notificationRemoved:true,noDispatchAfterRemoval:true,currentBrowserRevoked:true,signInScreenRestored:true,identityConfirmedSignedOut:true,oneTimeLinkMadeAndHidden:true};
function fixture(run){
 const parent=mkdtempSync(join(tmpdir(),'loom-signin-consumer-')),out=join(parent,'walkthrough'),directory=join(parent,'producer'),environment={GITHUB_SHA:'commit',GITHUB_RUN_ID:'run',GITHUB_RUN_ATTEMPT:'1',LOOM_WALKTHROUGH_EVIDENCE_RUN:'execution-1'};
 let asynchronous=false;
 try{
  mkdirSync(out);mkdirSync(directory);const startedAt=new Date(Date.now()-1000).toISOString();
  writeFileSync(join(out,'walkthrough.json'),JSON.stringify({source:{commit:'commit',run:'run',attempt:'1'},evidenceRun:environment.LOOM_WALKTHROUGH_EVIDENCE_RUN,startedAt,finishedAt:startedAt,signin:{ok:true,personBrowser:true},actions:{},apps:[],inventory:[],example:{gaps:[]},live:{dataFrames:0,errors:[]}}));
  writeFileSync(join(directory,'passkey.json'),JSON.stringify({...accountProof(passkey,environment),rawToken:'DO_NOT_COPY_PRIVATE_FIELD'}));
  writeFileSync(join(directory,'account-session.json'),JSON.stringify(accountProof(browsers,environment)));
  const result=run({out,directory,environment,startedAt});
  if(result&&typeof result.then==='function'){asynchronous=true;return Promise.resolve(result).finally(()=>rmSync(parent,{recursive:true,force:true}));}
  return result;
 }finally{if(!asynchronous)rmSync(parent,{recursive:true,force:true});}
}
it('keeps stale, malformed and incomplete proof unknown, and preserves explicit negative facts',()=>{
 const now=Date.now(),startedAt=new Date(now-1000).toISOString(),options={modifiedAt:now,startedAt,now,keys:['measured'],proof:'signin/proof.json',context:accountProofContext({LOOM_WALKTHROUGH_EVIDENCE_RUN:'execution-1'})};
 expect(proofFact({_evidence:options.context,completed:true,measured:true},options)).toMatchObject({ok:true});
 expect(proofFact({_evidence:options.context,completed:true,measured:false},options)).toMatchObject({ok:false,error:expect.stringContaining('measured')});
 for(const value of [{completed:false,measured:true},{completed:true,measured:'true'},{}])expect(proofFact({...value,_evidence:options.context},options)).toHaveProperty('inconclusive',true);
 for(const modifiedAt of [now-2000,now+6000,NaN])expect(proofFact({_evidence:options.context,completed:true,measured:true},{...options,modifiedAt})).toHaveProperty('inconclusive',true);
});
it('binds only the complete supported promises, preserves partial limits and strips unknown fields',()=>fixture(options=>{
 const report=attachSigninEvidence(options),page=report.pages.find(row=>row.page==='signing-in'),status=id=>page.promises.find(row=>row.id===id).status;
 for(const id of ['signing-in-002','signing-in-004','signing-in-005','signing-in-006','signing-in-011'])expect(status(id)).toBe('met');
 for(const id of ['signing-in-003','signing-in-007','signing-in-013'])expect(status(id)).toBe('not checkable yet');
 expect(readFileSync(join(options.out,'signin/passkey.json'),'utf8')).not.toContain('PRIVATE_FIELD');
 const run=JSON.parse(readFileSync(join(options.out,'walkthrough.json'),'utf8'));
 expect(run.actions.signinPasskey.proof).toBe('signin/passkey.json');expect(run.finishedAt>=options.startedAt).toBe(true);
 expect(run.source).toEqual({commit:'commit',run:'run',attempt:'1'});
}));
it('makes a complete observed failure not met without claiming copied-key rules or delivery',()=>fixture(options=>{
 writeFileSync(join(options.directory,'passkey.json'),JSON.stringify(accountProof({...passkey,passkeyRemoved:false},options.environment)));
 const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
 expect(page.promises.find(row=>row.id==='signing-in-004')).toMatchObject({status:'not met',reason:expect.stringContaining('passkeyRemoved')});
 expect(page.promises.find(row=>row.id==='signing-in-011').status).toBe('met');
 expect(page.promises.find(row=>row.id==='signing-in-002').status).toBe('met');
}));
it('rejects a different commit/run/attempt before changing the report',()=>fixture(options=>{
 const before=readFileSync(join(options.out,'walkthrough.json'),'utf8');
 for(const key of ['GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])expect(()=>attachSigninEvidence({...options,environment:{...options.environment,[key]:'other'}})).toThrow('identities differ');
 expect(readFileSync(join(options.out,'walkthrough.json'),'utf8')).toBe(before);
}));
it('removes stale copied proof and leaves unavailable evidence unknown',()=>fixture(options=>{
 attachSigninEvidence(options);rmSync(join(options.directory,'passkey.json'));
 const old=Date.parse(options.startedAt)/1000-1;utimesSync(join(options.directory,'account-session.json'),old,old);
 const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
 expect(page.promises.find(row=>row.id==='signing-in-004').status).toBe('not checkable yet');
 expect(existsSync(join(options.out,'signin/passkey.json'))).toBe(false);expect(existsSync(join(options.out,'signin/account-session.json'))).toBe(false);
}));

it('preserves separate counter and notification failures without assigning them to unrelated promises',()=>{
 fixture(options=>{
  writeFileSync(join(options.directory,'passkey.json'),JSON.stringify(accountProof({...passkey,counterIncreased:false},options.environment)));
  const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
  expect(page.promises.find(row=>row.id==='signing-in-002').status).toBe('met');
  expect(page.promises.find(row=>row.id==='signing-in-004').status).toBe('met');
  expect(page.promises.find(row=>row.id==='signing-in-011').status).toBe('not met');
 });
 fixture(options=>{
  writeFileSync(join(options.directory,'account-session.json'),JSON.stringify(accountProof({...browsers,notificationEnabled:false},options.environment)));
  const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
  expect(page.promises.find(row=>row.id==='signing-in-004').status).toBe('met');
  expect(page.promises.find(row=>row.id==='signing-in-005').status).toBe('not met');
  expect(page.promises.find(row=>row.id==='signing-in-013').status).toBe('not met');
 });
});
it('fails required evidence collection after preserving an honest incomplete report',()=>fixture(options=>{
 rmSync(join(options.directory,'passkey.json'));
 expect(()=>attachSigninEvidence({...options,required:true})).toThrow('Required sign-in');
 const saved=JSON.parse(readFileSync(join(options.out,'report.json'),'utf8')).pages.find(row=>row.page==='signing-in');
 expect(saved.promises.find(row=>row.id==='signing-in-002').status).toBe('not checkable yet');
}));

it('rejects fresh copied producer proof from another source or execution',()=>fixture(options=>{
 for(const changed of [{GITHUB_SHA:'other'},{GITHUB_RUN_ID:'other'},{GITHUB_RUN_ATTEMPT:'other'},{LOOM_WALKTHROUGH_EVIDENCE_RUN:'other'}]){
  writeFileSync(join(options.directory,'passkey.json'),JSON.stringify(accountProof(passkey,{...options.environment,...changed})));
  const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
  expect(page.promises.find(row=>row.id==='signing-in-002').status).toBe('not checkable yet');
 }
}));
it('tests the actual CLI entry function required failure and preserved report without spawning a child',()=>fixture(options=>{
 rmSync(join(options.directory,'passkey.json'));const errors=[];
 expect(main([options.out,options.directory],{environment:options.environment,stdout:()=>{},stderr:text=>errors.push(text)})).toBe(1);
 expect(errors).toEqual(['Required sign-in browser evidence is unavailable, stale or incomplete']);
 const page=JSON.parse(readFileSync(join(options.out,'report.json'),'utf8')).pages.find(row=>row.page==='signing-in');
 expect(page.promises.find(row=>row.id==='signing-in-002').status).toBe('not checkable yet');
}));
it('records the producer context while refusing non-boolean private facts',()=>{
 const environment={GITHUB_SHA:'sha',GITHUB_RUN_ID:'run',GITHUB_RUN_ATTEMPT:'1',LOOM_WALKTHROUGH_EVIDENCE_RUN:'nonce'};
 expect(accountProof({completed:true,observed:true},environment)).toEqual({completed:true,observed:true,_evidence:accountProofContext(environment)});
 expect(()=>accountProof({completed:true,rawToken:'PRIVATE'},environment)).toThrow('booleans');
 expect(proofFact(accountProof({completed:true,measured:true},{}),{context:accountProofContext({}),keys:['measured'],modifiedAt:Date.now(),startedAt:new Date().toISOString()})).toMatchObject({inconclusive:true});
});

it('executes the CLI module entry and records failing exit status without a child process',()=>fixture(async options=>{
 rmSync(join(options.directory,'passkey.json'));
 const argv=process.argv,exit=process.exitCode,log=vi.spyOn(console,'log').mockImplementation(()=>{}),error=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  for(const [key,value]of Object.entries(options.environment))vi.stubEnv(key,value);
  const url=new URL('./rebuild-signin-evidence.mjs',import.meta.url);
  process.argv=[process.execPath,fileURLToPath(url),options.out,options.directory];url.search='cli='+randomUUID();process.exitCode=undefined;
  await import(url.href);expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith('Required sign-in browser evidence is unavailable, stale or incomplete');
  const page=JSON.parse(readFileSync(join(options.out,'report.json'),'utf8')).pages.find(row=>row.page==='signing-in');
  expect(page.promises.find(row=>row.id==='signing-in-002').status).toBe('not checkable yet');
 }finally{process.argv=argv;process.exitCode=exit;vi.unstubAllEnvs();log.mockRestore();error.mockRestore();}
}));

it('rejects another producer or unsupported proof version despite otherwise matching fresh context',()=>fixture(options=>{
 for(const change of [{producer:'other-producer'},{version:2}]){
  const value=accountProof(passkey,options.environment);Object.assign(value._evidence,change);writeFileSync(join(options.directory,'passkey.json'),JSON.stringify(value));
  const errors=[];expect(main([options.out,options.directory],{environment:options.environment,stdout:()=>{},stderr:text=>errors.push(text)})).toBe(1);
  expect(errors).toEqual(['Required sign-in browser evidence is unavailable, stale or incomplete']);
  const page=JSON.parse(readFileSync(join(options.out,'report.json'),'utf8')).pages.find(row=>row.page==='signing-in');expect(page.promises.find(row=>row.id==='signing-in-002').status).toBe('not checkable yet');
 }
}));
it('keeps delivery failure separate from successful own-device controls',()=>fixture(options=>{
 writeFileSync(join(options.directory,'account-session.json'),JSON.stringify(accountProof({...browsers,notificationDispatched:false},options.environment)));
 const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
 expect(page.promises.find(row=>row.id==='signing-in-005').status).toBe('not met');
 expect(page.promises.find(row=>row.id==='signing-in-004').status).toBe('met');
 expect(page.promises.find(row=>row.id==='signing-in-013').status).toBe('not checkable yet');
}));
