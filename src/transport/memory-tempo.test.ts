import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createDataSchema } from '../core/data/database.js';
import { agents, household, inbox, triggers } from '../core/data/schema.js';
import { Conversations } from '../core/conversations/index.js';
import { FakeClock } from '../core/clock.js';
import { createTempo } from '../core/tempo/tempo.js';
import { knowledgeSweep } from '../pieces/mind/knowledge-sweep.js';
import { installMemoryTempo } from './memory-tempo.js';

it('runs the installed Knowledge contributor daily at household time through Conversations and preserves a stopped schedule on restart', () => {
  const client = new Database(':memory:'), db = createDataSchema(client);
  const knowledge = new Database(':memory:');
  knowledge.exec("CREATE TABLE pages (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, updated TEXT, verified_at TEXT, status TEXT); INSERT INTO pages VALUES (1, 'fictional-pump', 'Fictional pump', '2020-01-01', NULL, 'active')");
  const clock = new FakeClock(Date.parse('2026-11-14T13:16:59Z'));
  db.insert(household).values({ id: 'house', name: 'Fictional household', timezone: 'America/Chicago' }).run();
  db.insert(agents).values({ id: 'checker', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const options = { conversations: new Conversations(db, () => new Date(clock.now()).toISOString()), admit: () => false,
    operation: () => { throw new Error('Unexpected operation'); } };
  const reader = { sweep: (agent: string) => knowledgeSweep(knowledge, clock, agent) };
  let tempo = createTempo(db, clock, options);
  try {
    let remove = installMemoryTempo(db, tempo, reader, 'checker');
    tempo.start();
    expect(db.select().from(triggers).get()?.nextDueAt).toBe('2026-11-14T13:17:00.000Z');
    expect(db.select().from(inbox).all()).toEqual([]);
    clock.advance(1000);
    expect(db.select().from(inbox).all()).toMatchObject([{ to: 'checker', source: 'notice', words: expect.stringContaining('fictional-pump') }]);
    expect(knowledge.prepare('SELECT verified_at FROM pages').get()).toEqual({ verified_at: null });
    remove(); tempo.close();
    tempo = createTempo(db, clock, options);
    remove = installMemoryTempo(db, tempo, reader, 'checker'); tempo.start();
    expect(db.select().from(triggers).all()).toHaveLength(1);
    expect(db.select().from(inbox).all()).toHaveLength(1);
    clock.advance(86_400_000);
    expect(db.select().from(inbox).all()).toHaveLength(2);
    tempo.triggers.stop('knowledge-sweep:checker'); remove(); tempo.close();
    tempo = createTempo(db, clock, options);
    installMemoryTempo(db, tempo, reader, 'checker'); tempo.start();
    clock.advance(86_400_000);
    expect(db.select().from(inbox).all()).toHaveLength(2);
    expect(db.select().from(triggers).get()?.state).toBe('stopped');
  } finally { tempo.close(); knowledge.close(); client.close(); }
});

it('requires a named agent and leaves a conflicting schedule untouched without registering its reader', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), clock = new FakeClock();
  const tempo = createTempo(db, clock, { conversations: new Conversations(db), admit: () => false, operation() {} });
  let reads = 0;
  const reader = { sweep: () => { reads++; return { name: 'Knowledge', open: () => [] }; } };
  try {
    expect(() => installMemoryTempo(db, tempo, reader, ' ')).toThrow('explicit checking agent');
    tempo.triggers.set({ id: 'knowledge-sweep:checker', ownerKind: 'household', sourceKind: 'time', times: '08:19', lifespan: 'until-stopped', targetKind: 'operation', target: 'other', note: 'Someone else’s schedule' });
    const before = db.select().from(triggers).all();
    expect(() => installMemoryTempo(db, tempo, reader, 'checker')).toThrow('conflicts');
    expect(db.select().from(triggers).all()).toEqual(before);
    expect(reads).toBe(0);
  } finally { tempo.close(); client.close(); }
});

it('schedules the alternate only for independent checks and stops routing them when unconfigured', () => {
  const client=new Database(':memory:'), db=createDataSchema(client), clock=new FakeClock(Date.parse('2026-11-14T13:16:59Z'));
  db.insert(household).values({id:'house',name:'Example',timezone:'America/Chicago'}).run();
  for(const id of ['first','second'])db.insert(agents).values({id,about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
  const tempo=createTempo(db,clock,{conversations:new Conversations(db,()=>new Date(clock.now()).toISOString()),admit:()=>false,operation(){throw Error('Unexpected operation');}});
  const item=(id:string)=>[{id,words:id,openedAt:new Date(clock.now()).toISOString()}];
  const reader={sweep:()=>({name:'Knowledge',open:(who:{id:string})=>item('page-for-'+who.id)})};
  try{
    tempo.sweep.register({name:'Tasks',open:()=>item('unrelated')});
    const close=installMemoryTempo(db,tempo,reader,'first','second');
    tempo.start();clock.advance(1000);
    const words=()=>db.select().from(inbox).all().filter(row=>row.to==='second').map(row=>row.words);
    expect(words()).toEqual([expect.stringContaining('page-for-second')]);
    expect(words()[0]).not.toContain('unrelated');
    close();installMemoryTempo(db,tempo,reader,'first');clock.advance(86_400_000);
    expect(words()).toHaveLength(1);
  }finally{tempo.close();client.close();}
});
