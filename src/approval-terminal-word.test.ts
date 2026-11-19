import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bodyCredentials, bodyFixture, credentialHash } from '../test/fixtures/conversation-body.js';
import { TerminalSessions } from './core/conversations/terminal-sessions.js';
import { boxes, memberAgents, members, messages, jobs, terminalCredentials } from './core/data/schema.js';

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

it('lets the agent at a household owner’s own terminal answer for them, only on words loom recorded from them there',async()=>{
  const f=await bodyFixture(cleanup);
  f.db.update(members).set({role:'owner'}).where(eq(members.id,'alice')).run();
  const now=()=>new Date(f.clock.now()).toISOString();
  const sessions=new TerminalSessions(f.db,f.key,now);
  const key={machine:'box',sessionId:'session',harness:'claude'};
  const send=async(event:Parameters<typeof sessions.prepare>[1],scope={machine:'box',agent:'art',member:'alice'})=>(await sessions.prepare(scope,event))();
  const {conversation,job}=await send({...key,action:'open',cwd:'/src',model:null});
  let n=0;
  const card=()=>f.root.writes.run(()=>f.root.services.approvals.request({kind:'command',target:'t'+(++n),agent:'art',what:'Apply',why:'Fixture',
    askedFrom:'terminal',actingFor:'alice',ask:'Apply?',ifYes:'Apply',ifNo:'Wait'})).value;
  const answer=(id:string,quote:string,token=bodyCredentials.agent,extra:Record<string,unknown>={})=>f.root.http.request('/api/approvals/answer',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+token},
    body:JSON.stringify({id:'answer-'+(++n),input:{id,answer:'allow',onWord:{venue:'terminal',through:'art',quote},...extra}})});
  const state=(id:string)=>f.root.services.approvals.record(id).find(r=>r.event==='allow')?.note;
  await send({...key,action:'turn',role:'member',eventId:'m1',words:'go ahead and approve the card for the fixture machine'});
  await send({...key,action:'turn',role:'agent',eventId:'a1',words:'I will approve the card that says apply the other thing entirely'});
  const quote='approve the card for the fixture machine';

  // The agent's ordinary terminal credential is the agent alone: it answers nothing.
  const first=card();
  expect((await answer(first.id,quote)).status).toBe(403);
  // Bound to the owner's own machine, it is the agent at their terminal.
  f.db.insert(terminalCredentials).values({fingerprint:credentialHash(bodyCredentials.agent),machine:'box',member:'alice'}).run();
  expect((await answer(first.id,quote)).status).toBe(200);
  expect(state(first.id)).toBe(`Allowed by alice as told to art at the terminal: “${quote}” (conversation ${conversation}, turn 1, machine box)`);

  // Never on its own words, on words nobody said, on a word in passing, without a quote, or through another agent.
  const second=card();
  for (const words of ['approve the card that says apply the other thing','approve everything you like from now on','go ahead','            '])
    expect((await answer(second.id,words)).status,words).toBe(403);
  expect((await f.root.http.request('/api/approvals/answer',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bodyCredentials.agent},
    body:JSON.stringify({id:'no-word',input:{id:second.id,answer:'allow'}})})).status).toBe(403);
  expect((await f.root.http.request('/api/approvals/answer',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bodyCredentials.agent},
    body:JSON.stringify({id:'other-agent',input:{id:second.id,answer:'allow',onWord:{venue:'terminal',through:'mark',quote}}})})).status).toBe(403);
  expect(state(second.id)).toBeUndefined();

  // Said twice: the newest message is the one answered on, and there is never an unverified answer.
  await send({...key,action:'turn',role:'member',eventId:'m2',words:'yes, '+quote+', as I said'});
  expect((await answer(second.id,quote)).status).toBe(200);
  expect(state(second.id)).toContain('turn 3');
  expect(state(second.id)).not.toContain('unverified');

  // Words that are no longer kept, or cannot be read, answer nothing.
  const third=card();
  f.db.update(messages).set({words:Buffer.from('unreadable')}).where(eq(messages.thread,f.db.select().from(messages).where(eq(messages.clientId,'m1')).get()!.thread)).run();
  expect((await answer(third.id,quote)).status).toBe(403);
  await send({...key,action:'turn',role:'member',eventId:'m3',words:'again: '+quote});
  expect((await answer(third.id,quote)).status).toBe(200);

  // Only while that owner is who the machine and the agent are theirs, and the session is running.
  const refused=async(change:()=>void,undo:()=>void,why:string)=>{
    const c=card(); change();
    expect((await answer(c.id,quote)).status,why).toBe(403);
    expect(state(c.id),why).toBeUndefined();
    undo();
    expect((await answer(c.id,quote)).status,why+' (undone)').toBe(200);
  };
  await refused(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'alice')).run(),()=>f.db.update(members).set({role:'owner'}).where(eq(members.id,'alice')).run(),'the person at the terminal is not a household owner');
  await refused(()=>f.db.update(boxes).set({revokedAt:now()}).where(eq(boxes.id,'box')).run(),()=>f.db.update(boxes).set({revokedAt:null}).where(eq(boxes.id,'box')).run(),'the machine was revoked');
  await refused(()=>f.db.update(boxes).set({owner:'bob'}).where(eq(boxes.id,'box')).run(),()=>f.db.update(boxes).set({owner:'alice'}).where(eq(boxes.id,'box')).run(),'the machine is someone else’s');
  await refused(()=>f.db.update(jobs).set({member:'bob'}).where(eq(jobs.id,job)).run(),()=>f.db.update(jobs).set({member:'alice'}).where(eq(jobs.id,job)).run(),'the session’s records disagree');
  // What the owner said at one of their machines answers nothing for a session bound to another.
  f.db.insert(boxes).values({id:'other',name:'Other',owner:'alice',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
  await refused(()=>f.db.update(terminalCredentials).set({machine:'other'}).run(),()=>f.db.update(terminalCredentials).set({machine:'box'}).run(),'the credential is bound to another machine');
  // And only while the owner has the agent at all is there anything the agent may read of theirs; answering needs the owner role alone.
  expect(f.db.select().from(memberAgents).all().length).toBeGreaterThan(0);

  // A body of the agent is not at the terminal, and neither is a member who is not an owner.
  const fourth=card();
  expect((await answer(fourth.id,quote,bodyCredentials.body)).status).toBe(403);
  // Once the session has ended, what was said in it answers nothing.
  await send({...key,action:'end'});
  expect((await answer(fourth.id,quote)).status).toBe(403);
  expect(state(fourth.id)).toBeUndefined();
});
