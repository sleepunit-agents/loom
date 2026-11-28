/** What the boards page's live reads cost loom (docs/specs/boards.md, "Live reads and their cost"): a measurement,
 * not a check. It runs only when asked for, beside the browser suites:
 *
 *   npm run build && LOOM_BROWSER_TESTS=on LOOM_MEASURE=on npx vitest run --project browser src/ui/boards-live-cost.integration.test.ts
 *
 * The built page is served by loom's normal startup over a fictitious household and drawn in Chrome with a board
 * of ten bricks. Each case is run twice: as the page is, and with every selection made eager and no "now" sent
 * (the page's socket messages are rewritten on their way out), which is how the page was before there were two
 * paces. Counted: readings of open selections (initial and again), SQLite statements run on loom's connection
 * (not those the live-scope tracker runs for itself, core/data/table-tracker.ts), and the processor time of this
 * process, which is loom's (Chrome is another process). The numbers are printed; nothing is asserted about them.
 * Run it with LOOM_LIVE_SCOPE=off and =on to compare scoping (docs/specs/boards.md, "Live reads and their cost"). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { clock } from '../core/clock.js';
import { agents, boxes, jobs, jobTrace, memberAgents, members, projectAgents, projectMembers, projects, tasks } from '../core/data/schema.js';
import { reviewPlace } from '../core/conversations/review-place.js';
import { sharedUiProgram } from '../../test/fixtures/shared-ui-program.js';
import { DataLive } from '../core/data/live.js';
import { liveScope } from '../core/data/live-scope.js';
import { trackerStatement } from '../core/data/table-tracker.js';

const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find((p) => p && existsSync(p));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookie = 'c'.repeat(64), token = 't'.repeat(64);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
type Program = Awaited<ReturnType<typeof sharedUiProgram>>;

describe.runIf(chrome && existsSync(join(root, 'board.html')) && process.env.LOOM_MEASURE === 'on')('what the boards page\'s live reads cost', () => {
  let program: Program, browser: Browser, statements = 0, readings = 0;
  const lines: string[] = [];
  beforeAll(async () => {
    program = await sharedUiProgram({ clock, webRoot: root, seed(db, now) {
      db.insert(members).values([{ id: 'alice', role: 'owner', joinedAt: now() }]).run();
      db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
      db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
      db.insert(projects).values({ id: 'pond', name: 'pond' }).run();
      db.insert(projectMembers).values({ project: 'pond', member: 'alice' }).run();
      db.insert(projectAgents).values({ project: 'pond', agent: 'art' }).run();
      db.insert(boxes).values({ id: 'shed', name: 'Shed', owner: 'alice', sameMachineAsLoom: false, hostsAny: false, reportOnly: true, alwaysOn: false, enrolledAt: now() }).run();
      for (const [id, title] of [['t-21', 'Fix the pond pump'], ['t-32', 'Order pump parts'], ['t-43', 'Clear the reeds'], ['t-54', 'Mend the net']] as const)
        db.insert(tasks).values({ id, title, project: 'pond', ownerKind: 'member', owner: 'alice', createdByKind: 'member', createdBy: 'alice', createdAt: now(), changedAt: now() }).run();
      db.$client.prepare('INSERT INTO tokens (fingerprint,label,kind,member,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(hash(token), 'Fixture', 'owner', 'alice', now(), new Date(Date.now() + 6 * 3600000).toISOString());
      db.$client.prepare('INSERT INTO sessions (id,token,device,via,is_agent,issued_at,seen_at,proved_at) VALUES (?,?,?,?,?,?,?,?)').run(hash(cookie), hash(token), 'Browser', 'token', 0, now(), now(), now());
    } });
    // Every statement run on loom's own connection from here on.
    const made = Object.getPrototypeOf(program.client.prepare('SELECT 1')) as Record<string, (...args: unknown[]) => unknown>;
    for (const way of ['run', 'get', 'all', 'iterate']) { const real = made[way]; made[way] = function (this: { source: string }, ...args: unknown[]) { if (!trackerStatement(this.source)) statements++; return real.apply(this, args); }; }
    // Every reading of an open selection, the first and each again.
    const live = DataLive.prototype as unknown as Record<'read', (...args: unknown[]) => unknown>, read = live.read;
    live.read = function (this: unknown, ...args: unknown[]) { readings++; return read.apply(this, args); };
    lines.push(`LOOM_LIVE_SCOPE=${liveScope()}`);
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 120_000);
  afterAll(async () => {
    console.info('\n' + lines.join('\n') + '\n');
    try { await browser?.close(); } finally { await program?.close(); }
  }, 120_000);

  let made = 0;
  /** A thread with a board of ten bricks on screen, the session big, its job running. */
  async function board(before: boolean) {
    const n = ++made, now = () => new Date().toISOString(), mine = ['t-43', 't-54'][n - 1];
    const comms = program.composition.services.comms!;
    const thread = comms.threads.open({ id: `th:cost-${n}`, member: 'alice', agent: 'art', title: `Pond ${n}` });
    const job = { agent: 'art', title: 'Compare pumps', state: 'running' as const, brief: 'Compare the fictional pumps', model: 'none', startedByKind: 'member', startedBy: 'alice',
      houseRepository: '', houseFile: '', houseBranch: '', queuedAt: now() };
    const session = program.composition.writes.run(() => {
      program.db.insert(jobs).values({ ...job, id: `parent-${n}`, conversation: thread.conversation, state: 'done' } as typeof jobs.$inferInsert).run();
      const cv = program.composition.services.conversations.open({ agent: 'art', member: 'alice', project: 'pond', venue: 'handoff', place: reviewPlace(`parent-${n}`, 'brief'), label: 'Compare fictional pumps', direct: false });
      program.db.insert(jobs).values({ ...job, id: `child-${n}`, conversation: cv.id } as typeof jobs.$inferInsert).run();
      return cv.id;
    }).value;
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1600, height: 1200 } });
    await context.addCookies([{ name: 'loom_ui', value: cookie, url: program.url }]);
    const page = await context.newPage(), sent: { relaxed: number; eager: number; now: number } = { relaxed: 0, eager: 0, now: 0 };
    await page.routeWebSocket(/\/graphql$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const text = String(message);
        if (text.includes('LoomNow')) { sent.now++; if (before) return; }
        if (text.includes('"type":"subscribe"') && text.includes('LoomData')) { if (text.includes('"pace":"relaxed"') && !before) sent.relaxed++; else sent.eager++; }
        server.send(before ? text.replace('"pace":"relaxed"', '"pace":"eager"') : text);
      });
    });
    await page.goto(`${program.url}/app/t/${encodeURIComponent(thread.id)}`);
    await page.getByRole('textbox', { name: /^message /i }).waitFor();
    const operate = (name: string, input: object) => page.evaluate(async ([path, body]) => (await (await fetch('/api/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: body, id: crypto.randomUUID() }) })).json()) as { ok: boolean; value?: { board: string } }, [name.replace('.', '/'), input] as const);
    const bricks: [string, object][] = [['session', { session }], ['ticket', { ticket: mine }], ['lanes', { project: 'pond' }], ['comments', { ticket: mine }], ['agent', { agent: 'art' }],
      ['pull', { change: 'github:acme/pond#1' }], ['question', { item: 'in-3' }], ['inbox', {}], ['trend', { project: 'pond' }], ['project', { project: 'pond' }]];
    const opened = await operate('boards.open', { thread: thread.id, place: { brick: bricks[0][0], params: bricks[0][1] } });
    expect(opened.ok).toBe(true);
    for (const [brick, params] of bricks.slice(1)) expect((await operate('boards.change', { board: opened.value!.board, changes: [{ change: 'place', brick, params }] })).ok).toBe(true);
    await expect.poll(() => page.locator('article[data-form]').count()).toBe(10);
    await page.locator('article[data-form="primary"]').getByText('Compare pumps').first().waitFor();
    await sleep(7000);
    /** One commit from outside the page to a table no brick reads: a machine's name. */
    const outside = (i: number) => { program.composition.writes.run(() => { program.client.prepare('UPDATE boxes SET name=? WHERE id=?').run('Shed ' + i, 'shed'); }); };
    let seq = 0;
    const step = () => program.composition.writes.run(() => { program.db.insert(jobTrace).values({ conversation: session, seq: ++seq, job: `child-${n}`, at: now(), tool: 'Terminal', cardState: 'done', clientId: `child-${n}:s${seq}`, keepUntil: new Date(Date.now() + 86400000).toISOString() }).run(); });
    const ticket = (program.client.prepare("SELECT id FROM board_placements WHERE board=? AND brick='ticket'").get(opened.value!.board) as { id: string }).id;
    return { page, context, sent, outside, step, operate, mine, id: opened.value!.board, ticket };
  }
  async function measured(label: string, during: () => Promise<void>, after: number) {
    const from = statements, read = readings, cpu = process.cpuUsage(), began = performance.now();
    await during(); await sleep(after);
    const used = process.cpuUsage(cpu);
    lines.push(`${label.padEnd(64)} ${String(readings - read).padStart(5)} readings ${String(statements - from).padStart(6)} statements  ${((used.user + used.system) / 1000).toFixed(0).padStart(5)} ms cpu  over ${((performance.now() - began) / 1000).toFixed(1)} s`);
  }

  for (const before of [true, false]) {
    it(before ? 'as it was: every selection eager, no "now"' : 'as it is: bricks relaxed, "now" after the member\'s own write', async () => {
      const mode = before ? 'before' : 'after ', b = await board(before);
      try {
      lines.push(`${mode} selections opened since the page loaded: ${b.sent.eager} eager, ${b.sent.relaxed} relaxed`);
      await measured(`${mode} idle, nothing written`, async () => {}, 6000);
      await measured(`${mode} one outside write`, async () => b.outside(0), 6500);
      await measured(`${mode} 20 outside writes 300 ms apart`, async () => { for (let i = 1; i <= 20; i++) { b.outside(i); await sleep(300); } }, 6500);
      // What the ticket brick's Claim sends, from the page as the page sends it: the ticket's own command, then the report to the board.
      await measured(`${mode} one click (claim a ticket) and what follows it`, async () => { expect((await b.operate('tasks.command', { action: 'claim', id: b.mine })).ok).toBe(true); expect((await b.operate('boards.act', { board: b.id, placement: b.ticket, action: 'claim', detail: {} })).ok).toBe(true); }, 6500);
      await measured(`${mode} a session reporting 30 steps over 10 s`, async () => { for (let i = 0; i < 30; i++) { b.step(); await sleep(333); } }, 6500);
      const drawn = await b.page.locator('[data-session-trace] > li').count();
      lines.push(`${mode} steps drawn: ${drawn}; "now" sent by the page: ${b.sent.now}`);
      } finally { await b.context.close(); }
    }, 240_000);
  }
});
