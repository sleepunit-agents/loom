import {and,eq,getTableColumns,gt,isNotNull,sql,type SQL} from 'drizzle-orm';
import type {Viewer} from '../../policy.js';
import type {DataDatabase} from '../data/database.js';
import {taskVisibility} from '../data/visibility.js';
import {agentPosts,projects,tasks} from '../data/schema.js';
import {allActivitySourcesMatch,indexEarlierPostRefs,readableActivitySources,ticketRefDigest} from './agent-posts.js';
import type {WordsKey} from './words.js';

type Row={project:string;task:string;title:string;seq:number;at:string;words:Buffer;agent:string;thread:string};

/** The opener's explicit ticket reference also covers later replies. The digest index lets us
 * match references without opening private words to discover which tickets they mention. */
export async function projectPosts(db:DataDatabase,key:WordsKey,viewer:Viewer,allow:()=>SQL,
  project:string|undefined,since:string,after:number|undefined,perProject:number) {
  if(viewer.kind!=='member')return [];
  if(!Number.isInteger(perProject)||perProject<1||perProject>20)throw Error('Invalid activity page size');
  const recent=after===undefined ? gt(agentPosts.at,since) : gt(agentPosts.seq,after);
  if(!db.select({seq:agentPosts.seq}).from(agentPosts).where(recent).limit(1).get())return [];
  await indexEarlierPostRefs(db,key);
  const scope=taskVisibility(viewer);
  const visible=(columns:{id:typeof tasks.id;title?:typeof tasks.title;project?:typeof tasks.project})=>db.select(columns).from(tasks)
    .innerJoin(projects,eq(projects.id,tasks.project)).where(and(isNotNull(tasks.project),
      project ? eq(tasks.project,project) : undefined,scope.tasks!(getTableColumns(tasks)),scope.projects!(getTableColumns(projects))));
  const ids=visible({id:tasks.id}).all();
  if(!ids.length)return [];
  const map=JSON.stringify(ids.map(t=>[ticketRefDigest(key,t.id),t.id]));
  const read=()=>{
    const readable=allActivitySourcesMatch(db,readableActivitySources(db,viewer,allow()));
    return db.all<Row>(sql`WITH visible AS ${visible({id:tasks.id,title:tasks.title,project:tasks.project})}, anchors AS (
      SELECT DISTINCT visible.id AS task,visible.title,visible.project,anchor.thread
      FROM json_each(${map}) m JOIN visible ON visible.id=json_extract(m.value,'$[1]')
      JOIN agent_post_work_refs r ON r.digest=json_extract(m.value,'$[0]')
      JOIN agent_posts anchor ON anchor.seq=r.post
    ), latest AS (
      SELECT a.task,a.title,a.project,a.thread,p.seq,p.at,
        row_number() over(partition by a.task order by p.seq desc) AS position
      FROM anchors a JOIN agent_post_threads ON agent_post_threads.id=a.thread
      JOIN agent_posts p ON p.seq=(SELECT max(s.seq) FROM agent_posts s WHERE s.thread=a.thread)
      WHERE ${readable} AND ${after===undefined ? sql`p.at > ${since}` : sql`p.seq > ${after}`}
    ), distinctThreads AS (
      SELECT *,row_number() over(partition by project,thread order by task) AS linked FROM latest WHERE position=1
    ), ranked AS (
      SELECT *,row_number() over(partition by project order by seq desc,task) AS place FROM distinctThreads WHERE linked=1
    ) SELECT ranked.project,ranked.task,ranked.title,ranked.thread,ranked.seq,ranked.at,p.words,
        coalesce(source.agent,cv.agent) AS agent
      FROM ranked JOIN agent_posts p ON p.seq=ranked.seq JOIN agent_post_sources source ON source.id=p.source
      LEFT JOIN threads th ON th.id=source.conversation_thread LEFT JOIN conversations cv ON cv.id=th.conversation
      WHERE ranked.place<=${perProject} ORDER BY ranked.seq DESC,ranked.task`);
  };
  const rows=read();
  if(!rows.length)return [];
  const result=await Promise.all(rows.map(async({words,...r})=>({...r,id:String(r.seq),words:await key.open(words)})));
  const identity=(r:{project:string;task:string;seq:number})=>JSON.stringify([r.project,r.task,r.seq]);
  const current=new Map(read().map(row=>[identity(row),row.title]));
  return result.flatMap(row=>{
    const title=current.get(identity(row));
    return title===undefined?[]:[{...row,title}];
  });
}
