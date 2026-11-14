import { call, type Call } from '../../data';
import { frozen, idle } from '../../data/mutation';
import { mutation } from './model';
import { decode } from './encoding';
export interface BrowserSubscription { toJSON():PushSubscriptionJSON; unsubscribe():Promise<boolean> }
export interface NotificationBrowser {
  supported():boolean;
  permission():NotificationPermission;
  ask():Promise<NotificationPermission>;
  current():Promise<BrowserSubscription|null>;
  create(key:string,check:()=>void):Promise<BrowserSubscription>;
}
export const notificationBrowser:NotificationBrowser={
  supported:()=>typeof window!=='undefined'&&window.isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window,
  permission:()=>Notification.permission,
  ask:()=>Notification.requestPermission(),
  current:async()=> (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()??null,
  create:async (key,check)=>{
    const registration=await navigator.serviceWorker.getRegistration('/');
    if(!registration)throw Error('Open loom again to prepare notifications.');
    const bytes=decode(key);
    check();
    return registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
  },
};
/** Window-lifetime flow: a lost reply keeps its original request and continuation. */
export function notificationController(device:NotificationBrowser=notificationBrowser, send:typeof call=call, changes=mutation){
  let state={busy:false,message:'',permission:'default' as NotificationPermission,supported:false,on:false,ref:''};
  let generation=0,runningGeneration=0;
  let enabled=false,checked=false,local:BrowserSubscription|null=null;
  const listeners=new Set<()=>void>();
  const update=(value:Partial<typeof state>)=>{state={...state,...value};listeners.forEach(fn=>fn());};
  const allowed=()=>enabled&&!frozen(changes.getSnapshot().request?.getSnapshot()??idle);
  async function identify(sub:BrowserSubscription){const endpoint=sub.toJSON().endpoint;if(!endpoint)throw Error();const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`notification-device:${endpoint}`));update({ref:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')});}
  const check=()=>{if(!enabled||generation!==runningGeneration)throw Error('Open Account with a live connection to finish turning notifications on.');};
  // result is intentionally observed through subscribe: retry replaces Call.result.
  function write<T>(name:string,input:unknown):Promise<T>{
    const request=send<T>(name,input);changes.set(request as Call,name);
    return new Promise((resolve,reject)=>{
      let stop=()=>{};
      const observe=()=>{const r=request.getSnapshot().result;if(!r)return;
        if(!r.ok&&r.code==='unavailable')return;
        stop();if(r.ok)resolve(r.value);else reject(Error(r.message));
      };
      stop=request.subscribe(observe);observe();
    });
  }
  async function run(work:()=>Promise<void>){
    if(!allowed()||state.busy||!device.supported())return;
    runningGeneration=generation;
    update({busy:true,message:''});
    try{await work();}catch{update({message:'Notifications could not be changed. Check browser settings and the connection, then try again.'});}
    finally{update({busy:false,permission:device.supported()?device.permission():'default'});}
  }
  function reconcile(){
    if(!enabled||checked||state.busy||!device.supported()||!allowed())return;
    checked=true;
    void run(async()=>{
      try{
        local=await device.current();update({on:!!local});check();
        if(!local)return;await identify(local);check();
        const answer=await write<{status:string}>('notifications.subscribe',{sub:local.toJSON(),again:true});
        if(answer.status==='removed'){await local.unsubscribe();local=null;update({on:false});}
      }catch(error){if(generation!==runningGeneration)checked=false;throw error;}
    }).then(()=>{if(!checked&&enabled)reconcile();});
  }
  // A locked entry waits for the existing Account request instead of losing its
  // once-per-window reconciliation. This controller owns no React lifecycle.
  let stopRequest=()=>{};
  changes.subscribe(()=>{
    stopRequest();
    stopRequest=changes.getSnapshot().request?.subscribe(()=>queueMicrotask(reconcile))??(()=>{});
    queueMicrotask(reconcile);
  });
  return {
    getSnapshot:()=>state,
    subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
    setEnabled(value:boolean){
      if(enabled!==value)generation++;enabled=value;
      const supported=device.supported();update({supported,permission:supported?device.permission():'default'});
      reconcile();
    },
    enable(){return run(async()=>{
      // Ask directly from the user's click, before any asynchronous work.
      if(await device.ask()!=='granted'){update({message:'Notifications are blocked. Allow them in this browser’s site settings.'});return;}
      check();const {publicKey}=await write<{publicKey:string}>('notifications.key',{});check();
      local=await device.current();check();
      if(!local)local=await device.create(publicKey,check);check();await identify(local);check();
      const answer=await write<{status:string}>('notifications.subscribe',{sub:local.toJSON()});
      update({on:answer.status==='added'});
    });},
    disable(){return run(async()=>{
      local=await device.current();check();if(!local){update({on:false});return;}
      await write('notifications.unsubscribe',{sub:local.toJSON()});
      // Do not discard the local subscription until the server definitely answered.
      await local.unsubscribe();local=null;update({on:false});
    });},
  };
}
