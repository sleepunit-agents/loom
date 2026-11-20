import { z } from 'zod';
import { operation, mayAct, type Db, type Operations, type Sharing } from '../../core/index.js';
import { boxReport, hearBox } from './lifecycle.js';

/** Facts-only runner report. The transport supplies the authenticated principal;
 * input cannot choose a box, owner, timestamp or any scheduling configuration.
 */
export function installRunnerReports(db: Db, operations: Operations, sharing: () => Sharing) {
  operations.register(operation({
    name: 'runtime.hearBox', write: true, input: boxReport,
    output: z.object({ box: z.string() }),
    may: viewer => mayAct(viewer, { type: 'runtime.box', runner: viewer.id }, sharing(), 'report-box'),
    run(ctx, input) {
      const result = hearBox(db, ctx.viewer.id, input, ctx.now);
      if (result.changed) ctx.changed('runtime.box', result.box);
      return { box: result.box };
    },
  }));
}
