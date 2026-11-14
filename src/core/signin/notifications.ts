/** Notification devices belong to members, independently of short-lived sessions. */
import { z } from 'zod';
import webpush from 'web-push';
import type { Foundation } from '../app.js';
import { operation, OperationError } from '../operations/index.js';
import { SharingDatabase } from '../household/sharing.js';
import { mayAct, maySee, type Viewer } from '../../policy.js';
import type { SessionFile } from '../../ui/sessions.js';
import { hash, signin } from './index.js';

type Device = NonNullable<NonNullable<SessionFile['push']>['subs']>[string];
const ref = z.string().regex(/^[0-9a-f]{64}$/);
const hosts = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export const subscription = z.object({
  endpoint:z.string().max(1000).refine(value=>{
    try { const u=new URL(value);return u.protocol==='https:' && !u.port && !u.username && !u.password && !u.hash && hosts.some(h=>h.test(u.hostname)); } catch { return false; }
  }),
  keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)}).strict(),
}).strict();
const deviceRef=(endpoint:string)=>hash(`notification-device:${endpoint}`);
const sessionRef=(id:string)=>hash(`account-session:${id}`);
const info=z.object({ref,session:ref,at:z.number(),seenAt:z.number().optional(),device:z.string().optional()}).strict();

export function installNotifications(app:Foundation) {
  const s=signin(app),sharing=new SharingDatabase(app.db,'');
  const allowed=(v:Viewer)=>mayAct(v,{member:v.id},sharing.sharing());
  const browser=(v:Viewer)=>{if(!allowed(v))return false;try{s.notificationBrowser(v);return true;}catch{return false;}};
  // No first-owner fallback for orphaned imports. Resolve the original retained
  // token group, including revoked records; membership edits pin unbound tokens.
  function member(d:Device,f:SessionFile):string|undefined {
    if(d.member)return d.member;
    const token=d.token ?? f.sessions[d.session]?.secret;
    const rows=token?s.tokens.records(token):[];
    if(!rows.length || rows.some(t=>t.role!=='owner'))return;
    const owners=new Set(rows.map(t=>t.member ?? s.household()?.members.find(m=>m.agents==='*')?.person));
    return owners.size===1 ? [...owners][0] : undefined;
  }
  function read(id:string) {
    const f=s.sessions.read();
    return {member:id,devices:Object.entries(f.push?.subs??{}).filter(([,d])=>member(d,f)===id).map(([ep,d])=>({ref:deviceRef(ep),session:sessionRef(d.session),at:d.at,...(d.seenAt!==undefined?{seenAt:d.seenAt}:{}),...(d.device?{device:d.device}:{})})).sort((a,b)=>(b.seenAt??b.at)-(a.seenAt??a.at))};
  }
  const changed=(ctx:{viewer:Viewer;changed(type:string,id:string):void})=>ctx.changed('notifications.devices',ctx.viewer.id);
  app.operations.register(operation({name:'notifications.read',input:z.object({}).strict(),output:z.object({member:z.string(),devices:z.array(info)}).strict(),may:allowed,run:ctx=>read(ctx.viewer.id)}));
  app.operations.register(operation({name:'notifications.key',write:true,windowOnly:true,doors:['socket'],input:z.object({}).strict(),output:z.object({publicKey:z.string()}).strict(),may:browser,run:()=>{
    return s.sessions.change(f=>{f.push??={};f.push.vapid??=webpush.generateVAPIDKeys();return {publicKey:f.push.vapid.publicKey};});
  }}));
  app.operations.register(operation({name:'notifications.subscribe',write:true,windowOnly:true,doors:['socket'],input:z.object({sub:subscription,again:z.boolean().optional()}).strict(),output:z.object({status:z.enum(['added','removed'])}).strict(),may:browser,run:(ctx,i)=>{
    const proof=s.notificationBrowser(ctx.viewer);
    const status=s.sessions.change(f=>{
      f.push??={};const gone=hash(i.sub.endpoint);
      if(f.push.removed?.includes(gone)){
        if(i.again)return 'removed' as const;
        f.push.removed=f.push.removed.filter(h=>h!==gone);
      }
      const subs=f.push.subs??={},was=subs[i.sub.endpoint],same=was&&member(was,f)===ctx.viewer.id;
      // Quiet registration cannot take another member's device (shared tablet).
      if(was&&!same&&i.again)throw new OperationError('denied','Turn notifications on explicitly for this member');
      subs[i.sub.endpoint]={sub:i.sub,session:proof.session,token:proof.token,member:ctx.viewer.id,at:same?was.at:s.now(),...(same&&i.again?{seenAt:s.now()}:{}),...(proof.device?{device:proof.device}:{})};
      f.push.subs=subs;
      const all=Object.entries(subs).sort((a,b)=>(b[1].seenAt??b[1].at)-(a[1].seenAt??a[1].at));
      for(const [ep]of all.slice(20))delete subs[ep];
      return 'added' as const;
    });changed(ctx);return {status};
  }}));
  app.operations.register(operation({name:'notifications.unsubscribe',write:true,windowOnly:true,doors:['socket'],input:z.object({sub:subscription}).strict(),output:z.object({removed:z.boolean()}).strict(),may:browser,run:(ctx,i)=>{
    const removed=s.sessions.change(f=>{const d=f.push?.subs?.[i.sub.endpoint];if(!d||member(d,f)!==ctx.viewer.id)return false;delete f.push!.subs![i.sub.endpoint];return true;});changed(ctx);return {removed};
  }}));
  app.operations.register(operation({name:'notifications.remove',write:true,input:z.object({ref}).strict(),output:z.object({removed:z.literal(true)}).strict(),may:allowed,run:(ctx,i)=>{
    s.sessions.change(f=>{
      const hit=Object.entries(f.push?.subs??{}).find(([ep,d])=>deviceRef(ep)===i.ref&&member(d,f)===ctx.viewer.id);
      if(!hit)throw new OperationError('not-found','No matching notification device');
      delete f.push!.subs![hit[0]];const gone=hash(hit[0]);f.push!.removed=[...(f.push!.removed??[]).filter(h=>h!==gone),gone].slice(-100);
    });changed(ctx);return {removed:true as const};
  }}));
  app.live.register({name:'notifications.devices',ids:()=>Object.keys(sharing.sharing().members),read:(id,v)=>maySee(v,{member:id},sharing.sharing())?{id,...read(id)}:undefined,inScope:(_r,scope)=>scope===undefined,refreshOn:c=>c.type==='core.access'||c.type==='signin.admin'});
}
