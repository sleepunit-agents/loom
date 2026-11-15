import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { FakeClock } from '../clock.js';
import { Conversations } from '../conversations/index.js';
import { createDataSchema } from '../data/database.js';
import { agents, approvals, changes, inbox, members, tasks, projects, projectAgents, projectMembers } from '../data/schema.js';
import { createTempo } from './tempo.js';
import { WORK_SWEEP_LIMIT, workSweepParts } from './work-sweep.js';

it('sweeps committed open work into one settled batch per recorded recipient and stops when work closes', () => {
  const client = new Database(':memory:'), clock = new FakeClock();
  const now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values(['jonathan', 'other', 'art'].map(id => ({ id, role: 'owner' as const, joinedAt: now() }))).run();
  db.insert(agents).values(['art', 'mark'].map(id => ({ id, about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble' as const, faceEyes: 'dot' as const }))).run();
  db.insert(projects).values({id:'pond',name:'Pond'}).run();
  db.insert(projectAgents).values(['art','mark'].map(agent=>({project:'pond',agent}))).run();
  const old = new Date(clock.now() - 3 * 86_400_000).toISOString().replace('.000Z', 'Z');
  const task = { title: 'Pick a pump', ownerKind: 'agent' as const, owner: 'art', createdByKind: 'agent' as const, createdBy: 'art', createdAt: old, changedAt: now() };
  db.insert(tasks).values([
    { ...task, id: 'owned' }, { ...task, id: 'assigned', owner: 'mark', project:'pond', assigneeKind: 'agent', assignee: 'art' },
    { ...task, id: 'given-away', assigneeKind: 'agent', assignee: 'mark' },
    { ...task, id: 'closed', status: 'closed' }, { ...task, id: 'epic', type: 'epic' },
    { ...task, id: 'person', ownerKind: 'member', owner: 'jonathan' },
    { ...task, id: 'same-id-person', ownerKind: 'member', owner: 'art' },
    { ...task, id: 'household', ownerKind: 'household', owner: null },
  ]).run();
  db.insert(changes).values({ id: 'pr', repository: 'house/loom', number: 1, title: 'Pump script', body: '', url: 'https://example.test/pr/1', state: 'open', draft: false, authorLogin: 'art', agent: 'art', branch: 'pump', headCommit: 'abc', baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'yes', waitingOn: 'ci', openedAt: old, updatedAt: now() }).run();
  db.insert(changes).values({ ...db.select().from(changes).get()!, id: 'other-pr', number: 2, agent: 'mark' }).run();
  const approval = { kind: 'command' as const, target: 'pump', what: 'Buy', why: 'Needed', agent: 'art', askedFrom: 'chat', actingFor: 'jonathan', state: 'pending' as const, minutes: 60, ask: 'Buy the pump?', ifYes: 'Buy', ifNo: 'Wait', details: '', askedAt: old };
  db.insert(approvals).values([
    { ...approval, id: 'pending' }, { ...approval, id: 'done', state: 'allowed' },
    { ...approval, id: 'expired', expiresAt: now() }, { ...approval, id: 'private', member: 'other' },
    { ...approval, id: 'other-person', actingFor: 'other' },
    { ...approval, id: 'whole-second-expired', expiresAt: now().replace('.000Z', 'Z') },
    { ...approval, id: 'later', expiresAt: new Date(clock.now() + 500).toISOString() },
  ]).run();
  const admitted: Array<{ who: string; ids: string[] }> = [];
  const tempo = createTempo(db, clock, { conversations: new Conversations(db, now),
    admit(who, items) { admitted.push({ who: who.id, ids: items.map(i => i.id) }); return true; }, operation() { throw new Error('Unexpected operation'); } });
  try {
    const parts = workSweepParts(db, clock);
    parts.forEach(part => tempo.sweep.register(part));
    tempo.start();
    const agent = { kind: 'agent' as const, id: 'art' }, person = { kind: 'person' as const, id: 'jonathan' };
    expect(tempo.sweep.run(agent, 'morning')).toMatchObject([{ part: 'Tasks', count: 3, ageMs: 3 * 86_400_000 }, { part: 'Changes', count: 1 }]);
    expect(tempo.sweep.run(person, 'morning')).toMatchObject([{ part: 'Tasks', count: 1, items: [{ id: 'person' }] }, { part: 'Approvals', count: 2 }]);
    expect(parts[0].open({ kind: 'person', id: 'art' })).toMatchObject({ count: 1, items: [{ id: 'same-id-person' }] });
    // A duplicate occurrence delivers no second inbox item.
    tempo.sweep.run(agent, 'morning');
    expect(db.select().from(inbox).all()).toHaveLength(2);
    tempo.changed(); clock.advance(4_999); expect(admitted).toEqual([]);
    clock.advance(1); expect(admitted.map(a => a.who).sort()).toEqual(['art', 'jonathan']);
    expect(admitted.every(a => a.ids.length === 1)).toBe(true);
    expect(parts[2].open(person)).toMatchObject({ count: 1, items: [{ id: 'pending', words: 'Buy the pump?', openedAt: old }] });
    expect(parts[1].open(agent)).toMatchObject({ count: 1, items: [{ id: 'pr', words: 'Pump script', openedAt: old }] });
    // Contributions stay short while the total and oldest age remain accurate.
    db.insert(tasks).values(Array.from({ length: 25 }, (_, i) => ({ ...task, id: `more-${i}`, createdAt: i === 0 ? new Date(Date.parse(old) + 500).toISOString() : now() }))).run();
    const large = tempo.sweep.run(agent, 'large');
    expect(large[0]).toMatchObject({ count: 28, ageMs: 3 * 86_400_000 + 5_000 });
    expect(large[0].items).toHaveLength(WORK_SWEEP_LIMIT);
    expect(large[0].items.slice(0, 4).map(i => i.id)).toEqual(['assigned', 'epic', 'owned', 'more-0']);
    expect(db.select().from(inbox).all().at(-1)?.words).toContain('8 more open');
    db.update(tasks).set({ status: 'closed' }).run();
    db.update(changes).set({ state: 'merged' }).where(eq(changes.id, 'pr')).run();
    expect(tempo.sweep.run(agent, 'evening')).toEqual([]);
    expect(db.select().from(inbox).all()).toHaveLength(3);
  } finally { tempo.close(); client.close(); }
});
it('does not deliver assignment summaries outside current task sharing, including after project revocation',()=>{
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 try {
  db.insert(members).values({id:'sam',role:'member',joinedAt:now()}).run();
  db.insert(agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
  db.insert(projects).values({id:'pond',name:'Pond'}).run();
  db.insert(projectAgents).values({project:'pond',agent:'art'}).run();db.insert(projectMembers).values({project:'pond',member:'sam'}).run();
  const task={ownerKind:'agent' as const,owner:'mark',createdByKind:'agent' as const,createdBy:'mark',createdAt:now(),changedAt:now()};
  db.insert(tasks).values([{...task,id:'project-agent',title:'Visible project task',project:'pond',assigneeKind:'agent',assignee:'art'},
   {...task,id:'project-person',title:'Visible person task',project:'pond',assigneeKind:'member',assignee:'sam'},
   {...task,id:'hidden',title:'PRIVATE MARK TASK',assigneeKind:'agent',assignee:'art'}]).run();
  db.insert(tasks).values(Array.from({length:WORK_SWEEP_LIMIT+1},(_,i)=>({...task,id:`hidden-old-${i}`,title:`PRIVATE OLD TASK ${i}`,assigneeKind:'agent' as const,assignee:'art',createdAt:new Date(clock.now()-86400000).toISOString()}))).run();
  const approval={kind:'command' as const,target:'test',what:'test',why:'test',agent:'mark',askedFrom:'test',actingFor:'sam',state:'pending' as const,minutes:1,ask:'PRIVATE MARK APPROVAL',ifYes:'Run',ifNo:'Stop',details:'',askedAt:now()};
  db.insert(approvals).values([{...approval,id:'hidden-approval'},{...approval,id:'visible-approval',member:'sam',ask:'Visible private approval'},{...approval,id:'project-approval',project:'pond',ask:'Visible project approval'}]).run();
  const admitted=vi.fn(()=>true);
  const tempo=createTempo(db,clock,{conversations:new Conversations(db,now),admit:admitted,operation(){throw Error('No operation');}});
  try {
   workSweepParts(db,clock).forEach(part=>tempo.sweep.register(part));tempo.start();
   const agent={kind:'agent' as const,id:'art'},person={kind:'person' as const,id:'sam'};
   expect(tempo.sweep.run(agent,'visible')).toMatchObject([{part:'Tasks',count:1,items:[{id:'project-agent'}]}]);
   expect(tempo.sweep.run(person,'visible')).toMatchObject([{part:'Tasks',count:1,items:[{id:'project-person'}]},{part:'Approvals',count:2,items:[{id:'project-approval'},{id:'visible-approval'}]}]);
   expect(JSON.stringify(db.select().from(inbox).all())).not.toContain('PRIVATE MARK TASK');
   expect(JSON.stringify(db.select().from(inbox).all())).not.toContain('PRIVATE MARK APPROVAL');
   db.update(approvals).set({state:'allowed'}).where(eq(approvals.id,'visible-approval')).run();
   db.delete(inbox).run();db.delete(projectAgents).run();db.delete(projectMembers).run();
   expect(tempo.sweep.run(agent,'revoked')).toEqual([]);expect(tempo.sweep.run(person,'revoked')).toEqual([]);
   expect(db.select().from(inbox).all()).toEqual([]);tempo.changed();clock.advance(5000);expect(admitted).not.toHaveBeenCalled();
  } finally {tempo.close();}
 } finally {client.close();}
});
