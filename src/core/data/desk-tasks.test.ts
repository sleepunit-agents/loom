import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { members, tasks, taskLinks } from './schema';
import { deskTasksQuery } from '../../ui/desk-queries.fixture.js';

it('reads minimal progress and SQL readiness, including a hidden blocker, and reapplies current fixture visibility', async () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client), at = '2026-11-14T00:00:00Z';
    db.insert(members).values([{id:'member',role:'member',joinedAt:at},{id:'other',role:'member',joinedAt:at}]).run();
    const row = {title:'Private title',ownerKind:'member' as const,owner:'member',createdByKind:'member' as const,createdBy:'member',createdAt:at,changedAt:at};
    db.insert(tasks).values([
      {...row,id:'ready'}, {...row,id:'blocked'}, {...row,id:'parented'},
      {...row,id:'epic',type:'epic'}, {...row,id:'working',status:'in_progress'},
      {...row,id:'closed',status:'closed'}, {...row,id:'hidden',owner:'other'},
    ]).run();
    db.insert(taskLinks).values([{task:'blocked',dependsOn:'hidden',type:'blocks'},{task:'parented',dependsOn:'epic',type:'parent-child'}]).run();
    let visible = true;
    // Fixture predicate only; root supplies the production Tasks policy on HTTP and socket.
    const schema = dataQueries(client,{tables:['tasks'],visibility:{tasks:f=>visible ? sql`${f.owner} = 'member'` : sql`false`}});
    const read = () => graphql({schema,source:deskTasksQuery});
    const result = await read();
    expect(result.errors).toBeUndefined();
    expect(result.data?.inProgress).toEqual([{id:'working',isShelved:false}]);
    expect(result.data?.readyTasks).toEqual(expect.arrayContaining([{id:'ready'},{id:'parented'}]));
    expect(result.data?.readyTasks).toHaveLength(2);
    db.update(tasks).set({status:'closed'}).where(sql`${tasks.id} = 'hidden'`).run();
    expect((await read()).data?.readyTasks).toHaveLength(3);
    db.update(tasks).set({status:'in_progress'}).where(sql`${tasks.id} = 'ready'`).run();
    const updated = await read();
    expect(updated.data?.inProgress).toHaveLength(2);
    expect(updated.data?.readyTasks).toEqual(expect.arrayContaining([{id:'blocked'},{id:'parented'}]));
    expect(updated.data?.readyTasks).toHaveLength(2);
    visible = false;
    expect((await read()).data).toEqual({inProgress:[],readyTasks:[]});
  } finally { client.close(); }
});
