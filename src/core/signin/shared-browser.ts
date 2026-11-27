/** A browser at the door: how its session starts, and the cleanup when one ends. Every session row is made
 * here, whichever way the browser proved who it is. Which origins a door takes is core/data/origin.ts. */
import {createHash,randomBytes} from 'node:crypto';
import {eq,inArray} from 'drizzle-orm';
import type {DataDatabase} from '../data/database.js';
import {credentialFingerprint,isAgentBrowser,sessionEnds} from '../data/authentication.js';
import {notificationQueue,notificationReplies,notificationDevices,sessions,signinLinks,tokens} from '../data/schema.js';
import {browserDevice} from './browser-device.js';
type Session = typeof sessions.$inferSelect;
/** Sign a browser in on a member's current token, inside the caller's write transaction. Returns the
 * cookie, which is stored only as its fingerprint, and how long the browser should keep it.
 *
 * `agent` is the link maker's word that the browser is automated; a browser that names itself as one is
 * too. `from` is the browser that made the link this one came in by: the new session is that same proof
 * carried to another device, not a new one, so it is proved when that one was, ends when that one would,
 * and is automated if that one is; and it remembers that browser, so it ends when that one is ended
 * (endBrowser). Without `from` this is a new proof, now. */
export function startBrowser(db: DataDatabase, now: number, input: { token: Pick<typeof tokens.$inferSelect, 'fingerprint' | 'expiresAt'>; userAgent: string;
  via: 'link' | 'passkey'; passkey?: string; agent?: boolean; from?: Pick<Session, 'id' | 'issuedAt' | 'provedAt' | 'isAgent'> }): { cookie: string; maxAge: number } {
  const cookie = randomBytes(32).toString('hex'), at = new Date(now).toISOString();
  const row = { id: credentialFingerprint(cookie), token: input.token.fingerprint, device: browserDevice(input.userAgent), via: input.via, passkey: input.passkey ?? null,
    isAgent: !!input.agent || isAgentBrowser(input.userAgent) || !!input.from?.isAgent, issuedAt: input.from?.issuedAt ?? at, seenAt: at, provedAt: input.from?.provedAt ?? at, madeBy: input.from?.id ?? null };
  const ends = Math.min(sessionEnds(row), input.token.expiresAt ? Date.parse(input.token.expiresAt) : Infinity);
  if (!(ends > now)) throw Error('Sign-in refused');
  db.insert(sessions).values(row).run();
  return { cookie, maxAge: Math.floor((ends - now) / 1000) };
}
/** The cookie header that goes with startBrowser's answer, or, with no cookie, that clears it. */
export function browserCookie(cookie: string, maxAge: number, secure: boolean): string {
  return `loom_ui=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export const browserRef=(id:string)=>createHash('sha256').update('session:'+id).digest('hex');
/** End a browser, inside the caller's shared write transaction: every way a session row goes is this one.
 * What rests on that browser's proof goes with it: the links it made that nobody has used, and the browsers
 * its links signed in, and theirs in turn. A browser is made by one that already exists, so this ends. */
export function endBrowser(db:DataDatabase,id:string){
 if(!db.$client.inTransaction)throw Error('Browser cleanup requires a transaction');
 for(const made of db.select({id:sessions.id}).from(sessions).where(eq(sessions.madeBy,id)).all())endBrowser(db,made.id);
 db.delete(signinLinks).where(eq(signinLinks.session,id)).run();
 db.delete(notificationQueue).where(inArray(notificationQueue.device,db.select({endpoint:notificationDevices.endpoint}).from(notificationDevices).where(eq(notificationDevices.session,id)))).run();
 db.delete(notificationReplies).where(inArray(notificationReplies.device,db.select({endpoint:notificationDevices.endpoint}).from(notificationDevices).where(eq(notificationDevices.session,id)))).run();
 db.delete(notificationDevices).where(eq(notificationDevices.session,id)).run();
 db.delete(sessions).where(eq(sessions.id,id)).run();
}
