/** Trusted browser cleanup inside the caller's shared write transaction. */
import {createHash} from 'node:crypto';
import {eq,inArray} from 'drizzle-orm';
import type {DataDatabase} from '../data/database.js';
import {notificationQueue,notificationDevices,sessions} from '../data/schema.js';
export const browserRef=(id:string)=>createHash('sha256').update('session:'+id).digest('hex');
export function endBrowser(db:DataDatabase,id:string){
 if(!db.$client.inTransaction)throw Error('Browser cleanup requires a transaction');
 db.delete(notificationQueue).where(inArray(notificationQueue.device,db.select({endpoint:notificationDevices.endpoint}).from(notificationDevices).where(eq(notificationDevices.session,id)))).run();
 db.delete(notificationDevices).where(eq(notificationDevices.session,id)).run();
 db.delete(sessions).where(eq(sessions.id,id)).run();
}
