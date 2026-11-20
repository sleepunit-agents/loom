/** Discovery of reported metadata, never a repository check or execution grant. */
import { z } from 'zod';
import { operation, mayAct, maySee, type Db, type Operations, type Sharing } from '../../core/index.js';
import { configuredBuild, configuredHouse } from './builds.js';
import { runtimeStore } from './store.js';

export function installBuildStatus(db: Db, operations: Operations, sharing: () => Sharing) {
  const store = runtimeStore(db);
  operations.register(operation({
    name: 'runtime.buildStatus',
    input: z.object({ agent: z.string().min(1).max(200) }).strict(),
    output: z.object({ agent: z.string(), build: z.object({ image: z.string(), job: z.string(), at: z.number().int() }).nullable() }),
    may: (viewer, { agent }) => mayAct(viewer, { type: 'runtime.settings', agent }, sharing(), 'act', 'runtime.buildStatus'),
    run(ctx, { agent }) {
      const house = configuredHouse(store.read('settings', agent)), policy = sharing();
      let build: { image: string; job: string; at: number } | null = null;
      for (const id of store.ids('job')) {
        const job = store.read('job', id)!;
        if (job.agent !== agent || job.state === 'queued' || job.buildAt === undefined || job.claimedAt === undefined
          || job.buildAt < job.claimedAt || job.buildAt > ctx.now
          || !maySee(ctx.viewer, { ...job, type: 'runtime.job' }, policy)) continue;
        const image = configuredBuild(job, house);
        // ids() is ordered; equal server times choose the lexically first job.
        if (image && (!build || job.buildAt > build.at)) build = { image, job: id, at: job.buildAt };
      }
      return { agent, build };
    },
  }));
}
