import { expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exampleHome } from '../example-home.js';
import { startSharedHome } from '../shared-startup.js';
import { dataDatabase } from '../core/data/database.js';
import { prepareAgentPost } from '../core/conversations/agent-posts.js';
import { loadKey } from '../pieces/comms/crypto.js';

it.runIf(process.env.LOOM_TEST_CHROME)('reads a rail observation with its opening post, work receipt and conversations', async()=>{
  const directory = await mkdtemp(join(tmpdir(), 'loom-agent-presence-'));
  const home = join(directory, 'home');
  const opening = 'I’m comparing the pump fittings before we order the replacement.';
  const observation = 'The smaller coupling fits.';
  let app: Awaited<ReturnType<typeof startSharedHome>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const fixture = await exampleHome(home);
    const client = new Database(join(home, 'app.db'));
    try {
      const db = dataDatabase(client), key = await loadKey(home);
      const open = await prepareAgentPost(db,key,fixture.thread,{action:'open',title:'Replace the pump',words:opening});
      const thread = open(new Date(Date.now()-180000).toISOString());
      const reply = await prepareAgentPost(db,key,fixture.thread,{action:'reply',thread,words:observation,refs:[fixture.tasks[0]]});
      reply(new Date(Date.now()-120000).toISOString());
    } finally { client.close(); }
    app = await startSharedHome({home,port:0,webRoot:resolve('dist/web'),stdout(){}});
    browser = await chromium.launch({executablePath:process.env.LOOM_TEST_CHROME});
    const page = await browser.newPage({viewport:{width:1920,height:1000},reducedMotion:'reduce'});
    await page.goto(app.signinLink('alex'));
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.locator('.next-dock [data-value="tasks"]').click();
    const rail = page.getByRole('region',{name:'Fern rail card'});
    const update = rail.getByRole('button').filter({hasText:observation});
    await update.waitFor();
    expect(await update.innerText()).toMatch(/2m ago/);
    expect(await update.innerText()).not.toContain(opening);
    await update.click();
    const card = page.locator('.desk-agent-page');
    await card.getByRole('region',{name:'Replace the pump'}).waitFor();
    await card.getByText(opening,{exact:true}).waitFor();
    await card.getByText(observation,{exact:true}).waitFor();
    await card.getByText('Show the work',{exact:true}).click();
    await card.locator('details[open]').getByRole('link',{name:/Compare garden pumps/}).waitFor();
    await card.getByText('All conversations in Comms').waitFor();
    await page.setViewportSize({width:390,height:844});
    expect(await card.getByText(observation,{exact:true}).isVisible()).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const other = await browser.newPage();
    await other.goto(app.signinLink('robin'));
    await other.getByRole('button',{name:'Sign in',exact:true}).click();
    await other.locator('.desk-solo[data-agent="moss"]').waitFor();
    expect(await other.getByText(observation,{exact:true}).count()).toBe(0);
  } finally {
    try { await browser?.close(); await app?.close(); }
    finally { await rm(directory,{recursive:true,force:true}); }
  }
},45000);
