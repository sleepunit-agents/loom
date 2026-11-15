/** One Tasks browser proof: the actual entry, canonical schema and signed-in data door. */
import { it, expect } from 'vitest';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { getRequestListener } from '@hono/node-server';
import { chromium } from 'playwright-core';
import { createDataSchema } from '../core/data/database.js';
import { nextData } from '../next-data.js';
import { FakeClock } from '../core/clock.js';
import { taskService } from '../apps/tasks.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const web = resolve(import.meta.dirname, '../../web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'next.html')))('Tasks reads live canonical rows in two windows, including hidden blockers and project visibility', async () => {
  const clock = new FakeClock(Date.parse('2026-11-14T12:00:00Z'));
  const now = () => new Date(clock.now()).toISOString();
  const client = new Database(':memory:'), db = createDataSchema(client, now);
  client.exec(`INSERT INTO members(id,role,joined_at) VALUES('jonathan','owner','${now()}'),('pollock','member','${now()}');
    INSERT INTO agents(id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES('pond-bot','','#000','#fff','pebble','dot');
    INSERT INTO member_agents(member,agent) VALUES('pollock','pond-bot');
    INSERT INTO projects(id,name) VALUES('pond','Pond'),('other','Other');
    INSERT INTO project_members(project,member) VALUES('pond','pollock');`);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const cookies = { jonathan: 'fixture-jonathan-cookie'.repeat(3), pollock: 'fixture-pollock-cookie'.repeat(3) };
  for (const member of ['jonathan', 'pollock'] as const) {
    const token = hash(`fixture-${member}-token`);
    client.prepare('INSERT INTO tokens(fingerprint,label,kind,member,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(token,member,'owner',member,now(),new Date(clock.now()+3600000).toISOString());
    client.prepare('INSERT INTO sessions(id,token,device,via,is_agent,issued_at,seen_at,proved_at) VALUES(?,?,?,?,?,?,?,?)').run(hash(cookies[member]),token,'Fictional browser','token',0,now(),now(),now());
  }
  const data = nextData(db, clock, req => req.headers.origin === `http://${req.headers.host}`);
  const tasks = taskService(db, now), owner = { kind: 'member' as const, id: 'jonathan' };
  const make = (title: string, project: string | null, taskOwner: { kind: 'household' } | { kind: 'agent'; id: string } = { kind: 'household' }) => data.writes.run(() => tasks.create({ title, goal:'Shared current work', why:'Fixture proof', project, owner:taskOwner }, owner)).value;
  const pond = make('Pond work', 'pond');
  make('Pond-bot own work', null, { kind:'agent', id:'pond-bot' });
  const blocker = make('Other project work', 'other');
  make('Unfiled household work', null);
  const blocked = make('Visible blocked work', 'pond');
  data.writes.run(() => tasks.link(blocked.id, blocker.id, 'blocks'));
  const bundle = await build({
    stdin: {
      contents: `import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import Tasks from './src/pieces/tasks'; createRoot(document.getElementById('root')).render(createElement(Tasks));`,
      resolveDir:web, sourcefile:'tasks-proof.tsx', loader:'tsx',
    },
    bundle:true, minify:true, write:false, format:'esm', platform:'browser', jsx:'automatic',
    resolveExtensions:['.mjs','.js','.mts','.ts','.jsx','.tsx','.json'],
    alias:{'@':join(web,'src')}, loader:{'.css':'empty'}, logLevel:'silent',
    plugins:[{
      // Match Vite's case-distinct files in this standalone esbuild entry.
      name:'case-distinct-account-sources',
      setup(bundler: import('esbuild').PluginBuild) {
        bundler.onResolve({filter:/^\.\/[Nn]otifications$/}, args =>
          args.resolveDir === join(web,'src/pieces/account')
            ? {path:join(args.resolveDir,args.path === './Notifications' ? 'Notifications.tsx' : 'notifications.ts')}
            : undefined);
      },
    }],
  });
  const manifest = JSON.parse(readFileSync(join(root,'.vite/manifest.json'),'utf8')) as Record<string,{imports?:string[];css?:string[]}>;
  const seen = new Set<string>(), css = new Set<string>();
  const stylesFor = (key:string) => {
    if (seen.has(key)) return; seen.add(key);
    const entry = manifest[key]; if (!entry) throw Error(`Missing built fixture entry: ${key}`);
    for (const imported of entry.imports ?? []) stylesFor(imported);
    for (const file of entry.css ?? []) css.add(file);
  };
  stylesFor('next.html'); stylesFor('src/pieces/tasks/index.tsx');
  const styles = [...css].map(file => `<link rel="stylesheet" href="/app/${file}">`).join('');
  const html = `<!doctype html><html data-look="neon" data-mode="dark" data-motion="reduce"><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles}</head><body><div id="root" style="height:100dvh"></div><script type="module" src="/tasks-proof.js"></script></body></html>`;
  const listener = getRequestListener(data.http.fetch);
  const server = createServer((req,res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    if (path === '/graphql') { void listener(req,res); return; }
    if (path === '/tasks-proof.js') { res.writeHead(200,{'content-type':'text/javascript'});res.end(bundle.outputFiles[0].contents);return; }
    if (path.startsWith('/app/')) {
      const file = resolve(root,path.slice(5));
      if (!file.startsWith(`${root}/`) || !existsSync(file)) {res.writeHead(404);res.end();return;}
      res.writeHead(200,{'content-type':({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'} as Record<string,string>)[extname(file)] ?? 'application/octet-stream'});res.end(readFileSync(file));return;
    }
    res.writeHead(200,{'content-type':'text/html'});res.end(html);
  });
  data.attach(server);
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No listener');
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await context.grantPermissions(['local-network-access'],{origin:url});
    await context.addCookies([{name:'loom_ui',value:cookies.jonathan,url}]);
    const a = await context.newPage(), b = await context.newPage();
    const frames: string[] = [], sockets = [0,0];
    for (const [index,page] of [a,b].entries()) page.on('websocket',socket => {sockets[index]++;socket.on('framereceived',frame => frames.push(String(frame.payload)));});
    await Promise.all([a.goto(`${url}/p/tasks-preview`),b.goto(`${url}/p/tasks-preview`)]);
    const row = (page:typeof a,title:string) => page.locator('[data-split-row]').filter({hasText:title});
    await expect.poll(() => row(b,'Pond work').count()).toBe(1);
    await row(a,'Pond work').click(); await row(b,'Pond work').click();
    data.writes.run(() => tasks.comment(pond.id,'A comment shared between windows',owner));
    await expect.poll(() => b.getByText('A comment shared between windows',{exact:true}).count()).toBe(1);
    expect(new URL(b.url()).pathname).toContain(`/task/${pond.id}`);
    await b.reload();
    await expect.poll(() => b.getByText('A comment shared between windows',{exact:true}).count()).toBe(1);
    expect(sockets).toEqual([1,2]); // One connection per page lifetime, including the deliberate reload.
    const shots = process.env.LOOM_TEST_SHOTS ?? resolve('artifacts/tasks-app');mkdirSync(shots,{recursive:true});
    for (const look of ['neon','daylight']) for (const width of [390,1280,1920]) {
      await b.setViewportSize({width,height:900});
      await b.evaluate(look => {document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';},look);
      await b.screenshot({path:join(shots,`tasks-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    data.writes.run(() => tasks.close(pond.id,'Completed in the fixture'));
    await expect.poll(() => row(a,'Pond work').count()).toBe(0);
    await expect.poll(() => row(b,'Pond work').count()).toBe(0);
    expect(frames.some(frame => frame.includes('"patches"') && frame.includes('"path":["tasks",'))).toBe(true);
    const pollock = await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await pollock.grantPermissions(['local-network-access'],{origin:url});
    await pollock.addCookies([{name:'loom_ui',value:cookies.pollock,url}]);
    const p = await pollock.newPage();await p.goto(`${url}/p/tasks-preview`);
    await expect.poll(() => row(p,'Pond-bot own work').count()).toBe(1);
    expect(await row(p,'Visible blocked work').count()).toBe(0);
    await p.getByRole('button',{name:/All open/}).click();
    await expect.poll(() => row(p,'Visible blocked work').count()).toBe(1);
    expect(await row(p,'Other project work').count()).toBe(0);expect(await row(p,'Unfiled household work').count()).toBe(0);
    data.writes.run(() => tasks.close(blocker.id,'Hidden blocker completed'));
    await p.getByRole('button',{name:/Ready/}).click();
    await expect.poll(() => row(p,'Visible blocked work').count()).toBe(1);
    clock.advance(3600000);
    await expect.poll(() => p.getByText('Waiting for connection.',{exact:true}).count()).toBe(1);
    expect(await row(p,'Visible blocked work').count()).toBe(0);
    await pollock.close();
  } finally { await browser.close();await data.close();await new Promise<void>(resolve => server.close(() => resolve()));client.close(); }
});
