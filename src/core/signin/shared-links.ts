import { endBrowser } from './shared-browser.js';
import { sharedPasskeys } from './shared-passkeys.js';
import { bodyLimit } from 'hono/body-limit';
/** Shared-model sign-in links. Trusted issuers name an existing member token;
 * the HTTP door binds that token to the authenticated bearer. */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { Clock } from '../clock.js';
import type { DataDatabase } from '../data/database.js';
import { sessions, signinLinks } from '../data/schema.js';
import { AGENT_SESSION_MS, PERSON_SESSION_MS, credentialFingerprint as fingerprint, currentSession, freshProof, isAgentBrowser, presentedCookie, presentedCredential } from '../data/authentication.js';
import type { Authentication } from '../live/index.js';
import { sharedTokens, sharedTokenInput, sharedTokenOwner, activeMemberToken } from './shared-tokens.js';
import { OperationError } from '../operations/index.js';
import type { DataWrites } from '../data/writes.js';

const secret = () => randomBytes(32).toString('hex');
const LINK_MS = 5 * 60_000;
function browserDevice(ua: string): { device: string; isAgent: boolean } {
  const isAgent = isAgentBrowser(ua);
  const browser = isAgent ? 'HeadlessChrome' : /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : undefined;
  return { device: system ? `${browser} on ${system}` : browser, isAgent };
}
export function sharedSigninLinks(db: DataDatabase, clock: Clock) {
  const token = (id: string) => activeMemberToken(db,clock,id);
  return {
    /** A link lasts five minutes at most; a trusted issuer may ask for less, and name what it is for. */
    makeLink(id: string, options: { label?: string; ttlMs?: number } = {}) {
      const current = token(id), code = secret();
      const expiresAt = new Date(Math.min(clock.now() + Math.min(LINK_MS, options.ttlMs ?? LINK_MS), current.expiresAt ? Date.parse(current.expiresAt) : Infinity)).toISOString();
      db.insert(signinLinks).values({ id: fingerprint(code), token: id, label: options.label ?? current.label, expiresAt }).run();
      return { path: `/login/${code}`, expiresAt };
    },
    redeem(code: string, userAgent: string, isAgent = false) {
      if (!/^[0-9a-f]{64}$/.test(code)) throw new Error('Sign-in refused');
      return db.transaction(() => {
        const link = db.select().from(signinLinks).where(eq(signinLinks.id, fingerprint(code))).get();
        if (!link || Date.parse(link.expiresAt) <= clock.now()) throw new Error('Sign-in refused');
        const current = token(link.token), cookie = secret(), at = new Date(clock.now()).toISOString();
        const browser = browserDevice(userAgent), agent = isAgent || browser.isAgent;
        db.delete(signinLinks).where(eq(signinLinks.id, link.id)).run();
        db.insert(sessions).values({ id: fingerprint(cookie), token: current.fingerprint, device: browser.device,
          via: 'link', isAgent: agent, issuedAt: at, seenAt: at, provedAt: at }).run();
        const expires = Math.min(clock.now() + (agent ? AGENT_SESSION_MS : PERSON_SESSION_MS), current.expiresAt ? Date.parse(current.expiresAt) : Infinity);
        return { cookie, maxAge: Math.floor((expires - clock.now()) / 1000) };
      });
    },
  };
}

/** Public identity door, using the same connection and committed notifications
 * as queries/commands. No session cookie or raw link enters retry receipts.
 *
 * These routes are deliberately not registered operations. Each one answers with a credential (a token, a
 * sign-in link, a cookie), and a registered write's answer is kept as a retry receipt for thirty days. So
 * each carries its own gate here, on the same authentication as every other door, with program tokens
 * refused outright: owner for a token or a program token, the member's own bearer or freshly proved
 * browser for a link or a passkey, the cookie itself for logout, the one-time code for redeeming.
 *
 * The one-time code travels in the link's path. That is what a sign-in link is: something a person can be
 * handed and open. It is good once, for five minutes at most, the page that shows it sends no referrer
 * with the code, and redeeming is a POST from that page. */
export function sharedSigninLinkRoutes(options: { db: DataDatabase; clock: Clock; writes: DataWrites; publicOrigin?: string; admitted(): boolean; reportError(error: unknown): void; issueProgram?(input:unknown):{token:string;fingerprint:string}; authenticate(request:Request):Authentication|undefined }) {
  const signin = sharedSigninLinks(options.db, options.clock);
  const authenticate = options.authenticate;
  const routes = new Hono();
  const rp=options.publicOrigin?new URL(options.publicOrigin):undefined;
  const passkeys=rp&&(rp.protocol==='https:'||rp.hostname==='localhost')?sharedPasskeys(options.db,options.clock,{origin:rp.origin,rpId:rp.hostname}):undefined;
  for(const path of ['/api/signin/link','/api/signin/token','/api/signin/program','/login/*','/passkeys','/passkeys/options','/logout'])routes.use(path,bodyLimit({maxSize:32768,...(path==='/api/signin/program'?{onError:(c:Context)=>c.json({error:'Request too large'},413)}:{})}));
  const guard: MiddlewareHandler = async (c, next) => {
    c.header('cache-control', 'no-store'); c.header('referrer-policy', 'no-referrer');
    c.header('x-content-type-options', 'nosniff');
    if (!options.admitted()) return c.json({ error: 'Sign-in unavailable' }, 503);
    if (c.req.method === 'POST') {
      const origin = c.req.header('origin'), url = new URL(c.req.url);
      if (c.req.header('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin && !(origin === options.publicOrigin && new URL(origin).host === url.host)))
        return c.json({ error: 'Cross-origin request refused' }, 403);
    }
    await next();
  };
  routes.use('/api/signin/token', guard); routes.use('/api/signin/program',guard); routes.use('/api/signin/link', guard); routes.use('/login/*', guard);
  for(const path of ['/login/passkey/options','/login/passkey','/passkeys/options','/passkeys'])routes.use(path,guard);
  routes.use('/auth/session', guard); routes.use('/logout', guard);
  routes.onError(() => Response.json({ error: 'Sign-in could not complete' }, { status: 401, headers: { 'cache-control': 'no-store' } }));
  const write = <T>(action: () => T): T => {
    const committed = options.writes.run(() => { if(!options.admitted())throw Error('Sign-in unavailable'); return action(); });
    for (const error of committed.notificationErrors) { try { options.reportError(error); } catch { /* preserve committed sign-in */ } }
    return committed.value;
  };
  const cookieHeader = (cookie: string, maxAge: number, url: string) => {
    const secure = (options.publicOrigin ?? new URL(url).origin).startsWith('https:');
    return `loom_ui=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };
  const issueForOwner=async(c:Context,issue:(input:unknown)=>{token:string;fingerprint:string})=>{
    const input=await c.req.json().catch(()=>null),auth=authenticate(c.req.raw);
    if(!auth?.valid()||!sharedTokenOwner(options.db,auth.viewer))return c.json({error:'Household owner required'},403);
    try{
      const value=write(()=>{
        if(!auth.valid()||!sharedTokenOwner(options.db,auth.viewer))throw new OperationError('denied','Household owner required');
        return issue(input);
      });
      if(!options.admitted())return c.json({error:'Sign-in unavailable'},503);
      if(!auth.valid()||!sharedTokenOwner(options.db,auth.viewer))return c.json({error:'Household owner required'},403);
      return c.json({ok:true,value});
    }catch(error){
      if(error instanceof OperationError)return c.json({error:error.message},({denied:403,conflict:409,invalid:400,'not-found':404,unavailable:503} as const)[error.code]);
      throw error;
    }
  };
  routes.post('/api/signin/token',c=>issueForOwner(c,input=>{
    const parsed=sharedTokenInput.safeParse(input);if(!parsed.success)throw new OperationError('invalid','Invalid token request');
    return sharedTokens(options.db,options.clock).issue(parsed.data);
  }));
  routes.post('/api/signin/program',c=>issueForOwner(c,input=>{
    if(!options.issueProgram)throw new OperationError('unavailable','Program tokens are unavailable');
    return options.issueProgram(input);
  }));
  routes.post('/api/signin/link', c => {
    const auth = authenticate(c.req.raw), presented = presentedCredential(c.req.raw);
    if (!auth?.valid() || auth.viewer.kind !== 'member' || !presented) return c.json({ error: 'Member authentication required' }, 401);
    const session = presented.cookie === undefined ? undefined : fingerprint(presented.cookie);
    const token = presented.bearer !== undefined ? fingerprint(presented.bearer) : options.db.select({token:sessions.token}).from(sessions).where(eq(sessions.id,session!)).get()?.token;
    if(!token)return c.json({error:'Member authentication required'},401);
    // A browser cookie is not a new proof of identity. It must not turn an
    // aged or automated session into a fresh passkey-enrollment session.
    const freshBrowser = () => {
      if (!session) return true;
      const found = currentSession(options.db, session, options.clock.now());
      return !!found && found.token.fingerprint === token && freshProof(found.session, options.clock.now());
    };
    if (!freshBrowser()) return c.json({error:'Sign in again before making a sign-in link'},403);
    // Request input cannot choose a token/member or impersonate an agent.
    const value=write(() => { if(!auth.valid() || !freshBrowser())throw Error('Authentication ended'); return signin.makeLink(token); });
    // Publication hooks can end this caller after the transaction committed.
    if(!options.admitted())return c.json({error:'Sign-in unavailable'},503);
    if(!auth.valid())return c.json({error:'Member authentication required'},401);
    if(!freshBrowser())return c.json({error:'Sign in again before making a sign-in link'},403);
    return c.json({ok:true,value});
  });
  routes.get('/auth/session', c => {
    const auth = authenticate(c.req.raw);
    return c.json({ viewer: auth?.valid() && auth.viewer.kind === 'member' ? auth.viewer : null });
  });
  routes.post('/logout', c => {
    const cookie = presentedCookie(c.req.raw);
    // A stale cookie may be cleared locally, but must not authorize server
    // changes. Authenticate the cookie itself; an unrelated bearer cannot help.
    const auth = cookie ? authenticate(new Request(c.req.url, { headers: { cookie: `loom_ui=${cookie}` } })) : undefined;
    if (auth?.valid() && auth.viewer.kind === 'member' && cookie) write(() => {
      if(!auth.valid())return;
      const id = fingerprint(cookie);
      endBrowser(options.db,id);
    });
    c.header('set-cookie', cookieHeader('', 0, c.req.url));
    return c.json({ ok: true });
  });
  for(const path of ['/login/passkey/options','/login/passkey','/passkeys/options','/passkeys'])routes.post(path,async c=>{
    if(!passkeys||new URL(c.req.url).host!==rp!.host)return c.json({error:'Passkeys unavailable at this address'},404);
    const body=await c.req.json().catch(()=>null);
    if(!body||typeof body!=='object'||Array.isArray(body))return c.json({error:'Invalid request'},400);
    if(!options.admitted())return c.json({error:'Sign-in unavailable'},503);
    if(path==='/login/passkey/options')return c.json(passkeys.loginOptions());
    if(path==='/login/passkey'){
      const value=write(()=>passkeys.login(body,c.req.header('user-agent')??'Browser'));
      c.header('set-cookie',cookieHeader(value.cookie,value.maxAge,c.req.url));return c.json({ok:true});
    }
    const auth=authenticate(c.req.raw);
    if(!auth?.valid()||auth.viewer.kind!=='member')return c.json({error:'Member authentication required'},403);
    // A passkey is added from the browser that is signed in; a bearer token beside the cookie adds nothing.
    const cookie=presentedCredential(c.req.raw)?.cookie;
    if(!cookie)return c.json({error:'Sign in again before adding a passkey'},403);
    if(path==='/passkeys/options')return c.json(passkeys.registrationOptions(cookie));
    return c.json(write(()=>passkeys.register(cookie,body)));
  });
  routes.get('/login/:code', c => {
    if (!/^[0-9a-f]{64}$/.test(c.req.param('code'))) return c.notFound();
    // no-referrer also nulls a native form's Origin (Fetch section 3.2).
    // Keep the code path out of referrers while retaining same-origin POSTs.
    c.header('referrer-policy', 'strict-origin');
    c.header('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return c.html('<!doctype html><html><head><title>Sign in to loom</title></head><body><h1>Sign in to loom</h1><form method="post"><button>Sign in</button></form></body></html>');
  });
  routes.post('/login/:code', c => {
    const result = write(() => signin.redeem(c.req.param('code'), c.req.header('user-agent') ?? 'Browser'));
    c.header('set-cookie', cookieHeader(result.cookie, result.maxAge, c.req.url));
    return c.redirect('/', 303);
  });
  return routes;
}
