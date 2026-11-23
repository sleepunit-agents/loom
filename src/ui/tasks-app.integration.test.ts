/** Shipped Tasks form over the shared HTTP command/GraphQL door. Browser runs in CI only. */
import { it, expect, onTestFailed } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
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
async function fixture() {
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
  const data = sharedRoot({ db, clock, originAllowed: request => request.headers.origin === `http://${request.headers.host}`, reportError: error => { throw error; } });
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
  return { db, data, cookie, session, url: `http://127.0.0.1:${address.port}`,
    async close() { detach(); await data.close(); await new Promise<void>(ok => http.close(() => ok())); client.close(); } };
}

it('executes the registered Tasks selection and real command envelope over shared authenticated HTTP', async () => {
  const app = await fixture();
  try {
    const headers = { 'content-type': 'application/json', cookie: `loom_ui=${app.cookie}` };
    const read = await fetch(`${app.url}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query: tasksQuery }) });
    const result = await read.json(); expect(result.errors).toBeUndefined();
    expect(result.data.tasks.map((task: { id: string }) => task.id)).toEqual(['t-1','t-2']);
    expect(JSON.stringify(result)).toContain('github:acme/app#3'); expect(JSON.stringify(result)).not.toContain('github:secret/app#9');
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
    for (const page of [a,b]) await expect.poll(() => page.getByText('Finished in browser', { exact: true }).count()).toBe(1);
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
