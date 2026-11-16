import { readProjectConversations } from './core/data/project-conversations.js';
/** Project sections over the shared services' current outside visibility. No
 * legacy registry, persisted projection or independent permission predicate. */
import type {DataDatabase} from './core/data/database.js';
import {readProjectTasks,readProjectChanges} from './core/data/project-sections.js';
import {taskGroups,type ProjectTask} from './pieces/mind/projects-tasks.js';
import type {ProjectSectionRole} from './pieces/mind/projects-roles.js';
import type {ProjectGroup} from './pieces/mind/projects-model.js';
export function sharedProjectSections(db:DataDatabase):{tasks:ProjectSectionRole;changes:ProjectSectionRole;conversations:ProjectSectionRole}{
 return {
  tasks:{read(viewer,q){
   const selected=readProjectTasks(db,viewer);
   const rows:ProjectTask[]=selected.rows.map(row=>({
    id:row.id,title:row.title,status:row.status,priority:row.priority,createdAt:row.createdAt,comments:selected.comments(row.id),description:row.description,goal:row.goal,why:row.why,
    ...(row.project?{project:row.project}:{}),...(row.assignee&&row.assigneeKind===viewer.kind?{assignee:row.assignee}:{}),...(row.startedAt?{startedAt:row.startedAt}:{}),...(row.closedAt?{closedAt:row.closedAt}:{}),...(row.closeReason?{closeReason:row.closeReason}:{}),...(row.sourceKind&&row.sourceId?{source:row.sourceKind+':'+row.sourceId}:{}),
   }));
   const links=selected.links;
   const ready=selected.ready;
   return {available:true,groups:taskGroups(rows,links,ready,q,new Set([viewer.id]))};
  }},
  changes:{read(viewer,q){
   const repos=new Set((q.card.links.repos??[]).map(r=>(r.includes(':')?r:'github:'+r).toLowerCase())),groups:ProjectGroup[]=[];
   const labels:Record<string,string>={you:'Waiting on you',agent:'Ready to merge',ci:'Waiting on CI',reviewer:'Waiting on a reviewer',author:'Waiting on its author',done:'Lately'};
   for(const row of readProjectChanges(db,viewer)){
    const repo=(row.repository.includes(':')?row.repository:'github:'+row.repository).toLowerCase();
    if(!q.names.includes(row.project??'')&&!repos.has(repo))continue;
    const title=labels[row.waitingOn],waiting=row.waitingOn==='you';let group=groups.find(g=>g.title===title);
    if(!group){group={title,waiting,items:[]};groups.push(group);}
    const status=row.state==='open'?row.checks==='failing'?'CI red':row.checks==='running'?'CI running':'open':row.state;
    group.items.push({title:row.title,ref:row.id,when:row.updatedAt,status,who:[row.authorLogin],href:'/p/changes-preview/change/'+encodeURIComponent(row.id),...(waiting?{waiting:true}:{})});
   }
   return {available:true,groups};
  }},
  conversations:{read(viewer,q){
   const result=readProjectConversations(db,viewer,q.names,q.card.links.venues??[]),rows=result.rows;
   return {available:true,total:rows.length,conversationIds:rows.map(row=>row.id),items:rows.slice(0,50).map(row=>({title:row.label,ref:row.id,when:row.lastAt,href:'/p/comms-preview/conversation/'+encodeURIComponent(row.id),who:result.people(row.id)}))};
  }},
 };
}
