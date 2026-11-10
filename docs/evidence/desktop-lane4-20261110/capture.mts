import { deskHome } from './src/ui/agent-desk.fixture.ts';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
const dir='/tmp/lane4-evidence'; mkdirSync(dir,{recursive:true});
const d=await deskHome({art:'Art',mark:'Mark'});
const browser=await chromium.launch({executablePath:'/usr/local/bin/chrome-headless-shell',args:['--no-sandbox']});
const proof=[];
try {
for(const look of ['neon','lowlight','daylight']) for(const width of [1440,390]) {
 d.report({}); await d.changed();
 const ctx=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
 await ctx.addInitScript(({look})=>{localStorage.setItem('loom-look',look);sessionStorage.setItem('loom-arrived','1');sessionStorage.setItem('loom-booted','1');},{look});
 await ctx.request.post(d.base+'/login',{form:{token:d.tok.jonathan},maxRedirects:0});
 const p=await ctx.newPage(); await p.goto(d.base+'/');
 const line=p.locator('.loom-tick__line:not([aria-hidden])').first();
 await p.waitForFunction(()=>document.documentElement.dataset.attention==='live');
 await p.screenshot({path:`${dir}/home-${look}-${width}-before.png`});
 const at=Date.now();
 d.report({mark:{doing:[{text:'DO NOT DISPLAY PRIVATE TEXT',kind:'lane',where:'wake',since:new Date(at).toISOString(),activity:{action:'Reading a file',observedAt:new Date(at).toISOString(),expiresAt:new Date(at+28000).toISOString()}}]}}); await d.changed();
 await p.waitForFunction(()=>document.querySelector('.loom-tick__line:not([aria-hidden])')?.textContent?.includes('Mark · Reading a file · a wake'));
 await p.screenshot({path:`${dir}/home-${look}-${width}-after.png`});
 proof.push({look,width,text:await line.innerText(),overflow:await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
 await ctx.close();
}
writeFileSync(dir+'/screenshots-proof.json',JSON.stringify(proof,null,2));
} finally {await browser.close();await d.close();}
