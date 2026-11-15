import { expect, it } from 'vitest';
import { bodyInput } from './body-bootstrap.js';
import type { WorkerAssignment } from './worker.js';
const job: WorkerAssignment = { id: 'job', box: 'box', agent: 'agent', conversation: 'cv', model: 'model', account: 'account', harness: 'harness', brief: '', house: { repository: 'repo', file: 'Housefile', branch: 'next' } };
const token = Buffer.from('body_'+'a'.repeat(64));
it('adds the private credential alongside the assignment without mutating it', () => {
  expect(bodyInput(job, 'image')).toEqual({ job, build: 'image' });
  expect(bodyInput(job, 'image', { origin: 'https://loom.example', job: 'job', token }, true)).toEqual({ job, build: 'image', bootstrap: { origin: 'https://loom.example', job: 'job', token: token.toString() } });
  expect(JSON.stringify(job)).not.toContain('body_');
});
for (const patch of [{ job: 'other' }, { origin: 'http://remote.example' }, { origin: 'https://user:pass@loom.example' }, { origin: 'https://loom.example/path' }, { origin: 'https://loom.example?query' }, { origin: 'https://loom.example#fragment' }, { token: Buffer.from('short') }, { token: Buffer.alloc(69, 0xe1) }]) it('refuses mismatched jobs, unsafe origins and malformed raw credentials', () => {
  expect(() => bodyInput(job, 'image', { origin: 'https://loom.example', job: job.id, token, ...patch }, true)).toThrow();
});

for (const origin of ['https://loom.example/private/..', 'https://loom.example?', 'https://loom.example#']) it('rejects forbidden syntax before URL normalization can discard it', () => {
  expect(() => bodyInput(job, 'image', { origin, job: job.id, token }, true)).toThrow('Invalid private body origin');
});
it('emits a canonical origin for valid case/default-port representations', () => {
  expect(bodyInput(job, 'image', { origin: 'HTTPS://LOOM.EXAMPLE:443/', job: job.id, token }, true).bootstrap?.origin).toBe('https://loom.example');
});
