/** Pure task-feed projection. Data arrives through the new Tasks role, never legacy IO. */
import type {ProjectGroup,ProjectItem} from './projects-model.js';
import type {ProjectQuery} from './projects-roles.js';
/** Minimal metadata accepted from Tasks.call; the Tasks implementation owns its domain types. */
export interface ProjectTask {id:string;title:string;status:string;priority:number;createdAt:string;comments:Array<{at:string}>;project?:string;description?:string;assignee?:string;startedAt?:string;closedAt?:string;closeReason?:string;goal?:string;why?:string;source?:string}
export interface ProjectTaskLink {id:string;dependsOn:string;type:string}
type Task=ProjectTask;
type ScopedTask=ProjectTask;
type Link=ProjectTaskLink;
const clip=(text:string,n:number)=>text.length>n?text.slice(0,n-1)+'…':text;
function body(task:Task){
 const text=[[task.goal,task.why].filter(Boolean).join(' '),task.description].filter(Boolean).join('\n\n').trim();if(!text)return undefined;
 if(text.length<=600)return text;
 const kept=clip(text,600),missing=[...new Set(text.match(/\bdg-[0-9a-f]{12}\b/g)??[])].filter(id=>!kept.slice(0,-1).includes(id));
 const tail=missing.length?'\n'+missing.join(' ').slice(0,598):'';return tail?clip(text,600-tail.length)+tail:kept;
}
export function taskGroups(tasks:ScopedTask[],links:Link[],readyIds:Set<string>,q:ProjectQuery,ownerIds:Set<string>):ProjectGroup[]{
 const tree=new Set<string>(q.card.links.epic?[q.card.links.epic]:[]);
 let added=true;while(added){added=false;for(const l of links)if(l.type==='parent-child'&&tree.has(l.dependsOn)&&!tree.has(l.id)){tree.add(l.id);added=true;}}
 const threads=new Set((q.conversations??[]).map(id=>`conversation:${id}`));for(const t of tasks)if(t.source&&threads.has(t.source))tree.add(t.id);
 const names=q.names.map(n=>new RegExp(`(^|[^a-z0-9-])${n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z0-9-]|$)`,'i'));
 const matches=(t:ScopedTask)=>q.names.includes(t.project??'')||names.some(re=>re.test([t.title,t.description].join('\n')));
 const groups:ProjectGroup[]=[{title:'Waiting on you',waiting:true,items:[]},{title:'Ready',items:[]},{title:'Blocked or in progress',items:[]},{title:'Done lately',items:[]}];
 const ordered=tasks.map((task,index)=>({task,index})).sort((a,b)=>(a.task.status==='closed'?1:0)-(b.task.status==='closed'?1:0)||(a.task.status==='closed'&&b.task.status==='closed'?Date.parse(b.task.closedAt??'')-Date.parse(a.task.closedAt??'')||a.index-b.index:a.task.priority-b.task.priority||a.index-b.index));
 for(const {task:t} of ordered){
  if(t.id===q.card.links.epic)continue;
  const inside=tree.has(t.id),closed=t.status==='closed';
  if(closed?(!inside||!t.closedAt||Date.parse(t.closedAt)<Date.parse(q.since)):(!inside&&!matches(t)))continue;
  const waiting=!closed&&!!t.assignee&&ownerIds.has(t.assignee),group=closed?3:waiting?0:readyIds.has(t.id)?1:2;
  const moved=[t.createdAt,t.startedAt,...t.comments.map(c=>c.at)].filter((x):x is string=>!!x&&Number.isFinite(Date.parse(x))).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
  const status=closed?(t.closeReason==='cancelled'?'cancelled':'done'):!inside?'outside the tree':waiting?t.status:readyIds.has(t.id)?'ready':t.status==='in_progress'?'in progress':'blocked';
  const prose=body(t);
  const item:ProjectItem={title:clip(t.title.trim()||t.id,200),ref:t.id,...(closed?t.closedAt?{when:new Date(t.closedAt).toISOString()}:{}:moved?{when:new Date(moved).toISOString()}:{}),href:`/p/tasks-preview/task/${encodeURIComponent(t.id)}`,status,...(prose?{body:prose}:{}),...(waiting?{waiting:true}:{})};
  groups[group].items.push(item);
 }
 // Fairly share the old fifty-item cap; a truncated group names its full size.
 const take=groups.map(()=>0);let left=50;
 while(left){const open=groups.flatMap((g,i)=>take[i]<g.items.length?[i]:[]);if(!open.length)break;for(const i of open){if(!left)break;take[i]++;left--;}}
 return groups.flatMap((g,i)=>g.items.length?[{...g,title:take[i]<g.items.length?`${g.title} (${take[i]} of ${g.items.length})`:g.title,items:g.items.slice(0,take[i])}]:[]);
}
