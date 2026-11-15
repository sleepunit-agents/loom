import Database from 'better-sqlite3';
import { GraphQLInt, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { DataLive } from '../core/data/live.js';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { DataWrites } from '../core/data/writes.js';
import { OperationResults } from '../core/data/operation-results.js';
import { agents, members, inbox, approvals, tasks, changes } from '../core/data/schema.js';
import { Conversations } from '../core/conversations/index.js';
import { Operations } from '../core/operations/index.js';
import { installTempoComposition } from './tempo-composition.js';

const cleanup: (()=>void)[]=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
function fixture() {
  const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString();
  const db=createDataSchema(client,now);
  db.insert(members).values({id:'owner',role:'owner',joinedAt:now()}).run();
  db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
  const writeChanged=vi.fn(),writes=new DataWrites(db,{refreshAccess(){},changed:writeChanged});
  const operations=new Operations(client,clock,()=>{},{receipts:new OperationResults(db),writes,reportError:e=>{throw e;}});
  const mail=new Conversations(db,now),admitted=vi.fn(()=>true),changed=vi.fn();
  const tempo=installTempoComposition({db,clock,writes,operations,commands:{authorize:()=>true,settings(){throw Error('not used');}},
    delivery:{conversations:mail,admit:admitted,changed,operation(){throw Error('unknown operation');}}});
  cleanup.push(()=>{tempo.close();operations.close();client.close();});
  return {client,db,clock,now,writes,operations,mail,tempo,admitted,changed,writeChanged};
}

it('starts settled admission only after an outer shared commit; rolls back do not wake',()=>{
  const f=fixture(),conversation=f.mail.open({agent:'art',venue:'wake',place:'work',label:'Work'});
  expect(()=>f.writes.run(()=>{f.mail.send({toKind:'agent',to:'art',conversation:conversation.id,source:'trigger',sourceId:'failed',fromKind:'schedule',words:'rolled back'});throw Error('receipt failed');})).toThrow();
  f.clock.advance(10000);expect(f.admitted).not.toHaveBeenCalled();
  f.writes.run(()=>f.mail.send({toKind:'agent',to:'art',conversation:conversation.id,source:'trigger',sourceId:'committed',fromKind:'schedule',words:'committed'}));
  f.clock.advance(4999);expect(f.admitted).not.toHaveBeenCalled();
  f.clock.advance(1);expect(f.admitted).toHaveBeenCalledOnce();
  expect(f.admitted.mock.calls[0]).toMatchObject([{kind:'agent',id:'art'},[{words:'committed'}]]);
});

it('recovers answered sources through the shared commit boundary and stops late callbacks on close',()=>{
  const f=fixture();
  f.tempo.triggers.set({id:'watch',ownerKind:'household',sourceKind:'answer',watches:'question:q',lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'The answer arrived',note:'Answer'});
  const answer=()=>f.db.insert(inbox).values({id:'q',toKind:'person',to:'owner',source:'thread',fromKind:'agent',state:'answered',answers:'yes-no',words:'Ready?',answer:'yes',answeredAt:f.now(),at:f.now(),changedAt:f.now()}).run();
  expect(()=>f.writes.run(()=>{f.writes.run(answer);expect(f.db.select().from(inbox).all().filter(i=>i.source==='trigger')).toEqual([]);throw Error('outer rollback');})).toThrow();
  expect(f.db.select().from(inbox).all()).toEqual([]);
  f.writes.run(answer);
  expect(f.db.select().from(inbox).all().filter(i=>i.source==='trigger')).toMatchObject([{words:'The answer arrived'}]);
  f.clock.advance(5000);expect(f.admitted).toHaveBeenCalledOnce();
  f.tempo.close();f.admitted.mockClear();
  f.writes.run(()=>f.mail.send({toKind:'person',to:'owner',source:'notice',fromKind:'schedule',words:'After close'}));
  f.clock.advance(5000);expect(f.admitted).not.toHaveBeenCalled();
});

it('registers real work contributors: an empty sweep sends nothing and open tasks combine in one item',()=>{
  const f=fixture();
  f.tempo.sweep.run({kind:'agent',id:'art'},'empty');
  expect(f.db.select().from(inbox).all()).toEqual([]);
  f.db.insert(tasks).values({id:'t',title:'Fix pump',ownerKind:'agent',owner:'art',createdByKind:'agent',createdBy:'art',createdAt:f.now(),changedAt:f.now()}).run();
  f.db.insert(changes).values({id:'pr',repository:'org/repo',number:1,title:'PR',body:'',url:'https://example.test/pr',state:'open',draft:false,authorLogin:'art',agent:'art',branch:'feature',headCommit:'abc',baseBranch:'next',checks:'running',review:'required',mergeable:'unknown',waitingOn:'ci',openedAt:f.now(),updatedAt:f.now()}).run();
  f.db.insert(approvals).values({id:'approval',kind:'command',target:'test',what:'test',why:'test',agent:'art',askedFrom:'test',actingFor:'owner',state:'pending',minutes:1,ask:'Run?',ifYes:'Run',ifNo:'Stop',details:'',askedAt:f.now()}).run();
  expect(f.tempo.sweep.run({kind:'agent',id:'art'},'open')).toMatchObject([{part:'Tasks',count:1},{part:'Changes',count:1}]);
  expect(f.tempo.sweep.run({kind:'person',id:'owner'},'open')).toMatchObject([{part:'Approvals',count:1}]);
  expect(f.db.select().from(inbox).all()).toMatchObject([{to:'art',words:expect.stringContaining('Tasks: 1 open')},{to:'owner',words:expect.stringContaining('Approvals: 1 open')}]);
});

it('publishes a post-commit source result once through the existing live signal, while keeping timer and capacity publications',async()=>{
 const f=fixture(),live=new DataLive();
 f.changed.mockImplementation(()=>live.changed());f.writeChanged.mockImplementation(()=>live.changed());
 f.tempo.triggers.set({id:'watch',ownerKind:'household',sourceKind:'answer',watches:'question:q',lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Answer arrived',note:'Answer'});
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:{delivered:{type:GraphQLInt,resolve:()=>f.db.select().from(inbox).all().filter(i=>i.source==='trigger').length}}})});
 const watch=live.watch({schema,query:'{ delivered }',valid:()=>true});
 try{
  expect((await watch.next()).value?.patches).toEqual([{path:[],value:{delivered:0}}]);
  f.changed.mockClear();f.writeChanged.mockClear();const pending=watch.next();
  f.writes.run(()=>f.db.insert(inbox).values({id:'q',toKind:'person',to:'owner',source:'notice',fromKind:'agent',state:'answered',answer:'yes',answeredAt:f.now(),at:f.now(),changedAt:f.now()}).run());
  expect((await pending).value?.patches).toEqual([{path:['delivered'],value:1}]);
  expect(f.writeChanged).toHaveBeenCalledOnce();expect(f.changed).not.toHaveBeenCalled();
  f.tempo.capacityChanged();expect(f.changed).toHaveBeenCalledOnce();
  f.tempo.triggers.set({id:'timer',ownerKind:'household',sourceKind:'time',times:new Date(f.clock.now()+1000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Timer',note:'Timer'});
  f.changed.mockClear();f.clock.advance(1000);expect(f.changed).toHaveBeenCalledOnce();
  expect(f.db.select().from(inbox).all().filter(i=>i.source==='trigger')).toHaveLength(2);
 }finally{await watch.return?.();live.close();}
});
