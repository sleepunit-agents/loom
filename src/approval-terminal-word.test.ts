import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { TerminalSessions } from './core/conversations/terminal-sessions.js';
import { boxes, members, messages, jobs } from './core/data/schema.js';

const cleanup: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const done of cleanup.splice(0).reverse())await done();});
it('attaches only a unique retained human turn from the signing owner’s open terminal',async()=>{
  const f=await bodyFixture(cleanup);
  f.db.update(members).set({role:'owner'}).where(eq(members.id,'alice')).run();
  const sessions=new TerminalSessions(f.db,f.key,()=>new Date(f.clock.now()).toISOString());
  const key={machine:'box',sessionId:'session',harness:'claude'};
  const scope={machine:'box',agent:'art',member:'alice'};
  const send=async(event:Parameters<typeof sessions.prepare>[1])=>(await sessions.prepare(scope,event))();
  const {conversation,job}=await send({...key,action:'open',cwd:'/src',model:null});
  const quote='Apply the fixture';
  await send({...key,action:'turn',role:'agent',eventId:'reply',words:quote});
  const calls=new Map<string,()=>Promise<Response>>();
  const answer=async(id:string)=>{
    const card=f.root.writes.run(()=>f.root.services.approvals.request({kind:'command',target:id,agent:'art',what:'Apply',why:'Fixture',
      askedFrom:'terminal',actingFor:'alice',ask:'Apply?',ifYes:'Apply',ifNo:'Wait'})).value;
    const call=()=>f.root.http.request('/api/approvals/answer',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+bodyCredentials.memberCookie},
      body:JSON.stringify({id,input:{id:card.id,answer:'allow',onWord:{venue:'terminal',through:'art',quote}}})});
    calls.set(id,async()=>await call());
    expect((await call()).status).toBe(200);
    return f.root.services.approvals.record(card.id).find(r=>r.event==='allow')?.note;
  };
  expect(await answer('agent-only')).toContain('unverified');
  await send({...key,action:'turn',role:'member',eventId:'first',words:quote+' today.'});
  const verified=await answer('one');
  expect(verified).toContain('conversation '+conversation);
  expect(verified).toContain('turn 2');
  expect(verified).toContain('machine box');
  await send({...key,action:'turn',role:'member',eventId:'again',words:quote});
  expect(await answer('two')).toContain('unverified');
  expect((await calls.get('one')!()).status).toBe(409);
  f.db.update(messages).set({keepUntil:new Date(f.clock.now()).toISOString()}).where(eq(messages.clientId,'first')).run();
  expect(await answer('one-retained')).toContain('turn 3');
  f.db.update(messages).set({words:Buffer.from('unreadable'),keepUntil:new Date(f.clock.now()+86_400_000).toISOString()}).where(eq(messages.clientId,'first')).run();
  expect(await answer('unreadable')).toContain('unverified');
  f.db.update(messages).set({words:null}).where(eq(messages.clientId,'first')).run();
  f.db.update(boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(boxes.id,'box')).run();
  expect(await answer('revoked-machine')).toContain('unverified');
  f.db.update(boxes).set({revokedAt:null}).where(eq(boxes.id,'box')).run();
  f.db.update(jobs).set({member:'bob'}).where(eq(jobs.id,job)).run();
  expect(await answer('crossed-parent')).toContain('unverified');
  f.db.update(jobs).set({member:'alice'}).where(eq(jobs.id,job)).run();
  await send({...key,action:'end'});
  expect(await answer('ended')).toContain('unverified');
});
