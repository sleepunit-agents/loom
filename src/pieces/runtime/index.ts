import { registerBuiltinService } from '../../core/services.js';
import { z } from 'zod';
import { migrate, operation, maySee, mayAct, type Db, type Operations, type Live, type Sharing, type RecordScope, type LiveRecord } from '../../core/index.js';
import { records, type RecordKind } from './records.js';
import { schema } from './schema/001.js';
import { runtimeStore } from './store.js';
import { installBoxOperations } from './boxes.js';
import { installRevokeBox } from './revoke.js';
import { installRunnerJobs } from './runner-jobs.js';
import { installRunnerReports } from './runner.js';
import type { RuntimeCredentials } from './credentials.js';
const inScope = (record: LiveRecord, scope: string | undefined) => scope === undefined || record.agent === scope;
/** Control metadata. Execution is installed separately with its runner implementation. */
export function installRuntime(db: Db, operations: Operations, live: Live, sharing: () => Sharing, options: { credentials?: RuntimeCredentials } = {}) {
  registerBuiltinService(operations, 'runtime', ['runtime.box', 'runtime.job', 'runtime.settings', 'runtime.binding']);
  migrate(db, 'runtime', schema);
  const store = runtimeStore(db);
  installBoxOperations(db, operations, sharing);
  installRunnerReports(db, operations, sharing);
  installRunnerJobs(db, operations, sharing, options.credentials);
  installRevokeBox(db, operations, sharing, options.credentials);
  const names = { box: 'listBoxes', job: 'listJobs', settings: 'listSettings', binding: 'listBindings' };
  for (const kind of Object.keys(records) as RecordKind[]) {
    const type = `runtime.${kind}`, name = `runtime.${names[kind]}`;
    const read = (id: string, viewer: Parameters<typeof maySee>[0]) => {
      const record = store.read(kind, id);
      if (!record || !maySee(viewer, { ...record, type } as RecordScope, sharing())) return;
      return record;
    };
    operations.register(operation({
      name,
      input: z.object({ scope: z.string().optional() }).strict(), output: z.object({ records: z.array(z.unknown()) }),
      may: viewer => viewer.kind !== 'service' || mayAct(viewer, { type }, sharing(), 'act', name),
      run(ctx, input) {
        return { records: store.ids(kind).flatMap(id => {
          const record = read(id, ctx.viewer);
          return record && inScope(record, input.scope) ? [record] : [];
        }) };
      },
    }));
    live.register({ name: type, ids: () => store.ids(kind), read,
      inScope,
    });
  }
}
