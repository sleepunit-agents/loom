import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { startLoom } from '../foundation.js';
import { FakeClock, type Viewer } from '../core/index.js';
import { fixtureSharing } from '../fixture.js';
import { installApprovals } from '../pieces/approvals/index.js';
import type { Caller } from '../pieces/approvals/model.js';
import { installClock } from '../pieces/clock/index.js';
import { clockLocalFiling, localMarker } from '../pieces/clock/local-filing.js';
export const owner: Viewer = {kind:'member',id:'jonathan'};
export const caller: Caller = {who:{agent:'art',where:'house (queue)'},for:'owner',conversation:'cv-123456789abc'};
export const prompt = localMarker + '\nInspect the host disk usage and report it.';
const closes: (()=>Promise<void>)[] = [];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
export async function setupLocal(mode:'once'|'standing',runtime?:import('../pieces/clock/role.js').Runtime, authenticate?:Parameters<typeof startLoom>[0]['authenticate']) {
  const home=mkdtempSync(join(tmpdir(),'clock-local-')), access=fixtureSharing(), clock=new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  access.services.clock={types:['clock','approval'],operations:['clock.localRequest','approvals.piece-request',...(mode==='once'?['clock.localSchedule','approvals.piece-use-local']:['clock.localStandingSchedule','approvals.piece-standing-local','approvals.piece-standing-local-check'])]};
  access.services.approvals={types:['approval'],operations:['approvals.piece-request']};
  const options={home,clock,sharing:()=>access,authenticate:authenticate??(()=>({viewer:owner,valid:()=>true})),install(app:Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) {
    installApprovals(app.db,app.operations,app.live,()=>access,{localAgent:'art'});
    const jobs=installClock(app.db,app.operations,app.live,()=>access,{runtime}); app.onClose(jobs.close);
  }};
  let app=await startLoom(options);
  closes.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  return {get app(){return app;},access,clock,home,
    request(p=prompt,n='disk report',c=caller){return clockLocalFiling(app.operations).request(c,p,n);},
    async restart(whileClosed?:()=>void){await app.close();try{whileClosed?.();}finally{app=await startLoom(options);}},
  };
}
export const value = <T>(r: import('../core/index.js').Result): T => {if(!r.ok)throw Error(JSON.stringify(r));return r.value as T;};

