import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import { tasksQuery } from '../../../web/src/pieces/tasks/query.js';

it('runs the mounted Tasks selection in one SQL statement and respects hidden blockers and connected visibility', async () => {
  const statements: string[] = [];
  const db = new Database(':memory:', {verbose: sql => statements.push(sql)});
  createDataSchema(db);
  try {
    db.exec(`INSERT INTO members (id,role,joined_at) VALUES ('sam','member','2026-11-14T00:00:00Z');
      INSERT INTO projects (id,name) VALUES ('pond','Pond'),('hidden','Hidden');
      INSERT INTO project_members (project,member) VALUES ('pond','sam');
      INSERT INTO tasks (id,title,type,owner_kind,owner,project,created_by_kind,created_by,created_at,changed_at)
      VALUES ('a','Visible','task','member','sam','pond','member','sam','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z'),
      ('b','Ready','task','member','sam','pond','member','sam','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z'),
      ('epic','Epic','epic','member','sam','pond','member','sam','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z'),
      ('secret','Secret blocker','task','member','sam','hidden','member','sam','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z');
      INSERT INTO task_links (task,depends_on,type) VALUES ('a','secret','blocks'),('b','epic','parent-child');
      INSERT INTO task_comments (task,seq,actor_kind,actor,at,text) VALUES ('a',1,'member','sam','2026-11-14T00:00:00Z','Visible comment'),('secret',1,'member','sam','2026-11-14T00:00:00Z','Secret comment');`);
    const schema = dataQueries(db, { tables:['tasks','taskComments','taskLinks','projects','agents'], visibility: taskVisibility({kind:'member',id:'sam'}) });
    statements.length = 0;
    const result = await graphql({schema,source:tasksQuery});
    expect(result.errors).toBeUndefined();
    expect(statements).toHaveLength(1);
    expect(result.data?.tasks).toMatchObject([
      {id:'a',isReady:false,commentCount:1,taskLinksByTask:[],taskCommentsByTask:[{text:'Visible comment'}]},
      {id:'b',isReady:true,taskLinksByTask:[{task:'b',dependsOn:'epic',type:'parent-child'}]},
      {id:'epic',isReady:false},
    ]);
    expect(JSON.stringify(result.data)).not.toContain('Secret');
    db.exec("UPDATE tasks SET status = 'closed', closed_at = '2026-11-14T00:00:00Z' WHERE id = 'secret'");
    expect((await graphql({schema,source:tasksQuery})).data?.tasks).toMatchObject([{id:'a',isReady:true},{id:'b',isReady:true},{id:'epic',isReady:false}]);
    statements.length = 0;
    expect((await graphql({schema,source:'{ projects { tasksByProject { id isReady } } }'})).errors).toBeUndefined();
    expect(statements).toHaveLength(1);
    db.exec("DELETE FROM project_members");
    expect((await graphql({schema,source:tasksQuery})).data).toEqual({tasks:[]});
  } finally { db.close(); }
});
