import Database from 'better-sqlite3';
import { graphql, GraphQLSchema, GraphQLObjectType } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database.js';
import { workspaceDirectoryFields } from './workspace-directory.js';

it('counts directory rows within the reader’s scope and distinguishes member and agent assignments', async () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client);
    client.exec(`INSERT INTO members(id,role,joined_at) VALUES('sam','member','2026-11-25T00:00:00Z');
      INSERT INTO projects(id,name) VALUES('ours','Ours'),('hidden','Hidden');
      INSERT INTO project_members(project,member) VALUES('ours','sam');
      INSERT INTO tasks(id,title,type,project,assignee_kind,assignee,owner_kind,created_by_kind,created_by,created_at,changed_at) VALUES
      ('t-1','Ours','epic','ours','member','sam','household','member','sam','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z'),
      ('t-2','Hidden','epic','hidden','member','sam','household','member','sam','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z');
      INSERT INTO changes(id,repository,number,title,body,url,state,draft,author_login,project,branch,head_commit,base_branch,checks,review,mergeable,waiting_on,opened_at,updated_at) VALUES
      ('p1','readable',1,'One','','url1','open',0,'sam','ours','b','c','main','none','required','unknown','ci','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z'),
      ('p2','private',2,'Two','','url2','open',0,'sam','hidden','b','c','main','none','required','unknown','ci','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z');`);
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: 'Query', fields: workspaceDirectoryFields(db) }),
    });
    const r = await graphql({
      schema,
      contextValue: { viewer: { kind: 'member', id: 'sam' } },
      source: `{workspaceRepositories{repository project count} epics:workspaceListCount(list:"epics") agent:workspaceListCount(list:"tickets",assignee:"sam",actorKind:"agent") member:workspaceListCount(list:"tickets",assignee:"sam",actorKind:"member") prs:workspaceListCount(list:"pulls") notes:workspaceListCount(list:"comments")}`,
    });
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      workspaceRepositories: [{ repository: 'readable', project: 'ours', count: 1 }],
      epics: 1,
      agent: 0,
      member: 1,
      prs: 1,
      notes: 0,
    });
  } finally {
    client.close();
  }
});
