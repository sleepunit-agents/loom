/** Shipped Tasks form over the shared HTTP command/GraphQL door. Browser runs in CI only. */
import { it, expect, onTestFailed } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getRequestListener } from '@hono/node-server';
import { eq, and } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { sharedRoot } from '../shared-root.js';
import * as s from '../core/data/schema.js';
import { tasksQuery, taskChoicesQuery } from '../../web/src/pieces/tasks/query.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
const title = 'Fix pond pump', hiddenTitle = 'Private lee task';
async function fixture(withComms=false, memory?:import('../shared-memory.js').SharedMemoryOptions) {
  const client = new Database(':memory:');
  const at = '2026-11-14T20:00:00.000Z', clock = new FakeClock(Date.parse(at));
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(s.members).values(['sam', 'lee'].map(id => ({ id, role: 'member' as const, joinedAt: at }))).run();
  db.insert(s.agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(s.projects).values(['pond', 'other', 'bank'].map(id => ({ id, name: id }))).run();
  db.insert(s.projectMembers).values(['pond','bank'].flatMap(project => ['sam','lee'].map(member => ({ project, member })))).run();
  db.insert(s.projectAgents).values({ project: 'pond', agent: 'art' }).run();
  const cookie = 'c'.repeat(64), token = 't'.repeat(64);
  const fingerprint = createHash('sha256').update(token).digest('hex');
  const session = createHash('sha256').update(cookie).digest('hex');
  db.insert(s.tokens).values({ fingerprint, label: 'Disposable browser fixture', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(s.sessions).values({ id: session, token: fingerprint, device: 'Fixture', via: 'token', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  for (const [id, name, project, ownerKind, owner] of [
    ['t-1', title, 'pond', 'agent', 'art'], ['t-2', 'Order pump parts', 'pond', 'household', null],
    ['t-90', hiddenTitle, null, 'member', 'lee'],
  ] as const) db.insert(s.tasks).values({ id, title: name, project, ownerKind, owner,
    goal: 'The pump works', why: 'Pond needs water', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
  for (const [id, project, name] of [['github:acme/app#3','pond','Linked fixture change'], ['github:secret/app#9','other','Hidden linked change']] as const) {
    db.insert(s.changes).values({ id, repository:id.slice(0,id.indexOf('#')), number: Number(id.split('#')[1]), title:name, body:'', url:`https://github.com/${id.slice(7).replace('#','/pull/')}`, state:'open', draft:false, authorLogin:'fixture', project, branch:'feature', headCommit:'a'.repeat(40), baseBranch:'next', checks:'passing', review:'approved', mergeable:'yes', waitingOn:'done', openedAt:at, updatedAt:at }).run();
    db.insert(s.changeTasks).values({change:id,task:'t-1'}).run();
  }
  const key = {seal:async (s:string)=>Buffer.from(s),open:async (b:Uint8Array)=>Buffer.from(b).toString(),hash:(s:string)=>createHash('sha256').update(s).digest('hex')};
  const data = sharedRoot({ db, clock, memory, commsKey:withComms ? key : undefined, originAllowed: request => request.headers.origin === `http://${request.headers.host}`, reportError: error => { throw error; } });
  await data.ready;
  const serveData = getRequestListener(request => data.http.fetch(request));
  const http = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/graphql' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/login/') || url.pathname === '/logout') { void serveData(request, response); return; }
    const file = url.pathname.startsWith('/app/') ? resolve(root, url.pathname.slice(5)) : join(root, 'index.html');
    if (!file.startsWith(`${root}/`) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream');
    response.end(readFileSync(file));
  });
  const detach = data.attach(http);
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No fixture listener');
  return { db, data, clock, cookie, session, url: `http://127.0.0.1:${address.port}`,
    async close() { detach(); await data.close(); await new Promise<void>(ok => http.close(() => ok())); client.close(); } };
}

it('executes the registered Tasks selection and real command envelope over shared authenticated HTTP', async () => {
  const app = await fixture();
  try {
    const headers = { 'content-type': 'application/json', cookie: `loom_ui=${app.cookie}` };
    const read = await fetch(`${app.url}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query: tasksQuery }) });
    const result = await read.json(); expect(result.errors).toBeUndefined();
    expect(result.data.tasks.map((task: { id: string }) => task.id)).toEqual(['t-1','t-2']);
    expect(JSON.stringify(result)).not.toContain('changeTasksByTask');
    const opened = await (await fetch(app.url+'/graphql', {method:'POST', headers,
      body:JSON.stringify({query:tasksQuery,variables:{selected:'t-1',withComments:true}})})).json();
    expect(opened.errors).toBeUndefined();
    expect(opened.data.selectedTask.changeTasksByTask).toEqual([{changeRow:expect.objectContaining({id:'github:acme/app#3'})}]);
    expect(JSON.stringify(opened)).not.toContain('github:secret/app#9');
    const choices=()=>fetch(`${app.url}/graphql`,{method:'POST',headers,body:JSON.stringify({query:taskChoicesQuery})}).then(response=>response.json());
    const firstChoices=await choices();expect(firstChoices.errors).toBeUndefined();expect(firstChoices.data.members).toEqual([{id:'sam'}]);
    expect(firstChoices.data.projects.sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id))).toEqual(['bank','pond'].map(id=>({id,name:id,projectMembersByProject:[{member:'lee'},{member:'sam'}]})));
    app.data.writes.run(()=>app.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'sam')).run());
    expect((await choices()).data.members).toEqual([{id:'lee'},{id:'sam'}]);
    app.data.writes.run(()=>app.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'sam')).run());
    expect((await choices()).data.members).toEqual([{id:'sam'}]);
    app.data.writes.run(()=>app.db.delete(s.projectMembers).where(eq(s.projectMembers.member,'sam')).run());
    expect((await choices()).data.projects).toEqual([]);
    app.data.writes.run(()=>app.db.insert(s.projectMembers).values(['pond','bank'].map(project=>({project,member:'sam'}))).run());
    const input = { action: 'comment', id: 't-1', text: 'From real shared HTTP' };
    const send = () => fetch(`${app.url}/api/tasks/command`, { method: 'POST', headers, body: JSON.stringify({ input, id: 'fixture-comment' }) });
    expect(await (await send()).json()).toEqual({ ok: true, value: { id: 't-1' } });
    expect((await send()).status).toBe(200);
    expect(app.db.select().from(s.taskComments).all()).toMatchObject([{ actorKind: 'member', actor: 'sam', text: input.text }]);
    const ask = await fetch(`${app.url}/api/tasks/command`, {method:'POST',headers,body:JSON.stringify({id:'fixture-ask',input:{action:'ask',id:'t-1',input:{to:{kind:'member',id:'sam'},ask:'Node question?',ifYes:'Continue',ifNo:'Wait',answers:'yes-no'}}})});
    expect(ask.status).toBe(200);
    expect(app.db.select().from(s.inbox).where(and(eq(s.inbox.source,'task'),eq(s.inbox.waitsOnKind,'task'),eq(s.inbox.waitsOnId,'t-1'))).all()).toEqual([expect.objectContaining({to:'sam',words:'Node question?',answers:'yes-no'})]);
    app.data.writes.run(() => app.db.delete(s.sessions).where(eq(s.sessions.id, app.session)).run());
    expect((await send()).status).toBe(401);
  } finally { await app.close(); }
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root, 'index.html')))('Tasks forms commit through shared HTTP and update retained windows without legacy calls', async () => {
  const app = await fixture();
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  let stage='open windows';
  const step=(name:string)=>{stage=name;console.info('Tasks evidence:',name);};
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'loom_ui', value: app.cookie, url: app.url }]);
    const a = await context.newPage(), b = await context.newPage(), errors: string[] = [];
    await context.tracing.start({screenshots:true,snapshots:true,sources:false});
    onTestFailed(async()=>{
      console.error('Tasks evidence failed at:',stage);
      const dir=process.env.LOOM_TEST_SHOTS ?? join(tmpdir(),'loom-tasks-app');mkdirSync(dir,{recursive:true});
      try {await a.screenshot({path:join(dir,'failure.png'),fullPage:true,timeout:5000});await context.tracing.stop({path:join(dir,'failure-trace.zip')});} catch(error) {console.error('Tasks diagnostic capture:',String(error));}
      await browser.close();
    });
    for (const page of [a,b]) page.on('pageerror', error => errors.push(error.message));
    await Promise.all([a.goto(`${app.url}/p/tasks-preview`), b.goto(`${app.url}/p/tasks-preview`)]);
    const row = (page: typeof a, name = title) => page.locator('[data-split-row]').filter({ hasText: name });
    for (const page of [a,b]) { await expect.poll(() => row(page).count()).toBe(1); expect(await page.getByText(hiddenTitle, { exact: true }).count()).toBe(0); await row(page).click(); }
    for (const page of [a,b]) { await expect.poll(() => page.getByRole('group', { name:'Pull request acme/app#3', exact:true }).textContent()).toContain('Checks passing · Approved'); expect(await page.getByRole('link', { name:'secret/app#9', exact:true }).count()).toBe(0); }
    app.data.writes.run(() => app.db.update(s.changes).set({ checks:'failing', review:'changes_requested' }).where(eq(s.changes.id,'github:acme/app#3')).run());
    for (const page of [a,b]) await expect.poll(() => page.getByRole('group', { name:'Pull request acme/app#3', exact:true }).textContent()).toContain('Checks failing · Changes requested');
    step('comment');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Comment', exact: true }).click();
    let form = a.getByRole('form', { name: 'Add comment', exact: true });
    await form.getByLabel('Comment', { exact: true }).fill('Shared HTTP comment');
    await form.getByRole('button', { name: 'Add comment', exact: true }).click();
    for (const page of [a,b]) await expect.poll(() => page.getByText('Shared HTTP comment', { exact: true }).count()).toBe(1);
    expect(app.db.select().from(s.taskComments).all()).toMatchObject([{ actor: 'sam', text: 'Shared HTTP comment' }]);
    step('Priority');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Priority', exact: true }).click();
    form = a.getByRole('form', { name: 'Set priority', exact: true });
    await form.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('0');
    await form.getByRole('button', { name: 'Set priority', exact: true }).click();
    for (const page of [a,b]) await expect.poll(() => page.getByText('t-1 · P0 · open', { exact: true }).count()).toBe(1);
    await b.reload(); await expect.poll(() => b.getByText('Shared HTTP comment', { exact: true }).count()).toBe(1);
    await expect.poll(() => b.getByRole('group', {name:'Pull request acme/app#3',exact:true}).textContent()).toContain('Checks failing · Changes requested');
    step('Edit');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
    form = a.getByRole('form', { name: 'Edit task', exact: true });
    await form.getByLabel('Done when', { exact: true }).fill('Water flows after the browser edit');
    await form.getByRole('button', { name: 'Save changes', exact: true }).click();
    for (const page of [a,b]) await expect.poll(() => page.getByText('Water flows after the browser edit', { exact: true }).count()).toBe(1);
    // Parent and Blocked by are behind More; each form lists what the task has (with its own Remove) and adds one.
    for (const [action, title, relation, label, add] of [['Parent','Parent','parent-child','Parent task','Set parent'], ['Blocked by…','Blocked by','blocks','Blocking task','Add blocker']] as const) {
      for (const remove of [false, true]) {
        step(`${action} remove=${remove}`);
        await a.getByRole('button', { name: 'More for this task', exact: true }).click();
        await a.getByRole('group', { name: 'More for this task', exact: true }).getByRole('button', { name: action, exact: true }).click();
        form = a.getByRole('form', { name: title, exact: true });
        if (remove) await form.getByRole('button', { name: /^Remove / }).click();
        else { await form.getByRole('combobox', { name: label, exact: true }).selectOption('t-2'); await form.getByRole('button', { name: add, exact: true }).click(); }
        await expect.poll(() => app.db.select().from(s.taskLinks).where(and(eq(s.taskLinks.task, 't-1'), eq(s.taskLinks.dependsOn, 't-2'), eq(s.taskLinks.type, relation))).all().length).toBe(remove ? 0 : 1);
        for (const page of [a,b]) await expect.poll(() => page.getByRole('group', { name: title, exact: true }).count()).toBe(remove ? 0 : 1);
      }
    }
    for (const project of ['bank','pond']) {
      step(`project ${project}`);
      await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Project', exact: true }).click();
      form = a.getByRole('form', { name: 'Set project', exact: true });
      await form.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project);
      await form.getByRole('button', { name: 'Set project', exact: true }).click();
      for (const page of [a,b]) await expect.poll(() => page.getByText(`open · P0 · ${project}`, { exact: true }).count()).toBe(1);
    }
    step('Claim');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Claim', exact: true }).click();
    // Claim is done at once: no form, and the task then says who has it, by name.
    expect(await a.getByRole('form').count()).toBe(0);
    for (const page of [a,b]) await expect.poll(() => page.getByText('Assigned to', { exact: true }).count()).toBe(1);
    step('Unclaim');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Unclaim', exact: true }).click();
    await expect.poll(() => a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Claim', exact: true }).count()).toBe(1);
    step('Ask a person');
    await a.getByRole('button', { name: 'More for this task', exact: true }).click();
    await a.getByRole('group', { name: 'More for this task', exact: true }).getByRole('button', { name: 'Ask a person', exact: true }).click();
    form = a.getByRole('form', { name: 'Ask a person', exact: true });
    await form.getByRole('combobox', { name: 'Person', exact: true }).selectOption('lee');
    for (const [label,text] of [['Question','Which pump?'],['If yes','Order it'],['If no','Wait']]) await form.getByLabel(label, { exact: true }).fill(text);
    await form.getByRole('button', { name: 'Ask', exact: true }).click();
    for (const page of [a,b]) await expect.poll(() => page.getByText('Which pump?', { exact: true }).count()).toBe(1);
    expect(app.db.select().from(s.inbox).where(and(eq(s.inbox.source, 'task'), eq(s.inbox.waitsOnKind, 'task'), eq(s.inbox.waitsOnId, 't-1'))).all()).toEqual(expect.arrayContaining([expect.objectContaining({ to: 'lee', answers: 'yes-no' })]));
    step('Close');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    form = a.getByRole('form', { name: 'Close task', exact: true });
    await form.getByLabel('Reason', { exact: true }).fill('Finished in browser');
    await form.getByRole('button', { name: 'Close task', exact: true }).click();
    for (const page of [a,b]) await expect.poll(() => page.getByRole('region',{name:'Ticket story'}).getByText('Finished in browser', { exact: true }).count()).toBe(1);
    step('Reopen');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Reopen', exact: true }).click();
    for (const page of [a,b]) await expect.poll(() => page.getByText('open · P0 · pond', {exact:true}).count()).toBe(1);
    step('create at390');
    await a.setViewportSize({ width: 390, height: 900 });
    await a.goto(`${app.url}/p/tasks-preview`);
    await a.getByRole('button', { name: 'Create task', exact: true }).click();
    form = a.getByRole('form', { name: 'Create task', exact: true });
    for (const [label,text] of [['Title','Browser planted task'],['Goal','Water moves'],['Why','Pond needs it']]) await form.getByLabel(label, { exact: true }).fill(text);
    await form.getByRole('combobox', { name: 'Project', exact: true }).selectOption('pond');
    await form.getByRole('combobox', { name: 'Owner', exact: true }).selectOption('agent:art');
    expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await form.getByRole('button', { name: 'Create task', exact: true }).click();
    for (const page of [a,b]) await expect.poll(() => row(page, 'Browser planted task').count()).toBe(1);
    const created = app.db.select().from(s.tasks).where(eq(s.tasks.title, 'Browser planted task')).get()!;
    expect(created).toMatchObject({ project: 'pond', ownerKind: 'agent', owner: 'art', createdByKind: 'member', createdBy: 'sam' });
    await row(a, 'Browser planted task').click();
    await a.setViewportSize({ width: 1920, height: 900 });
    step('comment');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Comment', exact: true }).click();
    form = a.getByRole('form', { name: 'Add comment', exact: true });
    await form.getByLabel('Comment', { exact: true }).fill('Wide form comment');
    expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await form.getByRole('button', { name: 'Add comment', exact: true }).click();
    await expect.poll(() => a.getByText('Wide form comment', { exact: true }).count()).toBe(1);
    await expect.poll(() => a.getByRole('form', {name:'Add comment',exact:true}).count()).toBe(0);
    step('responsive images');
    const shots = process.env.LOOM_TEST_SHOTS ?? join(tmpdir(), 'loom-tasks-app'); mkdirSync(shots, { recursive: true });
    for (const look of ['neon','daylight']) for (const width of [390,1280,1920]) {
      await a.setViewportSize({ width, height: 900 });
      await a.evaluate(look => { document.documentElement.dataset.look = look; document.documentElement.dataset.mode = look === 'daylight' ? 'light' : 'dark'; }, look);
      await expect.poll(() => a.locator('.loom-split').getAttribute('data-mode')).toBe(width < 640 ? 'one' : 'three');
      expect(await a.locator('.loom-split').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await a.screenshot({ path: join(shots, `tasks-${look}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    step('comment');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Comment', exact: true }).click();
    form = a.getByRole('form', { name: 'Add comment', exact: true });
    await form.getByLabel('Comment', { exact: true }).fill('Discarded private draft');
    step('project withdrawal');
    app.data.writes.run(() => app.db.delete(s.projectMembers).where(eq(s.projectMembers.member, 'sam')).run());
    for (const page of [a,b]) await expect.poll(() => row(page, 'Browser planted task').count()).toBe(0);
    app.data.writes.run(() => app.db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run());
    for (const page of [a,b]) await expect.poll(() => row(page, 'Browser planted task').count()).toBe(1);
    expect(await a.getByRole('form', { name: 'Add comment', exact: true }).count()).toBe(0);
    step('comment');
    await a.getByRole('group', { name: 'Task actions', exact: true }).getByRole('button', { name: 'Comment', exact: true }).click();
    form = a.getByRole('form', { name: 'Add comment', exact: true });
    expect(await form.getByLabel('Comment', { exact: true }).inputValue()).toBe('');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    app.data.writes.run(() => app.db.delete(s.sessions).where(eq(s.sessions.id, app.session)).run());
    for (const page of [a,b]) await expect.poll(() => row(page, 'Browser planted task').count()).toBe(0);
    step('reconnect denied');
    await b.reload(); await expect.poll(() => b.getByRole('heading', { name: 'Sign in to loom', exact: true }).count()).toBe(1);
    expect(await row(b, 'Browser planted task').count()).toBe(0);
    step('finished');
    expect(errors).toEqual([]); await context.tracing.stop(); await context.close();
  } finally { await browser.close(); await app.close(); }
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root, 'index.html')))('opens a shared project in Work and follows its ticket into the existing reader', async () => {
  const app = await fixture(true);
  const mail = app.data.services.conversations;
  const ask = app.data.writes.run(()=>mail.send({toKind:'person',to:'sam',member:'sam',project:'pond',
    source:'notice',fromKind:'agent',words:'Order the pump?',answers:'yes-no'})).value;
  const browser = await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page = await context.newPage();
    await page.goto(app.url+'/p/work');
    const project = page.locator('[data-split-row]').filter({has:page.getByText('pond',{exact:true})});
    await expect.poll(()=>project.textContent({timeout:5000})).toContain('Needs you · 1');
    await page.getByText(/1 project question waiting for you/).waitFor();
    app.data.writes.run(()=>mail.answer(ask.id,'sam','yes'));
    await expect.poll(()=>project.textContent({timeout:5000})).not.toContain('Needs you');
    await project.click({timeout:15000});
    await page.getByText('Open board',{exact:true}).click();
    const ticket = page.locator('[data-split-row]').filter({hasText:title});
    await expect.poll(()=>ticket.textContent({timeout:3000})).toContain('PR #3');
    app.data.writes.run(()=>app.db.insert(s.taskLinks).values([
      {task:'t-1',dependsOn:'t-2',type:'blocks'}, {task:'t-1',dependsOn:'t-90',type:'blocks'},
    ]).run());
    await expect.poll(()=>ticket.textContent({timeout:3000})).toContain('Waiting for Order pump parts');
    expect(await page.getByText(hiddenTitle,{exact:false}).count()).toBe(0);
    await ticket.click({timeout:10000});
    await expect.poll(()=>page.getByRole('group',{name:'Pull request acme/app#3',exact:true}).count()).toBe(1);
    expect(await page.getByText(hiddenTitle,{exact:true}).count()).toBe(0);
  } finally {await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('promotes a ticket from its reader and keeps its pull request and history', async () => {
  const app=await fixture(), browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await context.newPage();
    await page.goto(app.url+'/p/tasks-preview/task/t-1');
    await page.getByRole('button',{name:'More for this task',exact:true}).click({timeout:10000});
    const menu = page.getByRole('group',{name:'More for this task'});
    for (const width of [1280,1440]) {
      await page.setViewportSize({width,height:900});
      await expect.poll(()=>menu.evaluate(box=>{
        const bounds=box.getBoundingClientRect();
        const actions=box.closest('.loom-kit-actions')!.getBoundingClientRect();
        return bounds.left>=actions.left-1 && bounds.right<=actions.right+1;
      })).toBe(true);
    }
    await page.getByText('Promote to epic',{exact:true}).click();
    await page.getByText('Promoted this ticket to an epic.',{exact:true}).waitFor();
    expect(new URL(page.url()).pathname).toBe('/p/tasks-preview/task/t-1');
    expect(await page.getByRole('group',{name:'Pull request acme/app#3',exact:true}).count()).toBe(1);
    expect(app.data.services.tasks.get('t-1').type).toBe('epic');
  } finally { await browser.close(); await app.close(); }
});


it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root, 'index.html')))('reads new ticket updates on a return visit to Work', async()=>{
  const app=await fixture(true);
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();
    await page.goto(app.url+'/p/work');
    const updates=page.getByRole('region',{name:'pond updates'});
    await updates.getByText(title,{exact:true}).waitFor();
    await page.reload();
    await page.getByText('No project tickets have changed since your last visit.').waitFor();
    const at='2026-11-15T20:00:00.000Z';
    app.data.writes.run(()=>{
      app.db.update(s.tasks).set({changedAt:at}).where(eq(s.tasks.id,'t-1')).run();
      app.db.insert(s.taskComments).values({task:'t-1',seq:1,at,actorKind:'agent',actor:'art',text:'Found a worn bearing.'}).run();
    });
    await updates.getByText('Found a worn bearing.',{exact:true}).waitFor();
    expect(await updates.getByText(hiddenTitle,{exact:true}).count()).toBe(0);
    await updates.getByText(title,{exact:true}).click();
    await page.getByRole('region',{name:'Ticket story'}).getByText('Found a worn bearing.',{exact:true}).waitFor();
    expect(new URL(page.url()).pathname).toBe('/p/tasks-preview/task/t-1');
  } finally { await browser.close(); await app.close(); }
});

it.runIf(process.env.CI==='true' && chrome && existsSync(join(root,'index.html')))('discusses a Work ticket in Comms and sends only the typed direction',async()=>{
  const app=await fixture(true);
  app.data.writes.run(()=>app.db.insert(s.memberAgents).values({member:'sam',agent:'art'}).run());
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(app.url+'/p/tasks-preview/task/t-1');
    await page.getByRole('button',{name:/Discuss privately with Art/i}).click();
    const composer=page.getByRole('textbox',{name:'Message Art',exact:true});
    await composer.waitFor();
    expect(await composer.inputValue()).toBe('');
    await page.locator('.comms-notice').getByRole('button',{name:title,exact:true}).waitFor();
    expect(app.db.select().from(s.inbox).all()).toHaveLength(0);
    await composer.fill('Please do this one next');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(()=>app.db.select().from(s.inbox).all().length).toBe(1);
    const href=page.url();
    await page.goto(app.url+'/p/tasks-preview/task/t-1');
    await page.getByRole('button',{name:/Discuss privately with Art/i}).click();
    await composer.waitFor();
    expect(page.url()).toBe(href);
    expect(app.db.select().from(s.inbox).all()).toHaveLength(1);
  } finally {await browser.close();await app.close();}
});

it.runIf(process.env.CI==='true' && chrome && existsSync(join(root,'index.html')))('pauses new project claims from Work and reads the direction after reload',async()=>{
  const app=await fixture(true);
  app.data.writes.run(()=>app.db.insert(s.memberAgents).values({member:'sam',agent:'art'}).run());
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();
    await page.goto(app.url+'/p/work/project/pond');
    await page.getByRole('button',{name:'Pause new claims for Art',exact:true}).click();
    const resume=page.getByRole('button',{name:'Resume new claims for Art',exact:true});
    await resume.waitFor();
    await page.reload();await resume.click();
    await page.getByRole('button',{name:'Pause new claims for Art',exact:true}).waitFor();
    expect(app.db.select().from(s.projectClaimDirections).all().map(row=>row.paused)).toEqual([true,false]);
    expect(app.db.select().from(s.agentPauses).all()).toEqual([]);
  } finally {await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root, 'index.html')))('reads a closed-only unfiled backlog across pages and returns from its ticket story', async () => {
  const app = await fixture(), browser = await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const at = '2026-11-14T20:00:00.000Z';
    app.data.writes.run(()=>app.db.insert(s.tasks).values(Array.from({length:51},(_,i)=>({
      id:'t-'+(200+i), title:'Completed inspection '+(200+i), status:'closed' as const, ownerKind:'member' as const,
      owner:'sam',goal:'Verify pumps',why:'Maintenance',createdByKind:'member' as const,createdBy:'sam',
      createdAt:at,changedAt:at,closedAt:at,closeReason:'Inspected',
    }))).run());
    const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(app.url+'/p/work');
    await page.getByText('Unfiled tickets',{exact:true}).click();
    await page.getByRole('button',{name:'Next page'}).click();
    const last = page.getByText('Completed inspection 250',{exact:true});
    await last.click();
    await page.getByRole('region',{name:'Ticket story'}).getByText('Ticket closed',{exact:true}).waitFor();
    await page.goBack();
    await last.waitFor();
    expect(await page.getByText(hiddenTitle,{exact:true}).count()).toBe(0);
    expect(await page.getByRole('button',{name:'Next page'}).isDisabled()).toBe(true);
  } finally {await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('explains a 64 to 43 backlog change and preserves the comparison on Back',async()=>{
  const app=await fixture(),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const stamp=()=>new Date(app.clock.now()).toISOString();
    const seed=(first:number,n:number)=>app.data.writes.run(()=>app.db.insert(s.tasks).values(Array.from({length:n},(_,i)=>({
      id:'t-'+(first+i),title:'Inspection '+(first+i),project:'bank',ownerKind:'member' as const,owner:'sam',
      goal:'Verify pumps',why:'Maintenance',createdByKind:'member' as const,createdBy:'sam',createdAt:stamp(),changedAt:stamp(),
    }))).run());
    app.clock.advance(60_000);seed(300,64);const since=stamp();
    app.clock.advance(60_000);seed(400,12);
    app.data.writes.run(()=>{
      for(const first of [300,400])for(let i=0;i<(first===300?30:3);i++)
        app.db.update(s.tasks).set({status:'closed',closedAt:stamp(),changedAt:stamp(),closeReason:'Inspected'}).where(eq(s.tasks.id,'t-'+(first+i))).run();
    });
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await context.newPage();page.setDefaultTimeout(8000);
    await page.goto(app.url+'/p/work/project/bank/history?'+new URLSearchParams({since,until:stamp()}));
    await page.getByText('64 open at the start · 43 open at the end',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Original tickets that closed · 30',exact:true}).waitFor();
    await page.getByRole('button',{name:'Tickets created here · 12',exact:true}).waitFor();
    await page.getByRole('button',{name:'New tickets that also closed · 3',exact:true}).click();
    const selection=page.url();
    await page.getByText('Inspection 401',{exact:true}).click();
    await page.getByRole('region',{name:'Ticket story'}).getByText('Ticket closed',{exact:true}).waitFor();
    await page.goBack();
    await page.getByText('Inspection 401',{exact:true}).waitFor();
    expect(page.url()).toBe(selection);
  }finally{await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('opens an unlinked project PR alongside linked work and preserves the project list on Back',async()=>{
  const app=await fixture(),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const existing=app.db.select().from(s.changes).where(eq(s.changes.id,'github:acme/app#3')).get()!;
    app.data.writes.run(()=>{
      app.db.insert(s.changes).values({...existing,id:'github:acme/second#8',repository:'acme/second',number:8,title:'New repository change'}).run();
      app.db.insert(s.changeSync).values({readAt:existing.updatedAt,failed:true}).run();
    });
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await context.newPage();page.setDefaultTimeout(7000);
    await page.goto(app.url+'/p/work/project/pond');
    await page.getByRole('button',{name:'Open pull requests'}).click();
    const url=page.url(),rows=page.getByRole('group',{name:'Project pull requests'});
    await rows.getByText('acme/app #3 · Linked ticket',{exact:true}).waitFor();
    await rows.getByText('acme/second #8 · No visible ticket link',{exact:true}).waitFor();
    await page.getByText('GitHub read time unavailable.',{exact:true}).waitFor();
    expect(await rows.getByText('Hidden linked change',{exact:true}).count()).toBe(0);
    await rows.getByText('New repository change',{exact:true}).click();
    await page.getByRole('article',{name:'Change',exact:true}).getByText('New repository change',{exact:true}).waitFor();
    await page.goBack();
    await rows.waitFor();
    expect(page.url()).toBe(url);
    app.data.writes.run(()=>app.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'sam')).run());
    await page.getByText(/Latest GitHub read failed.*Last successful household GitHub read/).waitFor();
  }finally{await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('reads a fresh reply on a quiet ticket in desk and project catch-up',async()=>{
  const app=await fixture(true),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const {prepareAgentPost}=await import('../core/conversations/agent-posts.js');
    const comms=app.data.services.comms!;
    const th=comms.threads.open({member:'sam',agent:'art',title:'Inspection'});
    const add=async(input:Parameters<typeof prepareAgentPost>[3])=>{
      const save=await prepareAgentPost(app.db,comms.key,th.id,input);
      return app.data.writes.run(()=>save(new Date(app.clock.now()).toISOString())).value;
    };
    const activity=await add({action:'open',words:'Checking idle pressure.',refs:['t-1']});
    const ctx=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();page.setDefaultTimeout(8000);
    await page.goto(app.url+'/p/work');
    const pond=page.getByRole('region',{name:'pond updates'});
    await pond.getByText(/Checking idle pressure/).waitFor();
    await page.reload();
    await page.getByText('No project tickets have changed since your last visit.').waitFor();
    await add({action:'reply',thread:activity,words:'Gauge is steady after restart.'});
    await pond.getByText(/Gauge is steady after restart/).waitFor();
    app.data.writes.run(()=>app.data.services.tasks.close('t-1','done'));
    await pond.getByText(/Completed · Art · Gauge is steady after restart/).waitFor();
    app.clock.advance(1000);
    app.data.writes.run(()=>{
      const tasks=app.data.services.tasks;
      tasks.comment('t-2','Both installed readers showed the correct portrait. '+'More evidence. '.repeat(40),{kind:'agent',id:'art'});
      tasks.close('t-2','done');
    });
    const receipt=pond.getByText(/Completed · Art · Both installed readers/);
    await receipt.waitFor();
    expect((await receipt.textContent())!.length).toBeLessThan(250);
    app.data.writes.run(()=>{app.data.services.tasks.reopen('t-2');app.data.services.tasks.close('t-2','The old pump was recycled.');});
    await pond.getByText('Closed · The old pump was recycled.',{exact:true}).waitFor();
    await pond.getByRole('button',{name:'pond',exact:true}).click();
    const highlights=page.getByRole('region',{name:'Latest agent updates'});
    await highlights.getByText(/Gauge is steady after restart/).click();
    await page.getByRole('region',{name:'Ticket story'}).getByText('Gauge is steady after restart.',{exact:true}).waitFor();
  }finally{await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('opens the attributed project note from Work and returns to the shared project',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'work-project-notes-'));
  const {ProjectsStore}=await import('../backends/projects.js');
  const memories=join(directory,'memories.db');
  const store=new ProjectsStore({dbPath:memories});
  store.write({slug:'field-notes',name:'Pump field notes',summary:'Cold starts need a second reading.',links:{epic:'t-1'}});
  store.close();
  const app=await fixture(false,{checkingAgent:'art',sources:{agents:[{agent:'art',directory,memories}],commons:{
    directory,knowledge:join(directory,'knowledge.db'),people:join(directory,'people.db'),
  }}});
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    app.data.writes.run(()=>{
      app.db.insert(s.memberAgents).values({member:'sam',agent:'art'}).run();
      app.db.update(s.tasks).set({type:'epic'}).where(eq(s.tasks.id,'t-1')).run();
    });
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();page.setDefaultTimeout(8000);
    await page.goto(app.url+'/p/work/project/pond');
    const notes=page.getByRole('region',{name:'Project notes'});
    await notes.getByText('Cold starts need a second reading.').waitFor();
    await notes.getByRole('button',{name:/art.*Pump field notes/i}).click();
    await page.getByRole('heading',{level:1,name:'Pump field notes',exact:true}).waitFor();
    await page.goBack();
    await notes.getByText('Cold starts need a second reading.').waitFor();
  }finally{await browser.close();await app.close();rmSync(directory,{recursive:true,force:true});}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('reads the same shared goal on the project card and overview',async()=>{
  const app=await fixture(),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const goal='Bring the well online before winter.';
    app.data.writes.run(()=>app.db.update(s.projects).set({goal}).where(eq(s.projects.id,'pond')).run());
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();page.setDefaultTimeout(7000);
    await page.goto(app.url+'/p/work');
    await page.getByText(goal,{exact:true}).waitFor();
    await page.getByRole('button',{name:/pond.*fix pond pump/i}).click();
    await page.getByRole('button',{name:'Open board'}).waitFor();
    await page.getByText(goal,{exact:true}).waitFor();
    app.data.writes.run(()=>app.db.update(s.projects).set({goal:null}).where(eq(s.projects.id,'pond')).run());
    await page.getByText(goal,{exact:true}).waitFor({state:'detached'});
  }finally{await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('reads two GitHub review revisions and withdraws findings when project access ends',async()=>{
  const app=await fixture(),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const at=new Date(app.clock.now()).toISOString();
    const visible='github:acme/app#3',hidden='github:secret/app#9';
    app.data.writes.run(()=>app.db.insert(s.githubReviews).values([
      {change:visible,id:'r1',login:'reviewer',state:'CHANGES_REQUESTED',body:'Back loses page two.',headCommit:'a'.repeat(40),submittedAt:at,url:'https://github.com/acme/app/pull/3#pullrequestreview-1'},
      {change:visible,id:'r2',login:'reviewer',state:'APPROVED',body:'Back now restores page two.',headCommit:'b'.repeat(40),submittedAt:at,url:'https://github.com/acme/app/pull/3#pullrequestreview-2'},
      {change:hidden,id:'r3',login:'private',state:'COMMENTED',body:'Private report',headCommit:null,submittedAt:at,url:'https://github.com/secret/app/pull/9#pullrequestreview-3'},
    ]).run());
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();page.setDefaultTimeout(8000);
    await page.goto(app.url+'/p/tasks-preview/task/t-1');
    const story=page.getByRole('region',{name:'Ticket story'});
    await story.getByText('Back loses page two.').waitFor();
    await story.getByText('Back now restores page two.').waitFor();
    expect(await story.getByRole('link',{name:/GitHub review/}).allTextContents()).toEqual(['GitHub review · aaaaaaaa','GitHub review · bbbbbbbb']);
    const link=story.getByRole('link',{name:'GitHub review · bbbbbbbb'});
    if(await link.getAttribute('href')!=='https://github.com/acme/app/pull/3#pullrequestreview-2')throw Error('Wrong review source');
    if(await page.getByText('Private report').count())throw Error('Private review exposed');
    app.data.writes.run(()=>app.db.delete(s.projectMembers).where(eq(s.projectMembers.member,'sam')).run());
    await page.getByText('Back loses page two.').waitFor({state:'detached'});
  } finally {await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('opens a finished ticket on its commitment and recorded outcome with expandable receipts',async()=>{
  const app=await fixture(),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const at=new Date(app.clock.now()).toISOString();
    const receipt='The first restart failed.\n'+('Pressure and flow recorded. '.repeat(27))+'The second restart held.';
    app.data.writes.run(()=>{
      app.db.update(s.tasks).set({status:'closed',closedAt:at,doneWhen:'Water reaches the upper pond.',closeReason:'Water reached the upper pond after two restarts.'}).where(eq(s.tasks.id,'t-1')).run();
      app.db.insert(s.taskComments).values({task:'t-1',seq:1,at,actorKind:'agent',actor:'art',text:receipt}).run();
    });
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();page.setDefaultTimeout(8000);
    await page.goto(app.url+'/p/tasks-preview/task/t-1');
    const reader=page.getByRole('article',{name:'Task'});
    const commitment=reader.getByRole('region',{name:'Commitment'}),outcome=reader.getByRole('region',{name:'Recorded outcome'});
    await commitment.getByText('Water reaches the upper pond.').waitFor();
    await outcome.getByText('Water reached the upper pond after two restarts.').waitFor();
    const names=await reader.locator('section[aria-label]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')));
    expect(names.indexOf('Commitment')).toBeLessThan(names.indexOf('Recorded outcome'));
    expect(names.indexOf('Recorded outcome')).toBeLessThan(names.indexOf('Ticket story'));
    const entry=reader.getByRole('region',{name:'Ticket story'}).locator('details').filter({hasText:receipt.slice(-24)});
    const full=entry.locator('p');
    expect(await full.isVisible()).toBe(false);
    await entry.locator('summary').click();
    await full.waitFor();expect(await full.textContent()).toBe(receipt);
    app.data.writes.run(()=>app.db.update(s.tasks).set({closeReason:'done'}).where(eq(s.tasks.id,'t-1')).run());
    await outcome.waitFor({state:'detached'});
  }finally{await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('opens a direct Work project with independent questions and backlog history',async()=>{
  const app=await fixture(true),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    app.data.writes.run(()=>app.db.insert(s.memberAgents).values({member:'sam',agent:'art'}).run());
    const {prepareAgentPost}=await import('../core/conversations/agent-posts.js');
    const save=await prepareAgentPost(app.db,app.data.services.comms!.key,'work-source:inspection',
      {action:'open',words:'Watching pressure on the shared pump.',refs:['t-1']},{task:'t-1',agent:'art',project:'pond'});
    app.data.writes.run(()=>save(new Date(app.clock.now()).toISOString()));
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce',viewport:{width:1440,height:900}});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();page.setDefaultTimeout(8000);
    await page.goto(app.url+'/p/work/project/pond');
    await page.getByRole('region',{name:'Latest agent updates'}).getByText(/Watching pressure/).waitFor();
    await page.getByRole('button',{name:'Compare backlog and see tickets'}).click();
    await page.waitForURL(url=>url.pathname.endsWith('/project/pond/history'));
  }finally{await browser.close();await app.close();}
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root,'index.html')))('keeps the epic and page on Back and filters finished work before limiting', async()=>{
  const app=await fixture(true), browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const service=app.data.services.tasks, actor={kind:'agent' as const,id:'art'};
    const create=(title:string,parent?:string,type:'task'|'epic'='task')=>service.create({
      title,project:'pond',goal:'Inspect the pump',why:'Maintenance',owner:actor,type,parent,
    },actor);
    const epic=app.data.writes.run(()=>{
      const epic=create('Spring inspections',undefined,'epic');
      const finished=create('Finished spring inspection',epic.id);
      service.close(finished.id,'Verified');
      for(let i=0;i<51;i++) service.claim(create('Spring work '+i,epic.id).id,actor);
      app.clock.advance(1000);
      for(let i=0;i<6;i++) service.close(create('Unrelated finished '+i).id,'Verified');
      return epic;
    }).value;
    const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await context.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await context.newPage();page.setDefaultTimeout(10000);
    await page.goto(app.url+'/p/work/project/pond/board');
    await page.getByRole('combobox',{name:'Epic'}).selectOption(epic.id);
    const working=page.getByRole('region',{name:'Working',exact:true});
    await page.getByRole('region',{name:'Recently finished'}).getByText('Finished spring inspection',{exact:true}).waitFor();
    expect(await page.getByText(/Unrelated finished/).count()).toBe(0);
    await page.getByRole('button',{name:'Next page'}).click();
    const last=working.getByText(/^Spring work /);
    await last.waitFor();
    const title=await last.textContent();
    await last.click();
    await page.getByRole('article',{name:'Task'}).getByText(title!,{exact:true}).waitFor();
    await page.goBack();
    await last.waitFor();
    expect(await last.textContent()).toBe(title);
    expect(await page.getByRole('combobox',{name:'Epic'}).inputValue()).toBe(epic.id);
    const query=new URL(page.url()).searchParams;
    expect(query.get('page')).toBe('2');
    expect(query.get('epic')).toBe(epic.id);
    await page.goto(app.url+'/p/work/project/pond/board?epic=t-90');
    await page.getByText('Epic unavailable',{exact:true}).waitFor();
    expect(await page.getByText(hiddenTitle,{exact:true}).count()).toBe(0);
  } finally {await browser.close();await app.close();}
});

it.runIf(process.env.CI==='true' && chrome && existsSync(join(root,'index.html')))('pages ticket notes without shifting older pages on a live update',async()=>{
  const app=await fixture(true),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const add=(text:string)=>app.data.services.tasks.comment('t-1',text,{kind:'agent',id:'art'});
    app.data.writes.run(()=>{for(let i=1;i<=65;i++)add('Inspection note '+i);});
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await ctx.addCookies([{name:'loom_ui',value:app.cookie,url:app.url}]);
    const page=await ctx.newPage();page.setDefaultTimeout(8000);
    await page.goto(app.url+'/p/tasks-preview/task/t-1');
    const story=page.getByRole('region',{name:'Ticket story'});
    const words=()=>story.getByText(/^Inspection note \d+$/).allTextContents();
    const range=(from:number,to:number)=>Array.from({length:to-from+1},(_,i)=>'Inspection note '+(from+i));
    await expect.poll(words).toEqual(range(36,65));
    await story.getByRole('button',{name:'Earlier notes'}).click();
    await expect.poll(words).toEqual(range(6,35));
    app.data.writes.run(()=>add('Inspection note 66'));
    await story.getByRole('button',{name:'Earlier notes'}).click();
    await expect.poll(words).toEqual(range(1,5));
    await story.getByRole('button',{name:'Newer notes'}).click();
    await expect.poll(words).toEqual(range(6,35));
    await story.getByRole('button',{name:'Newer notes'}).click();
    await expect.poll(words).toEqual(range(37,66));
    await story.getByRole('button',{name:'Earlier notes'}).click();
    await expect.poll(words).toEqual(range(7,36));
    app.data.writes.run(()=>app.db.delete(s.projectMembers).where(and(eq(s.projectMembers.project,'pond'),eq(s.projectMembers.member,'sam'))).run());
    await story.waitFor({state:'hidden'});
    expect(await page.getByText(/^Inspection note \d+$/).count()).toBe(0);
  }finally{await browser.close();await app.close();}
});
