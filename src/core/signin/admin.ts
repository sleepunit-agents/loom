/** Credential-safe administration: no legacy IO and no bearer in retry storage. */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Foundation } from '../app.js';
import { OperationError, type Operation } from '../operations/index.js';
import { HouseholdRows } from '../household/rows.js';
import { hash, signin } from './index.js';
import { cleanLabel } from '../../ui/sessions.js';
const label=z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u);
const isAgentSession=(s:{agent?:true;device?:string})=>s.agent===true||/^HeadlessChrome\b/.test(s.device??'');
const slug=z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
import { accessResponses, accessCommands } from './commands.js';
export function installAccessAdmin(app:Foundation) {
  const s=signin(app);
  const owner:Operation['may']=v=>v.kind==='member'&&s.owner(v.id);
  const safeToken=(t:ReturnType<typeof s.tokens.list>[number])=>{
    const from=t.from_sha256?s.tokens.list().find(p=>p.sha256===t.from_sha256)?.label??t.from:t.from;
    return ({label:t.label,role:t.role,created:t.created,passkey:!!t.passkey,...(t.member?{member:t.member}:{}),...(t.expires?{expires:t.expires}:{}),...(t.revoked?{revoked:t.revoked}:{}),...(t.last_used?{last_used:t.last_used}:{}),...(from?{from}:{})});
  };
  function register<I>(piece:'token'|'sessions',op:Omit<Operation<I>,'output'|'cli'|'may'>) {
    const name=op.name.split('.')[1],responses:Record<string,z.ZodType>=accessResponses[piece];
    app.operations.register({...op,may:owner,output:responses[name],cli:accessCommands(piece).find(c=>c.name===name)});
  }
  const listTokens=()=>s.tokens.list().map(safeToken);
  const listSessions=()=>{
    const tokens=s.tokens.list(),now=s.now();
    return Object.entries(s.sessions.read().sessions).map(([id,x])=>{
      const t=tokens.find(t=>t.sha256===x.secret),resolved=s.token(x.secret),agent=isAgentSession(x);
      return {ref:id.slice(0,16),issuedAt:x.issuedAt,expiresAt:Math.min((x.issuedAt+(agent?6*3600:30*86400))*1000,t?.expires?Date.parse(t.expires):Infinity),...(x.seenAt!==undefined?{seenAt:x.seenAt}:{}),...(x.device?{device:x.device}:{}),...(x.label?{label:x.label}:{}),...(x.via?{via:x.via}:{}),agent,...(t?{token:t.label}:{}),...(resolved?.viewer.kind==='member'?{member:resolved.viewer.id}:{}),ended:!resolved||resolved.viewer.kind!=='member'||now>=x.issuedAt+(agent?6*3600:30*86400)};
    }).sort((a,b)=>(b.seenAt??b.issuedAt)-(a.seenAt??a.issuedAt));
  };
  register('token',{name:'token.list',input:z.object({}).strict(),run:listTokens});
  register('sessions',{name:'sessions.list',input:z.object({}).strict(),run:listSessions});
  // Ephemeral, like signin.link: never journal or retry a returned bearer.
  register('token',{name:'token.create',doors:['http','direct','socket'],input:z.object({label,role:z.enum(['owner','agent','runner','service']),member:slug.optional(),agent:slug.optional(),service:slug.optional(),house:slug.optional(),principal:slug.optional(),expires:z.string().datetime().optional()}).strict(),run:(ctx,i)=>{
    const h=s.household();if(!h)throw new OperationError('unavailable','Household is not initialized');
    let role:string,member:string|undefined;
    if(i.role==='owner') {
      if(!i.member||!h.members.some(m=>m.person===i.member)||i.agent||i.service||i.house||i.principal)throw new OperationError('invalid','Name one household member');
      role='owner';member=i.member;
    } else if(i.role==='agent') {
      if(!i.agent||!h.agents.includes(i.agent)||i.member||i.principal)throw new OperationError('invalid','Name one household agent');
      role=`agent:${i.agent}${i.service?`/${i.service}`:''}${i.house?`@${i.house}`:''}`;
    } else {
      if(!i.principal||i.member||i.agent||i.service||i.house||!new HouseholdRows<{active:boolean}>(ctx.db,'settings').get(`signin-principal:${i.role}:${i.principal}`)?.active)throw new OperationError('invalid','Name one active principal');
      role=`${i.role}:${i.principal}`;
    }
    if(i.expires&&Date.parse(i.expires)<=ctx.now)throw new OperationError('invalid','Expiry must be in the future');
    const token=`loom_${randomBytes(32).toString('base64url')}`;
    const record={label:i.label,role,sha256:hash(token),created:new Date(ctx.now).toISOString(),...(member?{member}:{}),...(i.expires?{expires:i.expires}:{})};
    s.tokens.change(tokens=>{if(tokens.some(t=>t.label===i.label&&!t.revoked&&(!t.expires||Date.parse(t.expires)>ctx.now)))throw new OperationError('conflict','A live token already has that label');tokens.push(record);});
    ctx.changed('signin.admin','household');return {token,record:safeToken(record)};
  }});
  register('sessions',{name:'sessions.revoke',write:true,input:z.union([z.object({ref:z.string().regex(/^[0-9a-f]{16}$/)}).strict(),z.object({label:z.string().min(1).max(60)}).strict()]),run:(ctx,i)=>{
    let revoked=0,devices=0;
    const wanted='label'in i?cleanLabel(i.label):undefined;
    if('label'in i&&!wanted)throw new OperationError('invalid','A nonempty session label is required');
    s.sessions.change(f=>{
      const keys=Object.keys(f.sessions).filter(k=>'ref'in i?k.startsWith(i.ref):(isAgentSession(f.sessions[k])&&f.sessions[k].label===wanted));
      if(!keys.length||('ref'in i&&keys.length!==1))throw new OperationError('not-found','No unique matching session');
      const gone=new Set(keys);for(const k of keys)delete f.sessions[k];revoked=keys.length;
      for(const [ep,d]of Object.entries(f.push?.subs??{}))if(d.session&&gone.has(d.session)){delete f.push!.subs![ep];devices++;}
    });
    ctx.changed('core.access','credentials');ctx.changed('signin.admin','household');return {revoked,devices};
  }});
  register('token',{name:'token.revoke',write:true,input:z.object({label,withPasskeys:z.boolean().optional(),withDevices:z.boolean().optional()}).strict(),run:(ctx,i)=>{
    let revoked=0,passkeys=0,devices=0;
    s.tokens.change(tokens=>{
      const roots=tokens.filter(t=>t.label===i.label&&!t.revoked&&(!t.expires||Date.parse(t.expires)>ctx.now));
      if(!roots.length)throw new OperationError('not-found','No live token has that label');
      const digests=new Set(roots.map(t=>t.sha256)),descendants=new Set<string>();
      let grew=true;while(grew){grew=false;for(const t of tokens){if(!t.passkey||digests.has(t.sha256))continue;const parent=!!t.from_sha256&&digests.has(t.from_sha256);if(parent){digests.add(t.sha256);descendants.add(t.sha256);grew=true;}}}
      const affected=i.withPasskeys?digests:new Set(roots.map(t=>t.sha256));
      for(const t of tokens)if(affected.has(t.sha256)&&!t.revoked){t.revoked=new Date(ctx.now).toISOString();revoked++;}
      s.sessions.change(f=>{
        for(const [id,k]of Object.entries(f.passkeys??{}))if(descendants.has(k.secret)){
          if(i.withPasskeys){delete f.passkeys![id];passkeys++;}else if(tokens.some(t=>t.sha256===k.secret&&!t.revoked&&(!t.expires||Date.parse(t.expires)>ctx.now)))passkeys++;
        }
        if(i.withPasskeys||i.withDevices)for(const [ep,d]of Object.entries(f.push?.subs??{}))if(affected.has(d.token??f.sessions[d.session]?.secret??'')){delete f.push!.subs![ep];devices++;}
      });
    });
    ctx.changed('core.access','credentials');ctx.changed('signin.admin','household');return {revoked,passkeys,devices};
  }});
  app.live.register({name:'signin.admin',ids:()=>['household'],read:(id,v)=>{
    if(id!=='household'||!owner(v,{},app.db))return;
    const sessions=listSessions(),next=sessions.filter(x=>!x.ended&&x.expiresAt>app.operations.clock.now()).map(x=>x.expiresAt);
    return {id,tokens:listTokens(),sessions,...(next.length?{nextExpiry:Math.min(...next)}:{})};
  },inScope:()=>true,expires:r=>typeof r.nextExpiry==='number'?r.nextExpiry:undefined,refreshOn:c=>c.type==='core.access'});
}
