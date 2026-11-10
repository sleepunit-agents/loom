import type { Job } from './vocab.js';
import type { Source } from './render.js';
export type CardJob = Job & { source: Source };
const rank = { running: 0, waiting: 1, scheduled: 2, backlog: 3 };
/** Identity is producer + id; references explicitly supplied by producers absorb task-only backlog.
 * Titles and conversation provenance never prove two jobs are the same work. Concurrent runs remain separate. */
export function agentJobs(rows: CardJob[]): CardJob[] {
  const unique = new Map<string, CardJob>();
  for (const j of rows) {
    const key = `${j.source.id}:${j.id}`;
    const old = unique.get(key);
    if (!old || rank[j.status] < rank[old.status]) unique.set(key, j);
  }
  const jobs = [...unique.values()];
  const taskOnly = (j: CardJob) => j.tasks?.length === 1 && j.tasks[0] === j.id;
  const represented = new Set(jobs.filter((j) => !taskOnly(j)).flatMap((j) => j.tasks ?? []));
  return jobs.filter((j) => !taskOnly(j) || !represented.has(j.id))
    .sort((a, b) => rank[a.status] - rank[b.status] || (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0) || a.id.localeCompare(b.id));
}
