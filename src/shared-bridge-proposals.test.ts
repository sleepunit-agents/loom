import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials,credentialHash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(options:Parameters<typeof bodyFixture>[1]={}){
 const f=await bodyFixture(clean,options),now=()=>new Date(f.clock.now()).toISOString();
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
 for(const name of ['bot-token','app-token'])f.db.insert(s.secrets).values({name,description:'Private unrelated description',changedAt:now(),changedBy:'alice'}).run();
 const post=(path:string,input:unknown,id:string,token=bodyCredentials.body)=>f.root.http.request('/api/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id})});
 const channel={action:'channel',platform:'discord',workspace:'example-server',channel:'example-channel',answers:'art',botsMayTalk:false};
 const connection={action:'connection' as const,id:'example-link',platform:'discord' as const,workspace:'example-server',agent:'art',botUser:'example-bot',tokenSecret:'bot-token',appSecret:null,enabled:true,only:['2','1','2'],ignore:['9']};
 const propose=(id='proposal',input:unknown=channel,token=bodyCredentials.body)=>post('bridges/proposeSettings',input,id,token);
 const answer=(id:string,choice='allow',receipt='answer',token=bodyCredentials.member)=>post('approvals/answer',{id,answer:choice},receipt,token);
 const read=()=>({connections:f.db.select().from(s.bridgeConnections).all(),filters:f.db.select().from(s.bridgeChannelFilters).all(),channels:f.db.select().from(s.bridgeChannels).all(),people:f.db.select().from(s.bridgePeople).all()});
 return {...f,now,post,channel,connection,propose,answer,read};
}
it('prepares exact private-owner channel configuration and applies it only on Allow',async()=>{
 const f=await fixture(),before=f.read();expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 const replay=await (await f.propose()).json();expect(replay).toEqual({ok:true,value:{id:card.id}});
 expect(card).toMatchObject({kind:'setting',operation:'bridges.applyConfiguration',agent:'art',member:'alice',actingFor:'alice',conversation:f.thread.conversation,askedFrom:f.thread.conversation,state:'pending'});
 expect(card.target).toBe('bridges:configuration:["channel","discord","example-server","example-channel"]');
 expect(JSON.parse(card.details)).toEqual({before:null,after:f.channel});
 expect(card.changeSummary).toBe('Before: null. After: {"answers":"art","botsMayTalk":false,"channel":"example-channel","platform":"discord","workspace":"example-server"}.');
 expect(f.read()).toEqual(before);expect((await f.propose()).status).toBe(200);expect(f.db.select().from(s.approvals).all()).toHaveLength(1);
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read().channels).toEqual([{platform:'discord',workspace:'example-server',channel:'example-channel',answers:'art',botsMayTalk:false}]);
 f.root.services.bridges.settings.change({...f.channel,action:'channel',platform:'discord',answers:'mark'});
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read().channels[0]?.answers).toBe('mark');
 expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','allow','use']);
});
it.each(['connection','disconnect','person','removePerson','removeChannel']as const)('applies a typed %s plan without granting direct agent management',async action=>{
 const f=await fixture();let input:unknown;
 if(action==='connection')input={...f.connection,platform:'slack',appSecret:'app-token'};
 if(action==='disconnect'){f.root.services.bridges.settings.change(f.connection);input={action,id:f.connection.id};}
 if(action==='person')input={action,platform:'slack',workspace:'example-workspace',user:'example-user',member:'alice'};
 if(action==='removePerson'){f.root.services.bridges.settings.change({action:'person',platform:'slack',workspace:'example-workspace',user:'example-user',member:'alice'});input={action,platform:'slack',workspace:'example-workspace',user:'example-user'};}
 if(action==='removeChannel'){f.root.services.bridges.settings.change({...f.channel,action:'channel',platform:'discord'});input={action,platform:'discord',workspace:'example-server',channel:'example-channel'};}
 const before=f.read();expect((await f.post('bridges/command',input,'direct')).status).toBe(403);expect((await f.propose('typed',input)).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;expect(f.read()).toEqual(before);
 expect((await f.answer(card.id)).status).toBe(200);
 if(action==='connection'){expect(f.read().connections[0]).toMatchObject({platform:'slack',appSecret:'app-token'});expect(f.read().filters.filter(row=>row.rule==='only').map(row=>row.channel).sort()).toEqual(['1','2']);}
 if(action==='disconnect')expect(f.read().connections[0]?.enabled).toBe(false);
 if(action==='person')expect(f.read().people[0]).toMatchObject({platform:'slack',member:'alice'});
 if(action==='removePerson')expect(f.read().people).toEqual([]);
 if(action==='removeChannel')expect(f.read().channels).toEqual([]);
 expect(JSON.stringify(card)).not.toContain('Private unrelated description');
});
it('keeps volatile connection state out of the prepared configuration comparison',async()=>{
 const f=await fixture();f.root.services.bridges.settings.change(f.connection);
 expect((await f.propose('change',{...f.connection,only:['7']})).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 expect(JSON.parse(card.details).before).not.toHaveProperty('state');expect(JSON.parse(card.details).before).not.toHaveProperty('stateAt');
 f.db.update(s.bridgeConnections).set({state:'connected',stateAt:f.now()}).run();
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read().filters.filter(row=>row.rule==='only').map(row=>row.channel)).toEqual(['7']);
});
it('rejects unbound, nonowner, public, forged and send-review calls',async()=>{
 const f=await fixture();expect((await f.propose('unbound',undefined,bodyCredentials.agent)).status).toBe(403);expect((await f.propose('member',undefined,bodyCredentials.member)).status).toBe(403);
 expect((await f.propose('forged',{...f.channel,member:'alice'})).status).toBe(400);expect((await f.propose('review',{action:'review',id:'send',decision:'release'})).status).toBe(400);
 f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'alice')).run();expect((await f.propose('not-owner')).status).toBe(403);
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();f.db.update(s.conversations).set({member:null}).run();f.db.update(s.jobs).set({member:null}).run();expect((await f.propose('public')).status).toBe(403);expect(f.db.select().from(s.approvals).all()).toEqual([]);
});
it.each(['deny','settings','assignment','project','summary','target','conversation','conversationAgent','conversationProject']as const)('withholds configuration for %s before decision',async change=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;
 if(change==='settings')f.root.services.bridges.settings.change({...f.channel,action:'channel',platform:'discord',answers:'mark'});
 if(change==='assignment')f.db.delete(s.memberAgents).run();
 if(change==='project')f.db.delete(s.projectAgents).run();
 if(change==='summary')f.db.update(s.approvals).set({changeSummary:'Another setting'}).run();
 if(change==='target')f.db.update(s.approvals).set({target:'another-target'}).run();
 if(change==='conversation')f.db.update(s.conversations).set({member:'bob'}).run();
 if(change==='conversationAgent')f.db.update(s.conversations).set({agent:'mark'}).run();
 if(change==='conversationProject')f.db.update(s.conversations).set({project:'other'}).run();
 const before=f.read();expect((await f.answer(card.id,change==='deny'?'deny':'allow')).status).toBe(change==='deny'?200:change==='assignment'||change==='project'||change==='conversation'||change==='conversationAgent'||change==='conversationProject'?403:409);expect(f.read()).toEqual(before);
 if(change!=='deny'){expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request']);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');}
});
it('rechecks the requesting owner when another owner answers; cards survive the body ending',async()=>{
 const f=await fixture();f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();const token='f'.repeat(64);
 f.db.insert(s.tokens).values({fingerprint:credentialHash(token),kind:'owner',member:'bob',label:'Other fixture owner',createdAt:f.now()}).run();
 await f.propose();const card=f.db.select().from(s.approvals).get()!;f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'alice')).run();
 expect((await f.answer(card.id,'allow','other-owner',token)).status).toBe(403);expect(f.read().channels).toEqual([]);
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();f.db.update(s.jobs).set({state:'done'}).run();f.db.update(s.conversations).set({job:null}).run();
 expect((await f.answer(card.id,'allow','after-body',token)).status).toBe(200);expect(f.read().channels).toHaveLength(1);
});
it('validates references, fixed connection identity and no-op plans before asking',async()=>{
 const f=await fixture();expect((await f.propose('missing-agent',{...f.channel,answers:'missing'})).status).toBe(400);
 expect((await f.propose('missing-secret',{...f.connection,tokenSecret:'missing'})).status).toBe(400);
 expect((await f.propose('slack-app',{...f.connection,platform:'slack'})).status).toBe(400);
 expect((await f.propose('discord-app',{...f.connection,appSecret:'app-token'})).status).toBe(400);
 expect((await f.propose('missing-member',{action:'person',platform:'discord',workspace:'example',user:'user',member:'missing'})).status).toBe(400);
 f.root.services.bridges.settings.change(f.connection);expect((await f.propose('fixed',{...f.connection,agent:'mark'})).status).toBe(400);expect((await f.propose('noop',f.connection)).status).toBe(400);
 expect(f.db.select().from(s.approvals).all()).toEqual([]);
});
it('rolls back card and applied configuration with a failed receipt',async()=>{
 const f=await fixture();f.db.$client.exec("CREATE TEMP TRIGGER fail_bridge_proposal BEFORE INSERT ON operation_results WHEN NEW.id IN ('failed-proposal','failed-answer') BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect((await f.propose('failed-proposal')).status).toBe(503);expect(f.db.select().from(s.approvals).all()).toEqual([]);expect(f.read().channels).toEqual([]);
 await f.propose();const card=f.db.select().from(s.approvals).get()!;expect((await f.answer(card.id,'allow','failed-answer')).status).toBe(503);expect(f.read().channels).toEqual([]);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read().channels).toHaveLength(1);
});
it('binds the proposal receipt to the receiving job, not just the agent',async()=>{
 const f=await fixture();await f.propose();const job=f.db.select().from(s.jobs).get()!;
 f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,job.id)).run();f.db.insert(s.jobs).values({...job,id:'second-job'}).run();f.db.update(s.conversations).set({job:'second-job'}).run();
 const token='e'.repeat(64);f.db.insert(s.tokens).values({fingerprint:credentialHash(token),kind:'agent',agent:'art',job:'second-job',label:'Second body',createdAt:f.now()}).run();
 expect((await f.propose('proposal',undefined,token)).status).toBe(409);expect(f.db.select().from(s.approvals).all()).toHaveLength(1);
 expect((await f.propose('new-receipt',undefined,token)).status).toBe(200);expect(f.db.select().from(s.approvals).all()).toHaveLength(2);
});
it.each(['agent','member','secret']as const)('refuses a missing referenced %s at Allow and rolls back its record',async missing=>{
 const f=await fixture(),input=missing==='agent'?{...f.channel,answers:'mark'}:missing==='member'?{action:'person',platform:'slack',workspace:'example',user:'user',member:'bob'}:f.connection;
 await f.propose('reference',input);const card=f.db.select().from(s.approvals).get()!;
 if(missing==='agent')f.db.delete(s.agents).where(eq(s.agents.id,'mark')).run();
 if(missing==='member')f.db.delete(s.members).where(eq(s.members.id,'bob')).run();
 if(missing==='secret')f.db.delete(s.secrets).where(eq(s.secrets.name,'bot-token')).run();
 const before=f.read();expect((await f.answer(card.id)).status).toBe(400);expect(f.read()).toEqual(before);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request']);
});
it.each([{action:'disconnect',id:'missing'},{action:'removeChannel',platform:'discord',workspace:'missing',channel:'missing'},{action:'removePerson',platform:'slack',workspace:'missing',user:'missing'}])('never asks for missing configuration $action',async input=>{
 const f=await fixture();expect((await f.propose('missing',input)).status).toBe(400);expect(f.db.select().from(s.approvals).all()).toEqual([]);
});
it('rejects a changed card platform credential shape at Allow',async()=>{
 const f=await fixture();await f.propose('slack',{...f.connection,platform:'slack',appSecret:'app-token'});const card=f.db.select().from(s.approvals).get()!,change=JSON.parse(card.details);
 change.after.appSecret=null;f.db.update(s.approvals).set({details:JSON.stringify(change),changeSummary:card.changeSummary!.replace('"appSecret":"app-token"','"appSecret":null')}).run();
 expect((await f.answer(card.id)).status).toBe(400);expect(f.read().connections).toEqual([]);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');
});
it('publishes the approved configuration to the actual bridge observer only after the outer commit',async()=>{
 const f=await fixture({bridges:{effectsAllowed:()=>false,source:{async read(){throw Error('No provider access in this fixture');},async generation(){return 'fixture';}}}});
 let watched:string|undefined;
 const observed:Array<{inTransaction:boolean;state:string|undefined;channels:number}>=[];
 const spy=vi.spyOn(f.root.services.bridges.daemon!,'changed').mockImplementation(()=>{observed.push({inTransaction:f.db.$client.inTransaction,state:watched?f.db.select().from(s.approvals).where(eq(s.approvals.id,watched)).get()?.state:undefined,channels:f.read().channels.length});});
 const denied=await(await f.propose('denied')).json();watched=denied.value.id;expect((await f.answer(watched!,'deny','denied-answer')).status).toBe(200);
 expect(observed.at(-1)).toEqual({inTransaction:false,state:'denied',channels:0});
 const proposed=await(await f.propose()).json();watched=proposed.value.id;const card=f.db.select().from(s.approvals).where(eq(s.approvals.id,watched!)).get()!;expect(observed.every(value=>!value.inTransaction&&value.channels===0)).toBe(true);
 f.db.$client.exec("CREATE TEMP TRIGGER fail_bridge_observer BEFORE INSERT ON operation_results WHEN NEW.id='failed-answer' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 const count=observed.length;expect((await f.answer(card.id,'allow','failed-answer')).status).toBe(503);expect(observed).toHaveLength(count);expect(f.read().channels).toEqual([]);
 expect((await f.answer(card.id)).status).toBe(200);expect(observed.at(-1)).toEqual({inTransaction:false,state:'used',channels:1});
 const used=observed.length,applied=f.read();expect((await f.answer(card.id)).status).toBe(200);expect(f.read()).toEqual(applied);
 // The shared observer may see a receipt/token write; it sees no new config.
 expect(observed.slice(used).every(value=>!value.inTransaction&&value.state==='used'&&value.channels===1)).toBe(true);
 spy.mockRestore();
});
it('refuses an internal decision attributed to a nonowner as defense behind the owner HTTP door',async()=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;
 expect(()=>f.root.services.approvals.allow(card.id,'bob')).toThrow('authority changed');expect(f.read().channels).toEqual([]);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request']);
});
it('rejects a forged no-op connection card without resetting its live state',async()=>{
 const f=await fixture();f.root.services.bridges.settings.change(f.connection);f.db.update(s.bridgeConnections).set({state:'connected'}).run();
 await f.propose('edit',{...f.connection,only:['7']});const card=f.db.select().from(s.approvals).get()!,change=JSON.parse(card.details);
 change.after.only=change.before.only;const beforeSummary=card.changeSummary!.split('. After: ')[0];
 const sorted=JSON.stringify(Object.fromEntries(Object.entries(change.before).sort(([a],[b])=>a<b?-1:a>b?1:0)));
 f.db.update(s.approvals).set({details:JSON.stringify(change),changeSummary:beforeSummary+'. After: '+sorted+'.'}).run();
 expect((await f.answer(card.id)).status).toBe(400);expect(f.read().connections[0]?.state).toBe('connected');
});
it('rechecks fixed identity against desired configuration, not only a changed stored row',async()=>{
 const f=await fixture();f.root.services.bridges.settings.change(f.connection);await f.propose('edit',{...f.connection,only:['7']});const card=f.db.select().from(s.approvals).get()!,change=JSON.parse(card.details);
 change.after.agent='mark';const [before,after]=card.changeSummary!.split('. After: ');
 f.db.update(s.approvals).set({details:JSON.stringify(change),changeSummary:before+'. After: '+after.replace('"agent":"art"','"agent":"mark"')}).run();
 expect((await f.answer(card.id)).status).toBe(400);expect(f.read().connections[0]?.agent).toBe('art');expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');
});
