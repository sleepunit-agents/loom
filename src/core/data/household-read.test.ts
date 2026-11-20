/** Setup lists a browser as ended exactly when the door would refuse it. Fictional people. */
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from './database.js';
import { readHouseholdSetup } from './household-read.js';
import { currentSession } from './authentication.js';
import { members, sessions, tokens } from './schema.js';

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });

it('lists a browser as ended when the door would refuse it, whatever the reason', () => {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const at = '2026-11-17T12:00:00.000Z', now = Date.parse(at), db = createDataSchema(client, () => at);
  for (const id of ['sam', 'gone', 'revoked', 'old']) {
    db.insert(members).values({ id, role: 'member', joinedAt: at }).run();
    db.insert(tokens).values({ fingerprint: id.padEnd(64, '0'), label: id, kind: 'owner', member: id, createdAt: at }).run();
    db.insert(sessions).values({ id: id.padEnd(64, '1'), token: id.padEnd(64, '0'), device: 'Browser', isAgent: false, via: 'link', issuedAt: at, seenAt: at, provedAt: at }).run();
  }
  // gone was removed from the household; revoked's token was revoked. sam is as before.
  db.update(members).set({ removedAt: at }).where(eq(members.id, 'gone')).run();
  db.update(tokens).set({ revokedAt: at }).where(eq(tokens.member, 'revoked')).run();
  // old signed in long ago: the session has run out.
  db.update(sessions).set({ issuedAt: '2026-01-01T00:00:00.000Z' }).where(eq(sessions.id, 'old'.padEnd(64, '1'))).run();
  const listed = Object.fromEntries(readHouseholdSetup(db, at).sessions.map(row => [row.member, row.ended]));
  expect(listed).toEqual({ sam: false, gone: true, revoked: true, old: true });
  // And it is the door's own answer, not a second rule beside it.
  for (const id of ['sam', 'gone', 'revoked', 'old']) expect(!currentSession(db, id.padEnd(64, '1'), now), id).toBe(listed[id]);
});
