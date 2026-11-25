import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { workVisibility } from './work-visibility.js';
import { taskVisibility } from './visibility.js';
import { workProjectQuery, workHomeQuery, workUnfiledQuery, unfiledPageSize } from '../../../web/src/pieces/work/query.js';
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
      UPDATE tasks SET done_when='Valve closed',if_yes='Start pump',if_no='Wait',source_kind='old-conversation',source_id='pump' WHERE id='a';
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
    expect(statements[0]).not.toMatch(/change_tasks|task_comments|done_when|if_yes|if_no|source_kind|source_id/i);
    const detail = (selected:string) => graphql({schema,source:tasksQuery,variableValues:{selected,withComments:true}});
    statements.length = 0;
    const opened = await detail('a');
    expect(opened.errors).toBeUndefined();
    expect(statements).toHaveLength(2);
    expect(opened.data?.selectedTask).toMatchObject({id:'a',doneWhen:'Valve closed',ifYes:'Start pump',ifNo:'Wait',sourceKind:'old-conversation',sourceId:'pump',taskCommentsByTask:[{text:'Visible comment'}]});
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
    db.exec("UPDATE tasks SET status='in_progress' WHERE id='b'");
    const home = await graphql({schema,source:workHomeQuery});
    expect(home.errors).toBeUndefined();
    expect(home.data?.projects).toMatchObject(expect.arrayContaining([{id:'pond',name:'Pond',lifecycle:'active',tasksByProject:[expect.objectContaining({id:'a'})]}]));
    const project = await graphql({schema,source:workProjectQuery,variableValues:{id:'pond'}});
    expect(project.errors).toBeUndefined();
    expect(project.data).toMatchObject({working:[{id:'b'}],recent:[{id:'a'},{id:'b'},{id:'epic'}]});
    expect(JSON.stringify(project.data)).not.toContain('Secret blocker');
    db.exec("DELETE FROM project_members");
    expect((await graphql({schema,source:tasksQuery})).data).toEqual({tasks:[]});
  } finally { db.close(); }
});

it('pages each reader through only the unfiled tickets they may see, from the Work home and its unfiled view', async () => {
  const db = new Database(':memory:');
  createDataSchema(db);
  try {
    db.exec(`INSERT INTO members (id,role,joined_at) VALUES ('sam','member','2026-11-14T00:00:00Z'),('lee','member','2026-11-14T00:00:00Z');
      INSERT INTO projects (id,name) VALUES ('pond','Pond');
      INSERT INTO project_members (project,member) VALUES ('pond','sam'),('pond','lee');`);
    const insert = db.prepare(`INSERT INTO tasks (id,title,type,status,owner_kind,owner,project,created_by_kind,created_by,created_at,changed_at)
      VALUES (?,?,'task',?,'member',?,?,'member',?,'2026-11-14T00:00:00Z',?)`);
    // Sam owns 52 open unfiled tickets, one more than a page and its probe; Lee owns one private one.
    for (let n = 0; n < 52; n++) {
      const at = new Date(Date.UTC(2026,10,14,0,n)).toISOString();
      insert.run(`u-${String(n).padStart(2,'0')}`,`Sam unfiled ${n}`,'open','sam',null,'sam',at);
    }
    insert.run('lee-private','Lee private note','in_progress','lee',null,'lee','2026-11-15T00:00:00Z');
    insert.run('sam-closed','Sam closed unfiled','closed','sam',null,'sam','2026-11-16T00:00:00Z');
    insert.run('filed','Filed in pond','open','sam','pond','sam','2026-11-16T00:00:00Z');
    const as = (id:string) => dataQueries(db, { tables:['tasks','taskComments','taskLinks','projects','agents','changeTasks','changes'],
      visibility: { ...taskVisibility({kind:'member',id}), ...workVisibility({kind:'member',id}) } });
    const read = async (id:string, source:string, variableValues?:Record<string,unknown>) => {
      const result = await graphql({schema:as(id),source,variableValues});
      expect(result.errors).toBeUndefined();
      return result.data as {unfiled:{id:string;title:string;status:string}[]};
    };
    const first = await read('sam', workUnfiledQuery, {offset:0});
    expect(first.unfiled).toHaveLength(unfiledPageSize+1);
    expect(first.unfiled[0]).toMatchObject({id:'u-51',status:'open'});
    const second = await read('sam', workUnfiledQuery, {offset:unfiledPageSize});
    expect(second.unfiled.map(row=>row.id)).toEqual(['u-01','u-00']);
    const sam = JSON.stringify([first,second]);
    for (const hidden of ['Lee private note','Sam closed unfiled','Filed in pond']) expect(sam).not.toContain(hidden);
    expect((await read('sam', workHomeQuery)).unfiled).toMatchObject([{id:'u-51'}]);
    // The second reader sees their one ticket and nothing of Sam's, in rows and in the home entry.
    expect((await read('lee', workUnfiledQuery, {offset:0})).unfiled).toEqual([expect.objectContaining({id:'lee-private',status:'in_progress'})]);
    expect((await read('lee', workUnfiledQuery, {offset:unfiledPageSize})).unfiled).toEqual([]);
    const leeHome = await read('lee', workHomeQuery);
    expect(leeHome.unfiled).toMatchObject([{id:'lee-private'}]);
    expect(JSON.stringify(leeHome)).not.toContain('Sam unfiled');
    db.exec("UPDATE tasks SET status='closed' WHERE id='lee-private'");
    expect((await read('lee', workHomeQuery)).unfiled).toEqual([]);
    expect((await read('lee', workUnfiledQuery, {offset:0})).unfiled).toEqual([]);
  } finally { db.close(); }
});
