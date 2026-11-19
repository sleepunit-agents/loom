/** Rules that were once copied from file to file, each now stated in one place. These fail when a copy comes back. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { refsIn } from './pieces/mind/activity-model.js';
import { refsIn as conversationRefs } from './core/conversations/refs.js';
import { canonicalRepository, repositoryKey, tasksCited } from './pieces/changes/model.js';
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
import { CONTEXT_ENTRIES_MAX, CONTEXT_FILE_MAX, CONTEXT_MAX, CONTEXT_NAME_MAX, GIT_MINIMUM, ACCOUNT_SLOTS_BY_HARNESS, ACCOUNT_SLOTS_DEFAULT, BUILD_DEADLINE_MAX_MS, ENV_NAME, HOUSE_BUILD_DEFAULT_MS, HOUSE_SLOTS_DEFAULT, SLOTS_MAX, STEP_DEADLINE_MAX_MS, validDeadline } from './runtime/worker-limits.js';
import { CONVERSATION_ID, HOUSEHOLD_ID_MAX, PERSON_CARD_SLUG_MAX, PROJECT_CARD_SLUG_MAX, SCOPED_MEMORY_ID, SLUG, STORE_ID, TASK_ID, conversationId, householdId, scopedStoreId, slug, taskId } from './slug.js';
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
import { alwaysAsks, dangerousHouseholdChanges, householdChanges } from './shared-household-proposals.js';
import { householdMemorySources } from './shared-memory.js';
import { householdSettings } from './core/data/household-settings.js';
import { secretRules } from './core/data/schema.js';
import * as householdSchema from './core/data/schema.js';
import { getTableColumns, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { accountSignins, bridgeConnections, inbox, messages as messageRows, secretChanges } from './core/data/schema.js';
import { SECRET_VALUE_BYTES, SECRET_WRITE_MODES, secretValueSize, secretWriteMode } from './pieces/secrets/input.js';
import { secretSetInput } from './pieces/secrets/shared-values.js';
import { MEMORY_CONTENT_MAX } from './backends/types.js';
import { MAX_PAGE_BODY_LENGTH } from './backends/knowledge-verification.js';
import { LOG_TAIL_MAX, logTail } from './runtime/log-tail.js';
import { MESSAGE_WORDS_MAX } from './core/conversations/words.js';
import { LINE_NAME_MAX, hasControlCharacter, lineName, machineName } from './core/line-name.js';
import { boxSettingsInput } from './shared-box-settings.js';
import { AGING_DAYS, CHECK_DAYS, RECENT_DAYS } from './pieces/mind/knowledge.js';
import { RAW_EVENT_LIFETIME, UNREAD_EVENT_LIFETIME } from './pieces/bridges/events.js';
import { HELD_LIFETIME } from './pieces/bridges/receiver.js';
import { RELAY_MS, SIGNIN_MS } from './runtime/account-signin-time.js';
import { BODY_PROGRAM, BODY_PROGRAM_TARGET, NESTED_SOCKET_TARGET, plainPath } from './runtime/worker-mounts.js';
import { CONTAINER_RUNTIMES } from './runtime/worker-container.js';
import { HOUSE_IMAGES_KEPT, HOUSE_IMAGES_PER_HOUSE, HOUSE_LABEL, HOUSE_LABEL_HARNESSES, HOUSE_VERSION } from './runtime/house-image.js';
import { HOUSE_MIRRORS_KEPT } from './runtime/house-source.js';
import { CORE_DIRECTORY } from './runtime/house-core.js';
import { HOUSE_HOME, HOUSE_NODE, HOUSE_REPOSITORY, houseBodyFile, houseLogin, houseMount } from './runtime/house-layout.js';
import { WORKER_STOP } from './runtime/worker-stop.js';
import { LISTING_MAX } from './runtime/docker-engine.js';
import { bridgeReview, bridgeSetting } from './pieces/bridges/settings.js';

const root = new URL('../', import.meta.url).pathname;
const sources = (directory: string): string[] => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(directory, entry.name))
    : /\.ts$/.test(entry.name) && !/\.(test|fixture)\.ts$/.test(entry.name) ? [join(directory, entry.name)] : []);
const text = (file: string) => readFileSync(join(root, file), 'utf8');
/** Every file under a directory whose name matches, tests and fixtures left out: for the app, which has .tsx too. */
const sourcesOf = (directory: string, name: RegExp): string[] => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sourcesOf(join(directory, entry.name), name)
    : name.test(entry.name) && !/\.(test|fixture)\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []);

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
  for (const file of ['src/core/conversations/history-context.ts', 'src/core/conversations/bridge-history.ts', 'src/runtime/conversation-client.ts']) {
    expect(text(file), file).toContain('HISTORY_BYTES');
    // The count of lines too: built to it for a thread and for a bridge conversation, and taken to it.
    expect(text(file), file).toContain('HISTORY_LINES');
  }
  expect(text('src/runtime/conversation-client.ts')).toContain('history:z.array(historyLine).max(HISTORY_LINES)');
  expect(sources('src').filter(file => /HISTORY_LINES\s*=\s*\d/.test(text(file)))).toEqual(['src/core/conversations/history-limit.ts']);
});

it('says what a Discord file link is, and how a file\'s name is made plain, once each', () => {
  // Old transcripts' signed links are recognized and removed with the same rule used before a download.
  expect(sources('src').filter(file => /discordapp/.test(text(file)))).toEqual(['src/pieces/bridges/discord-link.ts']);
  for (const file of ['src/pieces/bridges/discord-link.ts', 'src/pieces/bridges/discord-files.ts']) expect(text(file), file).toContain('discordFileLink(');
  expect(text('src/core/conversations/body-input.ts')).toContain('discordBodyWords(');
  // A kept attachment, a file written for a body and a file on a post are named by one rule.
  expect(sources('src').filter(file => text(file).includes('[^A-Za-z0-9._-]+/g'))).toEqual(['src/pieces/bridges/file-name.ts']);
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
  const head = 'a1'.repeat(20), change = 'github:sleep-unit/loom.web#42';
  expect(parseMergeTarget(mergeTargetFor(change, head))).toEqual({ change, repository: 'sleep-unit/loom.web', head });
  // A repository has one spelling in a target: lower case, as loom stores a change's id, and no trailing
  // .git. Another spelling of the same repository is not a target, so it can never pass for a different one.
  for (const alias of ['github:Sleep-Unit/loom.web#42', 'github:sleep-unit/loom.web.git#42', 'github:sleep-unit/loom.web.GIT#42', 'github:sleep-unit/.#42', 'github:../loom.web#42', 'github:sleep-unit/..#42'])
    expect(parseMergeTarget(`${alias}@${head}`), alias).toBeUndefined();
  expect([canonicalRepository('acme/app'), canonicalRepository('Acme/app'), canonicalRepository('acme/app.git'), canonicalRepository('acme/a.git.b'), canonicalRepository('acme')]).toEqual([true, false, false, true, false]);
  expect([repositoryKey('github:Acme/App.git'), repositoryKey('acme/app'), repositoryKey('ACME/APP.GIT')]).toEqual(['acme/app', 'acme/app', 'acme/app']);
  // That identity is stated in one file; the target parser and the question "does loom read it" both ask it.
  expect(sources('src').filter(file => /\.git\b/.test(text(file)) && /repositor/i.test(text(file)) && /function (canonicalRepository|repositoryKey)|const (canonicalRepository|repositoryKey)/.test(text(file)))).toEqual(['src/pieces/changes/model.ts']);
  expect(text('src/apps/merge-target.ts')).toContain('canonicalRepository(');
  expect(text('src/apps/changes.ts').split('repositoryKey(').length).toBeGreaterThanOrEqual(4);
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
  // The kinds no standing rule answers are named once, and filing asks that one list.
  expect([...alwaysAsks].sort()).toEqual(['kit', 'kitGrant', 'placeSchedule', 'projectJoin', 'projectMerge', 'projectOutsidePerson', 'rule']);
  expect(text('src/shared-household-proposals.ts')).toContain('if(alwaysAsks.has(value.change))return card;');
  expect(text('src/shared-household-proposals.ts')).not.toMatch(/if\(value\.change==='(rule|projectJoin|projectMerge)'\)return card/);
  // What cannot be put back: three revocations, and a merge of two projects.
  expect([...dangerousHouseholdChanges].sort()).toEqual(['boxRevoke', 'browserSignOut', 'projectMerge', 'tokenRevoke']);
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
  expect(sources('src').filter(file => /\{\s*secretsDefault\b[^}]*\}\)\.onConflict|set(?::\s*|\()\{\s*secretsDefault/.test(text(file)))).toEqual(['src/apps/household.ts']);
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

it('writes the shape of a task id and of a conversation id once, where each is made', () => {
  // A literal `t-` or `cv-` followed by a digit pattern, a character class or an interpolation is a second copy.
  const copy = /\bt-(?:\\d|\[0-9|\$\{)|\bcv-(?:\[|\\|\(\?|\$\{)/;
  expect(sources('src').filter(file => copy.test(text(file)))).toEqual(['src/slug.ts']);
  // The makers use the same file's builders, and what they make is what the patterns find.
  expect(text('src/apps/tasks.ts')).toContain('id = taskId(n)');
  expect(text('src/core/conversations/index.ts')).toContain('id: conversationId(randomUUID())');
  const task = new RegExp(`^${TASK_ID}$`), conversation = new RegExp(`^${CONVERSATION_ID}$`);
  // No length is given to a task's number: Changes and Activity once disagreed at seven digits.
  for (const n of [1, 509, 1234567, 12345678901]) expect(task.test(taskId(n)), String(n)).toBe(true);
  for (const bad of ['t-', 't-x', 'x-1', 't-1a']) expect(task.test(bad), bad).toBe(false);
  expect(conversation.test(conversationId('123e4567-e89b-42d3-a456-426614174000'))).toBe(true);
  expect(conversation.test('cv-0123456789ab')).toBe(true);
  for (const bad of ['cv-', 'cv-0123456789a', 'cv-123e4567', 'th-123e4567-e89b-42d3-a456-426614174000']) expect(conversation.test(bad), bad).toBe(false);
  // The readers that find an id in words agree at every length.
  const long = taskId(12345678);
  expect(refsIn(`See ${long}.`, undefined).tasks).toEqual([long]);
  expect(conversationRefs(`See ${long}.`)).toEqual([long]);
  expect(tasksCited({ title: `Fix ${long}`, body: '', head: { ref: 'fix/t77-pond' } } as Parameters<typeof tasksCited>[0])).toEqual([long, 't-77']);
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

/** Every numeric literal in a file, as a number: `65_536` and `65536` are the same one. */
const numbersIn = (file: string) => new Set([...text(file).matchAll(/(?<![\w.])\d[\d_]*(?![\w.])/g)].map(found => Number(found[0].replaceAll('_', ''))));

it('writes the number of a named limit in that limit\'s home and nowhere else', () => {
  // The general guard. A limit that has a name is a number written once; a second file that writes the
  // same number is either a copy of the limit (import the name instead) or a different thing that happens
  // to be as large, and then it is listed here with what it is. Either way a new one fails this test and
  // somebody decides. It reads every literal, in a schema or not, in the program and in the app.
  // What it cannot see: a copy written as a sum (`64 * 1024`, checked for the two sizes below), and a
  // limit whose number is too ordinary to scan for (200, 30, 7); those have their own tests in this file.
  const limits: { value: number; homes: Record<string, string>; others: Record<string, string> }[] = [
    { value: SECRET_VALUE_BYTES, homes: { 'src/pieces/secrets/input.ts': 'SECRET_VALUE_BYTES', 'src/backends/types.ts': 'MEMORY_CONTENT_MAX' }, others: {
      'src/runtime/agy-body.ts': 'how much of a harness\'s first output is searched for its session id',
      'src/runtime/claude-body.ts': 'the size of the tools configuration handed to the harness',
      'src/runtime/docker-engine.ts': 'the size of one answer from the container engine',
      'src/runtime/worker-process.ts': 'how much a usage reader may print' } },
    { value: LOG_TAIL_MAX, homes: { 'src/runtime/log-tail.ts': 'LOG_TAIL_MAX', 'src/runtime/house-program.ts': 'PROGRAM_OUTPUT_BYTES' }, others: {
      'src/pieces/secrets/holder-store.ts': 'the longest header of a stored, encrypted value',
      'src/pieces/bridges/slack-socket.ts': 'the size of one answer from Slack when a socket is opened' } },
    { value: MESSAGE_WORDS_MAX, homes: { 'src/core/conversations/words.ts': 'MESSAGE_WORDS_MAX' }, others: {
      'src/runtime/claude-body.ts': 'how many tokens one tool answer may have, a setting of the harness',
      'web/src/pieces/comms-view/index.tsx': 'the message box\'s hint, held to MESSAGE_WORDS_MAX below',
      'web/src/pieces/attention/home-composer.tsx': 'the message box\'s hint, held to MESSAGE_WORDS_MAX below',
      'web/src/components/ui/code-block.tsx': 'the longest code the app colours',
      'web/src/lib/cojeev-motion/use-morph.ts': 'arithmetic in a hash' } },
    { value: GRANT_MINUTES_MAX, homes: { 'src/pieces/secrets/input.ts': 'GRANT_MINUTES_MAX' }, others: {
      'web/src/pieces/settings/controls.tsx': 'the form\'s hint, held to GRANT_MINUTES_MAX above' } },
  ];
  expect([SECRET_VALUE_BYTES, MEMORY_CONTENT_MAX, LOG_TAIL_MAX, MESSAGE_WORDS_MAX, GRANT_MINUTES_MAX]).toEqual([65536, 65536, 16384, 100000, 525600]);
  const files = [...sources('src'), ...sourcesOf('web/src', /\.tsx?$/)].map(file => [file, numbersIn(file)] as const);
  for (const { value, homes, others } of limits) {
    const holders = files.filter(([, numbers]) => numbers.has(value)).map(([file]) => file).sort();
    expect(holders, `files that write ${value}`).toEqual([...Object.keys(homes), ...Object.keys(others)].sort());
    for (const [home, name] of Object.entries(homes)) expect(text(home), home).toMatch(new RegExp(`export const ${name} = [\\d_]+;`));
  }
  // The same two sizes written as a sum: a Knowledge page's body, and a private key file read whole.
  expect(sources('src').filter(file => /\b(64|16) \* 1024\b/.test(text(file)))).toEqual(['src/backends/knowledge-verification.ts', 'src/pieces/secrets/local-holder.ts']);
  expect(MAX_PAGE_BODY_LENGTH).toBe(65536);
  // The app's two message boxes show the program's number.
  for (const file of ['web/src/pieces/comms-view/index.tsx', 'web/src/pieces/attention/home-composer.tsx'])
    expect([...text(file).matchAll(/<Textarea[^>]*? maxLength=\{(\d+)\}/g)].map(found => Number(found[1])), file).toEqual([MESSAGE_WORDS_MAX]);
});

it('holds a secret\'s value to one size and one shape of write, from the door to the key holder', () => {
  expect([secretValueSize(1), secretValueSize(SECRET_VALUE_BYTES), secretValueSize(0), secretValueSize(SECRET_VALUE_BYTES + 1)]).toEqual([true, true, false, false]);
  const write = { id: '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34', member: 'owner', name: 'TOKEN', mode: 'add' };
  // Bytes, not characters: a two-byte letter counts twice.
  expect(secretSetInput.safeParse({ ...write, value: 'x'.repeat(SECRET_VALUE_BYTES) }).success).toBe(true);
  expect(secretSetInput.safeParse({ ...write, value: 'x'.repeat(SECRET_VALUE_BYTES + 1) }).success).toBe(false);
  expect(secretSetInput.safeParse({ ...write, value: 'é'.repeat(SECRET_VALUE_BYTES / 2 + 1) }).success).toBe(false);
  expect(secretSetInput.safeParse({ ...write, value: '' }).success).toBe(false);
  // `secrets.set` is that shape without the member, and nothing else measures a value in text.
  expect(text('src/shared-secret-commands.ts')).toContain('secretSetInput.omit({member:true}).strict()');
  expect(sources('src').filter(file => /Buffer\.byteLength\(value\)\s*(<=?|>)\s*\d/.test(text(file)))).toEqual([]);
  // Each hop asks the one check; none compares a length with a number of its own.
  for (const file of ['src/shared-holder-channel.ts', 'src/pieces/secrets/holder-store.ts', 'src/pieces/secrets/private-inputs.ts', 'src/pieces/bridges/shared-secret-use.ts', 'src/shared-changes-reader.ts'])
    expect(text(file), file).toContain('secretValueSize(');
  expect(text('src/pieces/secrets/private-client.ts')).toContain('SECRET_VALUE_BYTES');
  // How a value is written is one list, and each way is an action the column records.
  expect(secretWriteMode.options).toEqual([...SECRET_WRITE_MODES]);
  for (const mode of SECRET_WRITE_MODES) expect(secretChanges.action.enumValues, mode).toContain(mode);
  expect(sources('src').filter(file => /'add',\s*'replace'/.test(text(file)) && file !== 'src/core/data/schema.ts')).toEqual(['src/pieces/secrets/input.ts']);
});

it('cuts a job\'s log to one length at the worker, the door and the store', () => {
  expect(logTail('x'.repeat(LOG_TAIL_MAX + 5)).length).toBe(LOG_TAIL_MAX);
  expect(logTail('abc')).toBe('abc');
  // The worker's three cuts call the one function; the door and the store take the number by name.
  for (const file of ['src/runtime/worker.ts', 'src/runtime/worker-process.ts', 'src/runtime/worker-container.ts']) expect(text(file), file).toContain('logTail(');
  expect(text('src/shared-runtime.ts')).toContain('logTail: z.string().max(LOG_TAIL_MAX)');
  expect(text('src/runtime/jobs.ts')).toContain('logTail.slice(-LOG_TAIL_MAX)');
  // No other cut of a tail or of a log by a number.
  expect(sources('src').filter(file => /([tT]ail|\blog)[^\n]{0,40}\.slice\(-\d|logTail:\s*z\.string\(\)\.max\(\d/.test(text(file)))).toEqual([]);
});

it('caps the words of a message once, for every door that takes them', () => {
  // A field named for words, a message, text or instructions is capped by the name, never by a number.
  const own = /\b(words|text|instructions|why|ifYes|ifNo|details):\s*z\.string\(\)(\.trim\(\))?(\.min\(1\))?\.max\(1[\d_]{5,6}\)/;
  expect(sources('src').filter(file => own.test(text(file)))).toEqual([]);
  for (const file of ['src/core/conversations/body-output.ts', 'src/core/conversations/operations.ts', 'src/core/conversations/body-operations.ts', 'src/shared-bridge-reply.ts', 'src/core/tempo/triggers.ts', 'src/shared-work-body.ts'])
    expect(text(file), file).toContain('.max(MESSAGE_WORDS_MAX)');
});

it('states the rule for a one-line name, and for a machine\'s name, once', () => {
  expect(['Workshop', 'a b', 'x'.repeat(LINE_NAME_MAX)].every(name => lineName.safeParse(name).success)).toBe(true);
  for (const bad of ['', ' a', 'a ', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(LINE_NAME_MAX + 1)]) expect(lineName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  // A machine's name is that, and has no control character of any kind. Enrolment and a rename take the same rule.
  const controls = ['\t', String.fromCharCode(0x1b), String.fromCharCode(0x7f), String.fromCharCode(0x85), String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
  for (const control of controls) {
    expect(hasControlCharacter('a' + control + 'b'), JSON.stringify(control)).toBe(true);
    expect(machineName.safeParse('a' + control + 'b').success, JSON.stringify(control)).toBe(false);
  }
  expect([machineName.safeParse('Workshop 2').success, machineName.safeParse(' Workshop').success, hasControlCharacter('Workshop 2')]).toEqual([true, false, false]);
  expect(boxSettingsInput.shape.name).toBe(machineName);
  expect(text('src/shared-machine-registry.ts')).toContain('input:z.object({name:machineName,');
  // Nobody else spells either rule: the trimmed-and-one-line test, or the list of control characters.
  expect(sources('src').filter(file => /value\s*===\s*value\.trim\(\)\s*&&\s*!\/\[\\0\\r\\n\]/.test(text(file)))).toEqual(['src/core/line-name.ts']);
  expect(sources('src').filter(file => /\\u007f-\\u009f/.test(text(file)))).toEqual(['src/core/line-name.ts']);
  for (const file of ['src/runtime/model-catalog.ts', 'src/shared-account-signin.ts', 'src/shared-model-account-admin.ts']) expect(text(file), file).toContain("from './core/line-name.js'".replace('./core', file.startsWith('src/runtime/') ? '../core' : './core'));
});

it('works out when a Knowledge page changes state from the days that decide the state', () => {
  expect([CHECK_DAYS, AGING_DAYS, RECENT_DAYS]).toEqual([30, 20, 7]);
  expect(AGING_DAYS).toBeLessThan(CHECK_DAYS);
  // The view decides fresh, aging and due; whatever times a refresh reads the same three names. No file
  // of Memory's multiplies a number of days of its own for them.
  expect(sources('src/pieces/mind').filter(file => /\b(20|30|7)\s*\*\s*86_?400_?000/.test(text(file)))).toEqual([]);
  expect(text('src/pieces/mind/knowledge-query.ts')).toMatch(/anchor\+AGING_DAYS\*[^,]+,anchor\+CHECK_DAYS\*[^,]+,[^;]*RECENT_DAYS\*/);
  expect(sources('src').filter(file => /\b(CHECK|AGING|RECENT)_DAYS\s*=\s*[\d(]/.test(text(file)))).toEqual(['src/pieces/mind/knowledge.ts']);
});

it('names where a nested job finds the engine, the engine runtimes and a mount\'s read-only default once', () => {
  // The socket's place inside a container: what the worker mounts there and what no other mount may cover.
  expect(NESTED_SOCKET_TARGET).toBe('/var/run/docker.sock');
  expect(sources('src').filter(file => /\/(var\/)?run\/docker\.sock/.test(text(file)))).toEqual(['src/runtime/worker-mounts.ts']);
  expect(text('src/runtime/worker-mounts.ts')).toContain("const SOCKET_PLACES = [NESTED_SOCKET_TARGET, '/run/docker.sock'] as const;");
  expect(text('src/runtime/worker-mounts.ts')).toContain('target: NESTED_SOCKET_TARGET');
  // How a mounted path and an engine socket must be written is one function. The configuration's schema
  // reads only that each is a string, and nothing else looks at how a socket's path begins.
  expect(plainPath('/run/engine.sock')).toBe(true);
  expect(['run/engine.sock', '/', '/run/', '/run//engine.sock', '/run/../engine.sock', '/run/./engine.sock', '/run/\0', '', 7, undefined].some(plainPath)).toBe(false);
  expect(text('src/runtime/worker-program.ts')).toContain('container: z.object({ socket: z.string(), nestedSocket: z.string().optional(),');
  expect(text('src/runtime/worker-program.ts')).toContain('const hostDirectory = z.object({ source: z.string(), target: z.string() }).strict();');
  expect(text('src/runtime/docker-engine.ts')).toContain('if (!plainPath(socketPath))');
  expect(sources('src/runtime').filter(file => /[sS]ocket(Path)?\??\.(startsWith|includes)\(/.test(text(file)))).toEqual([]);
  // The runtime names: the first is what a configuration that names none gets; the file is read by the same list.
  expect([...CONTAINER_RUNTIMES]).toEqual(['runc', 'crun']);
  expect(sources('src').filter(file => /['"`](runc|crun)['"`]/.test(text(file)))).toEqual(['src/runtime/worker-container.ts']);
  expect(text('src/runtime/worker-program.ts')).toContain('runtime: z.enum(CONTAINER_RUNTIMES)');
  expect(text('src/runtime/worker-container.ts')).toContain('Runtime: config.runtime ?? CONTAINER_RUNTIMES[0]');
  // A fixed mount is read-only unless it says false, decided in one place; the file's schema gives no default of its own.
  expect(sources('src/runtime').filter(file => /readOnly\s*(\?\?|!==|===|\|\|)|readOnly:[^,}\n]*\.default\(/.test(text(file)))).toEqual(['src/runtime/worker-mounts.ts']);
  expect(text('src/runtime/worker-mounts.ts')).toContain('readOnly: mount.readOnly !== false');
});

it('says once where a body finds its program, what a house image must say, and how long and how much a house may take', () => {
  // Where the worker's own directory is in every container, and the body program in it.
  expect([BODY_PROGRAM_TARGET, BODY_PROGRAM]).toEqual(['/opt/loom', '/opt/loom/dist/body.js']);
  expect(sources('src').filter(file => text(file).includes('/opt/loom'))).toEqual(['src/runtime/worker-mounts.ts']);
  expect(text('src/runtime/worker-container.ts')).toContain('Cmd: [BODY_PROGRAM, houseBodyFile(job.harness)]');
  // The layout inside every house is written in one file: the home, the repository, node, the body files, the sign-in.
  expect([HOUSE_HOME, HOUSE_REPOSITORY, HOUSE_NODE, houseBodyFile('claude'), houseLogin('claude'), houseMount('x')])
    .toEqual(['/home/agent', '/home/agent/repo', '/usr/local/bin/node', '/etc/loom/body/claude.json', '/run/loom/login/claude', '/home/agent/x']);
  expect(sources('src').filter(file => /\/home\/agent|\/run\/loom\/login|\/etc\/loom\/body|\/usr\/local\/bin\/node/.test(text(file)))).toEqual(['src/runtime/house-layout.ts']);
  // The worker never looks inside a sign-in directory: the one file that takes their paths asks the system
  // only what each directory is (lstat, realpath), and reads, lists, writes and removes nothing.
  expect(text('src/runtime/worker-mounts.ts')).toContain("import { lstatSync, realpathSync } from 'node:fs';");
  expect(text('src/runtime/worker-mounts.ts')).not.toMatch(/from 'node:fs\/promises'|node:child_process/);
  expect(sources('src').filter(file => /accountLogins/.test(text(file)))).toEqual(['src/runtime/job-exit.ts', 'src/runtime/worker-container.ts', 'src/runtime/worker-mounts.ts', 'src/runtime/worker-program.ts', 'src/runtime/worker-stop.ts']);
  // The file that mounts them reads one file in all, its own package.json, and the file that holds them
  // to one worker makes its names from their paths and opens nothing at them.
  expect(text('src/runtime/worker-container.ts')).toContain("import { lstatSync, readFileSync, realpathSync } from 'node:fs';");
  expect(text('src/runtime/worker-container.ts').match(/readFileSync\(/g)).toEqual(['readFileSync(']);
  expect(text('src/runtime/worker-container.ts')).toContain("readFileSync(join(program, 'package.json'), 'utf8')");
  expect(text('src/runtime/worker-alone.ts')).toContain("import { rmSync } from 'node:fs';");
  expect(text('src/runtime/worker-alone.ts')).toContain("const file = join(tmpdir(), `${nameOf(path)}-${userInfo().uid}.sock`);");
  // One worker for an engine and a sign-in directory: asked in one place, before anything is ended or built.
  expect(sources('src').filter(file => /holdAlone\b/.test(text(file)))).toEqual(['src/runtime/worker-alone.ts', 'src/runtime/worker-container.ts']);
  // The core house is defined in one directory of the install, and its image named in one file.
  expect(CORE_DIRECTORY).toBe('house/core');
  expect(sources('src').filter(file => /localhost\/loom-core/.test(text(file)))).toEqual(['src/runtime/house-image.ts']);
  expect(sources('src').filter(file => /['"`]LOOM_CORE['"`]/.test(text(file)))).toEqual(['src/runtime/house-image.ts']);
  // The names of what a body is told of its house are written once.
  expect(sources('src').filter(file => /LOOM_HOUSE_(REPOSITORY|BRANCH|COMMIT)/.test(text(file)))).toEqual(['src/runtime/house-layout.ts']);
  // A machine's configuration says where a sign-in directory is on the machine, and nothing of where it appears.
  expect(text('src/runtime/worker-mounts.ts')).toContain('target: houseLogin(harness), readOnly: false');
  // The image contract's labels: written in the one file that reads them.
  expect([HOUSE_LABEL, HOUSE_VERSION, HOUSE_LABEL_HARNESSES]).toEqual(['loom.house', '2', 'loom.house.harnesses']);
  expect(sources('src').filter(file => /['"`]loom\.house/.test(text(file)))).toEqual(['src/runtime/house-image.ts']);
  // What is kept on the disk, and how long a build may take.
  expect([HOUSE_IMAGES_PER_HOUSE, HOUSE_IMAGES_KEPT, HOUSE_MIRRORS_KEPT, HOUSE_BUILD_DEFAULT_MS]).toEqual([2, 10, 8, 1_800_000]);
  expect(sources('src/runtime').filter(file => /\b1_?800_?000\b/.test(text(file)))).toEqual(['src/runtime/worker-limits.ts']);
  expect(text('src/runtime/worker-container.ts')).toContain('fixed.buildTimeoutMs ?? HOUSE_BUILD_DEFAULT_MS');
  // How a repository's address, branch and Housefile must be written is the fetch's rule; a house image's name is made in one place.
  expect(sources('src').filter(file => text(file).includes('loom-house-'))).toEqual(['src/runtime/house-image.ts']);
  // Written once in that file too: how the name begins, and how many digits of the house follow.
  expect(text('src/runtime/house-image.ts').split('loom-house-')).toHaveLength(2);
  expect(text('src/runtime/house-image.ts').match(/\b16\b/g)).toHaveLength(1);
  // One listing's size, and one answer's, in the engine client; the oldest git, where git is run.
  expect([LISTING_MAX, [...GIT_MINIMUM]]).toEqual([4_194_304, [2, 32, 0]]);
  // The oldest git is one number: the stop line is made from it, and no other source writes a git version.
  expect(WORKER_STOP.git[1]).toBe('git 2.32.0 or later, which fetches each house\'s repository, could not be run on this machine');
  // A build context's limits, and the one file that writes a context: no other source asks git to archive.
  expect([CONTEXT_FILE_MAX, CONTEXT_MAX, CONTEXT_ENTRIES_MAX, CONTEXT_NAME_MAX]).toEqual([104_857_600, 1_073_741_824, 50_000, 4_096]);
  expect(sources('src').filter(file => /\b(104_?857_?600|1_?073_?741_?824)\b/.test(text(file)))).toEqual(['src/runtime/worker-limits.ts']);
  expect(sources('src/runtime').filter(file => /['"]archive['"]|['"]fetch\.fsckObjects['"]/.test(text(file)))).toEqual([]);
  expect(sources('src').filter(file => /['"](ls-tree|cat-file)['"]/.test(text(file)))).toEqual(['src/runtime/house-context.ts']);
  expect(sources('src').filter(file => /git \d+\.\d+/i.test(text(file)))).toEqual([]);
  expect(sources('src/runtime').filter(file => /GIT_MINIMUM = /.test(text(file)))).toEqual(['src/runtime/worker-limits.ts']);
  expect(sources('src').filter(file => /\b4_?194_?304\b/.test(text(file)))).toEqual(['src/runtime/docker-engine.ts']);
  expect(text('src/runtime/house-image.ts')).toContain("import { houseFile, type House } from './house-source.js';");
  // How many jobs a worker runs side by side: the two numbers in one file, read by the schema and the program.
  expect([HOUSE_SLOTS_DEFAULT, SLOTS_MAX, ACCOUNT_SLOTS_DEFAULT]).toEqual([4, 16, 4]);
  expect(text('src/runtime/worker-program.ts')).toContain('const accountSlot = z.number().int().min(1).max(SLOTS_MAX);');
  expect(text('src/runtime/worker-program.ts')).toContain('accountSlots: z.union([accountSlot, z.record(z.string().min(1), accountSlot)]).optional(),');
  expect(text('src/runtime/worker-program.ts')).toContain('Math.min(own(ACCOUNT_SLOTS_BY_HARNESS, harness) ?? ACCOUNT_SLOTS_DEFAULT, slots)');
  // Which harness's bodies run one at a time on an account by default is said in one place.
  expect(ACCOUNT_SLOTS_BY_HARNESS).toEqual({ codex: 1 });
  expect(sources('src').filter(file => /ACCOUNT_SLOTS_BY_HARNESS\b.*=/.test(text(file)))).toEqual(['src/runtime/worker-limits.ts']);
  expect(text('src/runtime/worker-program.ts')).toContain('slots: z.number().int().min(1).max(SLOTS_MAX).optional(),');
  expect(text('src/runtime/worker-program.ts')).toContain('config.slots ?? (config.container ? HOUSE_SLOTS_DEFAULT : 1)');
  // What two bodies cannot have at once is named in one place, and the loop asks there.
  expect(sources('src').filter(file => /[`'"](account|port):/.test(text(file)))).toEqual(['src/runtime/worker-turns.ts']);
  expect(text('src/runtime/worker.ts')).toContain('input.turns.take(turnsOf(assignment), abort.signal)');
  // A worker with container bodies takes no build command and no runners: the file's schema lets them be absent, and only then.
  expect(text('src/runtime/worker-program.ts')).toContain('build: command.optional(), runners: z.record(z.string(), runnerCommand).optional(),');
  expect(text('src/runtime/worker-program.ts')).toContain("throw new WorkerStop('retired', key)");
});

it('makes two times that must agree one time, or works one out from the other', () => {
  // A held message is retried for exactly as long as an unread frame is kept: one number.
  expect(HELD_LIFETIME).toBe(UNREAD_EVENT_LIFETIME);
  expect(RAW_EVENT_LIFETIME).toBeLessThan(UNREAD_EVENT_LIFETIME);
  expect(text('src/pieces/bridges/receiver.ts')).toContain('export const HELD_LIFETIME = UNREAD_EVENT_LIFETIME;');
  expect(sources('src/pieces/bridges').filter(file => /_LIFETIME\s*=\s*\d/.test(text(file)))).toEqual(['src/pieces/bridges/events.ts']);
  // The worker gives up on a sign-in before loom closes the request, and its configuration cannot ask for longer.
  expect(RELAY_MS).toBeLessThan(SIGNIN_MS);
  expect(RELAY_MS).toBeGreaterThan(0);
  expect(text('src/runtime/account-signin-time.ts')).toMatch(/export const RELAY_MS = SIGNIN_MS - /);
  expect(sources('src').filter(file => /\b(RELAY_MS|SIGNIN_MS)\s*=/.test(text(file)))).toEqual(['src/runtime/account-signin-time.ts']);
  expect(text('src/runtime/worker-program.ts')).toMatch(/timeoutMs: z\.number\(\)\.int\(\)\.min\(10_000\)\.max\(RELAY_MS\)/);
  expect(sources('src').filter(file => /\b(900_?000|1_?200_?000|(15|20) \* 60_?000)\b/.test(text(file)))).toEqual(['src/core/conversations/terminal-sessions.ts', 'src/runtime/account-signin-time.ts']);
});

it('takes these choices from the columns that check them too', () => {
  const holders = (list: RegExp) => sources('src').filter(file => file !== 'src/core/data/schema.ts' && list.test(text(file)));
  // How loudly an inbox item arrives; a bridge's platform; a card's state; a sign-in request's state.
  expect(holders(/'full',\s*'dim',\s*'mute'/)).toEqual([]);
  expect(holders(/\[\s*'discord',\s*'slack'\s*\]/)).toEqual([]);
  expect(holders(/\[\s*'running',\s*'done',\s*'failed'\s*\]/)).toEqual([]);
  expect(holders(/\[\s*'asked',\s*'started',\s*'waiting',\s*'done'/)).toEqual([]);
  expect(text('src/core/tempo/operations.ts')).toContain('z.enum(inbox.volume.enumValues)');
  expect(text('src/core/conversations/body-output.ts').split('z.enum(messages.cardState.enumValues)').length).toBe(3);
  expect(text('src/shared-account-signin.ts')).toContain('z.enum(accountSignins.state.enumValues)');
  for (const file of ['src/pieces/bridges/settings.ts', 'src/pieces/bridges/model.ts', 'src/pieces/bridges/channels.ts', 'src/shared-agent-body-policy.ts'])
    expect(text(file), file).toContain('z.enum(bridgeConnections.platform.enumValues)');
  expect([inbox.volume.enumValues, inbox.takenVolume.enumValues, bridgeConnections.platform.enumValues, messageRows.cardState.enumValues, accountSignins.state.enumValues])
    .toEqual([['full', 'dim', 'mute'], ['full', 'dim', 'mute'], ['discord', 'slack'], ['running', 'done', 'failed'], ['asked', 'started', 'waiting', 'done', 'failed']]);
  // When a secret is handed over is still written out beside its column: that file was being changed
  // elsewhere when the others were rolled up. It is to read `secretRuleAgents.when.enumValues`.
  expect(holders(/'on_request',\s*'at_start'/)).toEqual([]);
  // The app does not import the program; its volume buttons are the column's choices, in the column's order.
  expect(/\(\[([^\]]*)\] as const\)\.map\(value => <Button/.exec(text('web/src/pieces/inbox-view/index.tsx'))?.[1].replaceAll("'", '').split(', ')).toEqual([...inbox.volume.enumValues]);
});

it('reads a review of a held reply with one shape at the door and in the service', () => {
  expect(sources('src').filter(file => /z\.literal\('review'\)/.test(text(file)))).toEqual(['src/pieces/bridges/settings.ts']);
  expect(text('src/shared-bridge-commands.ts')).toContain("name:'bridges.command',input:bridgeReview,");
  expect(bridgeSetting.options).toContain(bridgeReview);
  // The id is the reply's own: taken as sent, so the reply the door asked about is the one the service changes.
  expect(bridgeReview.parse({ action: 'review', id: ' held ', decision: 'release' }).id).toBe(' held ');
});

it('asks policy.ts who may move a task to another project, at the one door that takes the move', () => {
  // The door reads the rule for each task named and states none of its own.
  const door = text('src/shared-task-access.ts');
  expect(door).toContain('holds(rules.moveTask, viewer, { ...row, to }, sharing)');
  expect(door).not.toMatch(/householdOwner|isHouseholdOwner|inProject|\.members\.includes|\.agents\.includes/);
  // The rule is written in policy.ts and in no other file; the trusted service and the dispatcher carry no policy.
  expect(sources('src').filter(file => /\bmoveTask\b\s*[:=]/.test(text(file)))).toEqual(['src/policy.ts']);
  for (const file of ['src/apps/tasks.ts', 'src/apps/task-command.ts']) expect(text(file), file).not.toMatch(/from '\.\.\/policy\.js'/);
  // That a task's project must be one in use is written once, with one set of refusal words; the door and the service call it.
  expect(sources('src').filter(file => /'No project has the id '|' is removed'/.test(text(file))).sort()).toEqual(['src/core/data/project-in-use.ts', 'src/shared-projects.ts']);
  // shared-projects.ts says that of an agent only; what is said of a project is in the one file, which tasks, joins and merges all call.
  expect(text('src/shared-projects.ts')).not.toMatch(/'Project '|'No project /);
  expect(text('src/shared-projects.ts').split('projectRefusal(db,').length).toBe(3);
  expect(text('src/apps/tasks.ts')).toContain('projectRefusal(db, project, use)?.message');
  expect(sources('src').filter(file => /projects\.removedAt\b/.test(text(file)) && /Refusal/.test(text(file)))).toEqual(['src/core/data/project-in-use.ts']);
  expect(door.split('taskProjectRefusal(db, ').length).toBe(3);
  expect(door).not.toMatch(/hasOwn\(sharing\.projects/);
});

it('holds a new question and a move that carries one to the one rule about who may be asked', () => {
  // Putting a question to a person, and moving a task with an unanswered one, both ask policy.ts; the
  // rule is written there and nowhere else, and nothing is handled when the answer comes.
  const door = text('src/shared-task-access.ts');
  expect(door.split('mayBeAskedAbout(').length).toBe(3);
  // A body's question to a person about a task is the third door, and asks the same rule for the person asked.
  expect(text('src/shared-conversation-questions.ts')).toContain("mayBeAskedAbout(q.to,");
  expect(sources('src').filter(file => /mayBeAskedAbout\(/.test(text(file))).sort()).toEqual(['src/policy.ts', 'src/shared-conversation-questions.ts', 'src/shared-task-access.ts']);
  expect(sources('src').filter(file => /function mayBeAskedAbout\b/.test(text(file)))).toEqual(['src/policy.ts']);
  expect(text('src/shared-task-commands.ts')).toContain('strandedQuestion(db, command)');
});

it('reads whether a project is retired, and whether a task is shelved, in one place', () => {
  // The column is read in the one file. The projects' owner writes it, in one statement, and reads it nowhere.
  const named = sources('src').filter(file => /retiredAt|retired_at/.test(text(file)) && !['src/core/data/schema.ts', 'src/core/data/database.ts'].includes(file)).sort();
  expect(named).toEqual(['src/core/data/project-in-use.ts', 'src/shared-projects.ts']);
  expect(text('src/shared-projects.ts').match(/retiredAt/g)).toEqual(['retiredAt']);
  expect(text('src/shared-projects.ts')).toContain('.set({retiredAt:retire?now():null})');
  // Nor does it read whether a project is removed: what state a project is in is asked of the one file.
  expect(text('src/shared-projects.ts')).not.toMatch(/row\.removedAt|project\.removedAt|projects\.removedAt/);
  // Every reader that picks work asks the one filter: the ready queue, readiness in the data door, the sweep, the hub.
  for (const file of ['src/apps/tasks.ts', 'src/core/data/queries.ts', 'src/core/tempo/work-sweep.ts', 'src/shared-memory-projects.ts']) expect(text(file), file).toContain('taskShelved(');
  for (const file of ['src/core/conversations/inbox-query.ts', 'src/core/data/inbox-read.ts']) expect(text(file), file).toContain('waitsOnShelvedTask(inbox)');
  // The app is told; it does not look at a project to decide.
  for (const file of sourcesOf('web/src', /\.tsx?$/)) expect(text(file), file).not.toMatch(/retiredAt|retired_at/);
  expect(text('web/src/pieces/tasks/query.ts')).toContain('isReady isShelved');
});

it('decides whose standing rules answer for a piece of work in policy.ts and nowhere else', () => {
  // The rule service asks policy for the person, and keeps no reading of its own of who is a household owner for it.
  const service = text('src/apps/approval-rules.ts');
  expect(service).toContain('rulesPerson(actingFor,kind,sharedSharing(db))');
  expect(service).not.toMatch(/\.owner\?''/);
  // The door that files a card names the principal by policy's function; nobody else spells the agent's own.
  expect(text('src/shared-work-body.ts').split('workPrincipal(').length).toBe(3);
  expect(sources('src').filter(file => /'agent:'/.test(text(file)))).toEqual(['src/policy.ts']);
  // A household change's principal is policy's statement too: a member or nobody, never the agent's own
  // account. (This case used to pin that the proposals file did not call policy at all, to keep it from
  // taking the agent's own account; the guarantee is now in the function it calls.)
  expect(text('src/shared-household-proposals.ts')).toContain('actingFor:householdChangePrincipal(where?.member,owner)');
  expect(text('src/shared-household-proposals.ts')).not.toMatch(/workPrincipal|OWN_WORK/);
  // Nobody's name is spelled once, and the kinds the agent's own work reads are stated once.
  expect(sources('src').filter(file => /NOBODY\s*=\s*'unknown'/.test(text(file)))).toEqual(['src/policy.ts']);
  for (const file of ['src/apps/approval-rules.ts', 'src/shared-work-always.ts', 'src/shared-household-proposals.ts', 'src/shared-work-body.ts', 'src/apps/approval-request.ts']) expect(text(file), file).not.toContain("'unknown'");
  for (const file of ['src/apps/approval-rules.ts', 'src/shared-work-always.ts']) expect(text(file), file).toContain('isNobody(');
  expect(text('src/shared-work-body.ts')).not.toMatch(/kind!=='merge'&&input\.kind!=='command'/);
});

it('states the limits of a notice an agent raises once, and takes who raises it from policy.ts', () => {
  const notices = text('src/shared-notices.ts');
  expect(sources('src').filter(file => /NOTICE_(KEY|TITLE|DETAIL|WHY|KEYS)_MAX\s*=|NOTICE_PUSH_AGAIN_MS\s*=/.test(text(file)))).toEqual(['src/shared-notices.ts']);
  expect(notices).toContain('holds(rules.agentItself,viewer,{agent:found.agent},sharedSharing(db))');
  // Who it is for is policy's one reading of an agent's people, which loom's own notice about that agent asks too.
  expect(notices).toContain('agentsPeople(name,sharedSharing(db))');
  expect(text('src/runtime/jobs.ts')).toContain('agentsPeople(agent, sharedSharing(this.db))');
  expect(sources('src').filter(file => /function agentsPeople\b/.test(text(file)))).toEqual(['src/policy.ts']);
  for (const file of ['src/shared-notices.ts', 'src/runtime/jobs.ts']) expect(text(file), file).not.toMatch(/membersWithAgent|householdOwners/);
  // What is never pushed is said in one file, and asked by the one place that queues a push.
  expect(sources('src').filter(file => /'quiet-notice:'/.test(text(file)))).toEqual(['src/core/data/inbox-push.ts']);
  expect(text('src/core/signin/shared-notifications.ts')).toContain('sql`not ${neverPushed(inbox)}`');
  expect(notices).not.toMatch(/\.(insert|update|delete)\(/);
});

it('asks policy.ts which agents Home shows', () => {
  const home = text('src/core/data/comms-home.ts');
  expect(home).toContain("mayAct(viewer, { type: 'conversation', agent, member: viewer.id }, sharing, 'give-work')");
  // It reads no list of who has an agent itself.
  expect(home).not.toMatch(/memberAgents|member_agents/);
});

it('writes out no list of three or more choices that a column already has', () => {
  // The general guard for choices. Every column of the household schema that lists its values is read
  // here, and every list of quoted words written in the program is compared with each, in any order. A
  // list that is a column's is taken from the column (`table.column.enumValues`); a file that writes one
  // out fails this until it does, or is named below with why it must. Lists of two are left to the tests
  // above: `yes, no` and `member, agent` are written for too many unrelated things to mean a copy.
  const columns = new Map<string, string>();
  for (const [name, table] of Object.entries(householdSchema)) if (is(table, SQLiteTable))
    for (const [key, column] of Object.entries(getTableColumns(table))) {
      const values = (column as { enumValues?: readonly string[] }).enumValues;
      if (values && values.length >= 3) columns.set([...values].sort().join(','), `${name}.${key}`);
    }
  expect(columns.size).toBeGreaterThan(20);
  const allowed: Record<string, string> = {
    // Another program, which states the shape of the answer it expects and does not load the household
    // schema (docs/accepted-tradeoffs.md, "A client states the shape of the answer it expects").
    'src/cli/access-client.ts': 'the command line reading a token\'s kind',
    'src/runtime/body-program-tools.ts': 'a body reading an agent\'s status',
    'src/runtime/conversation-client.ts': 'a body reading its mail and a secret request\'s state',
    // Measuring is handed its store and reads no household table; these are the kinds of thing it times.
    'src/core/measuring/index.ts': 'the kinds of timing Measuring accepts',
  };
  const list = /\[\s*((?:['"][\w-]+['"]\s*,\s*)+['"][\w-]+['"])\s*,?\s*\]/g;
  const copies = sources('src').filter(file => file !== 'src/core/data/schema.ts').flatMap(file => [...text(file).matchAll(list)]
    .map(found => columns.get([...found[1].matchAll(/['"]([\w-]+)['"]/g)].map(word => word[1]).sort().join(',')))
    .filter(column => column !== undefined).map(column => `${file}: ${column}`));
  expect([...new Set(copies.map(copy => copy.split(':')[0]))].sort()).toEqual(Object.keys(allowed).sort());
});

it('writes a day in milliseconds once', () => {
  const copy = /\b86_?400_?000\b|24 ?\* ?60 ?\* ?60 ?\* ?1000/;
  // The two others hand one harness a timeout as text, in that harness's own setting.
  expect(sources('src').filter(file => copy.test(text(file))).sort()).toEqual(['src/core/day.ts', 'src/runtime/body-secret-tools.ts', 'src/runtime/claude-body.ts']);
});
