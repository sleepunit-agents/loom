import { z } from 'zod';
import { operation, OperationError, mayAct, type Db, type Operations, type Sharing } from '../../core/index.js';
import { resolveBox } from './boxes.js';
import type { RuntimeCredentials } from './credentials.js';
import { runtimeStore } from './store.js';

const terminal = new Set(['done', 'failed', 'stopped', 'lost']);
/** All affected metadata and central credentials commit together, or none do. */
export function installRevokeBox(db: Db, operations: Operations, sharing: () => Sharing, credentials?: RuntimeCredentials) {
  const store = runtimeStore(db);
  operations.register(operation({
    name: 'runtime.revokeBox', write: true,
    input: z.object({ box: z.string().min(1).max(200) }).strict(),
    output: z.object({ box: z.string(), revoked: z.literal(true) }),
    may: viewer => mayAct(viewer, { type: 'runtime.box' }, sharing(), 'household'),
    run(ctx, input) {
      const box = resolveBox(store, input.box);
      if (box.local) throw new OperationError('conflict', 'The local runner cannot be revoked');
      if (!credentials) throw new OperationError('unavailable', 'Central credential revocation is not installed');
      const jobs = store.ids('job').map(id => store.read('job', id)!).filter(job => job.box === box.id);
      // Include terminal jobs defensively: their credentials should already be
      // gone, but box revocation must not rely on a previous cleanup succeeding.
      const result = credentials.revokeBox(db, { box: box.id, jobs: jobs.map(job => job.id), now: ctx.now });
      if ((result as unknown) instanceof Promise) throw new Error('Credential revocation must be synchronous');
      ctx.changed('core.access', 'credentials');
      if (store.put('box', { ...box, revokedAt: ctx.now }, ctx.now)) ctx.changed('runtime.box', box.id);
      for (const job of jobs) {
        if (terminal.has(job.state)) continue;
        const { changedAt: _jobAt, ...record } = job;
        if (store.put('job', { ...record, state: 'lost', endedAt: ctx.now }, ctx.now)) ctx.changed('runtime.job', job.id);
      }
      for (const id of store.ids('settings')) {
        const { changedAt: _settingsAt, ...settings } = store.read('settings', id)!;
        if (!settings.boxes.includes(box.id)) continue;
        if (store.put('settings', { ...settings, boxes: settings.boxes.filter(id => id !== box.id) }, ctx.now)) ctx.changed('runtime.settings', id);
      }
      return { box: box.id, revoked: true };
    },
  }));
}
