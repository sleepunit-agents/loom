/** Each role receives the original viewer and must enforce its own policy. All calls stay synchronous. */
import type {Viewer,Operations} from '../../core/index.js';
import type {Tasks} from '../tasks/role.js';
import type {ProjectCard,ProjectGroup,ProjectItem,ProjectSection} from './projects-model.js';
export interface ProjectQuery {agent:string;card:ProjectCard;names:string[];since:string;now:number}
export interface ProjectSectionRole {read(viewer:Viewer,query:ProjectQuery):Omit<ProjectSection,'key'|'label'>}
interface Task {id:string;title:string;description?:string;goal?:string;project?:string;status:string;assignee?:string;closedAt?:string;createdAt:string;ask?:string}
interface Link {id:string;dependsOn:string;type:string}
export function projectTasks(tasks:Tasks,isOwner:(viewer:Viewer)=>boolean=()=>false):ProjectSectionRole {
 return {read(viewer,q){
  const exported=tasks.call(viewer,'export',{}),ready=tasks.call(viewer,'ready',{});
  if(!exported.ok||!ready.ok)throw Error('Tasks could not answer');
  const data=(exported.value as {result:{ok:boolean;tasks:Task[];links:Link[]}}).result;
  if(!data.ok)throw Error('Tasks could not answer');
  const readyIds=new Set(((ready.value as {result:{entries?:Task[]}}).result.entries??[]).map(t=>t.id));
  const tree=new Set(q.card.links.epic?[q.card.links.epic]:[]);
  let added=true;while(added){added=false;for(const l of data.links)if(l.type==='parent-child'&&tree.has(l.dependsOn)&&!tree.has(l.id)){tree.add(l.id);added=true;}}
  const matches=(t:Task)=>q.names.some(n=>new RegExp(`(^|[^a-z0-9-])${n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z0-9-]|$)`,'i').test([t.title,t.description,t.goal].join(' ')))||q.names.includes(t.project??'');
  const groups:ProjectGroup[]=[{title:'Waiting on you',waiting:true,items:[]},{title:'Ready',items:[]},{title:'Blocked or in progress',items:[]},{title:'Done lately',items:[]}];
  for(const t of data.tasks){
   if(!tree.has(t.id)&&!matches(t))continue;
   const closed=t.status==='closed';if(closed&&(!t.closedAt||Date.parse(t.closedAt)<Date.parse(q.since)))continue;
   const waiting=!closed&&(t.assignee===viewer.id||(t.assignee==='jonathan'&&isOwner(viewer)))&&!!t.ask;
   const group=closed?3:waiting?0:readyIds.has(t.id)?1:2;
   const item:ProjectItem={title:t.title,ref:t.id,when:t.closedAt??t.createdAt,href:`/p/tasks-preview/task/${encodeURIComponent(t.id)}`,status:!tree.has(t.id)?'outside the tree':t.status,...(t.description?{body:t.description}:{}),...(waiting?{waiting:true}:{})};
   groups[group].items.push(item);
  }
  return {available:true,groups:groups.filter(g=>g.items.length)};
 }};
}
/** Changes owns attribution, waiting groups and private record policy. Repos select only its visible output. */
export function projectChanges(operations:Operations):ProjectSectionRole {
 return {read(viewer,q){
  const result=operations.call('direct',viewer,'changes.list',{});if(!result.ok)throw Error('Changes could not answer');
  type Change={repo:string;project?:string;title:string;id:string;updated:string;status:string;group:string;author:{name?:string;login:string}};
  const repos=new Set((q.card.links.repos??[]).map(r=>(r.includes(':')?r:`github:${r}`).toLowerCase()));
  const rows=(result.value as Change[]).filter(c=>q.names.includes(c.project??'')||repos.has(c.repo.toLowerCase()));
  const groups:ProjectGroup[]=[];
  for(const c of rows){let g=groups.find(g=>g.title===c.group);if(!g){g={title:c.group,waiting:c.group==='you',items:[]};groups.push(g);}g.items.push({title:c.title,ref:c.id,when:c.updated,status:c.status,who:[c.author.name??c.author.login],href:`/p/changes-preview/change/${encodeURIComponent(c.id)}`});}
  return {available:true,groups};
 }};
}
