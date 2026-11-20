import type { LiveRecord } from '../../data';
export interface Task extends LiveRecord {
  title: string; type: string; status: 'open' | 'in_progress' | 'closed'; priority: number;
  ready?: boolean; blocked?: boolean; assignee?: string; project?: string; parent?: string; dependsOn: string[];
  goal?: string; why?: string; doneWhen?: string; description?: string; ask?: string; ifYes?: string; ifNo?: string;
  createdAt: string; closedAt?: string; closeReason?: string; source?: string;
  comments: { actor: string; at: string; text: string }[];
}
export interface TaskAnswer { result: { ok: boolean; errors?: string[]; warnings?: string[]; id?: string; entries?: Task[]; task?: Task } }
export const plainFields = ['title', 'goal', 'why', 'doneWhen', 'description', 'ask', 'ifYes', 'ifNo'] as const;
export const fieldLabel = { title: 'Title', goal: 'Goal', why: 'Why', doneWhen: 'Done when', description: 'Description', ask: 'Question for Jonathan', ifYes: 'If yes', ifNo: 'If no' };
export function inFolder(task: Task, folder: string): boolean {
  if (folder === 'closed') return task.status === 'closed';
  if (task.status === 'closed') return false;
  if (folder === 'ready') return task.ready === true;
  if (folder === 'progress') return task.status === 'in_progress';
  if (folder === 'jonathan') return task.assignee === 'jonathan';
  if (folder.startsWith('project:')) return task.project === folder.slice(8);
  if (folder.startsWith('epic:')) return task.parent === folder.slice(5);
  return true;
}
export function matches(task: Task, query: string) {
  const text = [task.id, task.title, task.goal, task.why, task.doneWhen, task.description, task.ask, task.project, task.assignee].join(' ').toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every(word => text.includes(word));
}
export function pullRequests(task: Task) {
  const text = [task.description, ...task.comments.map(c => c.text)].join('\n');
  const refs = new Map<string, string>();
  for (const m of text.matchAll(/(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)|(?:github:)?([\w.-]+\/[\w.-]+)#(\d+))/g)) {
    const repo = m[1] ?? m[3], n = m[2] ?? m[4]; refs.set(`${repo}#${n}`, `https://github.com/${repo}/pull/${n}`);
  }
  return [...refs];
}
