/** The boards page in a real browser against the real server (docs/specs/boards.md, "Checks"): what the page's own
 * suites cannot see because they draw with a test renderer and fakes. The built page (dist/web/board.html and its
 * boards-assets) is served by loom's normal startup over a fictitious household; Chrome drives it. The household
 * has no model, so no agent ever replies, and nothing here waits for one.
 *
 * The page's look and some of its wording are being redesigned, so every selector is one of meaning, and all of
 * them are in the block below: change them there.
 *
 * Not here: a restart with a new build ("A restart" in the spec). This harness serves one build for its whole
 * life; swapping the served files under a live page is a different harness. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from 'playwright-core';
import { clock } from '../core/clock.js';
import { LIVE_RELAXED_MS } from '../core/data/live-pace.js';
import { agents, memberAgents, members, projectAgents, projectMembers, projects, tasks } from '../core/data/schema.js';
import { sharedUiProgram } from '../../test/fixtures/shared-ui-program.js';

const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find((p) => p && existsSync(p));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookie = 'c'.repeat(64), token = 't'.repeat(64);

// ---- Every assumption about the page's markup -------------------------------------------------------------------
/** A drawn placement: an <article> that says which form it has. */
const PLACEMENT = 'article[data-form]';
/** The one in the primary form. */
const BIG = 'article[data-form="primary"]';
/** A chip: anything that says which brick a click on it places. */
const chipFor = (brick: string, id: string) => `[data-place*='"brick":"${brick}"'][data-place*='"${id}"']`;
/** A placement is headed by its brick's name (the spec's "Names"), as a heading. */
const placement = (page: Page, name: RegExp) => page.locator(PLACEMENT).filter({ has: page.getByRole('heading', { name }) });
const LANES = /^lanes$/i, TICKET = /^ticket$/i, APPROVAL = /^approval$/i, AGENTS = /^agents$/i;
/** A placement's own controls are the buttons in its <header>; maximize is the one named for making it big. They
 * are seen, and take a click, only while the placement is pointed at or holds the keyboard, and always where
 * nothing can point (a phone): `reachable` below is the test of that. */
const frameButtons = (of: Locator) => of.locator('header').first().getByRole('button');
const MAXIMIZE = /big|maximi[sz]e|enlarge|expand/i;
/** Refresh is the one named for it; while a placement is getting new data its header holds a status that says so. */
const REFRESH = /^refresh/i;
const GETTING = '[role="status"][aria-label="Getting new data"]';
/** The board's own controls are buttons outside every placement. */
const boardButton = (page: Page, name: RegExp) => page.getByRole('button', { name }).and(page.locator(`:not(${PLACEMENT} *)`));
const CLOSE = /^close$/i, REOPEN = /^reopen$/i;
/** The ticket brick's actions, by the start of their names. */
const CLAIM = /^claim/i, RELEASE = /^(release|unclaim)/i, CLOSE_TICKET = /^close/i;
/** The conversation is a region labelled so; its input is the textbox labelled "Message <agent>". */
const talk = (page: Page) => page.getByRole('region', { name: /^conversation$/i });
const input = (page: Page) => talk(page).getByRole('textbox', { name: /^message /i });
/** The control that sends what is in the input: its form's submit button. */
const SEND = 'form button[type="submit"]';
/** One message's row in the conversation, edge to edge of the conversation's content (web/src/pair/ui/message.tsx). */
const MESSAGE = '[data-slot="message"]';
/** The presence: the control that opens and closes the conversation sheet on a narrow screen. */
const PRESENCE = '.boards-presence[aria-expanded]';
// -----------------------------------------------------------------------------------------------------------------

type Program = Awaited<ReturnType<typeof sharedUiProgram>>;
type Result = { ok: boolean; value?: { board: string; revision: number } };

describe.runIf(chrome && existsSync(join(root, 'board.html')))('the boards page in a real browser', () => {
  let program: Program, browser: Browser;
  const contexts: BrowserContext[] = [], pageErrors: string[] = [];
  let threads = 0;

  beforeAll(async () => {
    program = await sharedUiProgram({ clock, webRoot: root, seed(db, now) {
      db.insert(members).values([{ id: 'alice', role: 'member', joinedAt: now() }, { id: 'fixture-owner', role: 'owner', joinedAt: now() }]).run();
      db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
      db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
      db.insert(projects).values({ id: 'pond', name: 'pond' }).run();
      db.insert(projectMembers).values({ project: 'pond', member: 'alice' }).run();
      db.insert(projectAgents).values({ project: 'pond', agent: 'art' }).run();
      // t-21 is being worked, so the lanes always hold one chip. The others are open and nobody's, one per test.
      for (const [id, title, working] of [['t-21', 'Fix the pond pump', true], ['t-32', 'Order pump parts', false], ['t-43', 'Clear the reeds', false], ['t-54', 'Mend the net', false], ['t-65', 'Paint the bench', false]] as const)
        db.insert(tasks).values({ id, title, project: 'pond', ownerKind: 'member', owner: 'alice', goal: 'The pond is clear', why: 'Fish need air',
          ...(working ? { status: 'in_progress' as const, assigneeKind: 'agent' as const, assignee: 'art', startedAt: now() } : {}),
          createdByKind: 'member', createdBy: 'alice', createdAt: now(), changedAt: now() }).run();
      db.$client.prepare('INSERT INTO tokens (fingerprint,label,kind,member,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(hash(token), 'Fixture', 'owner', 'alice', now(), new Date(Date.now() + 6 * 3600000).toISOString());
      db.$client.prepare('INSERT INTO sessions (id,token,device,via,is_agent,issued_at,seen_at,proved_at) VALUES (?,?,?,?,?,?,?,?)').run(hash(cookie), hash(token), 'Browser', 'token', 0, now(), now(), now());
    } });
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 120_000);
  afterAll(async () => {
    try { await browser?.close(); } finally { await program?.close(); }
  }, 120_000);

  /** A signed-in window. Each test has its own, and (but for the way in) its own thread. */
  async function open(options: BrowserContextOptions = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, ...options });
    contexts.push(context); context.setDefaultTimeout(15_000);
    await context.addCookies([{ name: 'loom_ui', value: cookie, url: program.url }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => { pageErrors.push(error.message); console.info('Boards page error:', error.message); });
    return page;
  }
  const newThread = () => program.composition.services.comms!.threads.open({ id: `th:browser-${++threads}`, member: 'alice', agent: 'art', title: `Pond ${threads}` }).id;
  async function visit(page: Page, thread: string) {
    await page.goto(`${program.url}/app/t/${encodeURIComponent(thread)}`);
    await input(page).waitFor();
  }
  /** One of the member's own operations, posted from inside the page as the page posts it (web/src/data/operation.ts). */
  const operate = (page: Page, name: string, body: object) => page.evaluate(async ([path, sent]) => {
    const response = await fetch('/api/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: sent, id: crypto.randomUUID() }) });
    return await response.json();
  }, [name.replace('.', '/'), body] as const) as Promise<Result>;
  const place = (brick: string, params: object) => ({ change: 'place', brick, params });
  async function board(page: Page, thread: string, first: { brick: string; params: object }, ...rest: { brick: string; params: object }[]) {
    const opened = await operate(page, 'boards.open', { thread, place: first });
    expect(opened.ok).toBe(true);
    const id = opened.value!.board;
    for (const next of rest) expect((await operate(page, 'boards.change', { board: id, changes: [place(next.brick, next.params)] })).ok).toBe(true);
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/app/b/' + encodeURIComponent(id));
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(1 + rest.length);
    return id;
  }
  const path = (page: Page) => page.evaluate(() => location.pathname);
  /** Rule 3: the address holds one id and nothing else, and no storage holds a board, a placement or a thread. */
  async function holdsNoState(page: Page, ids: string[]) {
    const seen = await page.evaluate(() => ({ search: location.search, hash: location.hash, path: location.pathname,
      stored: JSON.stringify([Object.entries({ ...localStorage }), Object.entries({ ...sessionStorage })]) }));
    expect(seen.search).toBe(''); expect(seen.hash).toBe('');
    expect(seen.path).toMatch(/^\/app\/[bt]\/[^/]+$/);
    for (const id of ids) expect(seen.stored, 'storage holds ' + id).not.toContain(id);
  }
  const row = <T,>(sql: string, ...args: unknown[]) => program.client.prepare(sql).get(...args) as T;
  const rows = <T,>(sql: string, ...args: unknown[]) => program.client.prepare(sql).all(...args) as T[];
  const status = (ticket: string) => row<{ status: string }>('SELECT status FROM tasks WHERE id=?', ticket).status;
  const acts = (id: string) => rows<{ action: string }>("SELECT action FROM board_changes WHERE board=? AND change='act' ORDER BY revision, seq", id).map((r) => r.action);
  const ranks = (id: string) => rows<{ brick: string }>('SELECT brick FROM board_placements WHERE board=? AND removed_at IS NULL ORDER BY rank', id).map((r) => r.brick);
  /** What the page asks loom to do from here on: every POST to an operation. */
  function operations(page: Page) {
    const sent: string[] = [];
    page.on('request', (request) => { const at = new URL(request.url()).pathname; if (request.method() === 'POST' && at.startsWith('/api/')) sent.push(at); });
    return sent;
  }
  /** Whether a control can be seen and takes a click where it is drawn: not faded out by itself or anything around
   * it, not deaf to the pointer, and the thing found at its own middle. */
  const reachable = (of: Locator) => of.evaluate((el) => {
    let seen = 1;
    for (let at: Element | null = el; at; at = at.parentElement) seen *= Number(getComputedStyle(at).opacity);
    const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return seen >= 0.5 && getComputedStyle(el).pointerEvents !== 'none' && !!top && (top === el || el.contains(top));
  });
  /** Tab, as a member with no pointer would, until the keyboard is inside the placement. */
  async function tabInto(page: Page, of: Locator) {
    for (let n = 0; n < 80; n++) {
      await page.keyboard.press('Tab');
      if (await of.evaluate((el) => el.contains(document.activeElement))) return true;
    }
    return false;
  }
  /** Marks a node, so that the same node can be recognised later whatever was drawn around it. */
  const mark = (of: Locator, name: string) => of.evaluate((el, as) => { (el as unknown as { kept: string }).kept = as; }, name);
  const marked = (of: Locator) => of.evaluate((el) => (el as unknown as { kept?: string }).kept ?? null);
  /** The page's layout faults of 2026-11-27, measured on what is on screen now. */
  const layoutFaults = (page: Page) => page.evaluate((sel) => {
    const faults: string[] = [], wide = innerWidth;
    const shown = [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => { const r = el.getBoundingClientRect(); return r.right > 0 && r.left < wide; });
    for (const frame of shown) {
      const name = frame.querySelector<HTMLElement>('header h1, header h2, header h3, header [role="heading"]');
      const words = name?.textContent?.trim() ?? '';
      if (!name || !words) { faults.push('a placement has no heading'); continue; }
      // A name squeezed to nothing wraps a letter a line: narrower than three of its letters, or many lines tall.
      const style = getComputedStyle(name), size = parseFloat(style.fontSize), line = parseFloat(style.lineHeight) || size * 1.5;
      const range = document.createRange(); range.selectNodeContents(name);
      const text = range.getBoundingClientRect();
      const three = (text.width / Math.max(1, words.length)) * 3;
      if (words.length >= 3 && (name.getBoundingClientRect().width < Math.min(three, size * 1.2) || text.width < size * 1.2)) faults.push(`"${words}" is ${Math.round(text.width)} px wide`);
      if (text.height > line * 3 + 1) faults.push(`"${words}" is ${Math.round(text.height / line)} lines tall`);
      const box = frame.getBoundingClientRect();
      if (box.left < -1 || box.right > wide + 1) faults.push(`"${words}" spans ${Math.round(box.left)} to ${Math.round(box.right)} of ${wide}`);
      for (const el of frame.querySelectorAll<HTMLElement>('*')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && (r.right > wide + 1 || r.left < -1)) { faults.push(`<${el.tagName.toLowerCase()}> in "${words}" spans ${Math.round(r.left)} to ${Math.round(r.right)} of ${wide}`); break; }
      }
    }
    if (document.documentElement.scrollWidth > wide + 1) faults.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} of ${wide}`);
    return faults;
  }, PLACEMENT);
  /** Whether a node is the one drawn at its own middle: a board the trail has moved aside is in the document and is
   * not, and neither is one still sliding in under the conversation. */
  const hit = (el: Element) => { const r = el.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)); return !!at && (at === el || el.contains(at)); };
  /** Nothing drawn on the board moved between two frames: the trail and the placements have come to rest. */
  const still = (page: Page) => page.evaluate(async (sel) => {
    const where = () => JSON.stringify([...document.querySelectorAll(sel)].map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }));
    const was = where();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return was === where();
  }, PLACEMENT);
  /** Placements of the board the trail has on screen. */
  const onScreen = (page: Page) => page.evaluate(([sel, test]) => { const drawn = new Function('return ' + test)() as (el: Element) => boolean; return [...document.querySelectorAll(sel)].filter(drawn).length; }, [PLACEMENT, hit.toString()] as const);

  it('opens the way in on the thread, sends what was typed, draws a board as it arrives and keeps nothing but one id in the address', async () => {
    const page = await open();
    const chunks: string[] = [];
    page.on('request', (request) => { const at = new URL(request.url()).pathname; if (at.startsWith('/app/boards-assets/')) chunks.push(at.split('/').pop()!); });
    await page.goto(program.url + '/app/boards');
    await expect.poll(() => path(page)).toMatch(/^\/app\/t\/[^/]+$/);
    const thread = decodeURIComponent((await path(page)).split('/')[3]);
    await input(page).waitFor();

    // Sending: exactly the words typed are stored, and the input clears. Nobody replies in this household.
    const words = 'Show me   the pond, t-21 & <b>all</b> of it';
    // The page sends nothing until its thread is open, and says so by its send control; Enter is pressed once.
    await input(page).fill(words);
    await expect.poll(() => talk(page).locator(SEND).isEnabled()).toBe(true);
    await input(page).press('Enter');
    await expect.poll(() => row<{ n: number }>('SELECT count(*) AS n FROM messages').n).toBe(1);
    await expect.poll(() => input(page).inputValue()).toBe('');
    const last = await page.evaluate(async (id) => {
      const response = await fetch('/graphql', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query($id:String!){rows:commsMessages(thread:$id,limit:50){seq sender words}}', variables: { id } }) });
      return (await response.json()) as { data?: { rows: { seq: number; sender: string; words: string }[] } };
    }, thread);
    const mine = (last.data?.rows ?? []).filter((m) => m.words === words);
    expect(mine).toHaveLength(1);
    expect(mine[0].seq).toBe(Math.max(...last.data!.rows.map((m) => m.seq)));
    // Its words on screen stand clear of both edges of the conversation's column (the padding lost on 2026-11-27).
    const said = talk(page).locator(MESSAGE).filter({ hasText: 'Show me' }).last();
    await said.waitFor();
    const gaps = async () => { const [inner, outer] = [await said.boundingBox(), await talk(page).boundingBox()]; return { left: inner!.x - outer!.x, right: outer!.x + outer!.width - (inner!.x + inner!.width) }; };
    expect((await gaps()).left).toBeGreaterThan(8); expect((await gaps()).right).toBeGreaterThan(8);

    // A board arrives while the page is open: no reload, and the address becomes the board's.
    const opened = await operate(page, 'boards.open', { thread, place: { brick: 'lanes', params: { project: 'pond' } } });
    expect(opened.ok).toBe(true);
    const id = opened.value!.board;
    await expect.poll(() => path(page)).toBe('/app/b/' + encodeURIComponent(id));
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(1);
    await placement(page, LANES).locator(chipFor('ticket', 't-21')).waitFor();
    // Bricks load on demand: the lanes' chunk came, the approval's did not.
    expect(chunks.some((name) => name.startsWith('bricks-lanes-'))).toBe(true);
    expect(chunks.filter((name) => name.startsWith('bricks-approval-'))).toEqual([]);
    await mark(page.locator(PLACEMENT).nth(0), 'first');

    // One brick a call, each drawn as it lands, and what was there is the same node afterwards.
    const second = await operate(page, 'boards.change', { board: id, changes: [place('ticket', { ticket: 't-32' })] });
    expect(second.ok).toBe(true);
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(2);
    await placement(page, TICKET).getByText('Order pump parts').first().waitFor();
    expect(await marked(placement(page, LANES))).toBe('first');
    await mark(placement(page, TICKET), 'second');
    const third = await operate(page, 'boards.change', { board: id, changes: [place('approval', { approval: 'ap-none' })] });
    expect(third.ok).toBe(true);
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(3);
    await expect.poll(() => chunks.filter((name) => name.startsWith('bricks-approval-')).length).toBe(1);
    expect(await marked(placement(page, LANES))).toBe('first');
    expect(await marked(placement(page, TICKET))).toBe('second');
    expect(await path(page)).toBe('/app/b/' + encodeURIComponent(id));

    // Both halves are on screen, the big one is the widest, and nothing is squeezed or pushed off the side.
    await expect.poll(() => layoutFaults(page)).toEqual([]);
    const widths = await page.locator(PLACEMENT).evaluateAll((all) => all.map((el) => ({ form: el.getAttribute('data-form'), w: el.getBoundingClientRect().width })));
    const big = widths.filter((w) => w.form === 'primary'), small = widths.filter((w) => w.form !== 'primary');
    expect(big).toHaveLength(1); expect(small).toHaveLength(2);
    for (const one of small) expect(big[0].w).toBeGreaterThan(one.w);
    const [stage, side] = [await page.locator(BIG).boundingBox(), await talk(page).boundingBox()];
    expect(side!.width).toBeGreaterThan(200); expect(stage!.x + stage!.width).toBeLessThanOrEqual(side!.x + 1);

    // Nothing but the one id, anywhere; and a reload is the same board.
    const ids = [id, thread, ...rows<{ id: string }>('SELECT id FROM board_placements WHERE board=?', id).map((p) => p.id)];
    expect(ids).toHaveLength(5);
    await holdsNoState(page, ids);
    await page.reload();
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(3);
    expect(await path(page)).toBe('/app/b/' + encodeURIComponent(id));
    await holdsNoState(page, ids);
    await expect.poll(() => layoutFaults(page)).toEqual([]);
  });

  it('makes a small brick the big one, and offers that only where the brick can be big', async () => {
    const page = await open(), thread = newThread();
    await visit(page, thread);
    const id = await board(page, thread, { brick: 'lanes', params: { project: 'pond' } }, { brick: 'ticket', params: { ticket: 't-32' } }, { brick: 'approval', params: { approval: 'ap-none' } });
    const lanes = placement(page, LANES), ticket = placement(page, TICKET), approval = placement(page, APPROVAL);
    await expect.poll(() => lanes.getAttribute('data-form')).toBe('primary');
    // The big one and the small-only one have one control (remove); the small one that can be big has two.
    await expect.poll(() => frameButtons(ticket).count()).toBe(3);
    expect(await frameButtons(ticket).and(page.getByRole('button', { name: MAXIMIZE })).count()).toBe(1);
    expect(await frameButtons(approval).count()).toBe(2);
    expect(await frameButtons(approval).and(page.getByRole('button', { name: MAXIMIZE })).count()).toBe(0);
    expect(await frameButtons(lanes).and(page.getByRole('button', { name: MAXIMIZE })).count()).toBe(0);
    await mark(lanes, 'lanes'); await mark(ticket, 'ticket');
    // The controls are out of the way until the placement is pointed at or holds the keyboard; then they answer.
    const maximize = frameButtons(ticket).and(page.getByRole('button', { name: MAXIMIZE }));
    await page.mouse.move(1, 1);
    await expect.poll(() => reachable(maximize)).toBe(false);
    expect(await tabInto(page, ticket), 'the keyboard reaches the placement').toBe(true);
    await expect.poll(() => reachable(maximize)).toBe(true);
    for (const control of await frameButtons(ticket).all()) expect(await reachable(control)).toBe(true);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => reachable(maximize)).toBe(false);
    await ticket.hover();
    await expect.poll(() => reachable(maximize)).toBe(true);
    await maximize.click();
    await expect.poll(() => ticket.getAttribute('data-form')).toBe('primary');
    await expect.poll(() => lanes.getAttribute('data-form')).not.toBe('primary');
    // The old big one is first among the small, in loom's record and on the page.
    expect(ranks(id)).toEqual(['ticket', 'lanes', 'approval']);
    expect(await page.locator(PLACEMENT).evaluateAll((all) => all.filter((el) => el.getAttribute('data-form') !== 'primary').sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((el) => (el as unknown as { kept?: string }).kept ?? ''))).toEqual(['lanes', '']);
    // Moved, not redrawn.
    expect(await marked(lanes)).toBe('lanes'); expect(await marked(ticket)).toBe('ticket');
    await expect.poll(() => frameButtons(ticket).count()).toBe(2);
    await expect.poll(() => frameButtons(lanes).and(page.getByRole('button', { name: MAXIMIZE })).count()).toBe(1);
    expect(await frameButtons(approval).count()).toBe(2);
    await expect.poll(() => layoutFaults(page)).toEqual([]);
    await holdsNoState(page, [id, thread]);
  });

  it('claims, releases, closes and reopens a ticket from its brick while the lanes follow, and a chip places a brick', async () => {
    const page = await open(), thread = newThread();
    await visit(page, thread);
    const id = await board(page, thread, { brick: 'lanes', params: { project: 'pond' } }, { brick: 'ticket', params: { ticket: 't-43' } });
    const lanes = placement(page, LANES), ticket = placement(page, TICKET).filter({ hasText: 'Clear the reeds' });
    // The ticket is small here (the side form), and its actions are in that form. The lanes beside it are big. They
    // follow when what they say changes with the ticket and changes back; whether the ticket's own row is drawn
    // is the next test's.
    expect(await ticket.getAttribute('data-form')).toBe('side');
    expect(await lanes.getAttribute('data-form')).toBe('primary');
    await lanes.locator(chipFor('ticket', 't-21')).waitFor();
    const said = () => lanes.innerText(), atFirst = await said();
    expect(await lanes.locator(chipFor('ticket', 't-43')).count()).toBe(0);
    const jobs = () => row<{ n: number }>('SELECT count(*) AS n FROM jobs').n, before = jobs();

    await ticket.getByRole('button', { name: CLAIM }).click();
    await ticket.getByRole('button', { name: RELEASE }).waitFor();
    expect(status('t-43')).toBe('in_progress');
    await expect.poll(said).not.toBe(atFirst);

    await ticket.getByRole('button', { name: RELEASE }).click();
    await ticket.getByRole('button', { name: CLAIM }).waitFor();
    expect(status('t-43')).toBe('open');
    await expect.poll(said).toBe(atFirst);
    expect(await lanes.locator(chipFor('ticket', 't-43')).count()).toBe(0);

    // Closing asks why first; the reason goes to the ticket and never to the board.
    await ticket.getByRole('button', { name: CLOSE_TICKET }).click();
    const why = ticket.getByRole('textbox');
    await why.fill('The reeds died back'); await why.press('Enter');
    await ticket.getByRole('button', { name: REOPEN }).waitFor();
    expect(status('t-43')).toBe('closed');
    expect(await ticket.getByRole('button', { name: CLAIM }).count()).toBe(0);

    await ticket.getByRole('button', { name: REOPEN }).click();
    await ticket.getByRole('button', { name: CLAIM }).waitFor();
    expect(status('t-43')).toBe('open');

    // The page's own report of each reached loom's log of the board, in order, with nothing typed in it.
    await expect.poll(() => acts(id)).toEqual(['claim', 'unclaim', 'close', 'reopen']);
    expect(JSON.stringify(rows('SELECT * FROM board_changes WHERE board=?', id))).not.toContain('reeds died');

    // A chip: a ticket in a lane places its brick, last, by the member, and starts no job.
    await lanes.locator(chipFor('ticket', 't-21')).click();
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(3);
    await placement(page, TICKET).filter({ hasText: 'Fix the pond pump' }).first().waitFor();
    expect(rows('SELECT brick, params, placed_by_kind AS by FROM board_placements WHERE board=? AND removed_at IS NULL ORDER BY rank', id).at(-1)).toEqual({ brick: 'ticket', params: '{"ticket":"t-21"}', by: 'member' });
    // The same chip again places nothing.
    await lanes.locator(chipFor('ticket', 't-21')).click();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(ranks(id)).toEqual(['lanes', 'ticket', 'ticket']);
    expect(jobs()).toBe(before);
    await holdsNoState(page, [id, thread]);
  });

  // The spec's check 19: "The ticket moves lanes with no reload". This failed once: the list component kept the
  // number of rows it first drew wherever it did not measure, so a ticket entering a lane showed only as a count.
  it('draws a ticket in the big lanes when it enters a lane while the page is open', async () => {
    const page = await open(), thread = newThread();
    await visit(page, thread);
    await board(page, thread, { brick: 'lanes', params: { project: 'pond' } }, { brick: 'ticket', params: { ticket: 't-43' } });
    const lanes = placement(page, LANES), ticket = placement(page, TICKET);
    await lanes.locator(chipFor('ticket', 't-21')).waitFor();
    try {
      await ticket.getByRole('button', { name: CLAIM }).click();
      await ticket.getByRole('button', { name: RELEASE }).waitFor();
      await expect.poll(() => lanes.locator(chipFor('ticket', 't-43')).count(), { timeout: 4000 }).toBe(1);
    } finally {
      // Left as it was found, whichever way this went.
      if (status('t-43') === 'in_progress') { await ticket.getByRole('button', { name: RELEASE }).click(); await ticket.getByRole('button', { name: CLAIM }).waitFor(); }
    }
  });

  it('follows the trail to a second board, draws a closed board read-only at its address, and reopens it', async () => {
    const page = await open(), thread = newThread();
    await visit(page, thread);
    const first = await board(page, thread, { brick: 'lanes', params: { project: 'pond' } }, { brick: 'agents', params: {} });
    expect(await onScreen(page)).toBe(2);
    // A second board opens: the page moves to it.
    const opened = await operate(page, 'boards.open', { thread, place: { brick: 'ticket', params: { ticket: 't-54' } } });
    const second = opened.value!.board;
    await expect.poll(() => path(page)).toBe('/app/b/' + encodeURIComponent(second));
    const ticket = placement(page, TICKET);
    await ticket.getByRole('button', { name: CLAIM }).waitFor();
    await expect.poll(async () => ((await still(page)) ? onScreen(page) : -1)).toBe(1);
    await expect.poll(() => ticket.evaluate((el, test) => (new Function('return ' + test)() as (el: Element) => boolean)(el), hit.toString())).toBe(true);
    await holdsNoState(page, [first, second, thread]);

    // Closed by the member, it stays on screen, closed: Reopen, no control on its placement, and nothing in it responds.
    // Both open boards are in the document, side by side; the one to close is the one whose control is on screen.
    const close = boardButton(page, CLOSE);
    const mine = () => close.evaluateAll((all, test) => { const drawn = new Function('return ' + test)() as (el: Element) => boolean; const on = all.map((el, i) => (drawn(el) ? i : -1)).filter((i) => i >= 0); return on.length === 1 ? on[0] : -1; }, hit.toString());
    await expect.poll(async () => ((await still(page)) ? mine() : -1)).toBeGreaterThanOrEqual(0);
    expect(await close.count()).toBe(2);
    await close.nth(await mine()).click();
    await boardButton(page, REOPEN).waitFor();
    expect(await path(page)).toBe('/app/b/' + encodeURIComponent(second));
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(1);
    expect(await frameButtons(ticket).count()).toBe(0);
    expect(await boardButton(page, CLOSE).count()).toBe(0);
    const readOnly = async () => {
      const claim = ticket.getByRole('button', { name: CLAIM, includeHidden: true });
      await expect.poll(() => claim.count()).toBe(1);
      const sent = operations(page), spot = await claim.boundingBox();
      await page.mouse.click(spot!.x + spot!.width / 2, spot!.y + spot!.height / 2);
      // Nor can the keyboard reach it: it does not take focus, so Enter goes nowhere.
      expect(await claim.evaluate((el) => { (el as HTMLElement).focus(); return document.activeElement === el; })).toBe(false);
      await page.keyboard.press('Enter');
      // Long enough for an operation to have left the page: one answered round trip to loom, then two frames.
      await page.evaluate(async () => { await fetch('/auth/session', { credentials: 'same-origin' }); await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); });
      expect(sent).toEqual([]);
      expect(status('t-54')).toBe('open');
      expect(acts(second)).toEqual([]);
    };
    await readOnly();
    // Its address draws it the same way after a reload.
    await page.reload();
    await boardButton(page, REOPEN).waitFor();
    expect(await path(page)).toBe('/app/b/' + encodeURIComponent(second));
    expect(await frameButtons(ticket).count()).toBe(0);
    await readOnly();
    await expect.poll(() => layoutFaults(page)).toEqual([]);

    // Reopened, it is as it was: its controls are back and its action works.
    await boardButton(page, REOPEN).click();
    await expect.poll(() => frameButtons(ticket).count()).toBeGreaterThan(0);
    expect(row<{ closed: string | null }>('SELECT closed_at AS closed FROM boards WHERE id=?', second).closed).toBeNull();
    await ticket.getByRole('button', { name: CLAIM }).click();
    await ticket.getByRole('button', { name: RELEASE }).waitFor();
    expect(status('t-54')).toBe('in_progress');
    await expect.poll(() => acts(second)).toEqual(['claim']);

    // Closed again and left: the thread's address goes to the board before it, unchanged.
    expect((await operate(page, 'boards.close', { board: second })).ok).toBe(true);
    await boardButton(page, REOPEN).waitFor();
    await page.goto(`${program.url}/app/t/${encodeURIComponent(thread)}`);
    await expect.poll(() => path(page)).toBe('/app/b/' + encodeURIComponent(first));
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(2);
    await placement(page, LANES).locator(chipFor('ticket', 't-21')).waitFor();
    expect(await placement(page, AGENTS).count()).toBe(1);
    await holdsNoState(page, [first, second, thread]);
  });

  it('is one column on a phone, with the input on screen and the conversation a sheet that opens and closes', async () => {
    const page = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }), thread = newThread();
    await visit(page, thread);
    const opened = await operate(page, 'boards.open', { thread, place: { brick: 'lanes', params: { project: 'pond' } } });
    const id = opened.value!.board;
    expect((await operate(page, 'boards.change', { board: id, changes: [place('ticket', { ticket: 't-65' })] })).ok).toBe(true);
    await expect.poll(() => path(page)).toBe('/app/b/' + encodeURIComponent(id));
    // One column: the big one alone is drawn, across the screen, and the other is folded away as its chip.
    await expect.poll(() => page.locator(PLACEMENT).evaluateAll((all) => all.map((el) => el.getAttribute('data-form')))).toEqual(['primary']);
    await placement(page, LANES).locator(chipFor('ticket', 't-21')).waitFor();
    const frame = (await page.locator(BIG).boundingBox())!;
    expect(frame.x).toBeGreaterThanOrEqual(0); expect(frame.x + frame.width).toBeLessThanOrEqual(390); expect(frame.width).toBeGreaterThan(300);
    await expect.poll(() => layoutFaults(page)).toEqual([]);
    const inside = async (of: Locator) => { const box = await of.boundingBox(); return !!box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844; };
    await expect.poll(() => inside(input(page))).toBe(true);
    // Nothing can point here, so a placement's controls are there without being pointed at.
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    expect(await frameButtons(page.locator(BIG)).count()).toBeGreaterThan(0);
    for (const control of await frameButtons(page.locator(BIG)).all()) { expect(await reachable(control)).toBe(true); expect(await inside(control)).toBe(true); }
    const presence = page.locator(PRESENCE);
    await expect.poll(() => inside(presence)).toBe(true);
    // The bar opens the conversation as a sheet over the board, and closes it again.
    const tall = async () => (await talk(page).boundingBox())!.height;
    if (await presence.getAttribute('aria-expanded') === 'true') { await presence.click(); await expect.poll(() => presence.getAttribute('aria-expanded')).toBe('false'); }
    const shut = await tall();
    await presence.click();
    await expect.poll(() => presence.getAttribute('aria-expanded')).toBe('true');
    await expect.poll(tall).toBeGreaterThan(shut + 150);
    await expect.poll(() => inside(input(page))).toBe(true);
    await presence.click();
    await expect.poll(() => presence.getAttribute('aria-expanded')).toBe('false');
    await expect.poll(async () => Math.abs((await tall()) - shut)).toBeLessThan(2);
    await expect.poll(() => inside(input(page))).toBe(true);
    expect((await page.locator(BIG).boundingBox())!.width).toBeGreaterThan(300);
    await holdsNoState(page, [id, thread]);
  });

  it('places a brick with nothing moving when the device asks for reduced motion', async () => {
    const page = await open({ reducedMotion: 'reduce' }), thread = newThread();
    await visit(page, thread);
    // Everything that starts moving on or inside a placement from here on is counted, however briefly it runs.
    await page.evaluate((sel) => {
      const seen = ((window as unknown as { moved: string[] }).moved = [] as string[]);
      const note = (event: Event) => { if (event.target instanceof Element && event.target.closest(sel)) seen.push(event.type + ' ' + ((event as TransitionEvent).propertyName || (event as AnimationEvent).animationName)); };
      for (const type of ['transitionrun', 'transitionstart', 'animationstart']) document.addEventListener(type, note, true);
    }, PLACEMENT);
    // Not counted: an animation driven by scrolling and not by time (a scrolling body's fade at its foot), which
    // does not run unless the member scrolls.
    const moving = () => page.evaluate((sel) => {
      const all = document.getAnimations().filter((a) => a.effect instanceof KeyframeEffect && a.effect.target?.closest(sel));
      const scrolled = new Set(all.filter((a) => !(a.timeline instanceof DocumentTimeline)).map((a) => 'animationstart ' + (a as CSSAnimation).animationName));
      return [
        ...(window as unknown as { moved: string[] }).moved.filter((name) => !scrolled.has(name)),
        ...all.filter((a) => a.playState === 'running' && a.timeline instanceof DocumentTimeline).map((a) => 'running ' + ((a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName ?? '')),
      ];
    }, PLACEMENT);
    const opened = await operate(page, 'boards.open', { thread, place: { brick: 'lanes', params: { project: 'pond' } } });
    const id = opened.value!.board;
    await page.locator(PLACEMENT).first().waitFor();
    expect(await moving()).toEqual([]);
    expect((await operate(page, 'boards.change', { board: id, changes: [place('ticket', { ticket: 't-65' })] })).ok).toBe(true);
    await expect.poll(() => page.locator(PLACEMENT).count()).toBe(2);
    expect(await moving()).toEqual([]);
    await placement(page, TICKET).getByText('Paint the bench').first().waitFor();
    await placement(page, LANES).locator(chipFor('ticket', 't-21')).waitFor();
    expect(await moving()).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe('reduce');
  });

  // "Live reads and their cost": a brick's data is read every few seconds, at once after the member's own action, and
  // at once when asked for; the page's own reads are as immediate as ever.
  it('follows an outside change within the relaxed time, the member\'s own click at once, and an outside change at once when refreshed', async () => {
    const page = await open(), thread = newThread();
    // What the page sends on its socket: each selection's envelope, and each asking for "now".
    const opened: { name: string; pace?: string }[] = [], asked: string[][] = [];
    page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
      const sent = JSON.parse(String(payload)) as { type: string; payload?: { query: string; variables: { query?: string; pace?: string; keys?: string[] } } };
      if (sent.type !== 'subscribe') return;
      if (sent.payload!.variables.keys) asked.push(sent.payload!.variables.keys);
      else opened.push({ name: /query (\w+)/.exec(sent.payload!.variables.query!)?.[1] ?? '', pace: sent.payload!.variables.pace });
    }));
    await visit(page, thread);
    await board(page, thread, { brick: 'lanes', params: { project: 'pond' } }, { brick: 'ticket', params: { ticket: 't-65' } });
    const lanes = placement(page, LANES), ticket = placement(page, TICKET).filter({ hasText: 'Paint the bench' });
    const claim = ticket.getByRole('button', { name: CLAIM }), release = ticket.getByRole('button', { name: RELEASE });
    await claim.waitFor(); await lanes.locator(chipFor('ticket', 't-21')).waitFor();
    // The bricks' selections are relaxed; the board's own placements and the conversation are not.
    expect(opened.filter((o) => o.name.startsWith('Brick')).length).toBeGreaterThan(1);
    expect(opened.filter((o) => o.name.startsWith('Brick')).map((o) => o.pace)).not.toContain(undefined);
    expect(new Set(opened.filter((o) => o.name.startsWith('Brick')).map((o) => o.pace))).toEqual(new Set(['relaxed']));
    // The board's placements, the thread's own row and the conversation are sent as they always were.
    for (const name of ['ThreadBoards', 'BoardsThreadHead', 'PairLog']) expect(opened.filter((o) => o.name === name).map((o) => o.pace ?? 'eager'), name).toEqual(['eager']);
    /** A change from outside the page: the member's own command from another client, which this page never sees sent. */
    const outside = async (action: string) => {
      const reply = await page.context().request.post(program.url + '/api/tasks/command', { headers: { origin: program.url }, data: { input: { action, id: 't-65' }, id: crypto.randomUUID() } });
      expect(reply.ok()).toBe(true);
    };
    try {
      // 1. From outside: the brick follows within the relaxed time and a little, with nothing asked of the page.
      const before = asked.length;
      await outside('claim');
      expect(status('t-65')).toBe('in_progress');
      await release.waitFor({ timeout: LIVE_RELAXED_MS + 4000 });
      expect(asked.length).toBe(before);
      // It was read a moment ago, so the next outside change is not read for some seconds: the brick is not eager.
      await outside('unclaim');
      expect(status('t-65')).toBe('open');
      await page.waitForTimeout(1500);
      expect(await release.count()).toBe(1); expect(await claim.count()).toBe(0);
      // 2. Asked for: the refresh control brings it in at once, and names this placement's selections only.
      await ticket.hover();
      await frameButtons(ticket).and(page.getByRole('button', { name: REFRESH })).click();
      await claim.waitFor({ timeout: 2000 });
      expect(asked.length).toBe(before + 1);
      // Asked again with nothing changed, loom still answers: the mark that says it is getting new data goes.
      await frameButtons(ticket).and(page.getByRole('button', { name: REFRESH })).click();
      await expect.poll(() => asked.length).toBe(before + 2);
      await expect.poll(() => ticket.locator(GETTING).count(), { timeout: 3000 }).toBe(0);
      expect(asked[before + 1]).toEqual(asked[before]);
      // Only that placement was asked for: the lanes beside it still show the ticket as worked, until their own turn.
      expect(await lanes.locator(chipFor('ticket', 't-65')).count()).toBe(1);
      await expect.poll(() => lanes.locator(chipFor('ticket', 't-65')).count(), { timeout: LIVE_RELAXED_MS + 4000 }).toBe(0);
      // 3. The member's own click: this brick and the one beside it show it at once.
      await claim.click();
      await release.waitFor({ timeout: 2000 });
      await expect.poll(() => lanes.locator(chipFor('ticket', 't-65')).count(), { timeout: 2000 }).toBe(1);
      // That asking named more selections than the one placement's: every brick on screen.
      expect(asked.at(-1)!.length).toBeGreaterThan(asked[before].length);
    } finally {
      if (status('t-65') === 'in_progress') await outside('unclaim');
    }
  });

  it('raised no error in any page, nor in loom', async () => {
    expect(pageErrors).toEqual([]);
    expect(program.errors).toEqual([]);
    for (const context of contexts.splice(0)) await context.close();
  });
});
