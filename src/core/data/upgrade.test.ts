import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDataSchema, dataSchemaNumber, dataSchemaShape, recogniseDataSchema, upgradeDataSchema } from './database.js';

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

  it('recognises a readable household without opening it for writing', () => {
    const old = household(2), before = everything(old);
    old.pragma('query_only = ON');
    expect(recogniseDataSchema(old)).toBe(2);
    expect(everything(old)).toEqual(before);
  });
});
