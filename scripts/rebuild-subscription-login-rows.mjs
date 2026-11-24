import assert from 'node:assert/strict';
import {reportWorkerAccountLogins,reportWorkerHealth} from '../dist/runtime/worker-http.js';
import {SILENCE_MS} from '../dist/runtime/silence.js';

export async function subscriptionLoginRows({page,account,worker,clock}){
 const ends=new Date(clock.now()+3*86400000).toISOString();
 const host={account,harness:'claude',place:'host',state:'signed-out'};
 const house={account,harness:'codex',place:'containers',state:'signed-in'};
 await reportWorkerHealth({...worker,facts:['cpu:example']});
 await reportWorkerAccountLogins(worker,[host,house]);
 const summary=page.locator('summary').filter({hasText:'Example model subscription'});
 await summary.filter({hasText:'1 needs attention'}).click();
 const signins=summary.locator('..').getByRole('region',{name:'Sign-ins'});
 const row=place=>signins.locator('div').filter({has:page.getByText('Example workshop',{exact:true})}).filter({hasText:place});
 const machine=row('On the machine'),containers=row('In houses');
 const action=root=>root.getByRole('button',{name:'Sign in on this machine',exact:true});
 await action(machine).waitFor();
 assert.match(await machine.innerText(),/claude.*On the machine[\s\S]*Signed out/);
 assert.match(await containers.innerText(),/codex.*In houses[\s\S]*Signed in/);
 assert.equal(await containers.getByText(/^Ends /).count(),0);
 assert.equal(await action(containers).count(),0);
 await reportWorkerAccountLogins(worker,[{...host,state:'signed-in',expiresAt:new Date(Date.parse(ends)+SILENCE_MS).toISOString()},house]);
 await machine.getByText(/^Ends /).waitFor();
 await action(machine).waitFor({state:'hidden'});
 clock.advance(SILENCE_MS);
 await action(machine).waitFor();
 assert.match(await machine.innerText(),/Signed in/);
 const color=loc=>loc.evaluate(el=>getComputedStyle(el).color);
 const fresh=await color(machine);
 clock.advance(1);
 await summary.filter({hasText:'2 last known'}).waitFor();
 for(const loc of [machine,containers]){
  await loc.getByText(/^Last known: Signed in/).waitFor();
  assert.equal(await action(loc).count(),0);
  assert.notEqual(await color(loc),fresh);
 }
 assert.doesNotMatch(await summary.innerText(),/needs attention/);
 await reportWorkerHealth({...worker,facts:['cpu:example']});
 await action(machine).waitFor();
 assert.equal(await color(machine),fresh);
 assert.equal(await signins.getByText(/^Last known/).count(),0);
 const previousEnd=await machine.getByText(/^Ends /).innerText();
 const nearEnd=new Date(clock.now()+1000).toISOString();
 await reportWorkerAccountLogins(worker,[{...host,state:'signed-in',expiresAt:nearEnd},house]);
 await machine.getByText(previousEnd,{exact:true}).waitFor({state:'detached'});
 await machine.getByText(/^Ends /).waitFor();
 clock.advance(1000);
 await machine.getByText(/^Expired · Checked /).waitFor();
 await machine.getByText(/^Ended /).waitFor();
 await summary.filter({hasText:'1 signed in · 1 needs attention'}).waitFor();
 await action(machine).waitFor();
 await reportWorkerAccountLogins(worker,[{...host,state:'signed-in',expiresAt:null},house]);
 await summary.filter({hasText:'2 signed in'}).waitFor();
 await action(machine).waitFor({state:'hidden'});
 return {ok:true,reason:'Chromium displayed separate host and house sign-ins with their harness and machine. A signed-out or three-days-left sign-in offered Sign in; a healthy Codex sign-in had no end date. After worker silence both rows were muted, last known and had no action. A new worker check-in restored the current state.'};
}
