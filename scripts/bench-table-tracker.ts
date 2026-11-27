/** Cost of the t-2431 table tracker (src/core/data/table-tracker.ts) on the shared connection's hot path.
 * `npx tsx scripts/bench-table-tracker.ts`. Measures the same work on a connection without the tracker, then
 * (installing it, which also wraps better-sqlite3's statement methods for the process) on one with it. */
import Database from 'better-sqlite3';
import { createDataSchema } from '../src/core/data/database.js';
import { installTableTracker, recordReads } from '../src/core/data/table-tracker.js';

const ROUNDS = 9;
function connection() {
  const client = new Database(':memory:');
  createDataSchema(client);
  client.exec(`INSERT INTO members (id, role, joined_at) VALUES ('sam','member','2026-11-14T00:00:00.000Z');
    INSERT INTO projects (id,name) VALUES ('pond','Pond');
    INSERT INTO project_members (project,member) VALUES ('pond','sam');`);
  const insert = client.prepare(`INSERT INTO tasks (id,title,owner_kind,owner,project,created_by_kind,created_by,created_at,changed_at)
    VALUES (?,?,'member','sam','pond','member','sam','2026-11-14T00:00:00.000Z','2026-11-14T00:00:00.000Z')`);
  for (let i = 0; i < 200; i++) insert.run(`t-${i}`, `Task ${i}`);
  return client;
}
// A selection with a policy join, like the generated ones.
const SELECT = `SELECT tasks.id, tasks.title FROM tasks WHERE tasks.project IN (SELECT project FROM project_members WHERE member = ?) AND tasks.id = ?`;
const UPDATE = `UPDATE tasks SET title = ? WHERE id = ?`;

function time(iterations: number, body: (i: number) => void): number {
  // Warm up first, so the JIT has settled before anything is timed.
  for (let i = 0; i < iterations; i++) body(i);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) body(i);
    samples.push(Number(process.hrtime.bigint() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(ROUNDS / 2)]!;
}

let unique = 0;
/** `around` wraps a whole case, as one live reading or one write capture holds many statements. */
function cases(client: Database.Database, around: <T>(fn: () => T) => T) {
  const prepared = client.prepare(SELECT), update = client.prepare(UPDATE);
  return around(() => ({
    // What Drizzle does per query: prepare the same SQL text, then run it.
    'prepare + get (SQL seen before)': time(20_000, i => client.prepare(SELECT).get('sam', `t-${i % 200}`)),
    // A statement prepared once and reused.
    'get on a reused statement': time(100_000, i => prepared.get('sam', `t-${i % 200}`)),
    'run on a reused UPDATE': time(50_000, i => update.run(`T${i}`, `t-${i % 200}`)),
    // SQL text never seen before: the tracker runs EXPLAIN and classifies it.
    'prepare + get (new SQL text)': time(2_000, () => client.prepare(`${SELECT} AND ${++unique} = ${unique}`).get('sam', 't-1')),
  }));
}

const plain = connection();
const before = cases(plain, fn => fn());
plain.close();
const tracked = connection();
const tracker = installTableTracker(tracked);
const after = cases(tracked, fn => fn());
const inReading = cases(tracked, fn => recordReads(fn).value);
const inCapture = cases(tracked, fn => tracker.capture(fn).value);
tracked.close();

const rows = Object.keys(before).map(name => {
  const key = name as keyof typeof before, base = before[key];
  const pct = (value: number) => `${(value / base * 100 - 100).toFixed(1)}%`;
  return { case: name, 'untracked µs': (base / 1000).toFixed(2), 'tracked µs': (after[key] / 1000).toFixed(2), overhead: pct(after[key]),
    'in a reading µs': (inReading[key] / 1000).toFixed(2), 'reading overhead': pct(inReading[key]),
    'in a write capture µs': (inCapture[key] / 1000).toFixed(2), 'capture overhead': pct(inCapture[key]) };
});
console.log(`node ${process.version}, better-sqlite3 ${(await import('better-sqlite3/package.json', { with: { type: 'json' } })).default.version}, median of ${ROUNDS} rounds per case`);
console.table(rows);
