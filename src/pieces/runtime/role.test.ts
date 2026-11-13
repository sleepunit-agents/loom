import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createFoundation } from '../../core/app.js';
import { operation } from '../../core/index.js';
import { runtimeRole } from './role.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(f => f()); });
it('retains the caller and retry id through the registry and routes status to attention', () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-role-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const app = createFoundation({ home }); cleanups.push(() => app.close());
  const seen: string[] = [];
  for (const name of ['runtime.startBody', 'runtime.deliver', 'runtime.reply', 'attention.reportStatus']) {
    app.operations.register(operation({ name, write: true, input: z.unknown(), output: z.unknown(),
      may: v => v.kind === 'member' && v.id === 'owner',
      run(ctx) { seen.push(name); return { by: ctx.viewer.id }; },
    }));
  }
  const runtime = runtimeRole(app.operations);
  const owner = { kind: 'member', id: 'owner' } as const;
  const input = { agent: 'art', brief: 'Work', title: 'Work' };
  expect(runtime.startBody({ kind: 'agent', id: 'art' }, input, 'start')).toMatchObject({ ok: false, code: 'denied' });
  expect(runtime.startBody(owner, input, 'start')).toEqual({ ok: true, value: { by: 'owner' } });
  expect(runtime.startBody(owner, input, 'start')).toEqual({ ok: true, value: { by: 'owner' } });
  expect(runtime.startBody(owner, { ...input, title: 'Different' }, 'start')).toMatchObject({ ok: false, code: 'conflict' });
  expect(runtime.deliver(owner, { id: 'm', agent: 'art', venue: 'loom', place: 'th:1', from: { kind: 'person', slug: 'owner' }, kind: 'message', at: '2026-11-13T03:00:00Z', text: 'Hello' }, 'in').ok).toBe(true);
  expect(runtime.reply(owner, { conversation: 'cv', id: 'r', text: 'Hi', job: 'j' }, 'out').ok).toBe(true);
  expect(runtime.reportStatus(owner, { id: 'art', agent: 'art', state: 'working', work: 'Work', jobs: [], watched: [] }, 'status').ok).toBe(true);
  expect(seen).toEqual(['runtime.startBody', 'runtime.deliver', 'runtime.reply', 'attention.reportStatus']);
});
it('does not claim delivery succeeded when the runtime is not installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-role-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const app = createFoundation({ home }); cleanups.push(() => app.close());
  expect(runtimeRole(app.operations).deliver({ kind: 'agent', id: 'art' }, { id: 'm', agent: 'art', venue: 'loom', place: 'th:1', from: { kind: 'person', slug: 'owner' }, kind: 'message', at: '2026-11-13T03:00:00Z', text: 'Hello' }, 'in'))
    .toMatchObject({ ok: false, code: 'not-found' });
});
