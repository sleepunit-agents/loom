import Database from 'better-sqlite3';
import { graphql, GraphQLSchema, GraphQLObjectType } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database.js';
import { epicWorkFields } from './epic-work.js';
it('counts visible descendants through nested epics, deduplicates a shared PR and stops at hidden ancestry', async () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client);
    client.exec(`INSERT INTO members(id,role,joined_at) VALUES ('sam','member','2026-11-25T00:00:00Z'),('lee','member','2026-11-25T00:00:00Z');
      INSERT INTO projects(id,name)VALUES('ours','Ours'),('theirs','Theirs');
      INSERT INTO project_members(project,member)VALUES('ours','sam');`);
    const add = client.prepare(
      "INSERT INTO tasks(id,title,project,type,owner_kind,owner,created_by_kind,created_by,created_at,changed_at) VALUES(?,?,?,?,'member','sam','member','sam','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z')",
    );
    for (const [id, project, type] of [
      ['top', 'ours', 'epic'],
      ['inner', 'ours', 'epic'],
      ['leaf', 'ours', 'task'],
      ['private', 'theirs', 'epic'],
      ['outside', 'ours', 'task'],
    ])
      add.run(id, id, project, type);
    client.exec(`INSERT INTO task_links(task,depends_on,type)VALUES('inner','top','parent-child'),('leaf','inner','parent-child'),('private','top','parent-child'),('outside','private','parent-child');
      INSERT INTO changes(id,repository,number,title,body,url,state,draft,author_login,project,branch,head_commit,base_branch,checks,review,mergeable,waiting_on,opened_at,updated_at)
      VALUES ('pr','repo',1,'Merge','','url','open',0,'sam','ours','feature','abc','main','failing','required','unknown','ci','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z');
      INSERT INTO change_tasks(change,task)VALUES('pr','inner'),('pr','leaf');`);
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: 'Query', fields: epicWorkFields(db) }),
    });
    const read = async (id: string) => {
      const res = await graphql({
        schema,
        source:
          'query($id:String!){contextScopeWork(task:$id,offset:0){totals{status count} pullCount pulls{id checks}}}',
        variableValues: { id },
        contextValue: { viewer: { kind: 'member', id: 'sam' } },
      });
      expect(res.errors).toBeUndefined();
      return res.data?.contextScopeWork;
    };
    expect(await read('top')).toEqual({
      totals: [{ status: 'open', count: 2 }],
      pullCount: 1,
      pulls: [{ id: 'pr', checks: 'failing' }],
    });
    expect(await read('private')).toBeNull();
  } finally {
    client.close();
  }
});

it('counts an unfinished dependency and returns only the selected project page',async()=>{
  const {contextTicketFields}=await import('./context-tickets.js');
  const client=new Database(':memory:');
  try {
    const db=createDataSchema(client);
    client.exec("INSERT INTO members(id,role,joined_at) VALUES('reader','owner','2026-11-25T00:00:00Z');INSERT INTO projects(id,name) VALUES('pond','Pond')");
    const add=client.prepare("INSERT INTO tasks(id,title,project,owner_kind,created_by_kind,created_by,created_at,changed_at) VALUES(?,?,'pond','household','member','reader','2026-11-25T00:00:00Z','2026-11-25T00:00:00Z')");
    for(let i=0;i<36;i++)add.run(String(i),String(i));
    client.exec("INSERT INTO task_links(task,depends_on,type)VALUES('1','0','blocks')");
    const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:contextTicketFields(db)})});
    const read=async(group:string,offset:number)=>{const result=await graphql({schema,source:'query($group:String!,$offset:Int!){contextProjectTickets(id:"pond",group:$group,offset:$offset){counts{group count} rows{id}}}',variableValues:{group,offset},contextValue:{viewer:{kind:'member',id:'reader'}}});expect(result.errors).toBeUndefined();return result.data?.contextProjectTickets as {rows:{id:string}[];counts:{group:string;count:number}[]}};
    expect((await read('Blocked',0)).rows).toEqual([{id:'1'}]);
    expect((await read('Open',30)).rows).toHaveLength(6);
    expect((await read('Open',0)).counts).toContainEqual({group:'Open',count:36});
  }finally{client.close()}
});
