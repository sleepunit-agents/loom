/** Logs are fetched explicitly under job visibility, never streamed as live records. */
import { z } from 'zod';
import { operation, mayAct, type Db, type Operations, type Sharing } from '../../core/index.js';
import { runtimeStore } from './store.js';
export const resultFields = { exit: z.number().int().safe().optional(), log: z.string().max(1_000_000).optional() };
const resultSchema = z.object({ exit: z.number().int().safe().optional(), log: z.string().max(4000).optional() }).strict();
type JobResult = z.infer<typeof resultSchema>;
const refused = "the box couldn't start it: ";
function tail(log: string): string {
  const first = log.split('\n', 1)[0];
  return log.length > 4000 && first.startsWith(refused) && first.length < 300
    ? `${first}\n${log.slice(-(4000 - first.length - 1))}` : log.slice(-4000);
}
export function jobResults(db: Db) {
  function read(job: string): JobResult | null {
    const row = db.prepare('SELECT record FROM runtime_results WHERE job=?').get(job) as { record: string } | undefined;
    return row ? resultSchema.parse(JSON.parse(row.record)) : null;
  }
  return { read, put(job: string, fields: JobResult): boolean {
    if (!db.inTransaction) throw new Error('Runtime result writes require a transaction');
    if (fields.exit === undefined && fields.log === undefined) return false;
    const before = read(job), after = resultSchema.parse({ ...before,
      ...(fields.exit !== undefined ? { exit: fields.exit } : {}),
      ...(fields.log !== undefined ? { log: tail(fields.log) } : {}),
    });
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    db.prepare('INSERT INTO runtime_results (job,record) VALUES (?,?) ON CONFLICT(job) DO UPDATE SET record=excluded.record').run(job, JSON.stringify(after));
    return true;
  } };
}
export function installJobResults(db: Db, operations: Operations, sharing: () => Sharing) {
  const store = runtimeStore(db), results = jobResults(db);
  operations.register(operation({
    name: 'runtime.jobResult',
    input: z.object({ job: z.string().min(1).max(200) }).strict(),
    output: z.object({ job: z.string(), result: resultSchema.nullable() }),
    may(viewer, { job: id }) {
      const job = store.read('job', id);
      return !!job && mayAct(viewer, { ...job, type: 'runtime.job' }, sharing(), 'act', 'runtime.jobResult');
    },
    run: (_ctx, { job }) => ({ job, result: results.read(job) }),
  }));
}
