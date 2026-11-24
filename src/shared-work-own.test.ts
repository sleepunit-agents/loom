/** An agent's own credential asks what a standing rule says, files a card and spends it, outside any conversation. */
import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
const head='a'.repeat(40),held='github:acme/app#1@'+head,unread='github:sleepunit-agents/art#185@'+'b'.repeat(40);
const words={what:'Merge it',why:'Ready',ask:'Merge?',ifYes:'The agent merges that exact commit',ifNo:'It waits'};
async function fixture(){
 const f=await bodyFixture(clean),at=new Date(f.clock.now()).toISOString(),owner='o'.repeat(64),other='k'.repeat(64);
 // pat is a household owner. alice, who is not, has art; mark has nobody.
 f.db.insert(s.members).values({id:'pat',role:'owner',joinedAt:at}).run();
 f.db.insert(s.tokens).values([{fingerprint:hash(owner),label:'Fixture owner',kind:'owner',member:'pat',createdAt:at},{fingerprint:hash(other),label:'Mark',kind:'agent',agent:'mark',createdAt:at}]).run();
 // loom reads acme/app: art's own open change is there, in pond.
 f.db.insert(s.changes).values({id:'github:acme/app#1',repository:'acme/app',number:1,title:'Pump',body:'',url:'',state:'open',draft:false,authorLogin:'art',agent:'art',project:'pond',branch:'work',headCommit:head,baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:at,updatedAt:at}).run();
 const call=async(name:string,input:unknown,token=raw.agent,id:string=randomUUID())=>{const response=await f.root.http.request('/api/approvals/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input,id})});return {status:response.status,body:await response.json() as {ok:boolean;value?:Record<string,unknown>;message?:string}};};
 const rule=async(kind:string,target:string,token=raw.agent)=>(await call('rule',{kind,target},token)).body.value;
 const ownsArt=(member:string)=>f.root.writes.run(()=>f.db.insert(s.memberAgents).values({member,agent:'art'}).run());
 const cards=()=>f.db.select().from(s.approvals).all();
 return {...f,at,owner,other,call,rule,ownsArt,cards,rules:f.root.services.approvalRules};
}
const ask={tier:'ask',scope:null,person:null};

it('answers an agent’s terminal credential from the household’s own rules only while a household owner has the agent',async()=>{
 const f=await fixture();
 f.rules.set({kind:'merge',scope:'github:sleepunit-agents/*',tier:'do'},'pat');
 f.rules.set({kind:'merge',scope:'*',person:'alice',tier:'tell'},'pat');
 // Only alice has art, and she is not a household owner: the agent's own work reads no rule. Not hers either: this is not her work.
 expect(await f.rule('merge',unread)).toEqual(ask);
 // A household owner has art now: its own work is read as a household owner's, by the rule with no person.
 f.ownsArt('pat');
 expect(await f.rule('merge',unread)).toEqual({tier:'do',scope:'github:sleepunit-agents/*',person:''});
 // It needs only the kind and the target's words: loom holds no such change. Another repository has no rule; words that are not a target ask.
 expect(await f.rule('merge','github:elsewhere/app#2@'+head)).toEqual(ask);
 // Words that are not a merge target are refused, as they are for a body.
 expect((await f.call('rule',{kind:'merge',target:'github:sleepunit-agents/art#185'})).status).toBe(409);
 // A project's rule answers for the agent's own open change in that project.
 f.rules.set({kind:'merge',scope:'project:pond',tier:'tell'},'pat');
 expect(await f.rule('merge',held)).toEqual({tier:'tell',scope:'project:pond',person:''});
 // loom reads acme/app, so a target there is held to the agent's own open change at that head, for a rule
 // read as for a card. Under a rule that would say do, each of these is refused, not answered on its words.
 f.rules.set({kind:'merge',scope:'github:acme/*',tier:'do'},'pat');
 f.db.insert(s.changes).values({id:'github:acme/app#7',repository:'acme/app',number:7,title:'Marks',body:'',url:'',state:'open',draft:false,authorLogin:'mark',agent:'mark',project:'pond',branch:'m',headCommit:head,baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:f.at,updatedAt:f.at}).run();
 f.db.insert(s.changes).values({id:'github:acme/app#8',repository:'acme/app',number:8,title:'Closed',body:'',url:'',state:'closed',draft:false,authorLogin:'art',agent:'art',project:'pond',branch:'c',headCommit:head,baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:f.at,updatedAt:f.at}).run();
 // One repository has one spelling. Another spelling of a repository loom reads is not "a repository loom does
 // not read": it is refused, for a rule read and for a card, and never answered on its words.
 for(const alias of ['github:acme/app.git#1@'+head,'github:acme/app.GIT#7@'+head,'github:Acme/App#1@'+head,'github:ACME/app#8@'+head,'github:acme/app.git.git#1@'+head,'github:acme/.#1@'+head,'github:../app#1@'+head]){
  expect((await f.call('rule',{kind:'merge',target:alias})).status,alias).toBe(409);
  expect((await f.call('request',{kind:'merge',target:alias,...words})).status,alias).toBe(403);
 }
 // The same holds when what loom has stored is itself spelled with .git: the canonical target is a read repository.
 f.db.insert(s.projectRepositories).values({project:'other',repository:'github:Stored/Repo.git'}).run();
 f.rules.set({kind:'merge',scope:'github:stored/*',tier:'do'},'pat');
 expect((await f.call('rule',{kind:'merge',target:'github:stored/repo#3@'+head})).status).toBe(409);
 expect(f.cards()).toEqual([]);
 for(const wrong of ['github:acme/app#1@'+'f'.repeat(40),'github:acme/app#7@'+head,'github:acme/app#8@'+head,'github:acme/app#99@'+head]){
  expect((await f.call('rule',{kind:'merge',target:wrong})).status,wrong).toBe(409);
  expect((await f.call('request',{kind:'merge',target:wrong,...words})).status,wrong).toBe(403);
 }
 // An exact owner No is still a No.
 f.rules.set({kind:'command',scope:'deploy:*',tier:'do'},'pat');
 expect(await f.rule('command','deploy:site')).toEqual({tier:'do',scope:'deploy:*',person:''});
 // Household changes are not the agent's own account: a rule for settings or dangerous actions is not read for it.
 for(const kind of ['setting','dangerous'] as const){f.rules.set({kind,scope:'*',tier:'do'},'pat');expect(await f.rule(kind,'household:settings')).toEqual(ask);}
 // The owner stops being one: nothing answers. Asking filed nothing and changed nothing.
 f.root.writes.run(()=>f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'pat')).run());
 expect(await f.rule('merge',unread)).toEqual(ask);
 expect(f.cards()).toEqual([]);expect(f.db.select().from(s.approvalRecord).all()).toEqual([]);
 // Only an agent's own credential asks: not a member, not a worker. Another agent asks for itself, and nobody has it.
 for(const token of [raw.member,raw.runner,f.owner]){
  expect((await f.call('rule',{kind:'merge',target:unread},token)).status).toBe(403);
  expect((await f.call('request',{kind:'merge',target:unread,...words},token)).status).toBe(403);
  for(const [name,input] of [['use',{id:'a-none',kind:'merge',target:unread}],['report',{id:'a-none',what:'x'}],['withdraw',{id:'a-none'}]] as const)expect((await f.call(name,input,token)).status,name).toBe(403);
 }
 f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'pat')).run());
 expect(await f.rule('merge',unread,f.other)).toEqual(ask);
 // Nothing lists the rules for an agent.
 const listed=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.agent},body:JSON.stringify({query:'{ approvalRules { scope } }'})});
 expect(((await listed.json()) as {data?:{approvalRules?:unknown[]}}).data?.approvalRules??[]).toEqual([]);
});

it('never answers work done for a member who is not a household owner from the household’s own rules, and reads a lane as the agent’s own',async()=>{
 const f=await fixture();
 f.rules.set({kind:'merge',scope:'*',tier:'do'},'pat');
 // A lane of an agent that only alice has, and she is not a household owner: the household's rule is not read.
 const early=f.root.writes.run(()=>f.root.services.conversations.open({agent:'art',venue:'wake',place:'early',label:'Early',project:'pond'})).value,thread=f.thread.conversation;
 f.root.writes.run(()=>f.db.update(s.jobs).set({member:null,conversation:early.id}).run());
 expect(await f.rule('merge',held,raw.body)).toEqual(ask);
 f.root.writes.run(()=>f.db.update(s.jobs).set({member:'alice',conversation:thread}).run());
 f.ownsArt('pat');
 // A handoff carries the member it was opened for: work handed on for alice is still alice's, and reads no household rule.
 const handed=f.root.writes.run(()=>f.root.services.conversations.open({agent:'art',venue:'handoff',place:'handed',label:'Handed on',project:'pond',member:'alice'})).value;
 f.root.writes.run(()=>f.db.update(s.jobs).set({conversation:handed.id}).run());
 expect(await f.rule('merge',held,raw.body)).toEqual(ask);
 f.rules.set({kind:'merge',scope:'project:pond',person:'alice',tier:'tell'},'pat');
 expect(await f.rule('merge',held,raw.body)).toEqual({tier:'tell',scope:'project:pond',person:'alice'});
 f.rules.set({kind:'merge',scope:'project:pond',person:'alice',tier:null},'pat');
 // A handoff for no member is nobody's.
 const loose=f.root.writes.run(()=>f.root.services.conversations.open({agent:'art',venue:'handoff',place:'loose',label:'Loose',project:'pond'})).value;
 f.root.writes.run(()=>f.db.update(s.jobs).set({member:null,conversation:loose.id}).run());
 expect(await f.rule('merge',held,raw.body)).toEqual(ask);
 f.root.writes.run(()=>f.db.update(s.jobs).set({member:'alice',conversation:thread}).run());
 // The body works in alice's own thread: her work. The household's rule is not hers, though the same agent's terminal reads it.
 expect(await f.rule('merge',held,raw.body)).toEqual(ask);
 expect(await f.rule('merge',held)).toEqual({tier:'do',scope:'*',person:''});
 // A lane: a wake conversation for no member. The agent's own work.
 const lane=f.root.writes.run(()=>f.root.services.conversations.open({agent:'art',venue:'wake',place:'lane',label:'Lane',project:'pond'})).value;
 f.root.writes.run(()=>f.db.update(s.jobs).set({member:null,conversation:lane.id}).run());
 expect(await f.rule('merge',held,raw.body)).toEqual({tier:'do',scope:'*',person:''});
 // The agent's own account is for merges and commands, by any door: a lane reads no rule for a household change.
 for(const kind of ['setting','dangerous'] as const){f.rules.set({kind,scope:'*',tier:'do'},'pat');expect(await f.rule(kind,'household:settings',raw.body),kind).toEqual(ask);}
 f.rules.set({kind:'command',scope:'deploy:*',tier:'tell'},'pat');
 expect(await f.rule('command','deploy:site',raw.body)).toEqual({tier:'tell',scope:'deploy:*',person:''});
 // And a household change proposed from the lane still has nobody behind it: it waits, whatever the rule.
 const proposed=await f.root.http.request('/api/household/propose',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.body},body:JSON.stringify({input:{change:'settings',input:{commsDays:9},why:'Tidy'},id:randomUUID()})});
 expect((await proposed.json() as {value:{state:string}}).value.state).toBe('pending');
 expect(f.cards().at(-1)).toMatchObject({kind:'setting',actingFor:'unknown',state:'pending'});
 f.root.writes.run(()=>f.root.services.approvals.deny(f.cards().at(-1)!.id,'pat'));
 // In a lane too, a repository loom does not read is answered on the target's words, and its card carries no project.
 expect(await f.rule('merge',unread,raw.body)).toEqual({tier:'do',scope:'*',person:''});
 f.rules.set({kind:'merge',scope:'project:pond',tier:'tell'},'pat');
 expect(await f.rule('merge',unread,raw.body)).toEqual({tier:'do',scope:'*',person:''});
 const laneCard=await f.call('request',{kind:'merge',target:unread,...words},raw.body);
 expect(laneCard.body.value).toMatchObject({state:'allowed'});
 expect(f.cards().at(-1)).toMatchObject({actingFor:'agent:art',conversation:lane.id,project:null,target:unread});
 expect((await f.call('use',{id:laneCard.body.value!.id,kind:'merge',target:unread},raw.body)).body.value).toMatchObject({used:true});
 // A room on a bridge, for no member: nobody's. People outside the household talk there.
 const room=f.root.writes.run(()=>f.root.services.conversations.open({agent:'art',venue:'discord',place:'room',label:'Room',project:'pond'})).value;
 f.root.writes.run(()=>f.db.update(s.jobs).set({conversation:room.id}).run());
 expect(await f.rule('merge',held,raw.body)).toEqual(ask);
 const filed=await f.call('request',{kind:'merge',target:held,...words},raw.body);
 expect(filed.body.value).toMatchObject({state:'pending'});
 expect(f.cards().at(-1)).toMatchObject({actingFor:'unknown',conversation:room.id,project:'pond'});
});

it('files, allows, spends once, reports and withdraws a card for a repository loom does not read, on the target’s words alone',async()=>{
 const f=await fixture();f.ownsArt('pat');
 const filed=await f.call('request',{kind:'merge',target:unread,...words});
 expect(filed).toMatchObject({status:200,body:{ok:true,value:{state:'pending'}}});
 const id=filed.body.value!.id as string;
 expect(f.cards()).toMatchObject([{id,kind:'merge',target:unread,agent:'art',actingFor:'agent:art',askedFrom:'terminal',conversation:null,member:null,project:null,operation:null,state:'pending'}]);
 // The household owner is asked, and answers on the card's words: there is no change for loom to hold it to.
 expect(f.db.select().from(s.inbox).all().filter(row=>row.source==='approval')).toMatchObject([{toKind:'person',to:'pat',waitsOnId:id}]);
 const early=await f.call('use',{id,kind:'merge',target:unread});expect(early.body.value,JSON.stringify(early)).toEqual({id,used:false});
 expect((await f.call('answer',{id,answer:'allow'},raw.member)).status).toBe(403);
 expect((await f.call('answer',{id,answer:'allow'},f.owner)).status).toBe(200);
 expect(f.root.services.approvals.get(id)).toMatchObject({state:'allowed',decidedBy:'pat'});
 // Spent once, for exactly that kind and target.
 expect((await f.call('use',{id,kind:'merge',target:'github:sleepunit-agents/art#185@'+'c'.repeat(40)})).body.value).toEqual({id,used:false});
 expect((await f.call('use',{id,kind:'merge',target:unread})).body.value).toEqual({id,used:true});
 expect((await f.call('use',{id,kind:'merge',target:unread})).body.value).toEqual({id,used:false});
 // A report is of a step taken under a tell rule, as it is for a body: this card was an owner's own yes.
 expect((await f.call('report',{id,what:'Merged it'})).body.ok).toBe(false);
 // A tell rule answers the next card as it is filed; a command card is the same without a change at all.
 f.rules.set({kind:'merge',scope:'github:sleepunit-agents/*',tier:'tell'},'pat');
 const next='github:sleepunit-agents/art#186@'+'d'.repeat(40),told=await f.call('request',{kind:'merge',target:next,...words});
 expect(told.body.value).toMatchObject({state:'allowed'});
 expect(f.root.services.approvals.get(told.body.value!.id as string)).toMatchObject({decidedBy:'pat',actingFor:'agent:art'});
 const toldId=told.body.value!.id as string;
 expect((await f.call('use',{id:toldId,kind:'merge',target:next})).body.value).toEqual({id:toldId,used:true});
 expect((await f.call('report',{id:toldId,what:'Merged it'})).body.value).toEqual({id:toldId,reported:true});
 expect(f.db.select().from(s.approvalNotices).all()).toMatchObject([{agent:'art',kind:'merge',target:next,what:'Merged it'}]);
 const command=await f.call('request',{kind:'command',target:'deploy:site',...words});
 expect(command.body.value).toMatchObject({state:'pending'});
 expect((await f.call('withdraw',{id:command.body.value!.id})).body.value).toEqual({id:command.body.value!.id,state:'withdrawn'});
 // A denied card is denied; the owner may always say no.
 const again=await f.call('request',{kind:'merge',target:'github:elsewhere/app#9@'+head,...words});
 expect((await f.call('answer',{id:again.body.value!.id,answer:'deny'},f.owner)).status).toBe(200);
 expect(f.root.services.approvals.get(again.body.value!.id as string).state).toBe('denied');
});

it('holds a terminal card for a repository loom reads to the agent’s own open change at that head',async()=>{
 const f=await fixture();f.ownsArt('pat');
 const request=(target:string,token=raw.agent)=>f.call('request',{kind:'merge',target,...words},token);
 // Not the head loom holds; not a change loom holds; not this agent's change.
 expect((await request('github:acme/app#1@'+'f'.repeat(40))).status).toBe(403);
 expect((await request('github:acme/app#2@'+head)).status).toBe(403);
 expect((await request(held,f.other)).status).toBe(403);
 expect(f.cards()).toEqual([]);
 const filed=await request(held);
 expect(filed.body.value).toMatchObject({state:'pending'});
 const id=filed.body.value!.id as string;
 // It carries the change's project, so the people of that project see it like any other card of theirs.
 expect(f.cards()).toMatchObject([{id,project:'pond',actingFor:'agent:art',conversation:null,member:null}]);
 expect((await f.call('answer',{id,answer:'allow'},f.owner)).status).toBe(200);
 // The head moves before it is spent: refused, as for a body.
 f.root.writes.run(()=>f.db.update(s.changes).set({headCommit:'e'.repeat(40)}).run());
 expect((await f.call('use',{id,kind:'merge',target:held})).status).toBe(403);
 f.root.writes.run(()=>f.db.update(s.changes).set({headCommit:head}).run());
 expect((await f.call('use',{id,kind:'merge',target:held})).body.value).toEqual({id,used:true});
 // A card whose change is gone can only be denied, as before: loom reads that repository.
 const second=await request(held);
 f.root.writes.run(()=>f.db.update(s.changes).set({state:'closed'}).run());
 expect((await f.call('answer',{id:second.body.value!.id,answer:'allow'},f.owner)).status).not.toBe(200);
 expect((await f.call('answer',{id:second.body.value!.id,answer:'deny'},f.owner)).status).toBe(200);
});

it('lets a terminal credential act only on its own agent’s cards filed from no conversation',async()=>{
 const f=await fixture();f.ownsArt('pat');
 const own=(await f.call('request',{kind:'command',target:'deploy:site',...words})).body.value!.id as string;
 const bodys=(await f.call('request',{kind:'merge',target:held,...words},raw.body)).body.value!.id as string;
 const household=(await f.root.http.request('/api/household/propose',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.agent},body:JSON.stringify({input:{change:'settings',input:{commsDays:9},why:'Tidy'},id:randomUUID()})}).then(r=>r.json()) as {value:{id:string}}).value.id;
 // The body's card is its conversation's; the household change is not an approval of this kind; another agent's card is not its own.
 for(const id of [bodys,household])for(const name of ['withdraw','report','use'] as const)
  expect((await f.call(name,name==='withdraw'?{id}:name==='report'?{id,what:'x'}:{id,kind:'merge',target:held})).status,name+' '+id).toBe(403);
 expect((await f.call('withdraw',{id:own},raw.body)).status).toBe(403);
 expect((await f.call('withdraw',{id:own},f.other)).status).toBe(403);
 expect((await f.call('withdraw',{id:own})).body.value).toEqual({id:own,state:'withdrawn'});
 // It reads its own cards' states through the approvals read, as before.
 const read=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.agent},body:JSON.stringify({query:'{ approvals { id state } }'})});
 expect(((await read.json()) as {data:{approvals:{id:string;state:string}[]}}).data.approvals).toEqual(expect.arrayContaining([{id:own,state:'withdrawn'}]));
});

it('leaves a household change proposed from a terminal with nobody behind it: it always asks',async()=>{
 const f=await fixture();f.ownsArt('pat');
 f.rules.set({kind:'setting',scope:'*',tier:'do'},'pat');
 const filed=await f.root.http.request('/api/household/propose',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.agent},body:JSON.stringify({input:{change:'settings',input:{commsDays:9},why:'Tidy'},id:randomUUID()})});
 expect((await filed.json() as {value:{state:string}}).value.state).toBe('pending');
 expect(f.cards()).toMatchObject([{kind:'setting',actingFor:'unknown',state:'pending'}]);
});

it('makes the card and its Inbox question from the full literal command and spends only that command', async () => {
 const f = await fixture();
 f.ownsArt('pat');
 const script = '# ' + 'garden '.repeat(32) + '\r\nprintf one && printf two\r\n';
 const target = 'shell:sha256:' + hash(script);
 const input = {kind:'command',commandText:script,why:'Check the example pump'};
 for (const bad of [{...input,what:'Just look'}, {...input,target},
   {...input,commandText:'\n'.repeat(60_000)+'x'}])
   expect((await f.call('request',bad)).status).toBe(400);
 const result = await f.call('request',input);
 expect(result.status).toBe(200);
 const id = result.body.value!.id as string;
 const card = f.root.services.approvals.get(id);
 expect(card.target).toBe(target);
 expect(JSON.parse(card.details)).toBe(script);
 expect(card.what).toContain('shortened');
 expect(card.ask).toContain('separators');
 const questions = f.db.select().from(s.inbox).where(eq(s.inbox.waitsOnId,id)).all();
 expect(questions.length).toBeGreaterThan(0);
 expect(questions.every(row=>row.words===card.ask)).toBe(true);
 f.root.writes.run(()=>f.root.services.approvals.allow(id,'pat'));
 const asNamed = (cardId: string) => f.call('use',{id:cardId,kind:'command',target});
 expect((await asNamed(id)).body.value?.used).toBe(false);
 // A named request issued under the same spelling remains a distinct allowance.
 const named = await f.call('request',{kind:'command',target,...words});
 const namedId = named.body.value!.id as string;
 f.root.writes.run(()=>f.root.services.approvals.allow(namedId,'pat'));
 expect((await f.call('use',{id:namedId,kind:'command',commandText:script})).body.value?.used).toBe(false);
 expect((await asNamed(namedId)).body.value?.used).toBe(true);
 const denied = await f.call('request',{kind:'command',target,...words});
 f.root.writes.run(()=>f.root.services.approvals.deny(denied.body.value!.id as string,'pat'));
 expect(f.root.services.approvals.get(id).state).toBe('allowed');
 const use = (commandText:string)=>f.call('use',{id,kind:'command',commandText});
 expect((await use(script.trimEnd())).body.value?.used).toBe(false);
 expect((await use(script)).body.value?.used).toBe(true);
 expect((await use(script)).body.value?.used).toBe(false);
});

it('keeps literal commands pending under standing allowances for named commands', async () => {
 const f = await fixture();
 f.ownsArt('pat');
 const commandText='printf example',target='shell:sha256:'+hash(commandText);
 for (const scope of ['*', target]) {
   f.rules.set({kind:'command',scope,tier:'do'},'pat');
   const literal = await f.call('request',{kind:'command',commandText,why:'Fixture'});
   expect(literal.body.value?.state).toBe('pending');
   const named = await f.call('request',{kind:'command',target,...words});
   expect(named.body.value?.state).toBe('allowed');
   f.rules.set({kind:'command',scope,tier:null},'pat');
 }
});
