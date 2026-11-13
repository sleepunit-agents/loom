/** Own-person credential management; imported app rows only, central member policy. */
import { z } from 'zod';
import type { Foundation } from '../app.js';
import { operation, OperationError } from '../operations/index.js';
import { mayAct, maySee, type Viewer } from '../../policy.js';
import { SharingDatabase } from '../household/sharing.js';
import { hash, signin } from './index.js';
const ref=z.string().regex(/^[0-9a-f]{64}$/);
import { accountCommands, accountResponses } from './account-commands.js';
export function installAccount(app:Foundation){
  const s=signin(app),sharing=new SharingDatabase(app.db,'');
  const allowed=(v:Viewer)=>mayAct(v,{member:v.id},sharing.sharing());
  // Explicit imported member binding survives revocation. An unbound legacy token
  // belongs to the first owner only while it actually authenticates that person.
  const belongs=(secret:string,member:string)=>{const rows=s.tokens.records(secret);return rows.length>0&&rows.every(t=>t.role==='owner'&&(t.member===member||!t.member&&s.token(secret)?.viewer.id===member));};
  const keyRef=(id:string,secret:string)=>hash(JSON.stringify(['passkey',id,secret]));
  const sessionRef=(id:string)=>hash(`account-session:${id}`);
  function descendants(secret:string,member:string){
    const seen=new Set([secret]);let grew=true;
    while(grew){grew=false;for(const t of s.tokens.list())if(t.passkey&&t.from_sha256&&seen.has(t.from_sha256)&&!seen.has(t.sha256)&&belongs(t.sha256,member)){seen.add(t.sha256);grew=true;}}
    return seen;
  }
  function read(member:string){
    const f=s.sessions.read();
    return {member,passkeys:Object.values(f.passkeys??{}).filter(k=>belongs(k.secret,member)).map(k=>({ref:keyRef(k.id,k.secret),label:k.label,created:k.created,...(k.lastUsed!==undefined?{lastUsed:k.lastUsed}:{}),ended:!s.token(k.secret),made:Object.values(f.passkeys??{}).filter(child=>child.id!==k.id&&belongs(child.secret,member)&&descendants(k.secret,member).has(child.secret)).length})),
      sessions:Object.entries(f.sessions).filter(([,x])=>belongs(x.secret,member)).map(([id,x])=>{
        const agent=x.agent||/^HeadlessChrome\b/.test(x.device??'');
        return {ref:sessionRef(id),issuedAt:x.issuedAt,...(x.seenAt!==undefined?{seenAt:x.seenAt}:{}),...(x.label?{label:x.label}:{}),...(x.device?{device:x.device}:{}),...(x.via?{via:x.via}:{}),ended:!s.token(x.secret)||s.now()>=x.issuedAt+(agent?6*3600:30*86400)};
      }).sort((a,b)=>(b.seenAt??b.issuedAt)-(a.seenAt??a.issuedAt))};
  }
  app.operations.register(operation({name:'account.read',input:z.object({}).strict(),output:accountResponses.read,cli:accountCommands()[0],may:allowed,run:ctx=>read(ctx.viewer.id)}));
  app.operations.register(operation({name:'account.removePasskey',write:true,input:z.object({ref,withMade:z.boolean().optional()}).strict(),output:accountResponses.removePasskey,cli:accountCommands()[1],may:allowed,run:(ctx,i)=>{
    const member=ctx.viewer.id,f=s.sessions.read(),key=Object.values(f.passkeys??{}).find(k=>keyRef(k.id,k.secret)===i.ref&&belongs(k.secret,member));
    if(!key)throw new OperationError('not-found','No matching passkey');
    const affected=i.withMade?descendants(key.secret,member):new Set([key.secret]);let removed=0,revoked=0;
    // Old passkeys without a dedicated token lose the credential only, matching
    // removePasskey's legacy !tokenLabel case. Never revoke a shared links token.
    const ownKeys=new Set(Object.values(f.passkeys??{}).filter(k=>belongs(k.secret,member)).map(k=>k.id));
    const dedicated=new Set(s.tokens.list().filter(t=>affected.has(t.sha256)&&belongs(t.sha256,member)&&t.passkey&&(t.sha256!==key.secret||t.passkey===hash(key.id))).map(t=>t.sha256));
    s.tokens.change(tokens=>{for(const t of tokens)if(dedicated.has(t.sha256)&&!t.revoked){t.revoked=new Date(ctx.now).toISOString();revoked++;}});
    s.sessions.change(file=>{for(const [id,k]of Object.entries(file.passkeys??{}))if((id===key.id||i.withMade&&affected.has(k.secret))&&ownKeys.has(k.id)){delete file.passkeys![id];removed++;}});
    ctx.changed('core.access','credentials');ctx.changed('signin.admin','household');ctx.changed('account.self',member);return {removed,revoked};
  }}));
  app.operations.register(operation({name:'account.revokeSession',write:true,input:z.object({ref}).strict(),output:accountResponses.revokeSession,cli:accountCommands()[2],may:allowed,run:(ctx,i)=>{
    let devices=0;
    s.sessions.change(f=>{
      const ids=Object.keys(f.sessions).filter(id=>sessionRef(id)===i.ref&&belongs(f.sessions[id].secret,ctx.viewer.id));
      if(ids.length!==1)throw new OperationError('not-found','No matching session');
      delete f.sessions[ids[0]];
      for(const [ep,d]of Object.entries(f.push?.subs??{}))if(d.session===ids[0]){delete f.push!.subs![ep];devices++;}
    });
    ctx.changed('core.access','credentials');ctx.changed('signin.admin','household');ctx.changed('account.self',ctx.viewer.id);return {revoked:true as const,devices};
  }}));
  function live(member:string){
    const record=read(member),now=app.operations.clock.now(),f=s.sessions.read();
    const deadlines=[...s.tokens.list().filter(t=>belongs(t.sha256,member)&&!t.revoked&&t.expires).map(t=>Date.parse(t.expires!)),...Object.values(f.sessions).filter(x=>belongs(x.secret,member)).map(x=>(x.issuedAt+(x.agent||/^HeadlessChrome\b/.test(x.device??'')?6*3600:30*86400))*1000)].filter(x=>x>now);
    return {id:member,...record,...(deadlines.length?{nextExpiry:Math.min(...deadlines)}:{})};
  }
  app.live.register({name:'account.self',ids:()=>Object.keys(sharing.sharing().members),read:(id,v)=>maySee(v,{member:id},sharing.sharing())?live(id):undefined,inScope:(_r,scope)=>scope===undefined,expires:r=>typeof r.nextExpiry==='number'?r.nextExpiry:undefined,refreshOn:c=>c.type==='core.access'||c.type==='signin.admin'});
}
