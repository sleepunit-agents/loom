import { deliverNotification } from './notification-delivery.js';
/** Durable, deliberately requested test sends. Never IO inside an operation. */
import { pushTransport, type PushTransport } from './push-transport.js';
import { z } from 'zod';
import { isClosing, type Foundation } from '../app.js';
import { migrate } from '../db/index.js';
import type { OutsideEffects } from '../effects.js';
import { operation, OperationError } from '../operations/index.js';
import { SharingDatabase } from '../household/sharing.js';
import { mayAct, maySee, type Viewer } from '../../policy.js';
import { hash, signin } from './index.js';
import { notificationTarget, notificationBrowserAllowed } from './notifications.js';

export interface NotificationSendOptions {
  /** Trusted composition/test seam only, never operation input. */
  send?: PushTransport;
}
type State = 'queued' | 'sent' | 'gone' | 'failed' | 'uncertain' | 'cancelled';
interface Request { id:string; member:string; ref:string; binding:string; at:number; state:State }
const effectId=(id:string)=>`notifications:test:${id}`;
export function installNotificationSending(app:Foundation,effects:OutsideEffects,options:NotificationSendOptions={}) {
  migrate(app.db,'notifications',[{number:1,sql:`CREATE TABLE notifications_tests (
    id TEXT PRIMARY KEY, member TEXT NOT NULL, ref TEXT NOT NULL, binding TEXT NOT NULL,
    at INTEGER NOT NULL, state TEXT NOT NULL
  )`}]);
  const s=signin(app),sharing=new SharingDatabase(app.db,''),send=options.send??pushTransport;
  const allowed=(v:Viewer)=>mayAct(v,{member:v.id},sharing.sharing());
  const rows=()=>app.db.prepare('SELECT * FROM notifications_tests ORDER BY at,id').all() as Request[];
  const publish=(id:string)=>app.live.changed([{type:'notifications.test',id}]);
  const finish=(r:Request,state:State)=>{app.db.prepare('UPDATE notifications_tests SET state=? WHERE id=?').run(state,r.id);publish(r.id);};
  const target=(member:string,ref:string)=>notificationTarget(s,sharing.sharing(),member,ref);
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
      const state=await deliverNotification(app,effects,send,{effect:effectId(r.id),member:r.member,ref:r.ref,target:t,
        payload:JSON.stringify({title:'loom',body:'',tag:'loom-test',url:'/p/account-preview'}),ttl:600});
      finish(r,state);
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
    may:v=>active()&&notificationBrowserAllowed(s,v,sharing.sharing()),
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
