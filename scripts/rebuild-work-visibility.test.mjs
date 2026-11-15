import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {exampleHome} from '../src/example-home.js';
import {startSharedHome} from '../src/shared-startup.js';
import {workVisibility} from './rebuild-work-visibility.mjs';
it('measures real authenticated work visibility in a fresh running program',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-work-visibility-'));let app;
 try{
  const web=join(parent,'public');mkdirSync(web);writeFileSync(join(web,'next.html'),'<main>Fictitious test</main>');
  const example=await exampleHome(join(parent,'home'),web);app=await startSharedHome({home:join(parent,'home'),port:0,stdout:()=>{}});
  const proof=await workVisibility({page:{screenshot:async()=>{}},app,example,out:parent});
  expect(proof.workVisibility,JSON.stringify(proof)).toMatchObject({ok:true,projectWithdrawal:true,callers:['owner','member','agent','machine','anonymous']});
  expect(app.services.comms.db.$client.prepare("SELECT count(*) AS n FROM tokens WHERE label LIKE 'Fictitious work proof%' AND revoked_at IS NULL").get()).toEqual({n:0});
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});
