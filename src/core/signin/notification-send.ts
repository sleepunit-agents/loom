/** Durable, deliberately requested test sends. Never IO inside an operation. */
import webpush from 'web-push';
import { z } from 'zod';
import { isClosing, type Foundation } from '../app.js';
import { migrate } from '../db/index.js';
import type { OutsideEffects } from '../effects.js';
import { operation, OperationError } from '../operations/index.js';
import { SharingDatabase } from '../household/sharing.js';
import { mayAct, maySee, type Viewer } from '../../policy.js';
import { hash, signin } from './index.js';
import { deviceRef, notificationMember, subscription } from './notifications.js';

export interface NotificationSendOptions {
  /** Trusted composition/test seam only, never operation input. */
  send?: typeof webpush.sendNotification;
}
type State = 'queued' | 'sent' | 'gone' | 'failed' | 'uncertain' | 'cancelled';
interface Request { id:string; member:string; ref:string; binding:string; at:number; state:State }
const effectId=(id:string)=>`notifications:test:${id}`;
export function installNotificationSending(app:Foundation,effects:OutsideEffects,options:NotificationSendOptions={}) {
  migrate(app.db,'notifications',[{number:1,sql:`CREATE TABLE notifications_tests (
    id TEXT PRIMARY KEY, member TEXT NOT NULL, ref TEXT NOT NULL, binding TEXT NOT NULL,
    at INTEGER NOT NULL, state TEXT NOT NULL
  )`}]);
  const s=signin(app),sharing=new SharingDatabase(app.db,''),send=options.send??webpush.sendNotification.bind(webpush);
  const allowed=(v:Viewer)=>mayAct(v,{member:v.id},sharing.sharing());
  const rows=()=>app.db.prepare('SELECT * FROM notifications_tests ORDER BY at,id').all() as Request[];
  const publish=(id:string)=>app.live.changed([{type:'notifications.test',id}]);
  const finish=(r:Request,state:State)=>{app.db.prepare('UPDATE notifications_tests SET state=? WHERE id=?').run(state,r.id);publish(r.id);};
  function target(member:string,ref:string){
    if(!allowed({kind:'member',id:member}))return;
    const f=s.sessions.read();
    const hit=Object.entries(f.push?.subs??{}).find(([ep,d])=>deviceRef(ep)===ref&&notificationMember(s,d,f)===member);
    if(!hit||f.push?.removed?.includes(hash(hit[0])))return;
    const parsed=subscription.safeParse(hit[1].sub);
    if(!parsed.success||parsed.data.endpoint!==hit[0]||!f.push?.vapid)return;
    const {publicKey,privateKey}=f.push.vapid;
    if(!publicKey||!privateKey)return;
    return {sub:parsed.data,vapid:{publicKey,privateKey},binding:hash(JSON.stringify([member,hit[0],hit[1],f.push.vapid]))};
  }
  let stopped=false,running:Promise<void>|undefined,again=false,cancel:(()=>void)|undefined;
  const active=()=>!stopped&&!isClosing(app);
  function schedule(){
    if(!active())return;
    if(running){again=true;return;}
    cancel?.();cancel=app.operations.clock.at(app.operations.clock.now(),()=>{cancel=undefined;void flush();});
  }
  async function drain(){
    for(const r of rows().filter(r=>r.state==='queued')){
      if(!active())return;
      const status=effects.status(effectId(r.id));
      if(status==='started'||status==='uncertain'||status==='done'){finish(r,'uncertain');continue;}
      const t=target(r.member,r.ref);
      if(!t||t.binding!==r.binding){finish(r,'cancelled');continue;}
      if(!effects.beforeOutside({id:effectId(r.id),kind:'push',title:'Test notification'}))continue;
      let state:State='sent';
      try {
        await send(t.sub,JSON.stringify({title:'loom',body:'',tag:'loom-test',url:'/p/account-preview'}),{
          vapidDetails:{subject:'mailto:loom@localhost',...t.vapid},TTL:600,urgency:'high',timeout:15_000,
        });
      } catch(error){
        const code=(error as {statusCode?:number}|null)?.statusCode;
        state=code===404||code===410?'gone':typeof code==='number'?'failed':'uncertain';
      }
      // Never erase a re-enabled/reassigned subscription after a late 410.
      const current=target(r.member,r.ref);
      if(state==='gone'&&current?.binding===r.binding){
        s.sessions.change(f=>{delete f.push!.subs![current.sub.endpoint];});
        app.live.changed([{type:'notifications.devices',id:r.member}]);
      }
      effects.finish(effectId(r.id),state!=='uncertain');finish(r,state);
      // The next request resolves policy, exact binding and keys afresh after await.
    }
  }
  function flush():Promise<void>{
    if(running){again=true;return running;}
    if(!active())return Promise.resolve();
    running=drain().catch(()=>{/* Durable rows and effects reconcile on restart. */}).finally(()=>{running=undefined;if(again){again=false;schedule();}});
    return running;
  }
  app.operations.register(operation({name:'notifications.test',write:true,windowOnly:true,doors:['socket'],recheckPolicy:true,
    input:z.object({ref:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),output:z.object({id:z.string(),state:z.literal('queued')}).strict(),
    may:v=>{if(!allowed(v))return false;try{s.notificationBrowser(v);return true;}catch{return false;}},
    run:(ctx,i)=>{
      const t=target(ctx.viewer.id,i.ref);if(!t)throw new OperationError('not-found','No matching notification device');
      if(rows().filter(r=>r.member===ctx.viewer.id&&r.state==='queued').length>=20)throw new OperationError('conflict','Too many pending test notifications');
      const id=hash(JSON.stringify([ctx.receipt!.viewer,ctx.receipt!.id]));
      ctx.db.prepare('INSERT INTO notifications_tests VALUES (?,?,?,?,?,?)').run(id,ctx.viewer.id,i.ref,t.binding,ctx.now,'queued');
      ctx.changed('notifications.test',id);return {id,state:'queued' as const};
    },after:schedule,
  }));
  app.live.register({name:'notifications.test',ids:()=>rows().map(r=>r.id),read:(id,v)=>{
    const r=app.db.prepare('SELECT * FROM notifications_tests WHERE id=?').get(id) as Request|undefined;
    return r&&maySee(v,{member:r.member},sharing.sharing())?{id:r.id,member:r.member,ref:r.ref,at:r.at,state:r.state}:undefined;
  },inScope:(_r,scope)=>scope===undefined,refreshOn:c=>c.type==='core.access'});
  const unrelease=effects.onReleased(id=>{if(id.startsWith('notifications:test:'))schedule();});
  schedule();
  return {async close(){stopped=true;cancel?.();unrelease();await running;}};
}
