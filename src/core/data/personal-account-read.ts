/** Personal credential display metadata; mutations and credential proof remain
 * at the sign-in door. Restrict records before they leave SQLite. */
import { and, eq, inArray } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
export function readPersonalAccount(db: DataDatabase, member: string) {
  const own = db.query.tokens.findMany({columns:{fingerprint:true,revokedAt:true,expiresAt:true},where:f=>and(eq(f.kind,'owner'),eq(f.member,member))}).sync();
  const ids = own.map(row=>row.fingerprint);
  const passkeys = db.query.passkeys.findMany({columns:{id:true,token:true,label:true,createdAt:true,lastUsedAt:true},where:f=>inArray(f.token,ids)}).sync();
  const sessions = db.query.sessions.findMany({columns:{id:true,token:true,device:true,issuedAt:true,seenAt:true,isAgent:true},where:f=>inArray(f.token,ids)}).sync();
  return {tokens:new Map(own.map(row=>[row.fingerprint,row])),passkeys,sessions};
}
export function readPersonalNotificationDevices(db: DataDatabase, member: string) {
  return db.query.notificationDevices.findMany({columns:{endpoint:true,device:true,createdAt:true,seenAt:true},where:f=>eq(f.member,member)}).sync();
}
