/** Trusted browser/token administration on the one approved connection.
 * The outside door supplies scope. No raw cookies, push endpoints or keys leave
 * this reader; all mutation callbacks run inside the caller's DataWrites. */
import { createHash } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { notificationDevices, sessions, tokens } from '../data/schema.js';
const ref = (value: string) => createHash('sha256').update(value).digest('hex');
export function signinAccounts(db: DataDatabase) {
  const sessionRows = (member?: string) => db.select({
    id: sessions.id, member: tokens.member, label: tokens.label, device: sessions.device,
    via: sessions.via, isAgent: sessions.isAgent, issuedAt: sessions.issuedAt,
    seenAt: sessions.seenAt, provedAt: sessions.provedAt,
  }).from(sessions).innerJoin(tokens, eq(tokens.fingerprint, sessions.token))
    .where(member === undefined ? sql`true` : eq(tokens.member, member)).orderBy(asc(sessions.id)).all();
  const devices = (member?: string) => db.select({
    endpoint: notificationDevices.endpoint, member: notificationDevices.member,
    device: notificationDevices.device, createdAt: notificationDevices.createdAt, seenAt: notificationDevices.seenAt,
  }).from(notificationDevices).where(member === undefined ? sql`true` : eq(notificationDevices.member, member)).orderBy(asc(notificationDevices.endpoint)).all();
  return {
    sessions: sessionRows,
    devices(member?: string) { return devices(member).map(({ endpoint, ...row }) => ({ ...row, id: ref(endpoint) })); },
    tokens() { return db.select({
      id: tokens.fingerprint, label: tokens.label, kind: tokens.kind, member: tokens.member,
      agent: tokens.agent, job: tokens.job, box: tokens.box, madeFrom: tokens.madeFrom,
      createdAt: tokens.createdAt, expiresAt: tokens.expiresAt, revokedAt: tokens.revokedAt, lastUsedAt: tokens.lastUsedAt,
    }).from(tokens).orderBy(asc(tokens.label), asc(tokens.fingerprint)).all(); },
    sessionMember(id: string) { return db.select({ member: tokens.member }).from(sessions).innerJoin(tokens, eq(tokens.fingerprint, sessions.token)).where(eq(sessions.id, id)).get()?.member; },
    deviceMember(id: string) { return devices().find(row => ref(row.endpoint) === id)?.member; },
    endSession(id: string) {
      db.transaction(() => {
        db.delete(notificationDevices).where(eq(notificationDevices.session, id)).run();
        db.delete(sessions).where(eq(sessions.id, id)).run();
      });
    },
    removeDevice(id: string) {
      const row = devices().find(row => ref(row.endpoint) === id);
      if (row) db.delete(notificationDevices).where(eq(notificationDevices.endpoint, row.endpoint)).run();
    },
    revokeToken(id: string, at: string) {
      db.update(tokens).set({ revokedAt: at }).where(sql`${tokens.fingerprint} = ${id} and ${tokens.revokedAt} is null`).run();
    },
  };
}
