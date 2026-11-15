/** One shipped Inbox proof. CI owns Chromium; data and credentials are fictitious. */
import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { chromium } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { generateX25519Identity } from 'age-encryption';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { dataAuthentication } from '../core/data/authentication.js';
import { members, memberAgents, agents, messages, inbox, operationResults, threads } from '../core/data/schema.js';
import { wordsKey } from '../pieces/comms/crypto.js';
import { sharedRoot } from '../shared-root.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it.runIf(chrome && existsSync(join(root, 'index.html')))('shipped Inbox reads, sets recipient volume and answers across windows, then withdraws revoked words', async () => {
  const client = new Database(':memory:'), clock = new FakeClock(Date.now());
  const now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values({ id: 'alice', role: 'member', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const token = 't'.repeat(64), cookie = 'c'.repeat(64);
  client.prepare('INSERT INTO tokens (fingerprint,label,kind,member,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(hash(token), 'Fixture', 'owner', 'alice', now(), new Date(clock.now() + 3600000).toISOString());
  client.prepare('INSERT INTO sessions (id,token,device,via,is_agent,issued_at,seen_at,proved_at) VALUES (?,?,?,?,?,?,?,?)').run(hash(cookie), hash(token), 'Browser', 'token', 0, now(), now(), now());
  const key = wordsKey(await generateX25519Identity());
  const composition = sharedRoot({ db, clock, commsKey: key, originAllowed: req => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`, reportError: error => { throw error; } });
  const thread = composition.services.comms!.threads.open({member:'alice',agent:'art',title:'Pump'});
  const question = await composition.services.comms!.ask(thread.id,'art','question',{words:'PRIVATE PUMP QUESTION',answers:'yes-no'});
  const authenticate = dataAuthentication(db, () => clock.now());
  const handler = getRequestListener(composition.http.fetch);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/graphql' || path.startsWith('/api/')) { void handler(req, res); return; }
    if (path === '/auth/session') {
      const auth = authenticate(new Request('http://localhost/', { headers: { cookie: req.headers.cookie ?? '' } }));
      res.setHeader('content-type','application/json'); res.end(JSON.stringify({viewer:auth?.viewer ?? null,csrf:''})); return;
    }
    const file = path.startsWith('/app/') ? resolve(root,path.slice(5)) : join(root,'index.html');
    if (!file.startsWith(root + '/') || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('content-type',({'.js':'application/javascript','.css':'text/css','.html':'text/html'} as Record<string,string>)[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  const detach = composition.attach(server); let browser: import('playwright-core').Browser | undefined;
  try {
    await new Promise<void>(ok => server.listen(0,'127.0.0.1',ok));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No address');
    const url = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
    const context = await browser.newContext({serviceWorkers:'block'}); context.setDefaultTimeout(10_000);
    await context.addCookies([{name:'loom_ui',value:cookie,url}]);
    const a = await context.newPage(), b = await context.newPage();
    for(const page of [a,b]) { page.on('pageerror',error=>console.info('Fixture page error:',error.message)); page.on('console',msg=>{if(msg.type()==='error')console.info('Fixture console:',msg.text());}); }
    await Promise.all([a,b].map(page => page.goto(`${url}/p/inbox-preview/ask/${encodeURIComponent(question.inboxItem!)}`)));
    for (const page of [a,b]) await expect.poll(() => page.getByRole('heading',{name:'PRIVATE PUMP QUESTION',exact:true}).count()).toBe(1); console.info('Inbox: private question visible');
    await expect.poll(() => client.prepare('SELECT count(*) AS n FROM inbox_reads').get()).toEqual({n:1});
    // Recipient volume uses this already-open Inbox item, before answering it.
    await a.getByRole('button',{name:'Dim',exact:true}).click();
    await expect.poll(()=>client.prepare('SELECT volume FROM inbox WHERE id=?').get(question.inboxItem!)).toEqual({volume:'dim'});
    await expect.poll(()=>a.getByRole('button',{name:'Dim',exact:true}).isDisabled()).toBe(true);
    await a.getByRole('button',{name:'Mute',exact:true}).click();
    await expect.poll(()=>client.prepare('SELECT volume FROM inbox WHERE id=?').get(question.inboxItem!)).toEqual({volume:'mute'});
    await expect.poll(()=>a.getByRole('button',{name:'Mute',exact:true}).isDisabled()).toBe(true);
    expect(client.prepare('SELECT quiet_until AS until FROM inbox WHERE id=?').get(question.inboxItem!)).toEqual({until:new Date(clock.now()+7*86400000).toISOString()});
    expect(await a.getByText(/returns to full/).count()).toBe(1);
    await a.getByRole('button',{name:'Full',exact:true}).click();
    await expect.poll(()=>client.prepare('SELECT volume,quiet_until AS quietUntil FROM inbox WHERE id=?').get(question.inboxItem!)).toEqual({volume:'full',quietUntil:null});
    await a.getByRole('button',{name:'Yes',exact:true}).click();
    for (const page of [a,b]) {
      await expect.poll(() => page.getByRole('button',{name:'Yes',exact:true}).count()).toBe(0);
      await expect.poll(() => page.getByRole('heading',{name:'Answer',exact:true}).count()).toBe(1);
    }
    expect(db.select().from(messages).all()).toHaveLength(2);
    const durable = JSON.stringify([db.select().from(inbox).all(),db.select().from(operationResults).all()]);
    expect(durable).not.toContain('PRIVATE PUMP QUESTION');
    if (process.env.LOOM_SHOTS) {
      mkdirSync(process.env.LOOM_SHOTS,{recursive:true});
      await a.screenshot({path:join(process.env.LOOM_SHOTS,'inbox-shared-wide.png'),fullPage:true});
      await b.setViewportSize({width:390,height:844});
      await b.screenshot({path:join(process.env.LOOM_SHOTS,'inbox-shared-phone.png'),fullPage:true});
    }
    composition.writes.run(() => client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(now(),hash(token)));
    for (const page of [a,b]) for (const words of ['PRIVATE PUMP QUESTION']) await expect.poll(() => page.getByText(words,{exact:true}).count()).toBe(0);
  } finally {
    if(browser) for(const context of browser.contexts()) for(const page of context.pages()) console.info('Fixture visible text:',await page.locator('body').innerText().catch(()=>'')); console.info('Proof: closing browser'); await browser?.close(); console.info('Proof: closing root'); detach(); await composition.close(); console.info('Proof: closing listener'); await new Promise<void>(ok => server.close(() => ok())); client.close();
  }
}, 60_000);
