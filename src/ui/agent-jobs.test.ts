import { expect, it } from 'vitest';
import { agentJobs, type CardJob } from './agent-jobs.js';
import { parseManifest } from './vocab.js';
const source = { id: 'piece:runtime', label: 'Runtime' } as CardJob['source'];
const job = (id: string, status: CardJob['status'], tasks: string[] = []): CardJob => ({ id, status, text: 'Same title', tasks, source });
it('keeps two concurrent runs and scheduled/waiting work, dedups only explicit task references and producer identity', () => {
  const rows = [job('run1', 'running', ['t-1']), job('run2', 'running', ['t-1']), job('wait', 'waiting'), job('later', 'scheduled'), job('t-1', 'backlog', ['t-1']), job('t-2', 'backlog', ['t-2']), job('run1', 'running')];
  expect(agentJobs(rows).map((j) => j.id)).toEqual(['run1', 'run2', 'wait', 'later', 't-2']);
  expect(agentJobs(rows.filter((j) => !j.id.startsWith('run'))).map((j) => j.id)).toContain('t-1');
});
it('parses a complete jobs payload independently of the legacy doing limit', () => {
  const jobs = Array.from({ length: 40 }, (_, n) => job(String(n), n % 2 ? 'waiting' : 'scheduled'));
  const parsed = parseManifest({ v: 2, asks: [], agents: { art: { readings: [], jobs } } });
  expect(parsed).toHaveProperty('agents.art.jobs.length', 40);
});

it('does not mistake conversation provenance or matching titles for a task/run identity', () => {
  const cv = 'cv-0123456789ab';
  expect(agentJobs([{ ...job('r', 'running'), conversation: cv }, { ...job('t', 'backlog', ['t-9']), conversation: cv }])).toHaveLength(2);
});
