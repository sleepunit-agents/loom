/**
 * Ensure a person card (docs/specs/person-cards.md, "Ensure"): a minimal card when there's
 * none, only the missing `where` values when there is one, one card per person.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeopleStore } from './people.js';
import { checkEnsureInput, ensurePerson, ensureSummary, holdsValue } from './people-ensure.js';
import { commonsPeoplePath, openHouseholdPeople } from './people-household.js';
import { agentDir, loadHousehold, type Household } from '../household.js';
import { resolveSqliteDbPath } from '../config.js';

const SOURCE = "shuttle gates (art's people), allowed by the owner 2026-11-02";
const grace = {
  slug: 'grace-aquino', name: 'Grace Aquino', role: 'Toxicologist', source: SOURCE,
  where: { slack: { value: 'U08C330F8AG (Onterris)' } },
};

describe('ensurePerson, one store', () => {
  let s: PeopleStore;
  beforeEach(() => { s = new PeopleStore({ dbPath: ':memory:', actor: 'owner' }); });
  afterEach(() => s.close());

  it('with no card, makes a minimal one: the name, "<role>. From <source>.", and where', () => {
    const out = ensurePerson(s, checkEnsureInput(grace));
    expect(out).toMatchObject({ slug: 'grace-aquino', created: true, unchanged: false, added: { slack: ['U08C330F8AG (Onterris)'] } });
    const card = s.getRow('grace-aquino')!.card;
    expect(card).toEqual({
      slug: 'grace-aquino', name: 'Grace Aquino', summary: `Toxicologist. From ${SOURCE}.`,
      where: { slack: { value: 'U08C330F8AG (Onterris)', source: SOURCE } }, how: {}, may: [],
    });
    expect(s.history('grace-aquino')).toHaveLength(0);
  });

  it('with a card, only adds the where values it lacks: name, summary, how and may stay', () => {
    s.write({ slug: 'grace-aquino', name: 'Grace A.', summary: 'Onterris toxicologist, hand-written.', how: { mode: 'terse' },
      may: [{ text: 'DM Art about pond', source: 'Jonathan' }],
      where: { slack: { value: 'U08C330F8AG (Onterris)', label: 'G R A C E', verified_at: '2026-11-02T19:00:00Z' } } });
    const before = s.getRow('grace-aquino')!.card;
    // The same id, written another way, counts as there: nothing changes and nothing is stored.
    const same = ensurePerson(s, checkEnsureInput({ ...grace, name: 'Someone Else', role: 'Not this', where: { slack: { value: 'U08C330F8AG' } } }));
    expect(same).toMatchObject({ created: false, unchanged: true, added: {} });
    expect(s.getRow('grace-aquino')!.card).toEqual(before);
    expect(s.history('grace-aquino')).toHaveLength(0);

    const more = ensurePerson(s, checkEnsureInput({ ...grace, name: 'Someone Else', where: {
      slack: { value: ['U08C330F8AG (Onterris)', 'U0SECOND (Other)'], label: 'ignored: there is one' },
      discord: { value: '216348202406772736', label: '@grace' } } }));
    expect(more).toMatchObject({ created: false, unchanged: false, added: { slack: ['U0SECOND (Other)'], discord: ['216348202406772736'] } });
    const after = s.getRow('grace-aquino')!.card;
    expect({ ...after, where: undefined }).toEqual({ ...before, where: undefined });
    expect(after.where.slack).toEqual({ value: ['U08C330F8AG (Onterris)', 'U0SECOND (Other)'], label: 'G R A C E', verified_at: '2026-11-02T19:00:00Z', source: SOURCE });
    expect(after.where.discord).toEqual({ value: '216348202406772736', label: '@grace', source: SOURCE });
  });

  it('refuses a value already on another card: one person, one card', () => {
    s.write({ slug: 'jonathan-barket', name: 'Jonathan Barket', where: { discord: { value: '216348202406772736' } } });
    expect(() => ensurePerson(s, checkEnsureInput({ slug: 'jonathan', name: 'Jonathan', source: SOURCE, where: { discord: { value: '216348202406772736' } } })))
      .toThrow(/216348202406772736 is already on jonathan-barket's card/);
    expect(s.getRow('jonathan')).toBeNull();
  });

  it('refuses an archived card, a bad slug, reserved keys and anything unknown', () => {
    s.write({ slug: 'gone', name: 'Gone' });
    s.archive({ slug: 'gone', reason: 'left', actor: 'owner' });
    expect(() => ensurePerson(s, checkEnsureInput({ slug: 'gone', name: 'Gone', source: SOURCE }))).toThrow(/archived/);
    for (const slug of ['../x', 'Grace', '', 'a'.repeat(65)]) expect(() => checkEnsureInput({ ...grace, slug })).toThrow(/^slug: /);
    expect(() => checkEnsureInput({ ...grace, where: { tier: { value: '2' } } })).toThrow(/where\.tier: "tier" is a reserved key/);
    expect(() => checkEnsureInput({ ...grace, where: { slack: { value: 'U1', tier: 2 } } })).toThrow(/reserved key/);
    expect(() => checkEnsureInput({ ...grace, tier: 2 })).toThrow(/tier: unknown key/);
    expect(() => checkEnsureInput({ ...grace, summary: 'x' })).toThrow(/summary: unknown key/);
    expect(() => checkEnsureInput({ ...grace, name: '' })).toThrow(/name: is required/);
    expect(() => checkEnsureInput({ ...grace, source: undefined })).toThrow(/source: is required/);
    expect(() => checkEnsureInput({ ...grace, where: { Slack: { value: 'U1' } } })).toThrow(/field name must match/);
  });

  it('a dry run says what it would do and writes nothing', () => {
    const out = ensurePerson(s, checkEnsureInput({ ...grace, dry_run: true }));
    expect(out).toMatchObject({ created: true, dry_run: true, card: { summary: `Toxicologist. From ${SOURCE}.` } });
    expect(s.getRow('grace-aquino')).toBeNull();
  });

  it('the summary line, and the id test reach shares', () => {
    expect(ensureSummary('Toxicologist.', 'x')).toBe('Toxicologist. From x.');
    expect(ensureSummary(undefined, 'x')).toBe('From x.');
    expect(holdsValue(['U02AYL3QX (Onterris), DM D0…'], 'U02AYL3QX (Onterris)')).toBe(true);
    expect(holdsValue(['U02AYL3QXY'], 'U02AYL3QX')).toBe(false);
  });
});

describe('ensurePerson, in a household', () => {
  let h: Household;
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'loom-ensure-hh-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    h = loadHousehold(home)!;
  });
  afterEach(() => rmSync(h.home, { recursive: true, force: true }));

  it("a new card's name and handles go to the directory, its summary to the named agent's relationship", () => {
    const st = openHouseholdPeople(h, 'mark', agentDir(h, 'mark'), { actor: 'jonathan via shuttle' })!;
    try { ensurePerson(st, checkEnsureInput({ ...grace, agent: 'mark' })); } finally { st.close(); }
    const dir = new PeopleStore({ dbPath: commonsPeoplePath(h), readonly: true });
    const rel = new PeopleStore({ dbPath: resolveSqliteDbPath(agentDir(h, 'mark')), readonly: true });
    try {
      expect(dir.getRow('grace-aquino')!.card).toMatchObject({ name: 'Grace Aquino', where: { slack: { value: 'U08C330F8AG (Onterris)' } } });
      expect(dir.getRow('grace-aquino')!.card.summary).toBeUndefined();
      expect(rel.getRow('grace-aquino')!.card.summary).toBe(`Toxicologist. From ${SOURCE}.`);
    } finally { dir.close(); rel.close(); }
  });

  it("adding to an existing card touches only the directory: no relationship is made for an agent that hasn't met them", () => {
    const art = openHouseholdPeople(h, 'art', agentDir(h, 'art'))!;
    try { art.write({ slug: 'grace-aquino', name: 'Grace Aquino', summary: "Art's own words." }); } finally { art.close(); }
    const st = openHouseholdPeople(h, 'mark', agentDir(h, 'mark'), { actor: 'owner' })!;
    try {
      expect(ensurePerson(st, checkEnsureInput({ ...grace, agent: 'mark' }))).toMatchObject({ created: false, added: { slack: ['U08C330F8AG (Onterris)'] } });
    } finally { st.close(); }
    const rel = new PeopleStore({ dbPath: resolveSqliteDbPath(agentDir(h, 'mark')), readonly: true });
    try { expect(rel.getRow('grace-aquino')).toBeNull(); } finally { rel.close(); }
    const artRel = new PeopleStore({ dbPath: resolveSqliteDbPath(agentDir(h, 'art')), readonly: true });
    try { expect(artRel.getRow('grace-aquino')!.card.summary).toBe("Art's own words."); } finally { artRel.close(); }
  });
});
