import { it, expect } from 'vitest';
import { chromium } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { exampleHome } from '../example-home.js';
import { startSharedHome } from '../shared-startup.js';
import { changes } from '../core/data/schema.js';
import { prepareAgentPost } from '../core/conversations/agent-posts.js';

it.runIf(process.env.LOOM_TEST_CHROME)('keeps live updates, their linked work and thread history together on the desktop', async () => {
  const dir = await mkdtemp(join(tmpdir(),'loom-agent-feed-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let app: Awaited<ReturnType<typeof startSharedHome>> | undefined;
  try {
    const home=join(dir,'fixture');
    await exampleHome(home);
    const house = app = await startSharedHome({home,port:0,webRoot:resolve('dist/web'),stdout(){}});
    const service = house.services.comms!, db = service.db;
    const source = house.writes.run(()=>service.threads.open({member:'alex',agent:'fern',title:'Feed walkthrough'})).value;
    await service.send({thread:source.id,sender:'alex',kind:'message',words:'Start the boot console walkthrough here.'});
    const post = async (input: Parameters<typeof prepareAgentPost>[3]) => {
      const save = await prepareAgentPost(db,service.key,source.id,input);
      return house.writes.run(()=>save(new Date().toISOString())).value;
    };
    const change='github:example-house/garden#12';
    const boot = await post({action:'open',words:'Giving boot a console.'});
    browser = await chromium.launch({executablePath:process.env.LOOM_TEST_CHROME});
    const page = await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    page.setDefaultTimeout(9000);
    await page.goto(house.signinLink('alex'));
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    const card = page.locator('.desk-home [data-agent="fern"]');
    await card.getByText('Giving boot a console.',{exact:true}).last().waitFor();
    const disk = await post({action:'open',words:'Where did the disk go?'});
    await post({action:'reply',thread:disk,words:'Oh right, it was me.',refs:[change]});
    await post({action:'rename',thread:disk,title:'The missing disk space'});
    await card.getByText('The missing disk space',{exact:true}).waitFor();
    const diskRow=card.getByRole('listitem').filter({has:page.getByText('The missing disk space',{exact:true})});
    await diskRow.getByText('Show the work',{exact:true}).click();
    const receipt=card.getByRole('link',{name:/Plan the pump repair/});
    await expect.poll(()=>receipt.textContent()).toMatch(/open$/);
    house.writes.run(()=>db.update(changes).set({state:'merged'}).where(eq(changes.id,change)).run());
    await expect.poll(()=>receipt.textContent()).toMatch(/merged$/);
    await post({action:'reply',thread:boot,words:'It scrolls now.'});
    await expect.poll(()=>card.locator('.desk-agent-posts button').first().textContent()).toContain('It scrolls now.');
    await page.locator('.next-dock [data-value="tasks"]').click();
    const rail=page.locator('.desk-rail-card[data-agent="fern"] .desk-agent-posts button');
    await expect.poll(()=>rail.textContent()).toContain('Giving boot a console.');
    const title='Restore the scrolling console during the desktop boot cycle';
    await post({action:'rename',thread:boot,title});
    const heading=rail.locator('strong');
    await expect.poll(()=>heading.textContent()).toBe(title);
    expect(await heading.evaluate(el=>el.scrollWidth<=el.clientWidth+1 && getComputedStyle(el).whiteSpace!=='nowrap')).toBe(true);
    await rail.click();
    const history=page.getByRole('list',{name:'Activity posts'});
    await expect.poll(()=>history.locator('p').allTextContents()).toEqual(['It scrolls now.','Giving boot a console.']);
    for(let i=1;i<=5;i++)await post({action:'open',words:'Other activity '+i});
    await page.reload();
    const selected=page.locator('.desk-agent-page');
    await selected.getByRole('region',{name:title,exact:true}).waitFor();
    await post({action:'rename',thread:boot,title:'Boot console restored'});
    await selected.getByRole('region',{name:'Boot console restored',exact:true}).waitFor();
    await selected.getByRole('button',{name:'Back to agent'}).click();
    await selected.getByRole('button',{name:'Earlier activities'}).click();
    await selected.getByRole('button',{name:/Boot console restored/}).click();
    await selected.getByRole('region',{name:'Boot console restored',exact:true}).waitFor();
    await selected.getByRole('button',{name:'Back to agent'}).click();
    await page.reload();
    await selected.getByRole('button',{name:'Latest activities'}).waitFor();
    await selected.getByRole('button',{name:/Boot console restored/}).click();
    await page.getByRole('button',{name:'Source conversation'}).click();
    await page.getByText('Start the boot console walkthrough here.',{exact:true}).filter({visible:true}).first().waitFor();
  } finally {
    try { await browser?.close(); await app?.close(); } finally { await rm(dir,{recursive:true,force:true}); }
  }
},45000);
