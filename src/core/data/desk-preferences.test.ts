import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { members, memberPreferences as preferencesTable } from './schema';
import { memberPreferences, memberPreferencesQuery, type MemberPreferencesData, type MemberPreferenceRow } from '../../../web/src/shell/member-preferences';
const identity = { status: 'live' as const, data: { homeComms: { member: 'sam', agents: [], summaries: [] } } };
const row: MemberPreferenceRow = { member: 'sam', look: 'daylight', ground: 'wash', sound: false, pixel: false, haptics: false, oneWindow: true, zoom: true, motion: 'on', contrast: 'off', changedAt: '2026-11-14T00:00:00.000Z' };
const query = { status: 'live' as const, data: { memberPreferences: [{ ...row, member: 'other', look: 'lowlight' as const }, row] } };
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
it('executes the exact desk query against generated SQL, sees changed choices and clears revoked reads', async () => {
  const client = new Database(':memory:'); opened.push(client);
  const db = createDataSchema(client, () => row.changedAt);
  db.insert(members).values([{ id: 'sam', role: 'member', joinedAt: row.changedAt }, { id: 'other', role: 'member', joinedAt: row.changedAt }]).run();
  // The table still has `icons` (kept, unused: the web app no longer asks for it), so the stored rows carry one.
  db.insert(preferencesTable).values(query.data.memberPreferences.map(stored => ({ ...stored, icons: false }))).run();
  let allowed = 'sam';
  const schema = dataQueries(client, { tables: ['memberPreferences'], visibility: { memberPreferences: fields => eq(fields.member, allowed) } });
  const read = async () => {
    const result = await graphql({ schema, source: memberPreferencesQuery });
    expect(result.errors).toBeUndefined();
    return memberPreferences(identity, { status: 'live', data: result.data as MemberPreferencesData });
  };
  expect((await read()).records[0].prefs).toMatchObject({ look: 'daylight', oneWindow: true, pixel: false });
  db.update(preferencesTable).set({ look: 'lowlight', oneWindow: false }).where(eq(preferencesTable.member, 'sam')).run();
  expect((await read()).records[0].prefs).toMatchObject({ look: 'lowlight', oneWindow: false });
  allowed = 'revoked'; expect((await read()).records).toEqual([]);
});
