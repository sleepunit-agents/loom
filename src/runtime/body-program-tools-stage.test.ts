/** The one stage of a body that the injected native harness of body-program.test.ts skips: starting the
 * body's own tools server. Its module is replaced here so the start can fail. */
import { expect, it, vi } from 'vitest';
import { BODY_EXIT } from './job-exit.js';
import type { WorkerAssignment } from './worker.js';

vi.mock('./body-secret-tools.js', () => ({ bodySecretTools: async () => { throw new Error('tools server did not start'); } }));
const { bodyProgram } = await import('./body-program.js');

it('says its tools server failed, not identity and not the harness, when that server cannot start', async () => {
  const raw = 'body_' + 'a'.repeat(64);
  const job: WorkerAssignment = { id: 'job', box: 'box', agent: 'art', conversation: 'cv', thread: 'thread', model: 'requested', account: 'sub', harness: 'claude', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' } };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url).split('/').at(-1)!; calls.push(path); void init;
    if (path === 'startup') return Response.json({ aliases: [] });
    const values = {
      take: { job: 'job', conversation: 'cv', stopRequested: false, items: [{ id: 'mail', seq: 1, source: 'thread', sourceId: null, fromKind: 'person', fromId: 'alice', at: '2026-11-15T00:00:00.000Z', words: 'Hello', keepUntil: null, verdict: null, refs: [] }] },
      accept: { saved: true }, status: { saved: true, stopRequested: false },
    };
    return Response.json({ ok: true, value: values[path as keyof typeof values] });
  };
  const exit = await bodyProgram({ args: ['config'], read: async () => JSON.stringify({ command: '/native/claude', cwd: '/house' }),
    stdin: async () => Buffer.from(JSON.stringify({ job, build: 'image', bootstrap: { origin: 'https://loom.example', job: 'job', token: raw } })),
    env: {}, signal: new AbortController().signal, fetch: fetcher, loadMemory: async () => null, startup: async () => {}, error: () => {} });
  expect(exit).toBe(BODY_EXIT.tools);
  expect(calls).toContain('accept'); expect(calls).not.toContain('confirm');
});
