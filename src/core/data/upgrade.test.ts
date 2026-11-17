import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { applyUpgrades, createDataSchema, dataSchemaNumber, dataSchemaShape, recogniseDataSchema, upgradeDataSchema } from './database.js';

// The installation SQL exactly as each schema number shipped it, recovered from history and never edited.
// Adding upgrade step N+1 means checking today's assets/data/schema.sql in here as N+1.sql.
const shapes = new URL('./shipped-shapes/', import.meta.url);
const shipped = (number: number) => readFileSync(new URL(`${number}.sql`, shapes), 'utf8');
const installation = readFileSync(new URL('../../../assets/data/schema.sql', import.meta.url), 'utf8');
const numbers = Array.from({ length: dataSchemaNumber }, (_, index) => index + 1);
const at = '2026-11-15T00:00:00.000Z';

const opened: Database.Database[] = [];
afterEach(() => { for (const client of opened.splice(0)) client.close(); });
function open() { const client = new Database(':memory:'); client.pragma('foreign_keys = ON'); opened.push(client); return client; }
function fresh() { const client = open(); createDataSchema(client, () => at); return client; }
/** A household as the program at that schema number installed it. */
function household(number: number) {
  const client = open(); client.exec(shipped(number));
  const mark = client.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)');
  for (let step = 1; step <= number; step++) mark.run(step, at);
  return client;
}
const everything = (client: Database.Database) => client.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY rowid').all();

describe('upgrading a household database', () => {
  it('has the installation SQL of every shipped schema number, the newest being today\'s', () => {
    expect(readdirSync(shapes).sort()).toEqual(numbers.map(number => `${number}.sql`));
    // A change to the schema with no upgrade step fails here: the newest pinned shape is no longer what is installed.
    expect(shipped(dataSchemaNumber)).toBe(installation);
  });

  it.each(numbers)('brings a household installed at schema %i to exactly the shape of a fresh one', number => {
    const old = household(number);
    upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
    // Columns, defaults, keys, foreign keys with their actions, CHECKs, and each index and trigger as written, for every table.
    expect(dataSchemaShape(old)).toEqual(dataSchemaShape(fresh()));
    expect(old.prepare('SELECT number FROM migrations ORDER BY number').all()).toEqual(numbers.map(n => ({ number: n })));
    expect(old.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps existing rows, enforces the new rules on them, and does nothing the second time', () => {
    const old = household(1);
    expect(old.prepare("SELECT name FROM pragma_table_info('members')").all()).not.toContainEqual({ name: 'removed_at' });
    old.prepare("INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', ?)").run(at);
    upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
    expect(old.prepare('SELECT id, role, removed_at FROM members').all()).toEqual([{ id: 'sam', role: 'owner', removed_at: null }]);
    expect(() => old.prepare("UPDATE members SET removed_at = 'yesterday'").run()).toThrow();
    const before = everything(old);
    upgradeDataSchema(old);
    expect(everything(old)).toEqual(before);
    expect(old.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: dataSchemaNumber });
    const made = fresh(); upgradeDataSchema(made);
    expect(made.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: dataSchemaNumber });
  });

  it('rebuilds conversations in step 6 with every row and everything that points at them kept', () => {
    const old = household(5);
    old.exec(`INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot');
      INSERT INTO conversations (id, agent, venue, place, label, started_at, last_at, turn_count) VALUES ('room', 'art', 'discord', 'r', 'room', '${at}', '${at}', 1), ('dm', 'art', 'discord', 'd', 'dm', '${at}', '${at}', 1);
      INSERT INTO jobs (id, agent, conversation, title, state, brief, model, started_by_kind, started_by, house_repository, house_file, house_branch, queued_at) VALUES ('job', 'art', 'room', 't', 'running', '', 'm', 'agent', 'art', 'r', 'f', 'b', '${at}');
      UPDATE conversations SET job = 'job' WHERE id = 'room';
      INSERT INTO turns (conversation, seq, at, kind, from_kind) VALUES ('room', 1, '${at}', 'message', 'unknown'), ('dm', 1, '${at}', 'message', 'unknown');
      INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', '${at}');
      INSERT INTO secrets (name, description, changed_at, changed_by) VALUES ('s', '', '${at}', 'sam');
      INSERT INTO bridge_connections (id, platform, agent, workspace, bot_user, token_secret, enabled, state, state_at) VALUES ('c', 'discord', 'art', 'w', 'bot', 's', 1, 'connected', '${at}');
      INSERT INTO bridge_incoming (id, connection, channel, is_dm, user, text, posted_at, received_at, state, conversation) VALUES ('m1', 'c', 'd', 1, 'u', 'hi', '${at}', '${at}', 'delivered', 'dm'), ('m2', 'c', 'r', 0, 'u', 'hi', '${at}', '${at}', 'delivered', 'room');
      INSERT INTO bridge_resume (connection, session, sequence, resume_url) VALUES ('c', 'session', 4, 'wss://resume')`);
    upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
    expect(old.prepare('SELECT id, direct, turn_count FROM conversations ORDER BY id').all()).toEqual([{ id: 'dm', direct: 1, turn_count: 1 }, { id: 'room', direct: 0, turn_count: 1 }]);
    expect(old.prepare('SELECT count(*) AS n FROM turns').get()).toEqual({ n: 2 });
    expect(old.prepare('SELECT conversation FROM jobs').get()).toEqual({ conversation: 'room' });
    // A message from before the step has no admission fields; a cursor from before names no credential and is gone.
    expect(old.prepare("SELECT mentions, bot FROM bridge_incoming WHERE id = 'm1'").get()).toEqual({ mentions: null, bot: null });
    expect(old.prepare('SELECT count(*) AS n FROM bridge_resume').get()).toEqual({ n: 0 });
    // Foreign keys are enforced again afterwards, on the rebuilt table and towards it.
    expect(old.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => old.prepare("INSERT INTO turns (conversation, seq, at, kind, from_kind) VALUES ('nowhere', 1, ?, 'message', 'unknown')").run(at)).toThrow('FOREIGN KEY');
    expect(() => old.prepare("DELETE FROM conversations WHERE id = 'room'").run()).toThrow('FOREIGN KEY');
  });

  it('rebuilds jobs in step 7 with every row kept, moves loom\'s own lines out of the log tail, and carries each posted reply to its parts', () => {
    const old = household(6); old.function('loom_now', () => at);
    const job = (id: string, state: string, rest = '') => `INSERT INTO jobs (id, agent, conversation, title, state, brief, model, started_by_kind, started_by, house_repository, house_file, house_branch, queued_at${rest ? ', ' + rest.split('=')[0] : ''}) VALUES ('${id}', 'art', ${id === 'waits' ? "'room'" : 'NULL'}, 't', '${state}', '', 'm', 'agent', 'art', 'r', 'f', 'b', '${at}'${rest ? ', ' + rest.split('=')[1] : ''})`;
    old.exec(`INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot');
      INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', '${at}');
      INSERT INTO conversations (id, agent, venue, place, label, started_at, last_at, turn_count) VALUES ('room', 'art', 'discord', 'r', 'room', '${at}', '${at}', 1);
      ${job('waits', 'waiting')}; ${job('ran', 'failed', "log_tail='its own output'")}; ${job('gone', 'lost', "log_tail='Lost while running: its worker stopped reporting'")};
      ${job('never', 'failed', "log_tail='Never started: no machine took it within 24 hours'")}; UPDATE jobs SET exit_code = 31 WHERE id = 'never';
      ${job('again', 'queued', "retry_of='gone'")};
      INSERT INTO job_needs (job, need) VALUES ('waits', 'gpu');
      INSERT INTO tokens (fingerprint, label, kind, member, created_at) VALUES ('fp', 'sam', 'owner', 'sam', '${at}');
      INSERT INTO sessions (id, token, device, via, is_agent, issued_at, seen_at, proved_at) VALUES ('browser', 'fp', 'Chrome', 'link', 0, '${at}', '${at}', '${at}');
      INSERT INTO signin_links (id, token, label, expires_at) VALUES ('link', 'fp', 'sam', '${at}');
      INSERT INTO secrets (name, description, changed_at, changed_by) VALUES ('s', '', '${at}', 'sam');
      INSERT INTO bridge_connections (id, platform, agent, workspace, bot_user, token_secret, enabled, state, state_at) VALUES ('c', 'discord', 'art', 'w', 'bot', 's', 1, 'connected', '${at}');
      INSERT INTO bridge_incoming (id, connection, channel, is_dm, user, text, posted_at, received_at, state, conversation) VALUES ('m', 'c', 'r', 0, 'u', 'hi', '${at}', '${at}', 'delivered', 'room');
      INSERT INTO bridge_sends (id, incoming, connection, channel, text, state, posted_id, created_at) VALUES ('out', 'm', 'c', 'r', 'hello', 'sent', 'posted-1', '${at}'), ('queued', 'm', 'c', 'r', 'later', 'pending', NULL, '${at}')`);
    upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
    // No program ever wrote `waiting`; a row that has it was running. loom's own lines are no runner's output.
    expect(old.prepare('SELECT id, state, log_tail, ended_note, retry_of FROM jobs ORDER BY id').all()).toEqual([
      { id: 'again', state: 'queued', log_tail: null, ended_note: null, retry_of: 'gone' },
      { id: 'gone', state: 'lost', log_tail: null, ended_note: 'Lost while running: its worker stopped reporting', retry_of: null },
      { id: 'never', state: 'failed', log_tail: null, ended_note: 'Never started: no machine took it within 24 hours', retry_of: null },
      { id: 'ran', state: 'failed', log_tail: 'its own output', ended_note: null, retry_of: null },
      { id: 'waits', state: 'running', log_tail: null, ended_note: null, retry_of: null },
    ]);
    expect(() => old.prepare("UPDATE jobs SET state = 'waiting' WHERE id = 'waits'").run()).toThrow('CHECK');
    expect(() => old.prepare("UPDATE jobs SET ended_reason = 'stop' WHERE id = 'ran'").run()).not.toThrow();
    // Still one unended job to a conversation, and everything that points at a job still does.
    expect(() => old.prepare("UPDATE jobs SET conversation = 'room' WHERE id = 'again'").run()).toThrow('UNIQUE');
    expect(() => old.prepare("DELETE FROM jobs WHERE id = 'waits'").run()).toThrow('FOREIGN KEY');
    expect(() => old.prepare("INSERT INTO job_needs (job, need) VALUES ('nowhere', 'gpu')").run()).toThrow('FOREIGN KEY');
    // A reply posted before the step has the one id that was kept, as its first part.
    expect(old.prepare('SELECT send, part, posted_id FROM bridge_send_parts').all()).toEqual([{ send: 'out', part: 0, posted_id: 'posted-1' }]);
    expect(old.prepare("SELECT name FROM pragma_table_info('bridge_sends')").all()).not.toContainEqual({ name: 'posted_id' });
    // A link from before cannot say which browser made it, so it is not kept; the browser is.
    expect(old.prepare('SELECT count(*) AS n FROM signin_links').get()).toEqual({ n: 0 });
    expect(old.prepare('SELECT id, made_by FROM sessions').all()).toEqual([{ id: 'browser', made_by: null }]);
  });

  it('links each kept Slack file to its message in step 8 and removes the receipts that held a sign-in code', () => {
    const old = household(7);
    old.exec(`INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot');
      INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', '${at}');
      INSERT INTO secrets (name, description, changed_at, changed_by) VALUES ('s', '', '${at}', 'sam');
      INSERT INTO bridge_connections (id, platform, agent, workspace, bot_user, token_secret, enabled, state, state_at) VALUES ('c', 'slack', 'art', 'w', 'bot', 's', 1, 'connected', '${at}');
      INSERT INTO bridge_incoming (id, connection, channel, is_dm, user, text, posted_at, received_at, state) VALUES ('m1', 'c', 'r', 0, 'u', 'hi', '${at}', '${at}', 'delivered'), ('m2', 'c', 'r', 0, 'u', 'again', '${at}', '${at}', 'delivered');
      INSERT INTO bridge_files (connection, file, incoming, name, contents, fetched_at) VALUES ('c', 'F1', 'm1', 'a.txt', x'6869', '${at}'), ('c', 'F2', 'm2', 'b.txt', x'6869', '${at}');
      INSERT INTO operation_results (caller, id, operation, input_hash, result, expires_at) VALUES ('worker', 'old', 'runtime.signInCode', 'x', x'7b7d', '2999-01-01T00:00:00.000Z'), ('worker', 'kept', 'runtime.signInDone', 'x', x'7b7d', '2999-01-01T00:00:00.000Z')`);
    upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
    expect(old.prepare('SELECT connection, file, incoming FROM bridge_file_messages ORDER BY file').all()).toEqual([{ connection: 'c', file: 'F1', incoming: 'm1' }, { connection: 'c', file: 'F2', incoming: 'm2' }]);
    expect(old.prepare('SELECT count(*) AS n FROM bridge_files').get()).toEqual({ n: 2 });
    // The same file can now be listed under a second message; a link to a file that is not kept is refused.
    old.prepare("INSERT INTO bridge_file_messages (connection, file, incoming) VALUES ('c', 'F1', 'm2')").run();
    expect(() => old.prepare("INSERT INTO bridge_file_messages (connection, file, incoming) VALUES ('c', 'F9', 'm2')").run()).toThrow('FOREIGN KEY');
    expect(old.prepare('SELECT id FROM operation_results').all()).toEqual([{ id: 'kept' }]);
  });

  it('refuses to upgrade over a record whose member or agent is gone, and changes nothing', () => {
    // Step 6 puts guards on who edited a trigger. Before it nothing stopped that member's row being deleted,
    // and SQLite's own check does not see a kind-and-id reference.
    const old = household(5);
    old.exec(`INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', '${at}');
      INSERT INTO triggers (id, owner_kind, source_kind, lifespan, target_kind, target, note, enabled, state, created_at, changed_at) VALUES ('t', 'household', 'time', 'once', 'operation', 'op', '', 1, 'standing', '${at}', '${at}');
      INSERT INTO trigger_edits (trigger, at, by_kind, by, before) VALUES ('t', '${at}', 'member', 'sam', '{}');
      DELETE FROM members WHERE id = 'sam'`);
    const before = everything(old);
    expect(() => upgradeDataSchema(old)).toThrow('trigger_edits.by names a member that is not there');
    expect(everything(old)).toEqual(before);
    expect(old.prepare('SELECT max(number) AS n FROM migrations').get()).toEqual({ n: 5 });
    // Put right, the same database upgrades.
    old.prepare("INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', ?)").run(at);
    upgradeDataSchema(old);
    expect(old.prepare('SELECT max(number) AS n FROM migrations').get()).toEqual({ n: dataSchemaNumber });
  });

  it('refuses a database from a newer program', () => {
    const made = fresh();
    made.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)').run(dataSchemaNumber + 1, at);
    expect(() => upgradeDataSchema(made)).toThrow('newer program');
  });

  // Each of these carries a `migrations` table with a believable number, which is all the old check asked for.
  it.each<[string, (client: Database.Database) => void]>([
    ['a foreign database that happens to have a migrations table', client => {
      client.exec("CREATE TABLE migrations (number integer PRIMARY KEY, applied_at text); INSERT INTO migrations VALUES (1, 'then'); CREATE TABLE members (id text PRIMARY KEY, precious text); CREATE TABLE triggers (id text)");
    }],
    ['an interim household with a table this program never made', client => {
      client.exec(shipped(1)); client.prepare('INSERT INTO migrations VALUES (1, ?)').run(at); client.exec('CREATE TABLE interim_notes (words text)');
    }],
    ['a household whose column was altered by hand', client => {
      client.exec(shipped(2).replace('`role` text NOT NULL', '`role` text')); for (const n of [1, 2]) client.prepare('INSERT INTO migrations VALUES (?, ?)').run(n, at);
    }],
    ['a household that lost a CHECK', client => {
      client.exec(shipped(4).replace(/\tCONSTRAINT "members_role_choice" CHECK\([^\n]*\n/, '').replace(/,\n\);/g, '\n);')); for (const n of [1, 2, 3, 4]) client.prepare('INSERT INTO migrations VALUES (?, ?)').run(n, at);
    }],
    ['a household whose foreign key acts differently', client => {
      client.exec(shipped(3).replace('REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action', 'REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE cascade')); for (const n of [1, 2, 3]) client.prepare('INSERT INTO migrations VALUES (?, ?)').run(n, at);
    }],
    ['a household marked with a number it skipped to', client => {
      client.exec(shipped(1)); for (const n of [1, 3]) client.prepare('INSERT INTO migrations VALUES (?, ?)').run(n, at);
    }],
    ['a household already at this number with a dropped index', client => {
      createDataSchema(client, () => at); client.exec('DROP INDEX `trigger_edits_trigger_idx`');
    }],
  ])('refuses %s and changes nothing in it', (_, build) => {
    const client = open(); build(client);
    const before = everything(client), marks = client.prepare('SELECT * FROM migrations ORDER BY number').all();
    expect(() => recogniseDataSchema(client)).toThrow('separate move');
    expect(() => upgradeDataSchema(client)).toThrow('separate move');
    expect(everything(client)).toEqual(before);
    expect(client.prepare('SELECT * FROM migrations ORDER BY number').all()).toEqual(marks);
  });

  // Steps 6 and 7 rebuild or drop these tables, so a change made to one by hand is gone from the rehearsed
  // result. Only the database as it is, held against the pinned shape of its number, shows it.
  it.each<[string, number, string]>([
    ['an extra column on jobs, which step 7 rebuilds', 6, 'ALTER TABLE jobs ADD COLUMN precious text'],
    ['an extra column on conversations, which step 6 rebuilds', 5, 'ALTER TABLE conversations ADD COLUMN precious text'],
    ['an extra index on jobs', 6, 'CREATE INDEX jobs_by_hand ON jobs (title)'],
    ['an extra column on a table step 6 drops', 5, 'ALTER TABLE outside_effects ADD COLUMN precious text'],
    ['an extra column on a table step 6 drops and makes again', 4, 'ALTER TABLE bridge_resume ADD COLUMN precious text'],
    ['a trigger on a table step 7 rebuilds', 3, "CREATE TRIGGER jobs_by_hand BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'kept'); END"],
  ])('refuses an older household with %s, before any step, and changes nothing in it', (_, number, alter) => {
    const old = household(number); old.exec(alter);
    const before = everything(old), marks = old.prepare('SELECT * FROM migrations ORDER BY number').all();
    expect(() => recogniseDataSchema(old)).toThrow('separate move');
    expect(() => upgradeDataSchema(old)).toThrow('separate move');
    expect(everything(old)).toEqual(before);
    expect(old.prepare('SELECT * FROM migrations ORDER BY number').all()).toEqual(marks);
  });

  it('gives a household that reached a number by steps exactly the pinned shape of that number', () => {
    // Recognition holds a database to the pinned shape of its own number. A household installed earlier and
    // upgraded since got there by the steps, so every step from every start must land on the pinned shape.
    for (const from of numbers) for (const to of numbers.filter(number => number > from)) {
      const old = household(from);
      old.pragma('foreign_keys = OFF'); applyUpgrades(old, from, () => at, to);
      const pinned = open(); pinned.exec(shipped(to));
      expect(dataSchemaShape(old), `installed at ${from}, upgraded to ${to}`).toEqual(dataSchemaShape(pinned));
      if (to < dataSchemaNumber) expect(recogniseDataSchema(old)).toBe(to);
    }
  });

  it('recognises a readable household without opening it for writing', () => {
    const old = household(2), before = everything(old);
    old.pragma('query_only = ON');
    expect(recogniseDataSchema(old)).toBe(2);
    expect(everything(old)).toEqual(before);
  });
});
