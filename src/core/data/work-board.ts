import {and, asc, desc, eq, getTableColumns, inArray, isNotNull, ne, or, sql} from 'drizzle-orm';
import {GraphQLBoolean,GraphQLInt,GraphQLList,GraphQLNonNull,GraphQLObjectType,GraphQLString,type GraphQLFieldConfigMap} from 'graphql/index.js';
import type {Viewer} from '../../policy.js';
import {sqlVisibility} from '../../policy-sql.js';
import type {DataDatabase} from './database.js';
import {taskShelved} from './project-in-use.js';
import {changes,changeTasks,projects,taskLinks,tasks} from './schema.js';

type Change = Pick<typeof changes.$inferSelect,'number'|'state'|'draft'|'checks'|'review'|'waitingOn'|'mergeable'>;
function position(ask:string|null, blocker:string|undefined, linked:Change[]) {
  if (ask) return {lane:'Waiting',reason:ask};
  if (blocker) return {lane:'Waiting',reason:`Waiting for ${blocker}`};
  const open = linked.filter(change=>change.state==='open');
  const decision = open.find(change=>change.waitingOn==='you');
  if (decision) return {lane:'Waiting',reason:`PR #${decision.number} awaits a merge decision`};
  const fix = open.find(change=>change.checks==='failing' || change.review==='changes_requested' || change.mergeable==='no');
  if (fix) return {lane:'Working',reason:`PR #${fix.number} · ${fix.checks==='failing' ? 'Checks failed' : fix.review==='changes_requested' ? 'Changes requested' : 'Merge conflict'}`};
  const review = open.find(change=>!change.draft && (change.waitingOn==='reviewer' || change.waitingOn==='ci' || change.checks==='running'));
  if (review) return {lane:'Verifying',reason:`PR #${review.number} · ${review.checks==='running' ? 'Checks running' : review.waitingOn==='ci' ? 'Checking mergeability' : 'Review requested'}`};
  if (open.length) return {lane:'Working',reason:`PR #${open[0].number} · ${open[0].draft ? 'Draft' : 'Open'}`};
  return {lane:'Working',reason:linked.some(change=>change.state==='merged') ? 'PR merged · ticket still open' : null};
}

export function workBoardFields(db:DataDatabase):GraphQLFieldConfigMap<unknown,{viewer:Viewer}> {
  const text=new GraphQLNonNull(GraphQLString);
  const card=new GraphQLObjectType({name:'ProjectBoardTicket',fields:{
    id:{type:text},project:{type:text},title:{type:text},assignee:{type:GraphQLString},priority:{type:new GraphQLNonNull(GraphQLInt)},lane:{type:text},reason:{type:GraphQLString},
  }});
  return {projectBoardTickets:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(card))),
    args:{project:{type:text},epic:{type:GraphQLString},finished:{type:GraphQLBoolean,defaultValue:false},offset:{type:GraphQLInt,defaultValue:0},limit:{type:GraphQLInt,defaultValue:51}},
    resolve:(_row,{project,epic,finished,offset,limit},{viewer})=>{
      if (limit<1 || limit>100 || offset<0) throw Error('Invalid board page');
      const scope=sqlVisibility(viewer,['tasks','changeTasks','taskLinks','projects']);
      const visibleProject = db.select({id:projects.id}).from(projects)
        .where(and(eq(projects.id,project),scope.projects(getTableColumns(projects)))).get();
      if (!visibleProject) return [];
      const visibleTasks = scope.tasks(getTableColumns(tasks));
      const children = epic == null ? undefined : db.select({id:taskLinks.task}).from(taskLinks)
        .innerJoin(tasks,eq(tasks.id,taskLinks.dependsOn))
        .where(and(eq(tasks.id,epic),eq(tasks.type,'epic'),eq(tasks.project,project),
          eq(taskLinks.type,'parent-child'),scope.taskLinks(getTableColumns(taskLinks)),visibleTasks));
      const tickets = and(eq(tasks.project,project),visibleTasks,ne(tasks.type,'epic'),
        children && inArray(tasks.id,children));
      if (finished) {
        return db.select({id:tasks.id,title:tasks.title,project:tasks.project,assignee:tasks.assignee,priority:tasks.priority,closeReason:tasks.closeReason})
          .from(tasks).where(and(tickets,eq(tasks.status,'closed')))
          .orderBy(desc(tasks.closedAt),asc(tasks.id)).limit(limit).offset(offset).all()
          .map(({closeReason,...row})=>({...row,lane:'Finished',reason:closeReason==='cancelled' ? 'Cancelled' : 'Ticket closed'}));
      }
      const allowedLinks=scope.changeTasks(getTableColumns(changeTasks));
      const activeChanges=db.select({task:changeTasks.task}).from(changeTasks).innerJoin(changes,eq(changes.id,changeTasks.change))
        .where(and(allowedLinks,eq(changes.state,'open')));
      const page=db.select({id:tasks.id,title:tasks.title,project:tasks.project,assignee:tasks.assignee,priority:tasks.priority,ask:tasks.ask}).from(tasks)
        .where(and(tickets,ne(tasks.status,'closed'),
          sql`not ${taskShelved(tasks)}`,or(eq(tasks.status,'in_progress'),isNotNull(tasks.ask),inArray(tasks.id,activeChanges))))
        .orderBy(asc(tasks.priority),asc(tasks.position),asc(tasks.id)).limit(limit).offset(offset).all();
      if (!page.length) return [];
      const ids = page.map(row=>row.id);
      const blockers = db.select({task:taskLinks.task,title:tasks.title}).from(taskLinks)
        .innerJoin(tasks,eq(tasks.id,taskLinks.dependsOn))
        .where(and(inArray(taskLinks.task,ids),eq(taskLinks.type,'blocks'),ne(tasks.status,'closed'),
          scope.taskLinks(getTableColumns(taskLinks))))
        .orderBy(asc(tasks.priority),asc(tasks.id)).all();
      const firstBlocker = new Map<string,string>();
      for (const blocker of blockers) {
        if (!firstBlocker.has(blocker.task)) firstBlocker.set(blocker.task,blocker.title);
      }
      const linked=db.select({task:changeTasks.task,number:changes.number,state:changes.state,draft:changes.draft,
        mergeable:changes.mergeable,checks:changes.checks,review:changes.review,waitingOn:changes.waitingOn}).from(changeTasks)
        .innerJoin(changes,eq(changes.id,changeTasks.change)).where(and(allowedLinks,inArray(changeTasks.task,ids)))
        .orderBy(desc(changes.updatedAt),asc(changes.id)).all();
      const byTask=new Map<string,Change[]>();
      for (const change of linked) {
        const list=byTask.get(change.task) ?? [];
        list.push(change); byTask.set(change.task,list);
      }
      return page.map(({ask,...row})=>({...row,...position(ask,firstBlocker.get(row.id),byTask.get(row.id) ?? [])}));
    },
  }};
}
