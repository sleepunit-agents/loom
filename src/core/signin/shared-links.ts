import { browserCookie, endBrowser, startBrowser } from './shared-browser.js';
import { sharedPasskeys } from './shared-passkeys.js';
import { bodyLimit } from 'hono/body-limit';
/** Shared-model sign-in links. Trusted issuers name an existing member token;
 * the HTTP door binds that token to the authenticated bearer. */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { Clock } from '../clock.js';
import type { DataDatabase } from '../data/database.js';
import { signinLinks } from '../data/schema.js';
import { credentialFingerprint as fingerprint, currentSession, newProof, presentedCookie, presentedCredential } from '../data/authentication.js';
import type { Authentication } from '../live/index.js';
import { sharedTokens, sharedTokenInput, sharedTokenOwner, activeMemberToken } from './shared-tokens.js';
import { OperationError } from '../operations/index.js';
import type { DataWrites } from '../data/writes.js';
import { sameRequestOrigin } from '../data/origin.js';
import { LINK_MS } from './link-lifetime.js';

export function sharedSigninLinks(db: DataDatabase, clock: Clock) {
  const token = (id: string) => activeMemberToken(db,clock,id);
  return {
    /** A link lasts LINK_MS at most; a trusted issuer may ask for less, and name what it is for. `from` is
     * the browser session making the link, when a browser makes it; `agent` says the link is for an
     * automated browser. Both are kept in the link's row, so a link is the same link after the program
     * starts again. Links that have run out are dropped here, so unused ones do not pile up. */
    makeLink(id: string, options: { label?: string; ttlMs?: number; from?: string; agent?: boolean } = {}) {
      const current = token(id), code = randomBytes(32).toString('hex'), now = clock.now();
      for (const old of db.select({ id: signinLinks.id, expiresAt: signinLinks.expiresAt }).from(signinLinks).all()) if (Date.parse(old.expiresAt) <= now) db.delete(signinLinks).where(eq(signinLinks.id, old.id)).run();
      const expiresAt = new Date(Math.min(now + Math.min(LINK_MS, options.ttlMs ?? LINK_MS), current.expiresAt ? Date.parse(current.expiresAt) : Infinity)).toISOString();
      db.insert(signinLinks).values({ id: fingerprint(code), token: id, label: options.label ?? current.label, expiresAt, session: options.from ?? null, isAgent: !!options.agent }).run();
      return { path: `/login/${code}`, expiresAt };
    },
    redeem(code: string, userAgent: string) {
      if (!/^[0-9a-f]{64}$/.test(code)) throw new Error('Sign-in refused');
      return db.transaction(() => {
        const link = db.select().from(signinLinks).where(eq(signinLinks.id, fingerprint(code))).get(), now = clock.now();
        if (!link || Date.parse(link.expiresAt) <= now) throw new Error('Sign-in refused');
        const current = token(link.token);
        // A link made by a browser is that browser's proof carried to another device. It is good only while
        // that browser is still signed in, and it gives the new one nothing the first did not have.
        const from = link.session === null ? undefined : currentSession(db, link.session, now);
        if (link.session !== null && from?.token.fingerprint !== current.fingerprint) throw new Error('Sign-in refused');
        db.delete(signinLinks).where(eq(signinLinks.id, link.id)).run();
        return startBrowser(db, now, { token: current, userAgent, via: 'link', agent: link.isAgent, from: from?.session });
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
 * refused outright: owner for a token or a program token, the member's own credential for a link or a
 * passkey, the cookie itself for logout, the one-time code for redeeming. Every route that hands out a
 * credential also asks for a new proof of identity (`proved`, below): a bearer, or a person's own freshly
 * proved browser. A browser cookie is not a new proof, so an aged or automated browser gets no token, no
 * link and no passkey.
 *
 * The one-time code travels in the link's path. That is what a sign-in link is: something a person can be
 * handed and open. It is good once, for five minutes at most, the page that shows it sends no referrer
 * with the code, and redeeming is a POST from that page.
 *
 * Both choices are recorded in docs/accepted-tradeoffs.md. */
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
    if (c.req.method === 'POST' && !sameRequestOrigin(c.req.raw, options.publicOrigin)) return c.json({ error: 'Cross-origin request refused' }, 403);
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
  const cookieHeader = (cookie: string, maxAge: number, url: string) => browserCookie(cookie, maxAge, (options.publicOrigin ?? new URL(url).origin).startsWith('https:'));
  // The one gate of new proof for the token, program-token and link routes (newProof; passkeys ask it too).
  // `still` asks again, inside the write and after it: the same credential must still be a new proof.
  const proved=(request:Request)=>{
    const presented=presentedCredential(request),first=newProof(options.db,presented,options.clock.now());
    return first&&{...first,still:()=>newProof(options.db,presented,options.clock.now())?.token===first.token};
  };
  const stale='Sign in again before making a token';
  const issueForOwner=async(c:Context,issue:(input:unknown)=>{token:string;fingerprint:string})=>{
    const input=await c.req.json().catch(()=>null),auth=authenticate(c.req.raw),proof=proved(c.req.raw);
    if(!auth?.valid()||!sharedTokenOwner(options.db,auth.viewer))return c.json({error:'Household owner required'},403);
    // A token made here can last for ever. An aged or automated owner browser must not turn its short
    // session into one.
    if(!proof)return c.json({error:stale},403);
    try{
      const value=write(()=>{
        if(!auth.valid()||!sharedTokenOwner(options.db,auth.viewer))throw new OperationError('denied','Household owner required');
        if(!proof.still())throw new OperationError('denied',stale);
        return issue(input);
      });
      if(!options.admitted())return c.json({error:'Sign-in unavailable'},503);
      if(!auth.valid()||!sharedTokenOwner(options.db,auth.viewer))return c.json({error:'Household owner required'},403);
      if(!proof.still())return c.json({error:stale},403);
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
    const auth = authenticate(c.req.raw), proof = proved(c.req.raw);
    if (!auth?.valid() || auth.viewer.kind !== 'member') return c.json({ error: 'Member authentication required' }, 401);
    // A browser cookie is not a new proof of identity. It must not turn an
    // aged or automated session into a fresh passkey-enrollment session: only a freshly proved browser
    // may make a link, and the browser the link signs in inherits that proof (see redeem).
    if (!proof) return c.json({error:'Sign in again before making a sign-in link'},403);
    const freshBrowser = proof.still, { token, session } = proof;
    // Request input cannot choose a token/member or impersonate an agent.
    const value=write(() => { if(!auth.valid() || !freshBrowser())throw Error('Authentication ended'); return signin.makeLink(token, session === undefined ? {} : { from: session }); });
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
