import Database from 'better-sqlite3';
import { expect,it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { household, members, agents, tempoSettings } from '../data/schema.js';
import { tempoQueryFields } from './queries.js';
it('projects only the timezone and the caller\'s own timings to member/agent schemas and gives no value to other callers',()=>{
 const client=new Database(':memory:'),db=createDataSchema(client);
 try {
  expect(tempoQueryFields(db,{kind:'member',id:'sam'}).tempoTimezone.resolve()).toBe('UTC');
  db.insert(household).values({timezone:'America/Chicago',backupTarget:'PRIVATE TARGET'}).run();
  for(const kind of ['member','agent'] as const)expect(tempoQueryFields(db,{kind,id:'caller'}).tempoTimezone.resolve()).toBe('America/Chicago');
  for(const kind of ['runner','service'] as const)expect(tempoQueryFields(db,{kind,id:'caller'}).tempoTimezone.resolve()).toBeNull();
  expect(Object.keys(tempoQueryFields(db,{kind:'member',id:'sam'}))).toEqual(['tempoTimezone','tempoTimings']);
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
  expect(tempoQueryFields(db,{kind:'agent',id:'sam'}).tempoTimings.resolve()).toEqual({settleSeconds:5,dimDays:1,muteDays:7});
  for(const kind of ['runner','service'] as const)expect(tempoQueryFields(db,{kind,id:'sam'}).tempoTimings.resolve()).toBeNull();
 } finally {client.close();}
});
