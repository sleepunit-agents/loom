import {expect,it} from 'vitest';
import {chromium} from 'playwright-core';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {exampleHome} from '../example-home.js';
import {startSharedHome} from '../shared-startup.js';

it.runIf(process.env.LOOM_TEST_CHROME)('moves the same agent between Home and rail and minimizes a tiled window locally',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'loom-desk-card-')),home=join(dir,'home');
  let app:Awaited<ReturnType<typeof startSharedHome>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    await exampleHome(home);
    app=await startSharedHome({home,port:0,webRoot:resolve('dist/web'),stdout(){}});
    browser=await chromium.launch({executablePath:process.env.LOOM_TEST_CHROME});
    const page=await browser.newPage({viewport:{width:1920,height:1000},reducedMotion:'no-preference'});
    // Pause only the measured movements so a slow CI host can inspect the actual frame.
    await page.addInitScript(()=>{
      const animate=Element.prototype.animate;
      Element.prototype.animate=function(frames,options){
        const animation=animate.call(this,frames,options);
        if(animation.id==='loom-agent-card'){animation.pause();animation.currentTime=70;}
        if(typeof options==='object'&&options.pseudoElement?.includes('loom-departure')&&Array.isArray(frames)&&frames.some(frame=>'scale' in frame)){
          animation.pause();animation.currentTime=Number(options.duration);
          document.documentElement.dataset.dockFlight=options.pseudoElement;
        }
        return animation;
      };
    });
    await page.goto(app.signinLink('robin'));await page.getByRole('button',{name:'Sign in',exact:true}).click();
    const homeCard=page.locator('.desk-solo[data-agent="moss"]'),dock=page.locator('.next-dock');
    await homeCard.waitFor();
    await dock.locator('[data-value="tasks"]').click();
    const card=page.locator('.desk-rail-card[data-agent="moss"][data-card-flight="collapse"]');
    await card.waitFor();
    expect(await card.evaluate(el=>{
      const {x,y,width,height}=el.getBoundingClientRect(),cx=x+width/2,cy=y+height/2;
      return cx<el.closest('aside')!.getBoundingClientRect().left && el.contains(document.elementFromPoint(cx,cy));
    })).toBe(true);
    await card.evaluate(el=>el.getAnimations().find(a=>a.id==='loom-agent-card')!.finish());
    await dock.locator('[data-value="inbox"]').click();
    const tiles=page.locator('.next-tile[data-tile]');
    await expect.poll(()=>tiles.count()).toBe(2);
    await tiles.evaluateAll(nodes=>Promise.all(nodes.flatMap(n=>n.getAnimations().map(a=>a.finished.catch(()=>{})))));
    const right=await tiles.evaluateAll(nodes=>nodes.sort((a,b)=>b.getBoundingClientRect().left-a.getBoundingClientRect().left)[0].getAttribute('data-tile'));
    const tile=page.locator(`[data-tile="${right}"]`),icon=dock.locator(`[data-value="${right}"]`);
    const frame=(await tile.boundingBox())!,target=(await icon.boundingBox())!;
    await tile.locator('[data-act="dock"]').click();
    await page.waitForFunction(()=>!!document.documentElement.dataset.dockFlight);
    const delta=await page.evaluate(()=>{
      const root=document.documentElement;
      const group=getComputedStyle(root,'::view-transition-group(loom-departure)');
      const image=getComputedStyle(root,'::view-transition-image-pair(loom-departure)');
      return {groupScale:group.scale,offset:image.translate.split(' ').map(parseFloat)};
    });
    expect(delta.groupScale).toBe('none');
    expect(frame.x+frame.width/2+delta.offset[0]).toBeCloseTo(target.x+target.width/2,0);
    expect(frame.y+frame.height/2+delta.offset[1]).toBeCloseTo(target.y+target.height/2,0);
    await dock.locator('[data-value="home"]').click();
    await page.locator('.desk-solo[data-agent="moss"][data-card-flight="expand"]').waitFor();
  }finally{try{await browser?.close();await app?.close();}finally{await rm(dir,{recursive:true,force:true});}}
},30000);
