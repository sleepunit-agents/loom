/** Shared post-claim delivery lifecycle for deliberate and routine notifications. */
import type { Foundation } from '../app.js';
import type { OutsideEffects } from '../effects.js';
import { SharingDatabase } from '../household/sharing.js';
import { signin } from './index.js';
import { notificationTarget } from './notifications.js';
import type { PushTransport } from './push-transport.js';
type Target=NonNullable<ReturnType<typeof notificationTarget>>;
export async function deliverNotification(app:Foundation,effects:OutsideEffects,send:PushTransport,
  request:{effect:string;member:string;ref:string;target:Target;payload:string;ttl:number}) {
  const {target:t}=request,clock=app.operations.clock;
  const abort=new AbortController(),deadline=clock.at(clock.now()+15_000,()=>abort.abort());
  let state:'sent'|'gone'|'failed'|'uncertain'='sent';
  try{await send(t.sub,request.payload,{
    vapidDetails:{subject:'mailto:loom@localhost',...t.vapid},TTL:request.ttl,urgency:'high',timeout:15_000,
  },abort.signal);}catch(error){
    const code=(error as {statusCode?:number}|null)?.statusCode;
    state=code===404||code===410?'gone':typeof code==='number'?'failed':'uncertain';
  }finally{deadline();}
  const s=signin(app),latest=notificationTarget(s,new SharingDatabase(app.db,'').sharing(),request.member,request.ref);
  if(state==='gone'&&latest?.binding===t.binding){
    s.sessions.change(f=>{delete f.push!.subs![latest.sub.endpoint];});
    app.live.changed([{type:'notifications.devices',id:request.member}]);
  }
  effects.finish(request.effect,state!=='uncertain');return state;
}
