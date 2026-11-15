import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sharedWeb} from './shared-web.js';
const homes:string[]=[];afterEach(()=>{for(const path of homes.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(){const home=mkdtempSync(join(tmpdir(),'shared-web-'));homes.push(home);const root=join(home,'web');mkdirSync(join(root,'assets'),{recursive:true});writeFileSync(join(root,'next.html'),'<html>APP</html>');writeFileSync(join(root,'assets/app.js'),'public app');writeFileSync(join(home,'private.db'),'PRIVATE');return {home,root};}
it('serves app navigation and immutable built assets without turning missing resources or API paths into HTML',async()=>{
 const f=fixture(),web=sharedWeb(f.root);
 const page=await web.request('http://loom/p/knowledge-preview');expect(await page.text()).toBe('<html>APP</html>');expect(page.headers.get('cache-control')).toBe('no-store');
 const asset=await web.request('http://loom/app/assets/app.js');expect(await asset.text()).toBe('public app');expect(asset.headers.get('cache-control')).toContain('immutable');expect(asset.headers.get('content-type')).toContain('javascript');expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
 for(const path of ['/api/missing','/graphql','/app/missing.js','/missing.js','/app/../../private.db','/app/%2e%2e/private.db']){const response=await web.request('http://loom'+path);expect(response.status).toBe(404);expect(await response.text()).not.toContain('PRIVATE');}
 expect((await web.request('http://loom/manifest.webmanifest')).status).toBe(200);expect((await web.request('http://loom/sw.js')).headers.get('service-worker-allowed')).toBe('/');
});
it('rejects malformed app roots before acquiring shared services or source listeners',()=>{
 const f=fixture();rmSync(join(f.root,'assets'),{recursive:true});writeFileSync(join(f.root,'assets'),'not a directory');expect(()=>sharedWeb(f.root)).toThrow('assets are not a directory');
 rmSync(join(f.root,'next.html'));mkdirSync(join(f.root,'next.html'));expect(()=>sharedWeb(f.root)).toThrow('entry is not a file');
});
it('refuses asset symlinks escaping the public root',async()=>{
 const f=fixture();symlinkSync(join(f.home,'private.db'),join(f.root,'assets','private.js'));
 const web=sharedWeb(f.root);expect((await web.request('http://loom/app/assets/private.js')).status).toBe(404);
 rmSync(join(f.root,'assets'),{recursive:true});symlinkSync(f.home,join(f.root,'assets'));
 expect(()=>sharedWeb(f.root)).toThrow('escape');
});
