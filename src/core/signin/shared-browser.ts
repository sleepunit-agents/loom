/** What the door asks of a browser: that a request comes from the program's own pages, and the cleanup when one ends. */
import {createHash} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {eq,inArray} from 'drizzle-orm';
import type {DataDatabase} from '../data/database.js';
import {notificationQueue,notificationDevices,sessions} from '../data/schema.js';
import {relyingParty} from './webauthn.js';
/** A request with no Origin, or one whose Origin is the program's own. */
export function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  // Public URL supports the existing TLS-terminating reverse proxy; never trust forwarded headers.
  const publicOrigin = relyingParty(process.env)?.origin;
  const local = `${'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  return !origin || origin === (publicOrigin && new URL(publicOrigin).host === req.headers.host ? publicOrigin : local);
}
export const browserRef=(id:string)=>createHash('sha256').update('session:'+id).digest('hex');
/** Trusted browser cleanup inside the caller's shared write transaction. */
export function endBrowser(db:DataDatabase,id:string){
 if(!db.$client.inTransaction)throw Error('Browser cleanup requires a transaction');
 db.delete(notificationQueue).where(inArray(notificationQueue.device,db.select({endpoint:notificationDevices.endpoint}).from(notificationDevices).where(eq(notificationDevices.session,id)))).run();
 db.delete(notificationDevices).where(eq(notificationDevices.session,id)).run();
 db.delete(sessions).where(eq(sessions.id,id)).run();
}
