import type { LiveRecord } from '../../data';
export interface Ask extends LiveRecord {
  agent?: string; project?: string; member?: string;
  ask: string; why?: string; if_yes?: string; if_no?: string; href?: string; refs?: string[];
  answers?: 'yes-no' | 'words';
  waits_on?: { approval: string } | { task: string };
  source: { kind: 'conversation' | 'approval' | 'task' | 'piece'; id: string };
  state: 'open' | 'answered' | 'resolved'; createdAt: number; changedAt: number;
  answer?: { kind: string; text?: string; by: { kind: string; id: string }; at: number };
  resolution?: string;
}
export type Answer = { kind: 'yes' | 'no' | 'done' | 'dismiss' } | { kind: 'words'; text: string };
export function inFolder(ask: Ask, folder: string) {
  return folder === 'answered' ? ask.state !== 'open' : ask.state === 'open' && (!folder.startsWith('agent:') || ask.agent === folder.slice(6));
}
export function matches(ask: Ask, query: string) {
  const text = [ask.ask, ask.why, ask.agent, ask.project, ask.id, ...(ask.refs ?? [])].join(' ').toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every(word => text.includes(word));
}
/** A central answer cannot apply another piece's decision. Its app owns that action. */
export function decisionLink(ask: Ask): { path: string; label: string } | undefined {
  const approval = ask.waits_on && 'approval' in ask.waits_on ? ask.waits_on.approval : ask.source.kind === 'approval' ? ask.source.id : undefined;
  if (approval) return { path: `/p/approvals-preview/approval/${encodeURIComponent(approval)}`, label: 'Open approval' };
  const task = ask.waits_on && 'task' in ask.waits_on ? ask.waits_on.task : ask.source.kind === 'task' ? ask.source.id : undefined;
  if (task) return { path: `/p/tasks-preview/task/${encodeURIComponent(task)}`, label: 'Open task' };
}
export function safeHref(href?: string) {
  if (!href) return undefined;
  try { const url = new URL(href); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
