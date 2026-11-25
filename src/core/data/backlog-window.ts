import {and,eq,getTableColumns,sql,type SQL} from 'drizzle-orm';
import {GraphQLInt,GraphQLList,GraphQLNonNull,GraphQLObjectType,GraphQLString,type GraphQLFieldConfigMap} from 'graphql/index.js';
import type {Viewer} from '../../policy.js';
import {sqlVisibility} from '../../policy-sql.js';
import type {DataDatabase} from './database.js';
import {migrations,projects,tasks} from './schema.js';

const groups = {
  start: 'started = 1',
  end: 'finished = 1',
  originalEverClosed: 'started = 1 and closedHere = 1',
  originalClosed: 'started = 1 and lastHere = 1 and finished = 0',
  originalMovedOut: 'started = 1 and lastHere = 0',
  addedOpen: 'started = 0 and finished = 1',
  created: 'wasCreated = 1',
  arrivalsClosed: 'wasCreated = 1 and closedHere = 1',
  reopened: 'wasReopened = 1',
  movedIn: 'cameIn = 1',
  movedOut: 'wentOut = 1',
} as const;
type Group = keyof typeof groups;
const keys = Object.keys(groups) as Group[];
const text = new GraphQLNonNull(GraphQLString);
function instant(value:string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw Error('Use a UTC timestamp with milliseconds');
  return value;
}

/** Counts and paged drill-downs use the same predicates. Readership is checked against both
 * the requested project and the current ticket; no destination or private prior title is returned. */
export function backlogWindow(db:DataDatabase,viewer:Viewer,project:string,since:string,until:string,group?:string,offset=0,limit=50) {
  instant(since); instant(until);
  if (since>until || !Number.isSafeInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>100 ||
      (group!=null && !Object.hasOwn(groups,group))) throw Error('Invalid backlog window');
  if(viewer.kind!=='member')return null;
  const scope=sqlVisibility(viewer,['projects','tasks']);
  if(!db.select({id:projects.id}).from(projects).where(and(eq(projects.id,project),scope.projects(getTableColumns(projects)))).get())return null;
  const coverage=db.select({at:migrations.appliedAt}).from(migrations).where(eq(migrations.number,44)).get()!.at;
  const from=since<coverage?coverage:since;
  if(until<from)return {coverage,from,until,counts:[],tickets:[]};
  const visible=db.select({id:tasks.id,title:tasks.title}).from(tasks).where(scope.tasks(getTableColumns(tasks)));
  // Read only tickets that have ever belonged to this project. A move may have recorded its new
  // state in another project. It is considered only to account for leaving this project's backlog.
  const history=sql`WITH visible AS ${visible}, events AS (
    SELECT e.*, visible.title, lag(e.seq) over ticket AS prev,
      lag(e.project) over ticket AS previousProject, lag(e.open) over ticket AS previousOpen
    FROM task_backlog_events e JOIN visible ON visible.id=e.task
    WHERE e.task IN (SELECT task FROM task_backlog_events WHERE project=${project}) AND e.at <= ${until}
    WINDOW ticket AS (PARTITION BY e.task ORDER BY e.seq)
  ), bounds AS (
    SELECT task, max(CASE WHEN at<=${from} THEN seq END) AS firstSeq, max(seq) AS lastSeq
    FROM events GROUP BY task
  ), flags AS (
    SELECT e.task AS id,e.title,
      max(CASE WHEN e.seq=b.firstSeq AND e.project IS ${project} AND e.open THEN 1 ELSE 0 END) AS started,
      max(CASE WHEN e.seq=b.lastSeq AND e.project IS ${project} AND e.open THEN 1 ELSE 0 END) AS finished,
      max(CASE WHEN e.seq=b.lastSeq AND e.project IS ${project} THEN 1 ELSE 0 END) AS lastHere,
      max(e.at>${from} AND e.project IS ${project} AND e.prev IS NULL) AS wasCreated,
      max(e.at>${from} AND e.project IS ${project} AND e.open=0 AND (e.prev IS NULL OR (e.previousProject IS ${project} AND e.previousOpen=1))) AS closedHere,
      max(e.at>${from} AND e.project IS ${project} AND e.previousProject IS ${project} AND e.previousOpen=0 AND e.open=1) AS wasReopened,
      max(e.at>${from} AND e.prev IS NOT NULL AND e.previousProject IS NOT ${project} AND e.project IS ${project}) AS cameIn,
      max(e.at>${from} AND e.previousProject IS ${project} AND e.project IS NOT ${project}) AS wentOut
    FROM events e JOIN bounds b ON b.task=e.task GROUP BY e.task
  )`;
  const sums=sql.join(keys.map(key=>sql`coalesce(sum(${sql.raw(groups[key])}),0) AS ${sql.identifier(key)}`),sql`, `);
  const totals=db.get<Record<Group,number>>(sql`${history} SELECT ${sums} FROM flags`);
  const tickets=group==null?[]:db.all<{id:string;title:string}>(sql`${history} SELECT id,title FROM flags WHERE ${sql.raw(groups[group as Group])}
    ORDER BY title COLLATE NOCASE,id LIMIT ${limit} OFFSET ${offset}`);
  return {coverage,from,until,counts:keys.map(key=>({key,total:totals[key]})),tickets};
}

export function backlogWindowFields(db:DataDatabase):GraphQLFieldConfigMap<unknown,{viewer:Viewer}> {
  const count=new GraphQLObjectType({name:'BacklogWindowCount',fields:{key:{type:text},total:{type:new GraphQLNonNull(GraphQLInt)}}});
  const row=new GraphQLObjectType({name:'BacklogWindowTicket',fields:{id:{type:text},title:{type:text}}});
  return {projectBacklogWindow:{type:new GraphQLObjectType({name:'ProjectBacklogWindow',fields:{
    coverage:{type:text},from:{type:text},until:{type:text},counts:{type:new GraphQLList(count)},tickets:{type:new GraphQLList(row)},
  }}),args:{project:{type:text},since:{type:text},until:{type:text},group:{type:GraphQLString},offset:{type:GraphQLInt,defaultValue:0},limit:{type:GraphQLInt,defaultValue:50}},
    resolve:(_row,{project,since,until,group,offset,limit},{viewer})=>backlogWindow(db,viewer,project,since,until,group,offset,limit)}};
}
