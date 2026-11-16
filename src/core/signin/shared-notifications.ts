import {readPersonalNotificationDevices} from '../data/personal-account-read.js';
/** Browser devices and post-settlement pushes on the shared program. No source
 * words enter a push. Attempts are claimed before IO and never blindly retried.
 */
import {createHash} from 'node:crypto';
import {and,eq,getTableColumns,sql,type AnyColumn,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import type {Viewer} from '../../policy.js';
import type {Clock} from '../clock.js';
import type {DataDatabase} from '../data/database.js';
import type {DataWrites} from '../data/writes.js';
import {members,tokens,sessions,notificationDevices,notificationQueue,inbox} from '../data/schema.js';
import {OperationError,type Operations} from '../operations/index.js';
import {pushTransport,type PushTransport} from './push-transport.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const ref=(endpoint:string)=>hash('notification-device:'+endpoint);
const hosts=[/^fcm\.googleapis\.com$/,/^updates\.push\.services\.mozilla\.com$/,/(^|\.)push\.apple\.com$/,/(^|\.)notify\.windows\.com$/];
const subscription=z.object({endpoint:z.string().max(1000).refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.hash&&hosts.some(host=>host.test(url.hostname));}catch{return false;}}),keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)}).strict()}).strict();
export interface SharedNotificationOptions{vapid:{publicKey:string;privateKey:string};send?:PushTransport}
export function sharedNotifications(options:{db:DataDatabase;clock:Clock;writes:DataWrites;config?:SharedNotificationOptions;browser(viewer:Viewer):Readonly<{session:string}>|undefined;visible(viewer:Viewer,fields:Record<string,AnyColumn>):SQL;reportError(error:unknown):void}){
 const {db,clock}=options;let lastEnrollment=db.select({at:notificationDevices.createdAt}).from(notificationDevices).all().reduce((latest,row)=>Math.max(latest,Date.parse(row.at)),clock.now()-1);let closed=false,again=false,running:Promise<void>|undefined;const aborts=new Set<AbortController>();
 const write=<T>(action:()=>T)=>{const result=options.writes.run(action);for(const _error of result.notificationErrors)try{options.reportError(Error('Push metadata notification failed'));}catch{}return result.value;};
 const member=(viewer:Viewer)=>viewer.kind==='member'&&!!db.select().from(members).where(eq(members.id,viewer.id)).get();
 const device=(endpoint:string)=>{
  const row=db.select().from(notificationDevices).where(eq(notificationDevices.endpoint,endpoint)).get();if(!row)return;
  const session=db.select().from(sessions).where(eq(sessions.id,row.session)).get(),token=session&&db.select().from(tokens).where(eq(tokens.fingerprint,session.token)).get();
  if(!session||session.isAgent||!token||token.kind!=='owner'||token.member!==row.member||token.revokedAt||(token.expiresAt&&Date.parse(token.expiresAt)<=clock.now())||Date.parse(session.issuedAt)+30*86400000<=clock.now()||!db.select().from(members).where(eq(members.id,row.member)).get())return;
  return row;
 };
 const visible=(member:string,id:string)=>db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.id,id),eq(inbox.toKind,'person'),eq(inbox.to,member),eq(inbox.state,'waiting'),eq(inbox.volume,'full'),sql`(${inbox.quietUntil} is null or ${inbox.quietUntil} <= ${new Date(clock.now()).toISOString()})`,options.visible({kind:'member',id:member},getTableColumns(inbox)))).get();
 const remove=(endpoint:string)=>{db.delete(notificationQueue).where(eq(notificationQueue.device,endpoint)).run();db.delete(notificationDevices).where(eq(notificationDevices.endpoint,endpoint)).run();};
 async function drain(){
  if(closed||!options.config)return;
  for(const row of db.select().from(notificationQueue).where(and(eq(notificationQueue.attempts,0),sql`${notificationQueue.sentAt} is null`)).all()){
   if(closed)return;const target=device(row.device);if(!target||!visible(target.member,row.item)){write(()=>db.delete(notificationQueue).where(eq(notificationQueue.id,row.id)).run());continue;}
   const keys=subscription.safeParse({endpoint:target.endpoint,keys:JSON.parse(target.keys)});if(!keys.success){write(()=>remove(target.endpoint));continue;}
   const claim=write(()=>{const current=device(row.device);if(!current||current.session!==target.session||current.keys!==target.keys||!visible(current.member,row.item))return 0;return db.update(notificationQueue).set({attempts:1}).where(and(eq(notificationQueue.id,row.id),eq(notificationQueue.attempts,0))).run().changes;});if(!claim)continue;
   const current=device(row.device);if(closed||!current||current.session!==target.session||current.keys!==target.keys||!visible(current.member,row.item))continue;
   const abort=new AbortController();aborts.add(abort);const stop=clock.at(clock.now()+15000,()=>abort.abort());
   try{await (options.config.send??pushTransport)(keys.data,JSON.stringify({title:'loom',body:'',tag:'loom-inbox',url:'/p/inbox-preview'}),{vapidDetails:{subject:'mailto:loom@localhost',...options.config.vapid},TTL:3600,urgency:'high',timeout:15000},abort.signal);if(!closed)write(()=>db.update(notificationQueue).set({sentAt:new Date(clock.now()).toISOString()}).where(eq(notificationQueue.id,row.id)).run());}
   catch(error){if(!closed&&[404,410].includes((error as {statusCode?:number})?.statusCode??0)){const current=device(target.endpoint);if(current?.session===target.session&&current.keys===target.keys&&current.createdAt===target.createdAt)write(()=>remove(target.endpoint));}}
   finally{stop();aborts.delete(abort);}
  }
 }
 const kick=()=>{if(running){again=true;return;}if(!closed){again=false;running=Promise.resolve().then(drain).catch(()=>{try{options.reportError(Error('Push delivery unavailable'));}catch{}}).finally(()=>{running=undefined;if(again&&!closed)kick();});}};
 return {
  read(member:string){return{publicKey:options.config?.vapid.publicKey??null,devices:readPersonalNotificationDevices(db,member).map(row=>({ref:ref(row.endpoint),device:row.device,createdAt:row.createdAt,seenAt:row.seenAt}))};},
  install(operations:Operations){
   operations.register({name:'notifications.subscribe',write:true,recheckPolicy:true,windowOnly:true,doors:['http'],input:z.object({sub:subscription,device:z.string().trim().min(1).max(120)}).strict(),output:z.object({saved:z.literal(true)}).strict(),may:viewer=>!!options.config&&member(viewer)&&!!options.browser(viewer),run(ctx,input){
    const proof=options.browser(ctx.viewer),session=proof&&db.select().from(sessions).where(eq(sessions.id,proof.session)).get();if(!session||session.isAgent)throw new OperationError('denied','A signed-in person browser is required');
    const old=db.select().from(notificationDevices).where(eq(notificationDevices.endpoint,input.sub.endpoint)).get();if(old&&old.member!==ctx.viewer.id)throw new OperationError('conflict','Device belongs to another member');
    const at=new Date(clock.now()).toISOString(),createdAt=new Date(lastEnrollment=Math.max(clock.now(),lastEnrollment+1)).toISOString(),values={member:ctx.viewer.id,session:session.id,keys:JSON.stringify(input.sub.keys),device:input.device,seenAt:at};
    db.insert(notificationDevices).values({endpoint:input.sub.endpoint,...values,createdAt}).onConflictDoUpdate({target:notificationDevices.endpoint,set:{...values,createdAt}}).run();ctx.changed('notifications',ctx.viewer.id);return{saved:true as const};}});
   operations.register({name:'notifications.removeDevice',write:true,recheckPolicy:true,input:z.object({ref:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),output:z.object({removed:z.literal(true)}).strict(),may:member,run(ctx,input){const row=db.select().from(notificationDevices).where(eq(notificationDevices.member,ctx.viewer.id)).all().find(row=>ref(row.endpoint)===input.ref);if(!row)throw new OperationError('not-found','Device not found');remove(row.endpoint);ctx.changed('notifications',ctx.viewer.id);return{removed:true as const};}});
  },
  publish(member:string,ids:readonly string[]){if(closed||!options.config)return false;write(()=>{for(const target of db.select().from(notificationDevices).where(eq(notificationDevices.member,member)).all())for(const item of ids){if(device(target.endpoint)&&visible(member,item))db.insert(notificationQueue).values({id:hash(JSON.stringify([target.endpoint,item])),device:target.endpoint,item,queuedAt:new Date(clock.now()).toISOString()}).onConflictDoNothing().run();}});kick();return running??Promise.resolve();},
  close(){closed=true;for(const abort of aborts)abort.abort();return running??Promise.resolve();},
 };
}
