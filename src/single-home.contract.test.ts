/** Rules that were once copied from file to file, each now stated in one place. These fail when a copy comes back. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { agentInput, settingsInput } from './apps/household.js';
import { COMMIT, mergeTargetFor, parseMergeTarget } from './apps/merge-target.js';
import { COMMS_DAYS_MAX, commsKeepDays } from './core/data/comms-days.js';
import { keepUntilFor, validKeepDays, wordsDeadline, wordsKept } from './core/conversations/retention.js';
import { createDataSchema } from './core/data/database.js';
import { privateOrigin } from './core/private-origin.js';
import { agents, household, measuringSettings, members, tempoSettings } from './core/data/schema.js';
import { DEFAULT_MEASURING, KEEP_DAYS_MAX, validKeepDays as validMeasuringDays } from './core/measuring/index.js';
import { measuringValues } from './core/measuring/change.js';
import { defaultTimings, readTimings } from './core/tempo/volume.js';
import { DEFAULT_STALE_DAYS, fieldState, freshUntil } from './backends/cards.js';
import { MAX_SLUG } from './backends/people.js';
import { MAX_PROJECT_SLUG } from './backends/projects.js';
import { secretAgent } from './pieces/secrets/input.js';
import { isHolderGeneration } from './pieces/secrets/role.js';
import { isDiscordId } from './pieces/bridges/discord-id.js';
import { HH_MM } from './core/tempo/calendar.js';
import { SECRET_USE_ID, secretUseId } from './pieces/secrets/use-id.js';
import { BUILD_DEADLINE_MAX_MS, ENV_NAME, STEP_DEADLINE_MAX_MS, validDeadline } from './runtime/worker-limits.js';
import { HOUSEHOLD_ID_MAX, PERSON_CARD_SLUG_MAX, PROJECT_CARD_SLUG_MAX, SCOPED_MEMORY_ID, SLUG, STORE_ID, householdId, scopedStoreId, slug } from './slug.js';
import { MEMORY_CATEGORIES } from './categories.js';
import { DAY } from './core/day.js';
import { BODY_REQUEST_MAX_MS, BODY_REQUEST_MS, validBodyRequestMs } from './runtime/body-request-time.js';
import { LOGIN_PATH, SHA256_HEX } from './core/sha256-hex.js';
import { QUIET_DAYS_MAX, SETTLE_SECONDS_MAX, validTimings } from './core/tempo/volume.js';
import { LIFESPAN_DAYS, LIFESPAN_NAMES, NOTE_PATH_MAX } from './notes.js';
import { GRANT_MINUTES_MAX, agentSecretRequest, grantMinutes, houseSecretAlias, isHouseSecretAlias } from './pieces/secrets/input.js';
import { houseSecretsInput } from './shared-secret-commands.js';
import { PRIVATE_SECRET_TIMEOUT_MS, privateSecretClient } from './pieces/secrets/private-client.js';
import { secretAnswer, secretRuleInput } from './pieces/secrets/requests.js';
import { householdService } from './apps/household.js';
import { AgentFiles } from './pieces/mind/sources.js';
import { dangerousHouseholdChanges, householdChanges } from './shared-household-proposals.js';
import { householdMemorySources } from './shared-memory.js';
import { householdSettings } from './core/data/household-settings.js';
import { secretRules } from './core/data/schema.js';

const root = new URL('../', import.meta.url).pathname;
const sources = (directory: string): string[] => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(directory, entry.name))
    : /\.ts$/.test(entry.name) && !/\.(test|fixture)\.ts$/.test(entry.name) ? [join(directory, entry.name)] : []);
const text = (file: string) => readFileSync(join(root, file), 'utf8');

it('writes the slug pattern once, and keeps each length with its name', () => {
  // Either spelling of the group; the program's own sources only (the app's forms are checked below).
  const copies = sources('src').filter(file => /\[a-z0-9\]\+\((\?:)?-\[a-z0-9\]\+\)\*/.test(text(file)));
  expect(copies).toEqual(['src/slug.ts']);
  for (const good of ['a', 'art', 'on-pond', '2fast', 'a-1-b']) expect(SLUG.test(good), good).toBe(true);
  for (const bad of ['', 'A', '-a', 'a-', 'a--b', 'a_b', 'a b']) expect(SLUG.test(bad), bad).toBe(false);
  // Three things are named by a slug, and they are not the same length. A change to one is a decision, made here.
  expect([HOUSEHOLD_ID_MAX, PERSON_CARD_SLUG_MAX, PROJECT_CARD_SLUG_MAX]).toEqual([100, 64, 32]);
  expect([MAX_SLUG, MAX_PROJECT_SLUG]).toEqual([PERSON_CARD_SLUG_MAX, PROJECT_CARD_SLUG_MAX]);
  expect(householdId.safeParse('a'.repeat(100)).success).toBe(true);
  expect(householdId.safeParse('a'.repeat(101)).success).toBe(false);
  expect(slug(PROJECT_CARD_SLUG_MAX).safeParse('a'.repeat(33)).success).toBe(false);
  // The commands that write a card take the card's cap by name: no door gives a slug a number of its own.
  expect(sources('src').filter(file => /slug:\s*z\.string\(\)(\.min\(\d+\))?\.max\((64|32)\)/.test(text(file)))).toEqual([]);
  // A secret's agent is a household agent: the same rule, not a second one.
  expect(secretAgent).toBe(householdId);
});

it('shows the same slug rule in the app\'s forms as the program enforces', () => {
  for (const file of ['web/src/pieces/household/index.tsx', 'web/src/pieces/sharing/index.tsx']) {
    // The form's pattern is a hint to the person typing; the program decides. A cap, where a form gives one, is the id's.
    const fields = [...text(file).matchAll(/pattern="(\[a-z0-9\][^"]*)"(?: maxLength=\{(\d+)\})?/g)];
    expect(fields.length, file).toBeGreaterThan(0);
    for (const [, pattern, cap] of fields) {
      expect(pattern, file).toBe(SLUG.source.slice(1, -1));
      if (cap !== undefined) expect(Number(cap), file).toBe(HOUSEHOLD_ID_MAX);
    }
  }
});

it('reads how long Comms keeps words in one place, with the database\'s own default', () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client, () => '2026-11-16T00:00:00.000Z');
    expect(commsKeepDays(db)).toBe(household.commsDays.default);
    db.insert(household).values({ commsDays: 3 }).run();
    expect(commsKeepDays(db)).toBe(3);
  } finally { client.close(); }
  expect(settingsInput.safeParse({ commsDays: COMMS_DAYS_MAX }).success).toBe(true);
  expect(settingsInput.safeParse({ commsDays: COMMS_DAYS_MAX + 1 }).success).toBe(false);
  const copies = sources('src').filter(file => file !== 'src/core/data/comms-days.ts' && /comms_?[dD]ays\s*\?\?\s*\d|\.days\s*\?\?\s*\d/.test(text(file)));
  expect(copies).toEqual([]);
});

it('checks a Comms keep time, and works out when words stop being kept, in one place', () => {
  // The column's check is a second statement of the range, in SQL. It and the constant must agree.
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client, () => '2026-11-16T00:00:00.000Z');
    db.insert(household).values({ commsDays: COMMS_DAYS_MAX }).run();
    for (const [days, allowed] of [[1, true], [COMMS_DAYS_MAX, true], [0, false], [COMMS_DAYS_MAX + 1, false]] as const) {
      const set = () => db.update(household).set({ commsDays: days }).run();
      if (allowed) set(); else expect(set, String(days)).toThrow(/household_comms_days_range/);
      expect(validKeepDays(days), String(days)).toBe(allowed);
    }
  } finally { client.close(); }
  expect(validKeepDays(1.5)).toBe(false);
  const message = { at: '2026-11-01T00:00:00.000Z', keepUntil: '2026-11-04T00:00:00.000Z' };
  // The earlier of the stamped limit and the current age limit; nothing is kept under a keep time that is not valid.
  expect(wordsDeadline(message, 14)).toBe(Date.parse(message.keepUntil));
  expect(wordsDeadline(message, 2)).toBe(Date.parse('2026-11-03T00:00:00.000Z'));
  expect(wordsKept(message, 2, '2026-11-02T23:59:59.999Z')).toBe(true);
  expect(wordsKept(message, 2, '2026-11-03T00:00:00.000Z')).toBe(false);
  expect(wordsKept(message, COMMS_DAYS_MAX + 1, '2026-11-01T00:00:01.000Z')).toBe(false);
  expect(wordsKept({ ...message, keepUntil: null }, 2, '2026-11-01T00:00:01.000Z')).toBe(false);
  expect(keepUntilFor(message.at, 3)).toBe(message.keepUntil);
  // No reader compares a keep time with a number of its own, or multiplies days into milliseconds itself.
  const own = /\b(days|keep|count)\s*(<=?|>=?)\s*\d|\b(days|keep)\s*\*\s*86_?400_?000/;
  const copies = sources('src/core/conversations').filter(file => file !== 'src/core/conversations/retention.ts' && own.test(text(file)));
  expect(copies).toEqual([]);
});

it('takes an agent\'s face choices from the schema, and the app draws the same ones', () => {
  const agent = { id: 'art', about: '', markBg: '#000000', markFg: '#ffffff' };
  for (const faceShape of agents.faceShape.enumValues) for (const faceEyes of agents.faceEyes.enumValues)
    expect(agentInput.safeParse({ ...agent, faceShape, faceEyes }).success).toBe(true);
  expect(agentInput.safeParse({ ...agent, faceShape: 'square', faceEyes: 'dot' }).success).toBe(false);
  const face = text('web/src/face.tsx');
  const list = (name: string) => JSON.parse((new RegExp(`export const ${name}: \\w+\\[\\] = (\\[[^\\]]*\\])`).exec(face)?.[1] ?? '[]').replaceAll("'", '"'));
  expect(list('SHAPES')).toEqual([...agents.faceShape.enumValues]);
  expect(list('EYES')).toEqual([...agents.faceEyes.enumValues]);
});

it('names the door\'s request limit once', () => {
  // The door's three ways in and the clients that send to it. The number is written in the first file only.
  const door = ['src/core/data/door-limit.ts', 'src/core/data/http.ts', 'src/core/data/socket.ts', 'src/shared-root.ts', 'src/cli/shared-task-client.ts',
    'src/runtime/worker-http.ts', 'src/runtime/body-command-client.ts', 'src/runtime/conversation-client.ts'];
  expect(door.filter(file => /1024 \* 1024|1_048_576|1048576/.test(text(file)))).toEqual(['src/core/data/door-limit.ts']);
  for (const file of door) expect(text(file), file).toContain('DOOR_REQUEST_BYTES');
});

it('states the shape of a body\'s token once, where it is made', () => {
  // The worker makes it and the body checks what it was handed; both read the one pattern and length.
  const shapes = sources('src').filter(file => /body_\[a-f0-9\]|'body_'/.test(text(file)));
  expect(shapes).toEqual(['src/runtime/body-token.ts']);
  for (const file of ['src/runtime/worker-http.ts', 'src/runtime/body-bootstrap.ts', 'src/runtime/body-program.ts']) expect(text(file), file).toContain("from './body-token.js'");
});

it('states how much earlier talk a body is handed once', () => {
  for (const file of ['src/core/conversations/history-context.ts', 'src/runtime/conversation-client.ts']) expect(text(file), file).toContain('HISTORY_BYTES');
});

it('decides whether a card field is stale in one place', () => {
  const field = { verified_at: '2026-11-01T00:00:00.000Z' }, checked = Date.parse(field.verified_at), day = 86400000;
  expect(freshUntil(field)).toBe(checked + DEFAULT_STALE_DAYS * day);
  expect(freshUntil({ ...field, stale_after_days: 2 })).toBe(checked + 2 * day);
  expect(freshUntil({})).toBeUndefined();
  // Strictly after: the last fresh moment is still fresh.
  expect(fieldState(field, freshUntil(field)!).kind).toBe('ok');
  expect(fieldState(field, freshUntil(field)! + 1)).toEqual({ kind: 'stale', days: DEFAULT_STALE_DAYS });
  expect(fieldState({}, checked).kind).toBe('unverified');
  // The door's People and Projects reads use it; none carries the default or the comparison itself.
  const copies = sources('src').filter(file => file !== 'src/backends/cards.ts' && /stale_after_days\s*\?\?/.test(text(file)));
  expect(copies).toEqual([]);
});

it('checks an address a credential is sent to in one place', () => {
  for (const good of ['https://loom.example', 'https://loom.example:8443/', 'http://localhost:7777', 'http://127.0.0.1:7777', 'http://[::1]:7777'])
    expect(privateOrigin(good).origin, good).toBe(new URL(good).origin);
  for (const bad of ['http://loom.example', 'https://user@loom.example', 'https://loom.example/path', 'https://loom.example?x=1', 'https://loom.example#x', 'ftp://localhost', ' https://loom.example', 'https:loom.example', 'http://localhost.example'])
    expect(() => privateOrigin(bad), bad).toThrow('Invalid private origin');
  // The worker, the body's clients, the secret client and `loom mcp` call it; none lists this machine's names itself.
  const copies = sources('src').filter(file => file !== 'src/core/private-origin.ts' && /\[\s*'(localhost|127\.0\.0\.1)'\s*,/.test(text(file)));
  expect(copies).toEqual([]);
  for (const file of ['src/runtime/worker-http.ts', 'src/runtime/conversation-client.ts', 'src/runtime/body-command-client.ts', 'src/runtime/body-bootstrap.ts', 'src/pieces/secrets/private-client.ts', 'src/shared-mcp-stdio.ts'])
    expect(text(file), file).toContain('privateOrigin(');
});

it('states the range of Measuring\'s local history once in code, agreeing with the column\'s check', () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client, () => '2026-11-16T00:00:00.000Z');
    db.insert(measuringSettings).values({}).run();
    expect(db.select().from(measuringSettings).get()?.keepDays).toBe(DEFAULT_MEASURING.keep_days);
    const values = { on: true, send_outside: true, outside_address: 'https://monitor.example/v1/traces' };
    for (const [days, allowed] of [[0, true], [1, true], [KEEP_DAYS_MAX, true], [-1, false], [KEEP_DAYS_MAX + 1, false]] as const) {
      const set = () => db.update(measuringSettings).set({ keepDays: days }).run();
      if (allowed) set(); else expect(set, String(days)).toThrow(/measuring_settings_keep_days_range/);
      expect(validMeasuringDays(days), String(days)).toBe(allowed);
      expect(measuringValues.safeParse({ ...values, keep_days: days }).success, String(days)).toBe(allowed);
    }
  } finally { client.close(); }
  const copies = sources('src').filter(file => !['src/core/measuring/index.ts', 'src/core/data/schema.ts'].includes(file) && /keep_?[dD]ays[^\n]*\b3650\b/.test(text(file)));
  expect(copies).toEqual([]);
});

it('takes Tempo\'s unset timings from the columns, and reads a row or the defaults in one place', () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client, () => '2026-11-16T00:00:00.000Z');
    db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: '2026-11-16T00:00:00.000Z' }).run();
    db.insert(tempoSettings).values({ whoKind: 'person', who: 'owner' }).run();
    const { whoKind: _kind, who: _who, ...stored } = db.select().from(tempoSettings).get()!;
    expect(stored).toEqual(defaultTimings);
    expect(readTimings(db, { kind: 'agent', id: 'nobody' })).toEqual(defaultTimings);
    db.update(tempoSettings).set({ dimDays: 3 }).run();
    expect(readTimings(db, { kind: 'person', id: 'owner' })).toEqual({ ...defaultTimings, dimDays: 3 });
  } finally { client.close(); }
  const readers = sources('src').filter(file => /\.from\(tempoSettings\)/.test(text(file)));
  expect(readers).toEqual(['src/core/tempo/volume.ts']);
});

it('makes and reads a merge approval\'s target in one place', () => {
  const head = 'a1'.repeat(20), change = 'github:Sleep-Unit/loom.web#42';
  expect(parseMergeTarget(mergeTargetFor(change, head))).toEqual({ change, repository: 'Sleep-Unit/loom.web', head });
  for (const bad of [change, `${change}@${head.slice(1)}`, `${change}@${head.toUpperCase()}`, `github:loom#42@${head}`, `github:a/b#0@${head}`, `${change}@${head} `])
    expect(parseMergeTarget(bad), bad).toBeUndefined();
  expect(COMMIT.test(head)).toBe(true);
  expect(COMMIT.test(head + '0')).toBe(false);
  // A card that is filed and a standing rule that reads it cannot disagree: no other file spells the format or a commit id.
  const copies = sources('src').filter(file => file !== 'src/apps/merge-target.ts' && /\{40\}|#\[1-9\]\[0-9\]\*/.test(text(file)));
  expect(copies).toEqual([]);
});

it('holds a worker\'s configuration to limits that are written once', () => {
  for (const max of [STEP_DEADLINE_MAX_MS, BUILD_DEADLINE_MAX_MS]) {
    expect([validDeadline(1, max), validDeadline(max, max)]).toEqual([true, true]);
    expect([validDeadline(0, max), validDeadline(max + 1, max), validDeadline(1.5, max), validDeadline(NaN, max)]).toEqual([false, false, false, false]);
  }
  expect(['PATH', '_x', 'A1'].every(name => ENV_NAME.test(name))).toBe(true);
  expect(['1A', 'A-B', '', 'A=B'].some(name => ENV_NAME.test(name))).toBe(false);
  // What reads the file and what uses each part take the numbers from the one file, so a configuration that parses runs.
  const copies = sources('src/runtime').filter(file => file !== 'src/runtime/worker-limits.ts'
    && /\b300_?000\b|[<>]=?\s*3_?600_?000\b|\[A-Za-z_\]\[A-Za-z0-9_\]\*/.test(text(file)));
  expect(copies).toEqual([]);
});

it('makes a private secret use\'s id and checks its shape in one place', () => {
  const id = secretUseId('art', 'job-1', 'attempt-1');
  expect(SECRET_USE_ID.test(id)).toBe(true);
  expect(secretUseId('art', 'job-1', 'attempt-1')).toBe(id);
  expect(secretUseId('art', 'job-1', 'attempt-2')).not.toBe(id);
  const copies = sources('src').filter(file => file !== 'src/pieces/secrets/use-id.ts' && /use-input-/.test(text(file)));
  expect(copies).toEqual([]);
});

it('writes each of these small patterns once', () => {
  const once = (pattern: RegExp, home: string[], within = 'src') =>
    expect(sources(within).filter(file => pattern.test(text(file))), String(pattern)).toEqual(home);
  // An identity page's name, a scoped memory id.
  once(/\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,99\}\$\/;/, ['src/slug.ts']);
  once(/\[a-f0-9-\]\{36\}/, ['src/slug.ts']);
  const store = '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34';
  expect([STORE_ID.test(store), SCOPED_MEMORY_ID.test('art:' + store), scopedStoreId('proposal').test('art:proposal:' + store), scopedStoreId('person|project').test('art:project:' + store)]).toEqual([true, true, true, true]);
  expect([STORE_ID.test(store + '0'), SCOPED_MEMORY_ID.test(store), SCOPED_MEMORY_ID.test('art:proposal:' + store), scopedStoreId('person|project').test('art:proposal:' + store), scopedStoreId('proposal').test('art:xproposal:' + store)]).toEqual([false, false, false, false, false]);
  // A calendar day.
  once(/\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//, ['src/core/day.ts']);
  expect([DAY.test('2026-11-17'), DAY.test('2026-11-17T00:00:00Z'), DAY.test('26-11-17')]).toEqual([true, false, false]);
  // A body tool's name, a Discord id, a holder's generation, a time of day.
  once(/\[a-zA-Z\]\[a-zA-Z0-9_-\]\{0,63\}/, ['src/runtime/body-model-tools.ts']);
  once(/\\d\{1,20\}/, [], 'src/pieces/bridges');
  once(/4\[0-9a-f\]\{3\}-\[89ab\]/, ['src/pieces/secrets/role.ts']);
  once(/2\[0-3\]\):\[0-5\]\\d/, ['src/core/tempo/calendar.ts']);
  expect(isDiscordId('18446744073709551615')).toBe(true);
  for (const bad of ['0123', '18446744073709551616', '', 123]) expect(isDiscordId(bad), String(bad)).toBe(false);
  expect(isHolderGeneration('3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34')).toBe(true);
  expect(isHolderGeneration('3f2b8c1e-9d4a-1b6f-8a1c-0e5d7f9b2a34')).toBe(false);
  expect(['00:00', '23:59'].every(time => HH_MM.test(time))).toBe(true);
  expect(['24:00', '7:30', '12:60'].some(time => HH_MM.test(time))).toBe(false);
  // The address the program listens on when none is given is the listener's, and nobody else's.
  expect(sources('src').filter(file => /\?\?\s*'127\.0\.0\.1'/.test(text(file)))).toEqual(['src/shared-serve.ts']);
});

it('takes which agents have Memory, and who a local sign-in is for, from the household database', () => {
  // program.json is read in one file, and the two names an earlier build kept there are named nowhere else.
  expect(sources('src').filter(file => /signinMember/.test(text(file)))).toEqual(['src/shared-startup.ts']);
  expect(text('src/shared-initialize.ts')).not.toMatch(/memories|signin/);
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client, () => '2026-11-16T00:00:00.000Z');
    const commons = { directory: '/home/commons', knowledge: '/home/commons/knowledge.db', people: '/home/commons/people.db' };
    const found = householdMemorySources(db, commons, '/home/agents');
    expect(found.agents).toEqual([]);
    const face = { about: '', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble', faceEyes: 'dot' } as const;
    db.insert(agents).values([{ id: 'moss', ...face }, { id: 'fern', ...face }]).run();
    expect(found.agents).toEqual([{ agent: 'fern', directory: '/home/agents/fern', memories: '/home/agents/fern/memories.db' },
      { agent: 'moss', directory: '/home/agents/moss', memories: '/home/agents/moss/memories.db' }]);
    // The same list object while nothing changes; a removed agent stays; an id that could not be a directory name gets none.
    expect(found.agents).toBe(found.agents);
    db.update(agents).set({ removedAt: '2026-11-16T00:00:00.000Z' }).run();
    db.insert(agents).values({ id: '../elsewhere', ...face }).run();
    expect(found.agents.map(source => source.agent)).toEqual(['fern', 'moss']);
    // A reader's open files follow the list: each agent is opened once, when it is first listed.
    const opened: string[] = [];
    const files = new AgentFiles(() => found.agents, source => { opened.push(source.agent); return source.agent === 'moss' ? undefined : source.memories; });
    expect([...files.keys()]).toEqual(['fern']);
    db.insert(agents).values({ id: 'reed', ...face }).run();
    expect(files.get('reed')).toBe('/home/agents/reed/memories.db');
    expect([files.get('moss'), opened]).toEqual([undefined, ['fern', 'moss', 'reed']]);
    expect(files.end()).toEqual(['/home/agents/fern/memories.db', '/home/agents/reed/memories.db']);
    expect(files.size).toBe(0);
  } finally { client.close(); }
});

it('lists the memory categories once', () => {
  expect(sources('src').filter(file => /'pursuit'/.test(text(file)))).toEqual(['src/categories.ts']);
  for (const file of ['src/pieces/mind/semantic-commands.ts', 'src/shared-mcp-named.ts']) expect(text(file), file).toContain('z.enum(MEMORY_CATEGORIES)');
  expect(MEMORY_CATEGORIES).toContain('episode');
});

it('lists the kinds of household change once', () => {
  // The card, the command and the terminal's tool take the list from the one table of kinds.
  expect(sources('src').filter(file => /'tokenRevoke',\s*'boxRevoke'|'project',\s*'member',\s*'agent'/.test(text(file)))).toEqual([]);
  expect(text('src/shared-mcp-named.ts')).toContain('z.enum(householdChanges)');
  expect(new Set(householdChanges).size).toBe(householdChanges.length);
  for (const kind of ['agent', 'order', 'secretDescription', 'remove', 'restore', ...dangerousHouseholdChanges]) expect(householdChanges, kind).toContain(kind);
  expect([...dangerousHouseholdChanges].sort()).toEqual(['boxRevoke', 'browserSignOut', 'tokenRevoke']);
});

it('states how long a secret grant may last, and what an agent sends to ask for one, once', () => {
  expect(sources('src').filter(file => /525_?600/.test(text(file)))).toEqual(['src/pieces/secrets/input.ts']);
  expect([grantMinutes.safeParse(1).success, grantMinutes.safeParse(GRANT_MINUTES_MAX).success, grantMinutes.safeParse(0).success, grantMinutes.safeParse(GRANT_MINUTES_MAX + 1).success]).toEqual([true, true, false, false]);
  // The operation and the body's tool take the same shape, so what the tool accepts the operation accepts.
  for (const file of ['src/shared-secret-agent-commands.ts', 'src/runtime/body-secret-tools.ts']) expect(text(file), file).toMatch(/input(Schema)?:agentSecretRequest/);
  const asked = { id: '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34', secret: 'TOKEN', why: 'To push', minutes: GRANT_MINUTES_MAX };
  expect(agentSecretRequest.parse(asked)).toEqual({ ...asked, scope: 'job' });
  expect(secretRuleInput.safeParse({ secret: 'TOKEN', answer: 'auto', minutes: GRANT_MINUTES_MAX + 1, agents: [] }).success).toBe(false);
  // The form's limit is a hint to the person typing, and the same number.
  expect(/name="minutes" type="number" min=\{1\} max=\{(\d+)\}/.exec(text('web/src/pieces/settings/controls.tsx'))?.[1]).toBe(String(GRANT_MINUTES_MAX));
});

it('takes a secret\'s standing answers from the columns, and writes the household\'s default in one place', () => {
  expect(secretAnswer.options).toEqual([...household.secretsDefault.enumValues]);
  expect(secretAnswer.options).toEqual([...secretRules.answer.enumValues]);
  expect(sources('src').filter(file => file !== 'src/core/data/schema.ts' && /'ask',\s*'auto',\s*'never'/.test(text(file)))).toEqual([]);
  expect(sources('src').filter(file => /\{\s*secretsDefault\b[^}]*\}\)\.onConflict|set:\s*\{\s*secretsDefault/.test(text(file)))).toEqual(['src/apps/household.ts']);
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client, () => '2026-11-16T00:00:00.000Z'), requests = householdService(db, () => '2026-11-16T00:00:00.000Z');
    expect(householdSettings(db).secretsDefault).toBe(household.secretsDefault.default);
    requests.setSecretsDefault('never');
    expect(householdSettings(db).secretsDefault).toBe('never');
    requests.setSecretsDefault('auto');
    expect(db.select().from(household).all().map(row => row.secretsDefault)).toEqual(['auto']);
    expect(() => requests.setSecretsDefault('always' as 'auto')).toThrow();
  } finally { client.close(); }
});

it('holds Tempo\'s timings to one range', () => {
  const good = { settleSeconds: 0, dimDays: 1, muteDays: QUIET_DAYS_MAX };
  expect([validTimings(good), validTimings({ ...good, settleSeconds: SETTLE_SECONDS_MAX })]).toEqual([true, true]);
  for (const bad of [{ settleSeconds: -1 }, { settleSeconds: SETTLE_SECONDS_MAX + 1 }, { dimDays: 0 }, { dimDays: QUIET_DAYS_MAX + 1 }, { muteDays: 0 }, { muteDays: 1.5 }, { muteDays: QUIET_DAYS_MAX + 1 }])
    expect(validTimings({ ...good, ...bad }), JSON.stringify(bad)).toBe(false);
  // A household change is held to the same numbers where it is filed; it has none of its own.
  expect(sources('src').filter(file => file !== 'src/core/tempo/volume.ts' && /(settleSeconds|dimDays|muteDays)[^\n]*\b(86_?400|3650)\b/.test(text(file)))).toEqual([]);
  expect(text('src/shared-household-proposals.ts')).toMatch(/settleSeconds:z\.number\(\)\.int\(\)\.min\(0\)\.max\(SETTLE_SECONDS_MAX\)/);
});

it('states a note\'s lifespans and the length of its path once', () => {
  expect(sources('src').filter(file => /'keep',\s*'while',\s*'short'/.test(text(file)))).toEqual(['src/notes.ts']);
  expect(sources('src').filter(file => file !== 'src/notes.ts' && /(path|prefix)[^\n]{0,40}\b300\b/i.test(text(file)))).toEqual([]);
  expect([...LIFESPAN_NAMES].filter(name => name !== 'keep').sort()).toEqual(Object.keys(LIFESPAN_DAYS).sort());
  expect(NOTE_PATH_MAX).toBe(300);
  for (const file of ['src/shared-notes.ts', 'src/shared-mcp-named.ts']) { expect(text(file), file).toContain('z.enum(LIFESPAN_NAMES)'); expect(text(file), file).toContain('max(NOTE_PATH_MAX)'); }
});

it('writes the shape of a SHA-256 digest in hex once', () => {
  expect(sources('src').filter(file => /\[(a-f0-9|0-9a-f|0-9a-fA-F)\]\{64\}/.test(text(file)))).toEqual(['src/core/sha256-hex.ts']);
  const digest = 'a1'.repeat(32);
  expect([SHA256_HEX.test(digest), LOGIN_PATH.test('/login/' + digest)]).toEqual([true, true]);
  expect([SHA256_HEX.test(digest.toUpperCase()), SHA256_HEX.test(digest + '0'), SHA256_HEX.test(digest.slice(1)), LOGIN_PATH.test('/login/' + digest + '/'), LOGIN_PATH.test('x/login/' + digest)]).toEqual([false, false, false, false, false]);
  // The app checks the link it is handed with the same pattern, written out: it does not import the program.
  expect(text('web/src/signin/DeviceLink.tsx')).toContain('/' + LOGIN_PATH.source + '/.test(');
});

it('caps a private secret read in one place', () => {
  // Nor does a body's client carry its own wait: both read the one default and the one limit.
  expect(sources('src').filter(file => /timeoutMs[^\n]{0,40}\b15_?000\b/.test(text(file)))).toEqual([]);
  for (const file of ['src/runtime/body-command-client.ts', 'src/runtime/conversation-client.ts']) expect(text(file), file).toContain('validBodyRequestMs(timeout)');
  expect([validBodyRequestMs(BODY_REQUEST_MS), validBodyRequestMs(BODY_REQUEST_MAX_MS), validBodyRequestMs(BODY_REQUEST_MAX_MS + 1), validBodyRequestMs(0)]).toEqual([true, true, false, false]);
  expect(text('src/runtime/worker-http.ts')).toContain('PRIVATE_SECRET_TIMEOUT_MS');
  const options = { url: 'http://127.0.0.1:1', token: 'body_x', signal: new AbortController().signal };
  privateSecretClient({ ...options, timeoutMs: PRIVATE_SECRET_TIMEOUT_MS }).close();
  expect(() => privateSecretClient({ ...options, timeoutMs: PRIVATE_SECRET_TIMEOUT_MS + 1 })).toThrow('Private secret input unavailable');
});

it('takes a choice the database also checks from the column, and states the others once', () => {
  const holders = (list: RegExp) => sources('src').filter(file => file !== 'src/core/data/schema.ts' && list.test(text(file)));
  // Checked by the schema: the door's own shapes read the column's list.
  expect(holders(/'answered',\s*'progressed'/)).toEqual([]);
  expect(holders(/'ask',\s*'tell',\s*'do'/)).toEqual([]);
  expect(holders(/'merge',\s*'command',\s*'setting'/)).toEqual([]);
  // The body is another program and states what it expects to be answered (docs/accepted-tradeoffs.md,
  // "A client states the shape of the answer it expects"); on loom's side the list is the column's.
  expect(holders(/'pending',\s*'allowed',\s*'denied',\s*'cancelled'/)).toEqual(['src/runtime/conversation-client.ts']);
  expect(holders(/'working',\s*'waiting',\s*'idle'/)).toEqual(['src/runtime/body-program-tools.ts']);
  for (const list of [/'task',\s*'bug'/, /'pending',\s*'allowed',\s*'denied',\s*'used'/, /'waiting',\s*'taken',\s*'done'/]) expect(holders(list), String(list)).toEqual([]);
  // Not a column's list: a project card's status, what a second look at a memory found, what can be
  // removed, and how tasks depend on each other.
  expect(holders(/'active',\s*'paused',\s*'done'/)).toEqual(['src/backends/projects.ts']);
  expect(holders(/'confirm',\s*'contradict'/)).toEqual(['src/backends/types.ts']);
  expect(holders(/'member',\s*'agent',\s*'project',\s*'bridge'/)).toEqual(['src/apps/household.ts']);
  expect(holders(/'blocks',\s*'parent-child'/)).toEqual(['src/apps/tasks.ts']);
});

it('holds a house secret\'s alias to one rule at the door that stores it and in the body that receives it', () => {
  const names = ['DEPLOY_KEY', '_x', 'a1', 'A'.repeat(200), 'deploy-key', 'a.b', '1A', '', 'A=B', 'A'.repeat(201), 'PATH', 'home', 'NODE_OPTIONS', 'mcp_x', 'LD_PRELOAD', 'DYLD_X', 'LOOM_BODY_SCRATCH'];
  expect(names.filter(isHouseSecretAlias)).toEqual(['DEPLOY_KEY', '_x', 'a1', 'A'.repeat(200)]);
  for (const alias of names) {
    const door = houseSecretsInput.safeParse({ agent: 'art', repository: null, secrets: [{ alias, secret: 'S' }] }).success;
    expect([alias, door, houseSecretAlias.safeParse(alias).success]).toEqual([alias, isHouseSecretAlias(alias), isHouseSecretAlias(alias)]);
  }
  // The body's half of this is in runtime/body-secrets.test.ts: with nothing of its own to add, it takes the same names.
  // No other file spells the shape of an alias.
  const copies = sources('src').filter(file => file !== 'src/pieces/secrets/input.ts' && /\[A-Za-z_\]\[A-Za-z0-9_[^\]]*\]\{0,199\}|alias:\s*z\.string\(\)/.test(text(file)));
  expect(copies).toEqual([]);
});
