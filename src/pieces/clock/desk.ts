/** Read projections of visible active wakes. No prompt fields, principals or capability metadata. */
import type { Wake } from './store.js';
/** Structural input shared with the browser's already scoped live records. */
export type DeskWake = Pick<Wake, 'id' | 'agent' | 'due' | 'state' | 'note' | 'file' | 'schedule'>;
export interface ClockJob {
  id: string;
  wake: string;
  agent: string;
  status: 'scheduled' | 'waiting' | 'running';
  text: string;
  at: number;
  tasks: string[];
  href: string;
}
export interface AgentNext {
  agent: string;
  paused: boolean;
  held: number;
  next: { id: string; due: number; text: string } | null;
}
const ordered = (wakes: readonly DeskWake[]) => [...wakes].sort((a, b) => a.due - b.due || a.id.localeCompare(b.id));
const brief = (w: DeskWake) => (w.schedule ? w.schedule.replace(/^lane\//, '').replace(/[-_]/g, ' ') : w.note || w.file || 'A wake').slice(0, 300);
export function deskJobs(wakes: readonly DeskWake[], paused: boolean): ClockJob[] {
  return ordered(wakes).map(w => ({ id: w.id, wake: w.id, agent: w.agent,
    status: w.state === 'firing' ? 'running' : paused || w.state === 'parked' || w.state === 'held' ? 'waiting' : 'scheduled',
    text: brief(w), at: w.due, tasks: [...new Set(w.note.match(/\bt-\d+\b/g) ?? [])], href: '/p/clock-preview' }));
}
export function agentNext(agent: string, wakes: readonly DeskWake[], paused: boolean): AgentNext {
  // Park deadlines check an answer; they are not a promise of a body start.
  const next = paused ? undefined : ordered(wakes).find(w => w.state === 'pending');
  return { agent, paused, held: wakes.filter(w => w.state === 'held').length,
    next: next ? { id: next.id, due: next.due, text: brief(next) } : null };
}
