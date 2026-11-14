import { deliverNotification } from './notification-delivery.js';
/** Routine notifications: durable member dedupe, bounded admission, no backlog. */
import { isClosing, type Foundation } from '../app.js';
import { migrate } from '../db/index.js';
import type { OutsideEffects } from '../effects.js';
import { SharingDatabase } from '../household/sharing.js';
import { deviceRef, notificationMember, notificationTarget } from './notifications.js';
import { hash, signin } from './index.js';
import { pushTransport } from './push-transport.js';
import type { NotificationSendOptions } from './notification-send.js';

export interface Announcement { key:string; url:string }
interface Item { id:string; member:string; key:string; at:number; state:string }
interface Attempt { id:string; item:string; ref:string; binding:string; state:string }
const minute=60_000;
const effectId=(id:string)=>`notifications:announcement:${id}`;
/** The source role must return only this member's currently visible candidates. */
export function installNotificationAnnouncements(app:Foundation,effects:OutsideEffects,candidates:(member:string)=>Announcement[],options:NotificationSendOptions={}) {
  migrate(app.db,'notifications',[{number:2,sql:`
    CREATE TABLE notifications_announcement_seed (id INTEGER PRIMARY KEY CHECK(id=1));
    CREATE TABLE notifications_announcements (id TEXT PRIMARY KEY, member TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE notifications_announcement_attempts (id TEXT PRIMARY KEY, item TEXT NOT NULL, ref TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL);
  `}]);
  const s=signin(app),sharing=new SharingDatabase(app.db,''),clock=app.operations.clock,send=options.send??pushTransport;
  let stopped=false,running:Promise<void>|undefined,again=false,cancel:(()=>void)|undefined;
  const active=()=>!stopped&&!isClosing(app);
  const items=()=>app.db.prepare("SELECT * FROM notifications_announcements WHERE state='queued' ORDER BY at,id").all() as Item[];
  const attempts=(id:string)=>app.db.prepare("SELECT * FROM notifications_announcement_attempts WHERE item=? AND state='queued' ORDER BY id").all(id) as Attempt[];
  const target=(member:string,ref:string)=>notificationTarget(s,sharing.sharing(),member,ref);
  const current=(r:Item)=>Object.hasOwn(sharing.sharing().members,r.member)&&candidates(r.member).find(c=>c.key===r.key);
  function finish(a:Attempt,state:string){app.db.prepare('UPDATE notifications_announcement_attempts SET state=? WHERE id=?').run(state,a.id);}
  function admit(){
    const access=sharing.sharing();
    const now=Object.keys(access.members).sort().flatMap(member=>candidates(member).map(c=>({member,...c})));
    app.db.transaction(()=>{
      const seeded=!!app.db.prepare('SELECT 1 FROM notifications_announcement_seed').get();
      let room=5-(app.db.prepare("SELECT count(*) AS n FROM notifications_announcements WHERE state!='seeded' AND at>?").get(clock.now()-minute) as {n:number}).n;
      for(const c of now){
        const id=hash(JSON.stringify([c.member,c.key]));
        if(app.db.prepare('SELECT 1 FROM notifications_announcements WHERE id=?').get(id))continue;
        if(seeded&&room<=0)continue; // Deferred candidates stay unmarked.
        if(seeded)room--;
        app.db.prepare('INSERT INTO notifications_announcements VALUES (?,?,?,?,?)').run(id,c.member,c.key,clock.now(),seeded?'queued':'seeded');
        if(!seeded)continue;
        const f=s.sessions.read();
        for(const [ep,d] of Object.entries(f.push?.subs??{})){
          if(notificationMember(s,d,f)!==c.member)continue;
          const ref=deviceRef(ep),t=target(c.member,ref);if(!t)continue;
          app.db.prepare('INSERT INTO notifications_announcement_attempts VALUES (?,?,?,?,?)').run(hash(JSON.stringify([id,ref])),id,ref,t.binding,'queued');
        }
      }
      app.db.prepare('INSERT OR IGNORE INTO notifications_announcement_seed VALUES (1)').run();
    })();
  }
  async function drain(){
    for(const r of items()){
      for(const a of attempts(r.id)){
        if(!active())return;
        const status=effects.status(effectId(a.id));
        if(status==='started'||status==='uncertain'||status==='done'){finish(a,'uncertain');continue;}
        const c=current(r),t=target(r.member,a.ref);
        if(!c||!t||t.binding!==a.binding){finish(a,'cancelled');continue;}
        // Payloads contain no source words, device data or credential material.
        if(!effects.beforeOutside({id:effectId(a.id),kind:'push',title:'Routine notification'}))continue;
        const state=await deliverNotification(app,effects,send,{effect:effectId(a.id),member:r.member,ref:a.ref,target:t,
          payload:JSON.stringify({title:'loom',body:'',tag:`ask-${hash(r.key)}`,url:c.url}),ttl:6*3600});
        finish(a,state);
        // All source/authority/device facts are re-read before the next send.
      }
      if(!attempts(r.id).length)app.db.prepare("UPDATE notifications_announcements SET state='done' WHERE id=?").run(r.id);
    }
  }
  function schedule(at=clock.now()){
    if(!active())return;
    if(running){again=true;return;}
    cancel?.();cancel=clock.at(at,()=>{cancel=undefined;void flush();});
  }
  function flush():Promise<void>{
    if(running){again=true;return running;}
    if(!active())return Promise.resolve();
    running=drain().catch(()=>{/* Persisted claims reconcile on the next pass. */}).finally(()=>{
      running=undefined;
      if(again){again=false;schedule();}
    });return running;
  }
  function tick(){
    if(!active())return;
    try{admit();schedule();}catch{/* No partial admission or diagnostic leakage; retry the next sample. */}
    finally{
      // Resume once at the current instant after sleep/clock jumps, never replay
      // every elapsed minute or create a burst of old admission samples.
      nextTick=clock.at(clock.now()+minute,()=>{queueMicrotask(tick);});
    }
  }
  const unrelease=effects.onReleased(id=>{if(id.startsWith('notifications:announcement:'))schedule();});
  let nextTick:(()=>void)|undefined;
  tick(); // Baseline is committed before startup returns; later devices hear only new items.
  return {async close(){stopped=true;cancel?.();nextTick?.();unrelease();await running;}};
}
