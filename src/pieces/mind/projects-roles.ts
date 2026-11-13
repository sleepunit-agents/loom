/** Each role receives the original viewer and must enforce its own policy. All calls stay synchronous. */
import type {Viewer,Operations} from '../../core/index.js';
import {taskGroups} from './projects-tasks.js';
import type {Task,Link} from '../tasks/domain.js';
import type {Tasks} from '../tasks/role.js';
import type {ProjectCard,ProjectGroup,ProjectItem,ProjectSection} from './projects-model.js';
export interface ProjectQuery {agent:string;card:ProjectCard;names:string[];notePrefixes:string[];conversations?:string[];since:string;now:number}
export interface ProjectSectionRole {read(viewer:Viewer,query:ProjectQuery):Omit<ProjectSection,'key'|'label'>}
export function projectTasks(tasks:Tasks,isOwner:(viewer:Viewer)=>boolean=()=>false):ProjectSectionRole {
 return {read(viewer,q){
  const exported=tasks.call(viewer,'export',{}),ready=tasks.call(viewer,'ready',{});
  if(!exported.ok||!ready.ok)throw Error('Tasks could not answer');
  const data=(exported.value as {result:{ok:boolean;tasks:Task[];links:Link[]}}).result;
  if(!data.ok)throw Error('Tasks could not answer');
  const readyIds=new Set(((ready.value as {result:{entries?:Task[]}}).result.entries??[]).map(t=>t.id));
  return {available:true,groups:taskGroups(data.tasks,data.links,readyIds,q,new Set([viewer.id,...(isOwner(viewer)?['jonathan']:[])]))};
 }};
}
/** Changes owns attribution, waiting groups and private record policy. Repos select only its visible output. */
export function projectChanges(operations:Operations):ProjectSectionRole {
 return {read(viewer,q){
  const result=operations.call('direct',viewer,'changes.list',{});if(!result.ok)throw Error('Changes could not answer');
  type Change={repo:string;project?:string;title:string;id:string;updated:string;status:string;group:string;author:{name?:string;login:string}};
  const repos=new Set((q.card.links.repos??[]).map(r=>(r.includes(':')?r:`github:${r}`).toLowerCase()));
  const rows=(result.value as Change[]).filter(c=>q.names.includes(c.project??'')||repos.has(c.repo.toLowerCase()));
  const labels:Record<string,string>={you:'Waiting on you',agent:'Ready to merge',ci:'Waiting on CI',reviewer:'Waiting on a reviewer',author:'Waiting on its author',done:'Lately'};
  const groups:ProjectGroup[]=[];
  for(const c of rows){const title=labels[c.group]??c.group;let g=groups.find(g=>g.title===title);if(!g){g={title,waiting:c.group==='you',items:[]};groups.push(g);}g.items.push({title:c.title,ref:c.id,when:c.updated??new Date(q.now).toISOString(),status:c.status,who:[c.author.name??c.author.login],href:`/p/changes-preview/change/${encodeURIComponent(c.id)}`});}
  return {available:true,groups};
 }};
}
