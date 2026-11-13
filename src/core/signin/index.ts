/** Next-mode credentials. Only loom.db is consulted; no legacy file activation. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { migrate } from '../db/index.js';
import type { Foundation } from '../app.js';
import type { Authentication } from '../live/index.js';
import { OperationError } from '../operations/index.js';
import { HouseholdDatabase } from '../household/document.js';
import { HouseholdRows } from '../household/rows.js';
import { TokenDatabase } from '../household/tokens.js';
import { SessionDatabase } from '../../ui/session-db.js';
import { mayAct, type Viewer } from '../../policy.js';
import { SharingDatabase } from '../household/sharing.js';
import { ALGS, relyingParty, verifyAssertion, verifyRegistration } from './webauthn.js';
export { relyingParty } from './webauthn.js';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('hex');
interface StoredSession { issuedAt: number; secret: string; signedInAt?: number; agent?: true; device?: string; label?: string; via?: 'token'|'link'|'passkey' }
interface BrowserSession { s: StoredSession; viewer: Viewer; expiresAt: number }
const MONTH = 30 * 86400, HOURS = 6 * 3600;
const clean = (s?: string) => (s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,' ').replace(/\s+/g,' ').trim().slice(0,60);
/** Normalize before truncation: ordinary headless UAs begin with Mozilla and can be long. */
function deviceOf(ua?: string): string | undefined {
  if (!ua) return;
  const browser = /HeadlessChrome\//.test(ua) ? 'HeadlessChrome' : /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /^curl\//.test(ua) ? 'curl' : undefined;
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : undefined;
  return browser && system ? `${browser} on ${system}` : browser ?? system;
}
const eq = (a: string,b: string) => timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
export function cookieId(req: IncomingMessage): string | undefined {
  const value = (req.headers.cookie ?? '').split(';').map(p=>p.trim()).find(p=>p.startsWith('loom_ui='))?.slice(8);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
export function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  // Public URL supports the existing TLS-terminating reverse proxy; never trust forwarded headers.
  const publicOrigin = relyingParty(process.env)?.origin;
  const local = `${'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  return !origin || origin === (publicOrigin && new URL(publicOrigin).host === req.headers.host ? publicOrigin : local);
}
const stores = new WeakMap<Foundation, Signin>();
export function signin(app: Foundation): Signin {
  let store = stores.get(app); if (!store) { store=new Signin(app); stores.set(app,store); } return store;
}
export class Signin {
  readonly sessions: SessionDatabase;
  readonly tokens: TokenDatabase;
  private readonly key: Buffer;
  constructor(private app: Foundation) {
    this.sessions=new SessionDatabase(app.db); this.tokens=new TokenDatabase(app.db);
    const rows=new HouseholdRows<string>(app.db,'settings');
    this.key=Buffer.from(app.db.transaction(()=>{ const key=rows.get('signin-csrf-key') ?? random(); rows.put('signin-csrf-key',key); return key; }).immediate(),'hex');
  }
  now() { return Math.floor(this.app.operations.clock.now()/1000); }
  household() { return new HouseholdDatabase(this.app.db).household(''); }
  owner(id: string) { return mayAct({kind:'member',id},{},new SharingDatabase(this.app.db,'').sharing(),'household'); }
  token(digest: string): { viewer: Viewer; expiresAt?: number } | undefined {
    const now=this.app.operations.clock.now(), h=this.household(); if (!h) return;
    const t=this.tokens.records(digest).find(t=>!t.revoked && (!t.expires || Date.parse(t.expires)>now)); if (!t) return;
    let viewer: Viewer | undefined;
    if (t.role==='owner') { const id=t.member ?? h.members.find(m=>m.agents==='*')?.person; if (id && h.members.some(m=>m.person===id)) viewer={kind:'member',id}; }
    const a=/^agent:([a-z0-9-]+)(?:\/[a-z0-9-]+)?(?:@[a-z0-9-]+)?$/.exec(t.role);
    if (a && h.agents.includes(a[1])) viewer={kind:'agent',id:a[1]};
    const r=/^(runner|service):([a-z0-9-]+)$/.exec(t.role);
    if (r && new HouseholdRows<{active:boolean}>(this.app.db,'settings').get(`signin-principal:${r[1]}:${r[2]}`)?.active) viewer={kind:r[1] as 'runner'|'service',id:r[2]};
    return viewer ? {viewer,...(t.expires?{expiresAt:Date.parse(t.expires)}:{})} : undefined;
  }
  csrf(id: string) { return createHmac('sha256',this.key).update(`loom-next-csrf|${id}`).digest('hex'); }
  checkCsrf(req: IncomingMessage, value: string) { const id=cookieId(req); return !!id && eq(value,this.csrf(id)); }
  session(id: string): BrowserSession | undefined {
    const s=this.sessions.get('sessions',hash(id)); if (!s) return;
    const max=s.agent || /^HeadlessChrome\b/.test(s.device ?? '') ? HOURS : MONTH;
    if (this.now() >= s.issuedAt+max) return;
    const t=this.token(s.secret); if (!t || t.viewer.kind!=='member') return;
    return {s,...t,expiresAt:Math.min((s.issuedAt+max)*1000,t.expiresAt ?? Infinity)};
  }
  resolve(req: IncomingMessage): Authentication | undefined {
    const bearer=/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (bearer) {
      const digest=hash(bearer[1]), t=this.token(digest); if (!t) return;
      const valid=()=>{const current=this.token(digest);return !!current && current.viewer.kind===t.viewer.kind && current.viewer.id===t.viewer.id;};
      return {...t,valid};
    }
    const id=cookieId(req); if (!id) return;
    const s=this.session(id); if (!s) return;
    // Cookie socket upgrades always need an Origin, unlike nonbrowser bearer callers.
    if (req.headers.upgrade && (!req.headers.origin || !sameOrigin(req))) return;
    if (!['GET','HEAD','OPTIONS'].includes(req.method ?? 'GET') && !this.checkCsrf(req,String(req.headers['x-loom-csrf'] ?? ''))) return;
    return {viewer:s.viewer,expiresAt:s.expiresAt,valid:()=>{const c=this.session(id);return !!c && c.s.secret===s.s.secret && c.viewer.id===s.viewer.id;}};
  }
  createSession(secret: string, meta: { label?: string; signedInAt?: number; agent?: true; via?: 'link'|'passkey'; device?: string } = {}) {
    if (this.token(secret)?.viewer.kind!=='member') throw new Error('Sign-in refused');
    const id=random(), now=this.now();
    this.sessions.change(f=>{
      f.sessions[hash(id)]={issuedAt:now,secret,...meta,...(/HeadlessChrome\b/.test(meta.device ?? '')?{agent:true as const}:{})};
      const rank=(s:typeof f.sessions[string])=>!this.token(s.secret) || now>=s.issuedAt+(s.agent?HOURS:MONTH)?0:s.agent||/^HeadlessChrome\b/.test(s.device ?? '')?1:2;
      const all=Object.entries(f.sessions).sort((a,b)=>rank(a[1])-rank(b[1])||a[1].issuedAt-b[1].issuedAt);
      for(const [key] of all.slice(0,Math.max(0,all.length-50))) delete f.sessions[key];
    });
    this.app.live.refreshAccess(); return id;
  }
  cookie(id: string, req: IncomingMessage) {
    const secure=!!('encrypted' in req.socket && req.socket.encrypted) || !!(process.env.LOOM_PUBLIC_URL?.startsWith('https://'));
    return `loom_ui=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${id?MONTH:0}${secure?'; Secure':''}`;
  }
  end(id: string) { this.sessions.change(f=>{delete f.sessions[hash(id)];}); this.app.live.refreshAccess(); }
  link(member: string, label?: string, agent?: boolean, signedInAt?: number, ttl=300) {
    const h=this.household(); if (!h?.members.some(m=>m.person===member)) throw new OperationError('invalid','Unknown member');
    const code=random();
    this.app.db.transaction(()=>{
      let secret: string | undefined;
      this.tokens.change(tokens=>{
        const name=`page sign-in links · ${member}`;
        let t=tokens.find(t=>t.role==='owner' && t.member===member && t.label===name && !t.revoked && (!t.expires || Date.parse(t.expires)>this.app.operations.clock.now()));
        if (!t) { t={role:'owner',member,label:name,sha256:hash(random()),created:new Date(this.app.operations.clock.now()).toISOString()}; tokens.push(t); }
        secret=t.sha256;
      });
      this.sessions.change(f=>{f.links ??={};for(const [key,l] of Object.entries(f.links))if(l.expires<=this.now())delete f.links[key];f.links[hash(code)]={secret:secret!,expires:this.now()+ttl,label:clean(label),...(signedInAt!==undefined?{signedInAt}:{}),...(agent?{agent:true as const}:{})};});
    })(); return `/login/${code}`;
  }
  spend(code: string, device?: string) {
    return this.app.db.transaction(()=>{
      const link=this.sessions.get('links',hash(code)); if (!link || link.expires<=this.now() || this.token(link.secret)?.viewer.kind!=='member') return;
      this.sessions.change(f=>{delete f.links![hash(code)];});
      return this.createSession(link.secret,{label:link.label,signedInAt:link.signedInAt,agent:link.agent,via:'link',device:deviceOf(device)});
    }).immediate();
  }
  challenge(purpose: 'login'|'register', secret?: string) {
    const code=randomBytes(32).toString('base64url');
    this.sessions.change(f=>{ f.challenges ??={};const all=Object.entries(f.challenges).sort((a,b)=>b[1].expires-a[1].expires); for(const [id,c] of all)if(c.expires<=this.now())delete f.challenges[id];for(const [id] of all.slice(99))delete f.challenges[id];f.challenges[hash(code)]={purpose,expires:this.now()+300,...(secret?{secret}:{})}; });return code;
  }
  fresh(id: string): BrowserSession | undefined { const s=this.session(id);return s && this.now()-Math.min(s.s.issuedAt,s.s.signedInAt ?? s.s.issuedAt)<=600 ? s : undefined; }
  registrationOptions(id: string, rp: {rpId: string}) {
    const s=this.fresh(id); if (!s) throw new Error('Sign in again before adding a passkey');
    const member=s.viewer.id, first=this.household()?.members.find(m=>m.agents==='*')?.person===member;
    const seed=first?`loom-owner|${rp.rpId}`:`loom-member|${member}|${rp.rpId}`;
    return {challenge:this.challenge('register',s.s.secret),rp:{id:rp.rpId,name:'loom'},user:{id:Buffer.from(hash(seed),'hex').subarray(0,16).toString('base64url'),name:member,displayName:'loom'},pubKeyCredParams:ALGS.map(alg=>({type:'public-key',alg})),authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:300000,excludeCredentials:Object.values(this.sessions.read().passkeys ?? {}).filter(k=>this.token(k.secret)?.viewer.id===member).map(k=>({type:'public-key',id:k.id}))};
  }
  register(id: string, body: Record<string,unknown>, rp: {origin:string;rpId:string}) {
    this.app.db.transaction(()=>{
      const s=this.fresh(id); if (!s) throw new Error('Sign in again before adding a passkey');
      const registration=verifyRegistration(body,rp), challenge=this.sessions.get('challenges',hash(registration.challenge));
      if(!challenge || challenge.purpose!=='register' || challenge.expires<=this.now() || challenge.secret!==s.s.secret)throw new Error('Challenge refused');
      if(this.sessions.get('passkeys',registration.id) || Object.keys(this.sessions.read().passkeys ?? {}).length>=20)throw new Error('Passkey already exists or limit reached');
      const label=clean(typeof body.label==='string'?body.label:'') || 'A passkey', secret=hash(random()), tokenLabel=`Passkey: ${label} · ${s.viewer.id.slice(0,30)} · ${hash(registration.id).slice(0,12)}`;
      this.tokens.change(tokens=>{tokens.push({role:'owner',member:s.viewer.id,label:tokenLabel,sha256:secret,passkey:hash(registration.id),from_sha256:s.s.secret,created:new Date(this.app.operations.clock.now()).toISOString()});});
      this.sessions.change(f=>{delete f.challenges![hash(registration.challenge)];f.passkeys ??={};f.passkeys[registration.id]={id:registration.id,publicKey:registration.publicKey,alg:registration.alg,counter:registration.counter,label,secret,tokenLabel,created:this.now()};});
    }).immediate();
  }
  login(body: Record<string,unknown>, rp: {origin:string;rpId:string}, device?: string) {
    return this.app.db.transaction(()=>{
      const credential=typeof body.id==='string'?this.sessions.get('passkeys',body.id):undefined;if(!credential || this.token(credential.secret)?.viewer.kind!=='member')throw new Error('Passkey refused');
      const assertion=verifyAssertion(body,credential,rp),challenge=this.sessions.get('challenges',hash(assertion.challenge));
      if(!challenge || challenge.purpose!=='login' || challenge.expires<=this.now() || ((assertion.counter!==0 || credential.counter!==0) && assertion.counter<=credential.counter))throw new Error('Challenge or counter refused');
      this.sessions.change(f=>{delete f.challenges![hash(assertion.challenge)];f.passkeys![credential.id]={...credential,counter:assertion.counter,lastUsed:this.now()};});
      return this.createSession(credential.secret,{via:'passkey',device:deviceOf(device)});
    }).immediate();
  }
}
export function installSignin(app: Foundation) {
  migrate(app.db, 'signin', [{ number: 1, sql: `
    CREATE TABLE signin_audit (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, os_uid INTEGER NOT NULL,
      os_user TEXT NOT NULL, member TEXT NOT NULL, label TEXT NOT NULL, expires INTEGER NOT NULL
    );
  ` }]);
  const s=signin(app);
  // Deliberately ephemeral: no write retry journal may retain a sign-in URL or its input hash.
  app.operations.register({name:'signin.link',input:z.object({member:z.string(),label:z.string().optional(),agent:z.boolean().optional(),ttl:z.number().int().min(1).max(3600).optional()}),output:z.object({path:z.string()}),doors:['direct'],may:v=>v.kind==='member'&&s.owner(v.id),run:(_ctx,i)=>({path:s.link(i.member,i.label,i.agent,undefined,i.ttl)})});
  app.operations.register({name:'signin.setPrincipal',write:true,input:z.object({kind:z.enum(['runner','service']),id:z.string().regex(/^[a-z0-9-]+$/),active:z.boolean()}),output:z.object({ok:z.literal(true)}),may:v=>v.kind==='member'&&s.owner(v.id),run:(ctx,i)=>{new HouseholdRows(ctx.db,'settings').put(`signin-principal:${i.kind}:${i.id}`,{active:i.active});ctx.changed('core.access','credentials');return {ok:true as const};}});
  app.operations.register({name:'signin.revokeToken',write:true,input:z.object({label:z.string()}),output:z.object({revoked:z.boolean()}),may:v=>v.kind==='member'&&s.owner(v.id),run:(ctx,i)=>{const revoked=s.tokens.change(tokens=>{let found=false;for(const t of tokens)if(t.label===i.label&&!t.revoked){t.revoked=new Date(ctx.now).toISOString();found=true;}return found;});ctx.changed('core.access','credentials');return {revoked};}});
}
