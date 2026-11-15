/** The built app on the shared listener. Portable content files are never part
 * of this public root; API routes are handled before this fallback. */
import {existsSync,readFileSync,readdirSync,statSync,realpathSync} from 'node:fs';
import {extname,resolve,sep} from 'node:path';
import {Hono} from 'hono';
import {getMimeType} from 'hono/utils/mime';
import {MANIFEST,nextWorker} from './next-pwa.js';
export function sharedWeb(webRoot:string){
 const root=realpathSync(webRoot),assets=resolve(root,'assets'),publicRoot=realpathSync(resolve(import.meta.dirname,'../assets'));
 if(!statSync(resolve(root,'next.html')).isFile())throw new Error('Shared app entry is not a file');
 if(existsSync(assets)&&!statSync(assets).isDirectory())throw new Error('Shared app assets are not a directory');
 if(existsSync(assets)&&!realpathSync(assets).startsWith(root+sep))throw new Error('Shared app assets escape their public root');
 const built=existsSync(assets)?readdirSync(assets).filter(file=>/\.(js|css|woff2)$/.test(file)).sort().map(file=>'/app/assets/'+file):[];
 const app=new Hono();
 app.get('/manifest.webmanifest',()=>new Response(MANIFEST,{headers:{'content-type':'application/manifest+json','cache-control':'no-cache'}}));
 app.get('/sw.js',()=>new Response(nextWorker(built),{headers:{'content-type':'text/javascript','cache-control':'no-cache','service-worker-allowed':'/'}}));
 app.get('*',c=>{
  const path=new URL(c.req.url).pathname;
  if(/^\/(api|graphql|auth|login|logout|live|mcp|events|collections)(\/|$)/.test(path))return c.notFound();
  const asset=path.startsWith('/app/'),publicAsset=/^\/(icons|fonts)\//.test(path);
  if(!asset&&!publicAsset&&(extname(path)||/^\/(assets|faces|pixel-icons)(\/|$)/.test(path)))return c.notFound();
  const base=publicAsset?publicRoot:root,candidate=publicAsset?resolve(base,'.'+path):asset?resolve(root,'.'+path.slice(4)):resolve(root,'next.html');
  if(!candidate.startsWith(base+sep)||!existsSync(candidate))return c.notFound();
  const file=realpathSync(candidate);
  if(!file.startsWith(base+sep)||!statSync(file).isFile())return c.notFound();
  return new Response(readFileSync(file),{headers:{
   'content-type':getMimeType(file)??'application/octet-stream','cache-control':asset?'public, max-age=31536000, immutable':'no-store','x-content-type-options':'nosniff',
   'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'",
  }});
 });
 return app;
}
