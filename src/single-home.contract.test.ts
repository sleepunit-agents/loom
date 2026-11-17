/** Rules that were once copied from file to file, each now stated in one place. These fail when a copy comes back. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { agentInput, settingsInput } from './apps/household.js';
import { COMMS_DAYS_MAX, commsKeepDays } from './core/data/comms-days.js';
import { keepUntilFor, validKeepDays, wordsDeadline, wordsKept } from './core/conversations/retention.js';
import { createDataSchema } from './core/data/database.js';
import { privateOrigin } from './core/private-origin.js';
import { agents, household } from './core/data/schema.js';
import { DEFAULT_STALE_DAYS, fieldState, freshUntil } from './backends/cards.js';
import { MAX_SLUG } from './backends/people.js';
import { MAX_PROJECT_SLUG } from './backends/projects.js';
import { secretAgent } from './pieces/secrets/input.js';
import { HOUSEHOLD_ID_MAX, PERSON_CARD_SLUG_MAX, PROJECT_CARD_SLUG_MAX, SLUG, householdId, slug } from './slug.js';

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
