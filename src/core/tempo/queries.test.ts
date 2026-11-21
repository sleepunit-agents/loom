import Database from 'better-sqlite3';
import { expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { household, members, memberAgents, agents, triggers, tempoSettings } from '../data/schema.js';
import { tempoQueryFields } from './queries.js';
it('projects only the timezone and the caller\'s own timings to member/agent schemas and gives no value to other callers',()=>{
 const client=new Database(':memory:'),db=createDataSchema(client);
 try {
  db.insert(members).values([{id:'sam',role:'member',joinedAt:'2026-11-15T00:00:00.000Z'},{id:'caller',role:'member',joinedAt:'2026-11-15T00:00:00.000Z'}]).run();
  db.insert(agents).values({id:'caller',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
  expect(tempoQueryFields(db,{kind:'member',id:'sam'}).tempoTimezone.resolve()).toBe('UTC');
  db.insert(household).values({timezone:'America/Chicago',backupTarget:'PRIVATE TARGET'}).run();
  for(const kind of ['member','agent'] as const)expect(tempoQueryFields(db,{kind,id:'caller'}).tempoTimezone.resolve()).toBe('America/Chicago');
  // Only someone in the household now: not a member who has been removed, and not a body whose member has.
  expect(tempoQueryFields(db,{kind:'agent',id:'caller',workingFor:'sam'}).tempoTimings.resolve()).not.toBeNull();
  db.update(members).set({removedAt:'2026-11-15T00:00:00.000Z'}).where(eq(members.id,'sam')).run();
  for(const viewer of [{kind:'member',id:'sam'},{kind:'agent',id:'caller',workingFor:'sam'},{kind:'member',id:'nobody'},{kind:'agent',id:'nobody'}] as const){
   expect(tempoQueryFields(db,viewer).tempoTimezone.resolve()).toBeNull();expect(tempoQueryFields(db,viewer).tempoTimings.resolve()).toBeNull();
  }
  for(const kind of ['runner','service'] as const)expect(tempoQueryFields(db,{kind,id:'caller'}).tempoTimezone.resolve()).toBeNull();
  expect(Object.keys(tempoQueryFields(db,{kind:'member',id:'sam'}))).toEqual(['tempoProgram','tempoJournal','tempoDeliveries','tempoDefaultAgent','tempoTimezone','tempoTimings']);
 } finally {client.close();}
});
it('reads the caller\'s own timings, with the defaults until it has changed one, and never another caller\'s',()=>{
 const client=new Database(':memory:'),db=createDataSchema(client);
 try {
  db.insert(members).values({id:'sam',role:'owner',joinedAt:'2026-11-15T00:00:00.000Z'}).run();
  db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(tempoSettings).values({whoKind:'person',who:'sam',settleSeconds:60,dimDays:2,muteDays:7}).run();
  expect(tempoQueryFields(db,{kind:'member',id:'sam'}).tempoTimings.resolve()).toEqual({settleSeconds:60,dimDays:2,muteDays:7});
  expect(tempoQueryFields(db,{kind:'agent',id:'art'}).tempoTimings.resolve()).toEqual({settleSeconds:5,dimDays:1,muteDays:7});
  expect(tempoQueryFields(db,{kind:'agent',id:'sam'}).tempoTimings.resolve()).toBeNull();
  for(const kind of ['runner','service'] as const)expect(tempoQueryFields(db,{kind,id:'sam'}).tempoTimings.resolve()).toBeNull();
 } finally {client.close();}
});

it('shows the journal of an agent-owned standing wake only to a current owner in Tempo', () => {
 const client = new Database(':memory:'), db = createDataSchema(client);
 const at = '2026-11-15T00:00:00.000Z';
 try {
  db.insert(members).values([{ id: 'pat', role: 'owner', joinedAt: at }, { id: 'sam', role: 'member', joinedAt: at }]).run();
  db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(triggers).values({id:'lane', ownerKind:'agent', owner:'art', toKind:'agent', to:'art', targetKind:'inbox',
   lifespan:'until-stopped', sourceKind:'time', note:'Run', enabled:true, state:'standing', createdAt:at, changedAt:at}).run();
  const owner = tempoQueryFields(db, {kind:'member', id:'pat'}).tempoJournal;
  expect(owner.resolve(null, {id:'lane'})).toEqual({lessons:'', state:'', stateChangedAt:null});
  for (const viewer of [{kind:'member',id:'sam'}, {kind:'agent',id:'art'}, {kind:'service',id:'pat'}] as const)
   expect(tempoQueryFields(db,viewer).tempoJournal.resolve(null,{id:'lane'})).toBeNull();
  db.update(triggers).set({member:'sam'}).where(eq(triggers.id,'lane')).run();
  expect(owner.resolve(null,{id:'lane'})).toBeNull();
  db.update(triggers).set({member:null}).where(eq(triggers.id,'lane')).run();
  db.update(members).set({removedAt:at}).where(eq(members.id,'pat')).run();
  expect(owner.resolve(null,{id:'lane'})).toBeNull();
 } finally {client.close();}
});

it('chooses a clock from the current viewer and ignores inaccessible defaults and removed agents', () => {
  const client = new Database(':memory:'), db = createDataSchema(client);
  const at = '2026-11-15T00:00:00.000Z';
  try {
    db.insert(members).values({id:'sam',role:'member',joinedAt:at}).run();
    for (const id of ['fern','birch','cedar']) {
      db.insert(agents).values({id,about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
    }
    db.insert(household).values({defaultAgent:'cedar'}).run();
    const member = tempoQueryFields(db,{kind:'member',id:'sam'}).tempoDefaultAgent;
    const body = tempoQueryFields(db,{kind:'agent',id:'birch',workingFor:'sam'}).tempoDefaultAgent;
    expect(member.resolve()).toBeNull();
    expect(body.resolve()).toBeNull();
    db.insert(memberAgents).values({member:'sam',agent:'birch'}).run();
    expect(member.resolve()).toBe('birch');
    expect(body.resolve()).toBe('birch');
    db.insert(memberAgents).values({member:'sam',agent:'fern'}).run();
    expect(member.resolve()).toBeNull();
    db.update(household).set({defaultAgent:'fern'}).run();
    expect(member.resolve()).toBe('fern');
    expect(body.resolve()).toBe('birch');
    db.update(agents).set({removedAt:at}).where(eq(agents.id,'fern')).run();
    expect(member.resolve()).toBe('birch');
    db.update(members).set({removedAt:at}).run();
    expect(body.resolve()).toBeNull();
    expect(member.resolve()).toBeNull();
  } finally { client.close(); }
});
