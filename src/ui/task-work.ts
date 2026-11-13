/** Task-facing compatibility for apps that have not moved yet. All reads pass through the tasks role. */
import type { Tasks, Task } from '../pieces/tasks/role.js';
import type { WorkItem } from '../comms-work.js';
export const taskStatus = (task: Task) => task.status === 'closed' ? 'Done' : task.status === 'in_progress' ? 'In progress' : task.assignee === 'jonathan' ? 'Needs Jonathan' : 'Open';
function value(answer: ReturnType<Tasks['call']>): Record<string,unknown> | undefined {
  if (!answer.ok) return;
  const result = (answer.value as {result:Record<string,unknown>}).result;
  return result.ok ? result : undefined;
}
export function taskFor(tasks: Tasks, member: string, id: string): Task | undefined {
  return value(tasks.call({kind:'member',id:member},'show',{id}))?.task as Task | undefined;
}
export function taskWork(tasks: Tasks, member: string, conversation: string, refs: readonly string[]): WorkItem[] {
  const exported = value(tasks.call({kind:'member',id:member},'export',{}));
  if (!exported) throw new Error('Tasks unavailable');
  return (exported.tasks as Task[]).filter(task => refs.includes(task.id) || task.source === `conversation:${conversation}`).map(task => ({
    ref:task.id,title:task.title,status:taskStatus(task),from:'tasks',url:`/p/tasks/task/${task.id}`,
    ...(task.status === 'closed' ? {tone:'ok' as const} : {}),
    ...(task.source === `conversation:${conversation}` ? {made:true as const} : {}),
    when:task.closedAt ?? task.startedAt ?? task.createdAt,
  }));
}
export function projectTasks(tasks: Tasks, member: string, slug: string, epic: string | undefined, since: string) {
  const exported = value(tasks.call({kind:'member',id:member},'export',{}));
  if (!exported) throw new Error('Tasks unavailable');
  const all = exported.tasks as (Task & {project?:string})[];
  const ids = new Set(all.filter(task => task.project === slug || task.id === epic).map(task=>task.id));
  const links = exported.links as {id:string;dependsOn:string;type:string}[];
  for (;;) {
    const before = ids.size;
    for (const link of links) if (link.type === 'parent-child' && ids.has(link.dependsOn)) ids.add(link.id);
    if (ids.size === before) break;
  }
  const included = all.filter(task => ids.has(task.id) && (task.status !== 'closed' || Date.parse(task.closedAt ?? task.createdAt) >= Date.parse(since)));
  return { key:'piece:tasks',label:'Tasks',groups:[
    {title:'Needs Jonathan',waiting:true,items:included.filter(task=>task.status!=='closed' && task.assignee==='jonathan')},
    {title:'Work',items:included.filter(task=>task.status!=='closed' && task.assignee!=='jonathan')},
    {title:'Recently closed',items:included.filter(task=>task.status==='closed')},
  ].filter(group=>group.items.length).map(group=>({...group,items:group.items.map(task=>({title:task.title,status:taskStatus(task),ref:task.id,page:`loom:p/tasks/task/${task.id}`,body:task.goal,when:task.closedAt ?? task.startedAt ?? task.createdAt}))})) };
}
