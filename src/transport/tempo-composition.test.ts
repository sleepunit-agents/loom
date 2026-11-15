import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { DataWrites } from '../core/data/writes.js';
import { OperationResults } from '../core/data/operation-results.js';
import { agents, members, inbox, approvals, tasks } from '../core/data/schema.js';
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
  const writes=new DataWrites(db,{refreshAccess(){},changed(){}});
  const operations=new Operations(client,clock,()=>{},{receipts:new OperationResults(db),writes,reportError:e=>{throw e;}});
  const mail=new Conversations(db,now),admitted=vi.fn(()=>true),changed=vi.fn();
  const tempo=installTempoComposition({db,clock,writes,operations,commands:{authorize:()=>true,settings(){throw Error('not used');}},
    delivery:{conversations:mail,admit:admitted,changed,operation(){throw Error('unknown operation');}}});
  cleanup.push(()=>{tempo.close();operations.close();client.close();});
  return {client,db,clock,now,writes,operations,mail,tempo,admitted,changed};
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
  f.writes.run(()=>f.db.insert(inbox).values({id:'q',toKind:'person',to:'owner',source:'thread',fromKind:'agent',state:'answered',answers:'yes-no',words:'Ready?',answer:'yes',answeredAt:f.now(),at:f.now(),changedAt:f.now()}).run());
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
  f.tempo.sweep.run({kind:'agent',id:'art'},'open');
  expect(f.db.select().from(inbox).all()).toMatchObject([{to:'art',words:expect.stringContaining('Tasks: 1 open')}]);
});
