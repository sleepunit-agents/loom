/** Rules that were once copied from file to file, each now stated in one place. These fail when a copy comes back. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { agentInput, settingsInput } from './apps/household.js';
import { COMMS_DAYS_DEFAULT, COMMS_DAYS_MAX, commsKeepDays } from './core/data/comms-days.js';
import { createDataSchema } from './core/data/database.js';
import { agents, household } from './core/data/schema.js';
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
    expect(commsKeepDays(db)).toBe(COMMS_DAYS_DEFAULT);
    expect(household.commsDays.default).toBe(COMMS_DAYS_DEFAULT);
    db.insert(household).values({ commsDays: 3 }).run();
    expect(commsKeepDays(db)).toBe(3);
  } finally { client.close(); }
  expect(settingsInput.safeParse({ commsDays: COMMS_DAYS_MAX }).success).toBe(true);
  expect(settingsInput.safeParse({ commsDays: COMMS_DAYS_MAX + 1 }).success).toBe(false);
  const copies = sources('src').filter(file => file !== 'src/core/data/comms-days.ts' && /comms_?[dD]ays\s*\?\?\s*\d|\.days\s*\?\?\s*\d/.test(text(file)));
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
  const door = ['src/core/data/door-limit.ts', 'src/core/data/http.ts', 'src/core/data/socket.ts', 'src/shared-root.ts', 'src/cli/shared-task-client.ts'];
  expect(door.filter(file => /1024 \* 1024|1_048_576|1048576/.test(text(file)))).toEqual(['src/core/data/door-limit.ts']);
  for (const file of door) expect(text(file), file).toContain('DOOR_REQUEST_BYTES');
});
