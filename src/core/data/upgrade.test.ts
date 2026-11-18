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
    // Both lists in the same order: names sort as words, so 10.sql comes before 2.sql.
    expect(readdirSync(shapes).sort()).toEqual(numbers.map(number => `${number}.sql`).sort());
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

  it('leaves earlier work in the house and accepts only a complete machine grant', () => {
    const old = household(13);
    old.exec(`INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot');
      INSERT INTO triggers (id, owner_kind, owner, source_kind, lifespan, target_kind, to_kind, "to", note, enabled, state, created_at, changed_at)
      VALUES ('wake', 'agent', 'art', 'time', 'once', 'inbox', 'agent', 'art', '', 1, 'standing', '${at}', '${at}');
      INSERT INTO jobs (id, agent, title, state, brief, model, started_by_kind, started_by, house_repository, house_file, house_branch, queued_at)
      VALUES ('job', 'art', '', 'queued', '', 'm', 'agent', 'art', '', '', '', '${at}')`);
    upgradeDataSchema(old);
    expect(old.prepare('SELECT machine, machine_approval, machine_words FROM triggers').get()).toEqual({ machine: null, machine_approval: null, machine_words: null });
    expect(old.prepare('SELECT machine FROM jobs').get()).toEqual({ machine: null });
    // Isolate the grant and digest checks from foreign-key enforcement.
    old.pragma('foreign_keys = OFF');
    const assign = old.prepare('UPDATE triggers SET machine = ?, machine_approval = ?, machine_words = ?');
    const digest = 'ab'.repeat(32);
    assign.run('box', null, null);
    assign.run('box', 'card', digest);
    for (const invalid of ['', digest.toUpperCase(), digest.slice(1), digest + '\0x'])
      expect(() => assign.run('box', 'card', invalid)).toThrow();
    expect(() => assign.run(null, 'card', digest)).toThrow();
    expect(() => assign.run('box', null, digest)).toThrow();
    expect(() => assign.run('box', 'card', null)).toThrow();
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

  it('keeps a populated private Comms thread intact when step 13 rebuilds conversations', () => {
    const old = household(12);
    old.exec(`INSERT INTO members (id, role, joined_at) VALUES ('sam', 'member', '${at}');
      INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot');
      INSERT INTO conversations (id, agent, member, venue, place, label, direct, started_at, last_at, turn_count)
        VALUES ('cv', 'art', 'sam', 'loom', 'th', 'Private', 1, '${at}', '${at}', 1);
      INSERT INTO threads (id, conversation, title, titled_by, pinned, opened_at, last_at, read_seq, working, stop_requested)
        VALUES ('th', 'cv', 'Private', 'member', 1, '${at}', '${at}', 1, 0, 0);
      INSERT INTO turns (conversation, seq, at, kind, from_kind, from_id) VALUES ('cv', 1, '${at}', 'message', 'person', 'sam');
      INSERT INTO messages (thread, seq, at, kind, sender, words, keep_until, client_id)
        VALUES ('th', 1, '${at}', 'message', 'sam', X'0012FFAA00', '2026-11-29T00:00:00.000Z', 'm1')`);
    const privateHistory = () => ['conversations', 'threads', 'messages', 'turns']
      .map(table => old.prepare(`SELECT * FROM ${table}`).all());
    const before = privateHistory();
    upgradeDataSchema(old);
    expect(privateHistory()).toEqual(before);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    expect(() => old.prepare("DELETE FROM conversations WHERE id = 'cv'").run()).toThrow('FOREIGN KEY');
  });

  it('backfills ended attempts at step 12, keeping unknown counters absent and queued attempts pending', () => {
    const old = household(11);
    old.exec(`INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot')`);
    const insert = old.prepare(`INSERT INTO jobs (id, agent, title, state, brief, model, started_by_kind, started_by, house_repository, house_file, house_branch, queued_at, claimed_at, ended_at)
      VALUES (?, 'art', '', ?, '', 'model', 'agent', 'art', '', '', '', ?, ?, ?)`);
    insert.run('ended', 'lost', at, at, '2026-11-15T00:00:00.071Z');
    insert.run('stopped', 'stopped', at, null, at);
    insert.run('queued', 'queued', at, null, null);
    upgradeDataSchema(old);
    expect(old.prepare('SELECT job, source, tokens_in, wall_ms FROM job_usage ORDER BY job').all()).toEqual([
      { job: 'ended', source: 'none', tokens_in: null, wall_ms: 71 },
      { job: 'stopped', source: 'none', tokens_in: null, wall_ms: null },
    ]);
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

  it('drops the stale first message of a kept file in step 9, and says who a trigger works for and whose an exit code is only where that is known', () => {
    const old = household(8);
    old.exec(`INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot');
      INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', '${at}'), ('kim', 'member', '${at}');
      INSERT INTO secrets (name, description, changed_at, changed_by) VALUES ('s', '', '${at}', 'sam');
      INSERT INTO bridge_connections (id, platform, agent, workspace, bot_user, token_secret, enabled, state, state_at) VALUES ('c', 'slack', 'art', 'w', 'bot', 's', 1, 'connected', '${at}');
      INSERT INTO bridge_incoming (id, connection, channel, is_dm, user, text, posted_at, received_at, state) VALUES ('m1', 'c', 'd', 1, 'u', '', '${at}', '${at}', 'delivered'), ('m2', 'c', 'r', 0, 'u', 'again', '${at}', '${at}', 'delivered');
      INSERT INTO bridge_files (connection, file, incoming, name, contents, fetched_at) VALUES ('c', 'F1', 'm1', 'a.txt', x'6869', '${at}');
      INSERT INTO bridge_file_messages (connection, file, incoming) VALUES ('c', 'F1', 'm2');
      INSERT INTO triggers (id, owner_kind, owner, source_kind, lifespan, target_kind, to_kind, "to", note, enabled, state, created_at, changed_at) VALUES
        ('kims', 'member', 'kim', 'time', 'once', 'inbox', 'agent', 'art', '', 1, 'standing', '${at}', '${at}'),
        ('sams', 'member', 'sam', 'time', 'once', 'inbox', 'agent', 'art', '', 1, 'standing', '${at}', '${at}'),
        ('own', 'agent', 'art', 'time', 'once', 'inbox', 'agent', 'art', '', 1, 'standing', '${at}', '${at}'),
        ('note', 'member', 'kim', 'time', 'once', 'inbox', 'person', 'kim', '', 1, 'standing', '${at}', '${at}');
      INSERT INTO jobs (id, agent, title, state, brief, model, started_by_kind, started_by, house_repository, house_file, house_branch, exit_code, ended_note, queued_at, claimed_at, ended_at) VALUES
        ('unplaced', 'art', '', 'failed', '', 'm', 'agent', 'art', 'r', 'f', 'b', 31, 'Never started: no machine took it within 6 hours', '${at}', NULL, '${at}'),
        ('ran-31', 'art', '', 'failed', '', 'm', 'agent', 'art', 'r', 'f', 'b', 31, NULL, '${at}', '${at}', '${at}'),
        ('ran-14', 'art', '', 'failed', '', 'm', 'agent', 'art', 'r', 'f', 'b', 14, NULL, '${at}', '${at}', '${at}'),
        ('ran-0', 'art', '', 'done', '', 'm', 'agent', 'art', 'r', 'f', 'b', 0, NULL, '${at}', '${at}', '${at}')`);
    upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
    // The file and its bytes are kept, under the one message that still lists it. The message it was first
    // fetched for, which had stopped listing it, is named nowhere and is not listed again.
    expect(old.prepare("SELECT name FROM pragma_table_info('bridge_files') ORDER BY name").all().map(row => (row as { name: string }).name)).toEqual(['connection', 'contents', 'fetched_at', 'file', 'name']);
    expect(old.prepare('SELECT connection, file, name, hex(contents) AS contents, fetched_at FROM bridge_files').all()).toEqual([{ connection: 'c', file: 'F1', name: 'a.txt', contents: '6869', fetched_at: at }]);
    expect(old.prepare('SELECT incoming FROM bridge_file_messages').all()).toEqual([{ incoming: 'm2' }]);
    // A link still needs a kept file, and a kept file with a link cannot be deleted from under it.
    expect(() => old.prepare("INSERT INTO bridge_file_messages (connection, file, incoming) VALUES ('c', 'F9', 'm2')").run()).toThrow('FOREIGN KEY');
    expect(() => old.prepare("DELETE FROM bridge_files WHERE file = 'F1'").run()).toThrow('FOREIGN KEY');
    // A member's trigger that puts an agent to work is for that member, as its firing read it before. Others are nobody's.
    expect(old.prepare('SELECT id, member FROM triggers ORDER BY id').all()).toEqual([{ id: 'kims', member: 'kim' }, { id: 'note', member: null }, { id: 'own', member: null }, { id: 'sams', member: 'sam' }]);
    expect(() => old.prepare("UPDATE triggers SET member = 'nobody' WHERE id = 'own'").run()).toThrow('FOREIGN KEY');
    // Only the job no machine took is known to be loom's code. A code a machine reported may have been anyone's.
    expect(old.prepare('SELECT id, exit_by FROM jobs ORDER BY id').all()).toEqual([{ id: 'ran-0', exit_by: null }, { id: 'ran-14', exit_by: null }, { id: 'ran-31', exit_by: null }, { id: 'unplaced', exit_by: 'loom' }]);
    expect(() => old.prepare("UPDATE jobs SET exit_by = 'harness' WHERE id = 'ran-14'").run()).toThrow('CHECK');
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

  it('adds the time a project was retired in step 10, empty on every project there is, and touches no row', () => {
    const old = household(9);
    old.exec(`INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot');
      INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', '${at}');
      INSERT INTO projects (id, name, removed_at) VALUES ('pond', 'Pond', NULL), ('shut', 'Shut', '${at}');
      INSERT INTO project_members (project, member) VALUES ('pond', 'sam');
      INSERT INTO project_agents (project, agent) VALUES ('pond', 'art');
      INSERT INTO tasks (id, title, owner_kind, project, status, assignee_kind, assignee, created_by_kind, created_by, created_at, changed_at) VALUES ('t-1', 'Pump', 'household', 'pond', 'in_progress', 'agent', 'art', 'member', 'sam', '${at}', '${at}')`);
    // Every table there is, projects first, so a step that touched any other row is seen. The schema number's own marks are the step's to add.
    const names = (old.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('projects', 'migrations') ORDER BY name").all() as { name: string }[]).map(row => row.name);
    expect(names.length).toBeGreaterThan(80);
    const rows = () => ['projects', ...names].map(table => old.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all());
    const before = rows();
    expect(old.prepare("SELECT name FROM pragma_table_info('projects')").all()).not.toContainEqual({ name: 'retired_at' });
    upgradeDataSchema(old, () => '2026-11-18T00:00:00.000Z');
    // The one new column, empty: no project is retired by upgrading, a removed one included.
    expect(old.prepare("SELECT name FROM pragma_table_info('projects') ORDER BY name").all().map(row => (row as { name: string }).name)).toEqual(['id', 'name', 'removed_at', 'retired_at']);
    expect(old.prepare('SELECT id, name, removed_at, retired_at FROM projects ORDER BY id').all()).toEqual([{ id: 'pond', name: 'Pond', removed_at: null, retired_at: null }, { id: 'shut', name: 'Shut', removed_at: at, retired_at: null }]);
    // Every row that was there is as it was: the projects without the new column, and what hangs off them whole.
    const after = rows();
    expect(after[0].map(row => { const { retired_at: _new, ...rest } = row as Record<string, unknown>; return rest; })).toEqual(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
    // It takes a UTC time or nothing, like removed_at; a project can be both retired and removed.
    expect(() => old.prepare("UPDATE projects SET retired_at = 'yesterday' WHERE id = 'pond'").run()).toThrow('CHECK');
    old.prepare("UPDATE projects SET retired_at = ? WHERE id IN ('pond', 'shut')").run(at);
    old.prepare("UPDATE projects SET retired_at = NULL WHERE id = 'pond'").run();
    expect(old.prepare('SELECT id, retired_at FROM projects ORDER BY id').all()).toEqual([{ id: 'pond', retired_at: null }, { id: 'shut', retired_at: at }]);
    expect(recogniseDataSchema(old)).toBe(dataSchemaNumber);
  });

  it('adds step 11\'s columns and tables, all empty, rebuilds bridge_sends with every row in every state carried across, and changes no row that was there', () => {
    const old = household(10);
    old.exec(`INSERT INTO agents (id, about, mark_bg, mark_fg, face_shape, face_eyes) VALUES ('art', '', '', '', 'pebble', 'dot');
      INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', '${at}');
      INSERT INTO secrets (name, description, changed_at, changed_by) VALUES ('bot', '', '${at}', 'sam');
      INSERT INTO bridge_connections (id, platform, agent, workspace, bot_user, token_secret, enabled, state, state_at) VALUES ('c', 'discord', 'art', 'guild', 'bot', 'bot', 1, 'connected', '${at}');
      INSERT INTO bridge_channels (platform, workspace, channel, answers, bots_may_talk) VALUES ('discord', 'guild', 'pond', 'art', 0), ('discord', 'guild', 'general', 'art', 1);
      INSERT INTO conversations (id, agent, venue, place, label, direct, started_at, last_at, turn_count) VALUES ('cv-1', 'art', 'discord', '["guild","pond",null]', 'pond', 0, '${at}', '${at}', 0);
      INSERT INTO bridge_incoming (id, connection, channel, is_dm, user, text, posted_at, received_at, delivered_at, state, conversation) VALUES ('bi:1', 'c', 'pond', 0, 'u', 'Hello', '${at}', '${at}', '${at}', 'delivered', 'cv-1');
      INSERT INTO bridge_sends (id, incoming, connection, channel, thread, text, state, created_at) VALUES ('s-1', 'bi:1', 'c', 'pond', NULL, 'Hi', 'sent', '${at}'),
        ('s-2', 'bi:1', 'c', 'pond', 'th', 'Two', 'pending', '${at}'), ('s-3', 'bi:1', 'c', 'pond', NULL, 'Three', 'held', '${at}'), ('s-4', 'bi:1', 'c', 'pond', NULL, 'Four', 'sending', '${at}'),
        ('s-5', 'bi:1', 'c', 'pond', 'th', 'Five', 'uncertain', '${at}'), ('s-6', 'bi:1', 'c', 'pond', NULL, 'Six', 'dismissed', '${at}');
      INSERT INTO bridge_send_parts (send, part, posted_id) VALUES ('s-1', 0, 'm-1'), ('s-5', 0, 'm-5')`);
    // Every table there is, the changed one first, so a step that touched any other row is seen.
    const names = (old.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('bridge_channels', 'migrations') ORDER BY name").all() as { name: string }[]).map(row => row.name);
    expect(names.length).toBeGreaterThan(80);
    const rows = () => [old.prepare('SELECT * FROM bridge_channels ORDER BY channel').all(), ...names.map(table => old.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all())];
    const before = rows();
    expect(names).not.toContain('bridge_send_files'); expect(names).not.toContain('conversation_sessions');
    upgradeDataSchema(old, () => '2026-11-18T00:00:00.000Z');
    // The one new column, empty: no channel gains a brief by upgrading.
    expect(old.prepare('SELECT channel, answers, bots_may_talk, brief FROM bridge_channels ORDER BY channel').all()).toEqual([
      { channel: 'general', answers: 'art', bots_may_talk: 1, brief: null }, { channel: 'pond', answers: 'art', bots_may_talk: 0, brief: null }]);
    const after = rows();
    // Every row of every table says what it said, once the columns the step added, all empty, are set aside.
    const added = ['brief', 'reports_to', 'conversation', 'asked_by_kind', 'asked_by', 'asked_at', 'on_word_kind', 'on_word', 'chain', 'chain_started_at'];
    const was = before.map(table => new Set(table.flatMap(row => Object.keys(row as object))));
    const without = after.map((table, index) => table.map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([name, value]) => was[index].has(name) || !(added.includes(name) && value === null)))));
    expect(without).toEqual(before);
    // The rebuilt table: six rows, one in each state, each as it was, none with a conversation, and what hangs off it still does.
    expect(old.prepare('SELECT id, incoming, thread, text, state, conversation FROM bridge_sends ORDER BY id').all()).toEqual([
      { id: 's-1', incoming: 'bi:1', thread: null, text: 'Hi', state: 'sent', conversation: null }, { id: 's-2', incoming: 'bi:1', thread: 'th', text: 'Two', state: 'pending', conversation: null },
      { id: 's-3', incoming: 'bi:1', thread: null, text: 'Three', state: 'held', conversation: null }, { id: 's-4', incoming: 'bi:1', thread: null, text: 'Four', state: 'sending', conversation: null },
      { id: 's-5', incoming: 'bi:1', thread: 'th', text: 'Five', state: 'uncertain', conversation: null }, { id: 's-6', incoming: 'bi:1', thread: null, text: 'Six', state: 'dismissed', conversation: null }]);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    // In the order they were queued: what was said is read back in that order (bridge-history.ts).
    expect((old.prepare('SELECT id FROM bridge_sends ORDER BY rowid').all() as { id: string }[]).map(row => row.id)).toEqual(['s-1', 's-2', 's-3', 's-4', 's-5', 's-6']);
    // A post that answers no message needs its conversation; one with neither is refused.
    old.prepare("INSERT INTO bridge_sends (id, incoming, connection, channel, conversation, text, state, created_at) VALUES ('s-7', NULL, 'c', 'pond', 'cv-1', 'Seven', 'held', ?)").run(at);
    expect(() => old.prepare("INSERT INTO bridge_sends (id, incoming, connection, channel, text, state, created_at) VALUES ('s-8', NULL, 'c', 'pond', 'Eight', 'held', ?)").run(at)).toThrow('CHECK');
    old.prepare("DELETE FROM bridge_sends WHERE id = 's-7'").run();
    expect(() => old.prepare("INSERT INTO bridge_send_files (send, position, name, contents) VALUES ('none', 0, 'a', x'00')").run()).toThrow('FOREIGN');
    // The two new tables, empty, keyed as stated and tied to what they hang off.
    expect(old.prepare('SELECT count(*) AS n FROM bridge_send_files').get()).toEqual({ n: 0 });
    expect(old.prepare('SELECT count(*) AS n FROM conversation_sessions').get()).toEqual({ n: 0 });
    old.prepare("INSERT INTO bridge_send_files (send, position, name, contents) VALUES ('s-1', 0, 'plot.png', x'00ff')").run();
    expect(() => old.prepare("INSERT INTO bridge_send_files (send, position, name, contents) VALUES ('s-1', 0, 'again.png', x'00')").run()).toThrow('UNIQUE');
    expect(() => old.prepare("INSERT INTO bridge_send_files (send, position, name, contents) VALUES ('no-such-send', 0, 'x', x'00')").run()).toThrow('FOREIGN KEY');
    old.prepare("INSERT INTO conversation_sessions (conversation, harness, session, files, bytes, started_at) VALUES ('cv-1', 'claude', 'abc', x'00', 1, ?)").run(at);
    // One session for a conversation and harness; another harness has its own.
    expect(() => old.prepare("INSERT INTO conversation_sessions (conversation, harness, session, files, bytes, started_at) VALUES ('cv-1', 'claude', 'def', x'00', 1, ?)").run(at)).toThrow('UNIQUE');
    old.prepare("INSERT INTO conversation_sessions (conversation, harness, session, files, bytes, started_at) VALUES ('cv-1', 'codex', 'def', x'00', 1, ?)").run(at);
    expect(() => old.prepare("INSERT INTO conversation_sessions (conversation, harness, session, files, bytes, started_at) VALUES ('cv-1', 'agy', 'x', x'00', 1, 'yesterday')").run()).toThrow('CHECK');
    expect(() => old.prepare("INSERT INTO conversation_sessions (conversation, harness, session, files, bytes, started_at) VALUES ('cv-none', 'claude', 'x', x'00', 1, ?)").run(at)).toThrow('FOREIGN KEY');
    old.prepare("UPDATE bridge_channels SET brief = 'onterris' WHERE channel = 'pond'").run();
    expect(recogniseDataSchema(old)).toBe(dataSchemaNumber);
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
  }, 120_000); // every start to every later number: the pairs grow with each schema number, and 13 of them pass 20 seconds on a loaded runner

  it('recognises a readable household without opening it for writing', () => {
    const old = household(2), before = everything(old);
    old.pragma('query_only = ON');
    expect(recogniseDataSchema(old)).toBe(2);
    expect(everything(old)).toEqual(before);
  });
});
