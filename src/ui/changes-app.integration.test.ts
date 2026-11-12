/** Changes in real Chrome: groups/list/reader, URL state, phone navigation and pane edges,
 * at 1280, 1440, 1920 and 390 in all three looks. LOOM_TEST_SHOTS saves the images. */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { clearPieceCache } from './pieces.js';

vi.setConfig({ testTimeout: 90_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 15_000, ...o }) }) as typeof vexpect;
const SHOTS = process.env.LOOM_TEST_SHOTS;

const groups = [['you', 'Waiting on you'], ['agent', 'Ready to merge'], ['ci', 'Waiting on CI'], ['author', 'Waiting on its author'], ['reviewer', 'Waiting on a reviewer'], ['done', 'Lately']].map(([id, label]) => ({ id, label }));
const rows = Array.from({ length: 45 }, (_, i) => ({ id: `c/github/acme/loom/${i + 1}`, group: i < 40 ? 'you' : 'ci', title: `A useful change ${i + 1}`, repo: i % 2 ? 'acme/loom' : 'acme/tasks', number: String(i + 1), author: i % 2 ? 'Ada' : 'Art', ago: '2 hours ago', status: 'Green · needs your yes' }));
const reader = { title: 'loom#1', intro: 'A useful change 1', sections: [
  { id: 'state', blocks: [{ type: 'buttons', items: [{ action: 'yes', label: 'Yes, merge it', fields: { id: 'github:acme/loom#1', head: 'a'.repeat(40) } }] }] },
  { id: 'facts', title: 'Where it stands', blocks: [{ type: 'kv', items: [{ label: 'CI', value: 'Green (4 checks)' }, { label: 'Review', value: 'Approved by Ada' }] }] },
  { id: 'rule', title: 'Standing rule', blocks: [{ type: 'text', text: 'ask' }] },
  { id: 'body', title: 'Summary', blocks: [{ type: 'text', text: 'The complete summary. '.repeat(80) }] },
  { id: 'links', blocks: [{ type: 'link', text: 'Open on GitHub', href: 'https://github.com/acme/loom/pull/1' }, { type: 'link', text: 'Task', page: 'loom:p/tasks/task/t-1984' }] },
] };
const PAGE = { title: 'Changes', sections: [], changes: { groups, rows, selected: '', reader: null } };

describe.runIf(built && chrome)('Changes split panes', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-changes-page-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# art\n');
    const db = new BetterSqlite3(join(home, 'agents', 'art', 'memories.db')); createConversationTables(db); db.close();
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'changes.json'), JSON.stringify({ v: 2, tab: { label: 'Changes' }, asks: [] }));
    writeFileSync(join(bin, 'page.json'), JSON.stringify(PAGE));
    // Neighbour pieces exercise Changes in loom's desktop.
    for (const [n, l] of [['garden', 'Garden'], ['shed', 'Shed']]) {
      // Garden supplies a neighbouring desktop app.
      writeFileSync(join(bin, `${n}.json`), JSON.stringify({ v: 2, tab: { label: l, ...(n === 'garden' ? { fit: { big: true, ideal: 1300 } } : {}) } }));
      writeFileSync(join(bin, `loom-${n}`), `#!/bin/sh\ncase "$1 $2" in "ui --json") cat "${join(bin, `${n}.json`)}" ;; *) echo '{"title":"${l}","sections":[{"id":"a","blocks":[{"type":"text","text":"hi"}]}]}' ;; esac\n`);
      chmodSync(join(bin, `loom-${n}`), 0o755);
    }
    writeFileSync(join(bin, 'reader.json'), JSON.stringify(reader));
    writeFileSync(join(bin, 'loom-changes'), `#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\np=Path(__file__).parent\nif sys.argv[1:] == ['ui','--json']:\n print((p/'changes.json').read_text())\nelse:\n req=json.load(sys.stdin)\n out=json.loads((p/'page.json').read_text())\n out['changes']['selected']=req.get('path','')\n if req.get('path'):\n  out['changes']['reader']=json.loads((p/'reader.json').read_text())\n print(json.dumps(out))\n`);
    chmodSync(join(bin, 'loom-changes'), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  async function open(width: number, look: string) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript((look) => { localStorage.setItem('loom-look', look); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); }, look);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    return { ctx, p: await ctx.newPage() };
  }
  for (const width of [1280, 1440, 1920, 390]) for (const look of ['neon', 'lowlight', 'daylight']) {
    it(`${width} ${look}: groups, URL filters, reader, edge scrollbars`, async () => {
      const { ctx, p } = await open(width, look);
      await p.goto(`${base}/p/changes?t=*%2Fp%2Fchanges`);
      const app = p.locator('.loom-changes').last();
      await app.waitFor();
      await expect.poll(() => app.getAttribute('data-mode')).toBe(width === 390 ? 'one' : 'three');
      expect(await p.locator('html').getAttribute('data-look')).toBe(look);
      expect(await p.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--v-canvas').trim().toLowerCase())).toBe(
        { neon: '#07070c', lowlight: '#15171a', daylight: '#f5f3ee' }[look]);
      expect(await app.locator('[data-split-row]').first().evaluate((el) => getComputedStyle(el).color)).toBe(
        { neon: 'rgb(243, 241, 255)', lowlight: 'rgb(243, 244, 244)', daylight: 'rgb(31, 29, 39)' }[look]);
      if (SHOTS && width === 390) await p.screenshot({ path: join(SHOTS, `changes-${width}-${look}-list.png`) });
      const firstRow = app.locator('[data-split-row]').first();
      expect(await firstRow.textContent()).toContain('acme/tasks#1');
      expect(await firstRow.textContent()).toContain('Art');
      expect(await firstRow.textContent()).toContain('Green · needs your yes');
      await firstRow.click();
      await expect.poll(() => new URL(p.url()).pathname).toContain('/c/github/acme/loom/1');
      await app.getByRole('heading', { name: 'Summary', exact: true }).waitFor();
      expect(await app.getByRole('button', { name: 'Yes, merge it' }).count()).toBe(1);
      expect(await app.getByText('Green (4 checks)', { exact: true }).count()).toBe(1);
      expect(await app.getByText('Approved by Ada', { exact: true }).count()).toBe(1);
      expect(await firstRow.getAttribute('aria-current')).toBe('true');
      expect(await firstRow.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
      if (width === 390) {
        expect(await app.locator('.loom-split__list').isVisible()).toBe(false);
      } else {
        const geometry = await app.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const reader = el.querySelector('.loom-split__reader')!;
          return { edge: Math.abs(reader.getBoundingClientRect().right - box.right), overflow: el.scrollWidth - el.clientWidth, scroll: getComputedStyle(reader).overflowY };
        });
        expect(geometry.edge).toBeLessThan(2);
        expect(geometry.overflow).toBeLessThan(2);
        expect(geometry.scroll).toBe('auto');
      }
      if (SHOTS) await p.screenshot({ path: join(SHOTS, `changes-${width}-${look}.png`) });
      await p.reload();
      await app.getByRole('heading', { name: 'Summary', exact: true }).waitFor();
      if (width === 390) await app.getByRole('button', { name: 'Changes', exact: true }).click();
      await app.getByLabel('Repository', { exact: true }).selectOption('acme/tasks');
      await expect.poll(() => new URL(p.url()).searchParams.get('repo')).toBe('acme/tasks');
      await expect.poll(() => app.locator('[data-split-row]').count()).toBe(20);
      await p.reload();
      await expect.poll(() => app.getByLabel('Repository', { exact: true }).inputValue()).toBe('acme/tasks');
      expect(await app.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (width === 390) await app.getByLabel('Group', { exact: true }).selectOption('ci');
      else await app.getByRole('button', { name: /Waiting on CI/ }).click();
      await expect.poll(() => new URL(p.url()).searchParams.get('group')).toBe('ci');
      await expect.poll(() => app.locator('[data-split-row]').count()).toBe(3);
      await app.getByLabel('Author', { exact: true }).selectOption('Ada');
      await expect.poll(() => new URL(p.url()).searchParams.get('author')).toBe('Ada');
      await expect.poll(() => app.locator('[data-split-row]').count()).toBe(0);
      await p.goBack();
      await expect.poll(() => app.locator('[data-split-row]').count()).toBe(3);
      await ctx.close();
    });
  }
});
