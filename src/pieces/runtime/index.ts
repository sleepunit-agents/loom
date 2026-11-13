import { z } from 'zod';
import { migrate, operation, maySee, type Db, type Operations, type Live, type Sharing, type RecordScope, type LiveRecord } from '../../core/index.js';
import { records, type RecordKind } from './records.js';
import { schema } from './schema/001.js';
import { runtimeStore } from './store.js';
const inScope = (record: LiveRecord, scope: string | undefined) => scope === undefined || record.agent === scope;
/** Metadata reads only. Mutating operations are installed with their runner/delivery implementations. */
export function installRuntime(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  migrate(db, 'runtime', schema);
  const store = runtimeStore(db);
  const names = { box: 'listBoxes', job: 'listJobs', settings: 'listSettings', binding: 'listBindings' };
  for (const kind of Object.keys(records) as RecordKind[]) {
    const type = `runtime.${kind}`;
    const read = (id: string, viewer: Parameters<typeof maySee>[0]) => {
      const record = store.read(kind, id);
      if (!record || !maySee(viewer, { ...record, type } as RecordScope, sharing())) return;
      return record;
    };
    operations.register(operation({
      name: `runtime.${names[kind]}`,
      input: z.object({ scope: z.string().optional() }).strict(), output: z.object({ records: z.array(z.unknown()) }),
      may: () => true,
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
