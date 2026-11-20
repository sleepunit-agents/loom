import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {exampleHome} from '../src/example-home.js';
import {exampleHomeCopies} from '../test/fixtures/example-home-copy.js';
import {startSharedHome} from '../src/shared-startup.js';
import {workVisibility} from './rebuild-work-visibility.mjs';
const copyExampleHome=exampleHomeCopies(exampleHome);
it('measures real authenticated work visibility in a fresh running program',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-work-visibility-'));let app;
 try{
  const web=join(parent,'public');mkdirSync(web);writeFileSync(join(web,'next.html'),'<main>Fictitious test</main>');
  const example=await copyExampleHome(join(parent,'home'),web);app=await startSharedHome({home:join(parent,'home'),port:0,stdout:()=>{}});
  const proof=await workVisibility({page:{screenshot:async()=>{}},app,example,out:parent});
  expect(proof.workVisibility,JSON.stringify(proof)).toMatchObject({ok:true,projectWithdrawal:true,callers:['owner','member','agent','machine','anonymous']});
  expect(app.services.comms.db.$client.prepare("SELECT count(*) AS n FROM tokens WHERE label LIKE 'Fictitious work proof%' AND revoked_at IS NULL").get()).toEqual({n:0});
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});

it.each([false,true])('keeps credentials out of failure evidence and attempts every revocation (cleanup failure=%s)',async cleanupFailure=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-work-visibility-failure-'));let app;const issued=[],attempts=[],screenshots=[];
 try{
  const web=join(parent,'public');mkdirSync(web);writeFileSync(join(web,'next.html'),'<main>Fictitious test</main>');
  const example=await copyExampleHome(join(parent,'home'),web);app=await startSharedHome({home:join(parent,'home'),port:0,stdout:()=>{}});
  const signin=app.services.signin,issue=signin.issue.bind(signin),revoke=signin.revoke.bind(signin);
  signin.issue=input=>{const value=issue(input);issued.push(value);return value;};
  app.http.request=async()=>{throw Error('Injected transport error: '+issued[0].token);};
  let fail=cleanupFailure;
  signin.revoke=fingerprint=>{attempts.push(fingerprint);if(fail){fail=false;throw Error('Injected revoke failure');}return revoke(fingerprint);};
  const proof=await workVisibility({page:{screenshot:async options=>screenshots.push(options)},app,example,out:parent});
  expect(proof.workVisibility.ok).toBe(false);expect(issued.length).toBe(3);expect(attempts.length).toBe(issued.length);
  const evidence=JSON.stringify({proof,screenshots});for(const value of issued)expect(evidence.includes(value.token)).toBe(false);
  if(cleanupFailure)expect(proof.workVisibility.cleanupFailures).toBe(1);
  else expect(proof.workVisibility.error).toContain('[fictitious credential redacted]');
  for(const value of issued)app.writes.run(()=>revoke(value.fingerprint));
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});
