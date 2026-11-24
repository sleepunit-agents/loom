import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { workVisibility } from './work-visibility.js';
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
      INSERT INTO task_comments (task,seq,actor_kind,actor,at,text) VALUES ('a',1,'member','sam','2026-11-14T00:00:00Z','Visible comment'),('b',1,'member','sam','2026-11-14T00:00:00Z','Other thread'),('secret',1,'member','sam','2026-11-14T00:00:00Z','Secret comment');`);
    db.exec(`INSERT INTO changes(id,repository,number,title,body,url,state,draft,author_login,project,branch,head_commit,base_branch,checks,review,mergeable,waiting_on,opened_at,updated_at)
      VALUES ('public-change','github:acme/app',3,'Public change','','https://github.com/acme/app/pull/3','open',0,'sam','pond','feature','abc','next','passing','approved','yes','done','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z'),
      ('secret-change','github:private/app',4,'Secret change','','https://github.com/private/app/pull/4','open',0,'sam','hidden','feature','def','next','failing','required','no','ci','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z');
      INSERT INTO change_tasks(change,task) VALUES('public-change','a'),('secret-change','a');`);
    const schema = dataQueries(db, { tables:['tasks','taskComments','taskLinks','projects','agents','changeTasks','changes'], visibility: { ...taskVisibility({kind:'member',id:'sam'}), ...workVisibility({kind:'member',id:'sam'}) } });
    statements.length = 0;
    const result = await graphql({schema,source:tasksQuery});
    expect(result.errors).toBeUndefined();
    expect(statements).toHaveLength(1);
    expect(result.data?.tasks).toMatchObject([
      {id:'a',isReady:false,taskLinksByTask:[]},
      {id:'b',isReady:true,taskLinksByTask:[{task:'b',dependsOn:'epic',type:'parent-child'}]},
      {id:'epic',isReady:false},
    ]);
    expect(JSON.stringify(result.data)).not.toContain('Visible comment');
    expect(statements[0]).not.toMatch(/change_tasks|task_comments/i);
    const detail = (selected:string) => graphql({schema,source:tasksQuery,variableValues:{selected,withComments:true}});
    statements.length = 0;
    const opened = await detail('a');
    expect(opened.errors).toBeUndefined();
    expect(statements).toHaveLength(2);
    expect(opened.data?.selectedTask).toMatchObject({id:'a',taskCommentsByTask:[{text:'Visible comment'}]});
    expect(JSON.stringify(opened.data)).not.toContain('Other thread');
    expect((await detail('secret')).data?.selectedTask).toBeNull();
    expect(JSON.stringify(result.data)).not.toContain('Secret');
    expect(opened.data?.selectedTask).toMatchObject({changeTasksByTask:[{changeRow:{id:'public-change',checks:'passing',review:'approved'}}]});
    expect(JSON.stringify(opened.data)).not.toContain('secret-change');
    db.exec("UPDATE tasks SET status = 'closed', closed_at = '2026-11-14T00:00:00Z' WHERE id = 'secret'");
    expect((await graphql({schema,source:tasksQuery})).data?.tasks).toMatchObject([{id:'a',isReady:true},{id:'b',isReady:true},{id:'epic',isReady:false}]);
    statements.length = 0;
    expect((await graphql({schema,source:'{ projects { tasksByProject { id isReady } } }'})).errors).toBeUndefined();
    expect(statements).toHaveLength(1);
    db.exec("DELETE FROM project_members");
    expect((await graphql({schema,source:tasksQuery})).data).toEqual({tasks:[]});
  } finally { db.close(); }
});
