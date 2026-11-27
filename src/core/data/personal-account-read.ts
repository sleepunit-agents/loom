/** Personal credential display metadata; mutations and credential proof remain
 * at the sign-in door. Restrict records before they leave SQLite. */
import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
import { passkeys, sessions, tokens } from './schema.js';

export function readPersonalAccount(db: DataDatabase, member: string) {
  const owned = and(eq(tokens.kind, 'owner'), eq(tokens.member, member));
  const lifetime = { revokedAt: tokens.revokedAt, expiresAt: tokens.expiresAt };
  const keys = db.select({
    id: passkeys.id, label: passkeys.label, createdAt: passkeys.createdAt, lastUsedAt: passkeys.lastUsedAt, ...lifetime,
  }).from(passkeys).innerJoin(tokens, eq(passkeys.token, tokens.fingerprint)).where(owned).all();
  const browsers = db.select({
    id: sessions.id, device: sessions.device, issuedAt: sessions.issuedAt, seenAt: sessions.seenAt,
    isAgent: sessions.isAgent, ...lifetime,
  }).from(sessions).innerJoin(tokens, eq(sessions.token, tokens.fingerprint)).where(owned).all();
  return { passkeys: keys, sessions: browsers };
}
export function readPersonalNotificationDevices(db: DataDatabase, member: string) {
  return db.query.notificationDevices.findMany({columns:{endpoint:true,device:true,createdAt:true,seenAt:true,replies:true},where:f=>eq(f.member,member)}).sync();
}
