import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {proofFact,attachSigninEvidence} from './rebuild-signin-evidence.mjs';
const passkey={completed:true,realPasskeyRegistered:true,realPasskeySignin:true,counterIncreased:true,passkeyRemoved:true,oneTimeLinkRedeemedOnce:true,deviceLogout:true};
const browsers={completed:true,anotherBrowserRevoked:true,notificationEnabled:true,notificationRemoved:true,currentBrowserRevoked:true,signInScreenRestored:true,identityConfirmedSignedOut:true,oneTimeLinkMadeAndHidden:true};
function fixture(run){
 const parent=mkdtempSync(join(tmpdir(),'loom-signin-consumer-')),out=join(parent,'walkthrough'),directory=join(parent,'producer'),environment={GITHUB_SHA:'commit',GITHUB_RUN_ID:'run',GITHUB_RUN_ATTEMPT:'1'};
 try{
  mkdirSync(out);mkdirSync(directory);const startedAt=new Date(Date.now()-1000).toISOString();
  writeFileSync(join(out,'walkthrough.json'),JSON.stringify({source:{commit:'commit',run:'run',attempt:'1'},startedAt,finishedAt:startedAt,signin:{ok:true,personBrowser:true},actions:{},apps:[],inventory:[],example:{gaps:[]},live:{dataFrames:0,errors:[]}}));
  writeFileSync(join(directory,'passkey.json'),JSON.stringify({...passkey,rawToken:'DO_NOT_COPY_PRIVATE_FIELD'}));
  writeFileSync(join(directory,'account-session.json'),JSON.stringify(browsers));
  return run({out,directory,environment,startedAt});
 }finally{rmSync(parent,{recursive:true,force:true});}
}
it('keeps stale, malformed and incomplete proof unknown, and preserves explicit negative facts',()=>{
 const now=Date.now(),startedAt=new Date(now-1000).toISOString(),options={modifiedAt:now,startedAt,now,keys:['measured'],proof:'signin/proof.json'};
 expect(proofFact({completed:true,measured:true},options)).toMatchObject({ok:true});
 expect(proofFact({completed:true,measured:false},options)).toMatchObject({ok:false,error:expect.stringContaining('measured')});
 for(const value of [{completed:false,measured:true},{completed:true,measured:'true'},{}])expect(proofFact(value,options)).toHaveProperty('inconclusive',true);
 for(const modifiedAt of [now-2000,now+6000,NaN])expect(proofFact({completed:true,measured:true},{...options,modifiedAt})).toHaveProperty('inconclusive',true);
});
it('binds only the complete supported promises, preserves partial limits and strips unknown fields',()=>fixture(options=>{
 const report=attachSigninEvidence(options),page=report.pages.find(row=>row.page==='signing-in'),status=id=>page.promises.find(row=>row.id===id).status;
 for(const id of ['signing-in-002','signing-in-004','signing-in-006'])expect(status(id)).toBe('met');
 for(const id of ['signing-in-005','signing-in-011','signing-in-013'])expect(status(id)).toBe('not checkable yet');
 expect(readFileSync(join(options.out,'signin/passkey.json'),'utf8')).not.toContain('PRIVATE_FIELD');
 const run=JSON.parse(readFileSync(join(options.out,'walkthrough.json'),'utf8'));
 expect(run.actions.signinPasskey.proof).toBe('signin/passkey.json');expect(run.finishedAt>=options.startedAt).toBe(true);
 expect(run.source).toEqual({commit:'commit',run:'run',attempt:'1'});
}));
it('makes a complete observed failure not met without claiming copied-key rules or delivery',()=>fixture(options=>{
 writeFileSync(join(options.directory,'passkey.json'),JSON.stringify({...passkey,passkeyRemoved:false}));
 const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
 expect(page.promises.find(row=>row.id==='signing-in-004')).toMatchObject({status:'not met',reason:expect.stringContaining('passkeyRemoved')});
 expect(page.promises.find(row=>row.id==='signing-in-011').status).toBe('not checkable yet');
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
  writeFileSync(join(options.directory,'passkey.json'),JSON.stringify({...passkey,counterIncreased:false}));
  const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
  expect(page.promises.find(row=>row.id==='signing-in-002').status).toBe('met');
  expect(page.promises.find(row=>row.id==='signing-in-004').status).toBe('met');
  expect(page.promises.find(row=>row.id==='signing-in-011').status).toBe('not met');
 });
 fixture(options=>{
  writeFileSync(join(options.directory,'account-session.json'),JSON.stringify({...browsers,notificationEnabled:false}));
  const page=attachSigninEvidence(options).pages.find(row=>row.page==='signing-in');
  expect(page.promises.find(row=>row.id==='signing-in-004').status).toBe('met');
  expect(page.promises.find(row=>row.id==='signing-in-005').status).toBe('not checkable yet');
  expect(page.promises.find(row=>row.id==='signing-in-013').status).toBe('not met');
 });
});
it('fails required evidence collection after preserving an honest incomplete report',()=>fixture(options=>{
 rmSync(join(options.directory,'passkey.json'));
 expect(()=>attachSigninEvidence({...options,required:true})).toThrow('Required sign-in');
 const saved=JSON.parse(readFileSync(join(options.out,'report.json'),'utf8')).pages.find(row=>row.page==='signing-in');
 expect(saved.promises.find(row=>row.id==='signing-in-002').status).toBe('not checkable yet');
}));
