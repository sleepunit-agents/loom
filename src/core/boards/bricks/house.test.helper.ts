/** A real household for a brick's suite that must follow what its page reports past `boards.act`: an in-memory
 * database with loom's schema, the board operations registered on it, one member's thread with the agent, and a
 * board holding one placement of the brick. `stored()` is every row of every table as one string, and `brief()` is
 * what the agent is handed at the start of its next job, so a suite can say what a report can never carry. */
import Database from 'better-sqlite3';
import { FakeClock } from '../../clock.js';
import { createDataSchema } from '../../data/database.js';
import { OperationResults } from '../../data/operation-results.js';
import { DataWrites } from '../../data/writes.js';
import { agents, members } from '../../data/schema.js';
import { Operations } from '../../operations/index.js';
import { CommsMessages } from '../../conversations/messages.js';
import type { Viewer } from '../../../policy.js';
import { registerBoardOperations } from '../operations.js';

export async function household(brick: string) {
  const client = new Database(':memory:');
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const operations = new Operations(client, clock, () => {}, {
    receipts: new OperationResults(db), writes: new DataWrites(db, { refreshAccess() {}, changed() {} }), reportError(error) { throw error; },
  });
  const comms = new CommsMessages(db, { async seal(w) { return Buffer.from(w); }, async open(b) { return Buffer.from(b).toString(); }, hash: (w) => 'h:' + w }, now);
  const thread = comms.threads.open({ id: 'th:sam', member: 'sam', agent: 'art', title: 'Household' });
  const body = { job: { id: 'job-1' }, cv: { id: thread.conversation, agent: 'art' } };
  const store = registerBoardOperations(operations, db, ((viewer: Viewer) => (viewer.id === 'body' ? body : undefined)) as never, (w) => 'h:' + w);
  store.sentFrom('th:sam', null, now());
  let n = 0;
  const as = (viewer: Viewer) => async (name: string, input: unknown) => {
    clock.advance(1000);
    return operations.callAsync('http', viewer, name, input, 'c' + ++n, true, () => true) as Promise<{ ok: boolean; code?: string; value?: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const agent = as({ kind: 'agent', id: 'body' }), member = as({ kind: 'member', id: 'sam' });
  const board = (await agent('boards.open', { title: 'Household' })).value.board as string;
  const placement = (await agent('boards.change', { board, changes: [{ change: 'place', brick, params: {} }] })).value.placements[0].placement as string;
  const tables = (client.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((t) => t.name);
  return {
    act: (action: string, detail: Record<string, unknown>) => member('boards.act', { board, placement, action, detail }),
    read: () => agent('boards.read', { board }),
    stored: () => JSON.stringify(Object.fromEntries(tables.map((t) => [t, client.prepare(`select * from "${t}"`).all()]))),
    brief: () => store.takeBrief('th:sam'),
    close() { operations.close(); client.close(); },
  };
}
