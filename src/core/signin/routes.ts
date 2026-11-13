import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Foundation } from '../app.js';
import type { IncomingMessage } from 'node:http';
import { cookieId, relyingParty, sameOrigin, signin } from './index.js';
export function signinRoutes(app: Foundation) {
  const s=signin(app), routes=new Hono<{Bindings:{incoming:IncomingMessage}}>();
  routes.use('*',bodyLimit({maxSize:32768}));
  routes.use('*',async(c,next)=>{c.header('cache-control','no-store');c.header('referrer-policy','strict-origin');c.header('x-content-type-options','nosniff');if(c.req.method==='POST'&&!sameOrigin(c.env.incoming))return c.json({error:'Cross-site request'},403);await next();});
  routes.onError(()=>Response.json({error:'Sign-in could not complete'},{status:400,headers:{'cache-control':'no-store'}}));
  routes.post('/api/signin/link',async c=>{
    const req=c.env.incoming;
    if(!/^Bearer\s+.+$/i.test(req.headers.authorization ?? ''))return c.json({error:'Bearer authentication required'},403);
    const auth=s.resolve(req);if(!auth?.valid())return c.json({error:'Authentication required'},401);
    const body=await c.req.json();
    const result=app.operations.call('direct',auth.viewer,'signin.link',body?.input);
    return c.json(result,result.ok?200:result.code==='denied'?403:400);
  });
  routes.get('/auth/session',c=>{
    const id=cookieId(c.env.incoming), current=id?s.session(id,true):undefined;
    return current?c.json({viewer:current.viewer,csrf:s.csrf(id!)}):c.json({viewer:null});
  });
  routes.get('/login/:code',c=>{
    if(!/^[0-9a-f]{64}$/.test(c.req.param('code')))return c.notFound();
    // No credential is spent, reflected in HTML, or included in subresource URLs on GET.
    c.header('content-security-policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return c.html('<!doctype html><html><head><title>Sign in to loom</title></head><body><h1>Sign in to loom</h1><form method="post"><button>Sign in</button></form></body></html>');
  });
  routes.post('/login/:code',(c,next)=>{
    if(!/^[0-9a-f]{64}$/.test(c.req.param('code')))return next();
    const id=s.spend(c.req.param('code'),c.req.header('user-agent'));if(!id)return c.json({error:'That link is used up, expired, or revoked'},401);
    c.header('set-cookie',s.cookie(id,c.env.incoming));return c.redirect('/',303);
  });
  routes.post('/logout',async c=>{
    const id=cookieId(c.env.incoming);const body=await c.req.json().catch(()=>({}));
    if(!id||!s.session(id)||!s.checkCsrf(c.env.incoming,String(body._csrf ?? c.req.header('x-loom-csrf') ?? '')))return c.json({error:'Reload and try again'},403);
    s.end(id);c.header('set-cookie',s.cookie('',c.env.incoming));return c.json({ok:true});
  });
  for(const path of ['/login/passkey/options','/login/passkey','/passkeys/options','/passkeys']) routes.post(path,async c=>{
    const rp=relyingParty(process.env);if(!rp||new URL(rp.origin).host!==c.req.header('host'))return c.json({error:'Passkeys are not set up at this address'},404);
    const body=await c.req.json();if(!body||typeof body!=='object'||Array.isArray(body))return c.json({error:'Invalid request'},400);
    if(path==='/login/passkey/options')return c.json({challenge:s.challenge('login'),rpId:rp.rpId,timeout:300000});
    if(path==='/login/passkey'){
      try{const id=s.login(body,rp,c.req.header('user-agent'));c.header('set-cookie',s.cookie(id,c.env.incoming));return c.json({ok:true});}catch{return c.json({error:'Passkey sign-in refused'},401);}
    }
    const id=cookieId(c.env.incoming);
    if(!id||!s.checkCsrf(c.env.incoming,String(body._csrf ?? ''))||!s.fresh(id))return c.json({error:'Sign in again before adding a passkey'},403);
    if(path==='/passkeys/options')return c.json(s.registrationOptions(id,rp));
    s.register(id,body,rp);return c.json({ok:true});
  });
  return routes;
}
