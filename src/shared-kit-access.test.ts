import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createDataSchema } from './core/data/database.js';
import { agentKitMembers, agentKitProjects, agentKits, agents, members, projectMembers, projects } from './core/data/schema.js';
import { kitAccess } from './shared-kit-access.js';

it('looks up every current project of the asker, independently of the room, and unions direct grants', () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client), agent = 'art', member = 'sam';
    db.insert(agents).values({id:agent, about:'', markBg:'', markFg:'', faceShape:'pebble', faceEyes:'dot'}).run();
    db.insert(members).values({id:member, role:'member', joinedAt:new Date().toISOString()}).run();
    db.insert(projects).values({id:'pond',name:'Pond'}).run();
    db.insert(projectMembers).values({project:'pond',member}).run();
    for (const kit of ['weather','lookup','private']) db.insert(agentKits).values({agent,kit,tools:[]}).run();
    db.insert(agentKitMembers).values({agent,kit:'weather',member}).run();
    db.insert(agentKitProjects).values({agent,kit:'lookup',project:'pond'}).run();
    const kits = () => kitAccess(db,agent,{woke:'others',person:{kind:'member',id:member}}).kits.map(row => row.kit).sort();
    expect(kits()).toEqual(['lookup','weather']);
    db.delete(projectMembers).run();
    expect(kits()).toEqual(['weather']);
    expect(kitAccess(db,agent,{woke:'others'}).kits).toEqual([]);
    expect(kitAccess(db,agent,{woke:'own'}).kits).toHaveLength(3);
  } finally { client.close(); }
});
