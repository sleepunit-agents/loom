/**
 * An agent's pixel face (Jonathan, 2026-11-04: the PixelLab sheets he made for Art): a sprite sheet per facing, kept
 * with the household's marks (faces/<agent>/), set with `loom household sprite`, carried on the agent's mark (face.sprite)
 * and served only to someone signed in who sees that agent. In a browser, an agent with a sheet wears it at whole pixels
 * (2x on its card) unless the person turned "Pixel faces" off; an agent without one keeps its drawn face.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { chromium, type Browser } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, checkSpriteManifest, createToken, HouseholdError, loadHousehold, manifestFromPixelLab, setSprite, spriteOf, type Household } from '../household.js';
import { runHousehold } from '../cli/household.js';
import { pick, variantsFor } from '../../web/src/pixel-face';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

/** A sheet as PixelLab exports one: 56×84 cells, 17 columns, a rotations row, then each state in the facings given; a cyan square in each cell. */
function sheet(facings = ['south', 'south-east', 'south-west']): { png: Buffer; json: Buffer } {
  const names = ['Error', 'Shift eyes rapidly from side to side to simulate reading', 'Idle', 'Thinking', 'Done', 'Waiting', 'Crack Neck'];
  const [cw, ch, cols, rows] = [56, 84, 17, 1 + names.length * facings.length];
  const [w, h] = [cw * cols, ch * rows];
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [cx, cy] = [x % cw, y % ch];
    if (cx >= 10 && cx < 46 && cy >= 20 && cy < 64) raw.set([0x2e, 0xe6, 0xf0, 255], y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const json = Buffer.from(JSON.stringify({ character: { size: { width: 48, height: 48 } }, spritesheet: { cell_size: { width: cw, height: ch }, columns: cols,
    rows: [{ row: 0, type: 'rotations', frame_count: 8 }, ...names.flatMap((animation, i) => facings.map((direction, j) => ({ row: 1 + i * facings.length + j, type: 'animation', frame_count: 17, animation, direction })))] } }));
  return { png, json };
}

describe('an agent\'s pixel face', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let token: string;
  let browser: Browser | undefined;
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-pixel-'));
    for (const a of ['art', 'mark']) { mkdirSync(join(home, 'agents', a), { recursive: true }); writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n'); }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    if (built && chrome) browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle.close();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  const signIn = async () => ((await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`, redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0];

  it('a manifest seeded from PixelLab: each state in each facing, one animation, weight 1; waiting south only', () => {
    const m = manifestFromPixelLab(JSON.parse(sheet().json.toString()));
    expect(m.cell).toEqual([56, 84]);
    expect(m.states.idle).toEqual({ south: [{ row: 7, frames: 17, weight: 1 }], 'south-east': [{ row: 8, frames: 17, weight: 1 }], 'south-west': [{ row: 9, frames: 17, weight: 1 }] });
    expect(m.states.working?.south).toEqual([{ row: 4, frames: 17, weight: 1 }]);
    expect(m.states.waiting).toEqual({ south: [{ row: 16, frames: 17, weight: 1 }] });
    // A named animation that isn't a state is left out unless placed: Art's neck crack, a rare idle.
    expect(Object.values(m.states).flatMap((f) => Object.values(f!).flat()).some((v) => v!.row >= 19)).toBe(false);
    const art = manifestFromPixelLab(JSON.parse(sheet().json.toString()), { weights: { idle: 85 }, variants: { 'Crack Neck': { state: 'idle', weight: 15, rare: true } } });
    expect(art.states.idle).toEqual({
      south: [{ row: 7, frames: 17, weight: 85 }, { row: 19, frames: 17, weight: 15, rare: true }],
      'south-east': [{ row: 8, frames: 17, weight: 85 }, { row: 20, frames: 17, weight: 15, rare: true }],
      'south-west': [{ row: 9, frames: 17, weight: 85 }, { row: 21, frames: 17, weight: 15, rare: true }],
    });
    expect(() => checkSpriteManifest({ cell: [56, 84], states: { idle: { south: [{ row: 7, frames: 17, weight: 1 }] }, waiting: { 'south-east': [{ row: 17, frames: 17, weight: 1 }] } } })).toThrow(HouseholdError);
    expect(() => checkSpriteManifest({ cell: [56, 84], states: { idle: { east: [{ row: 7, frames: 17, weight: 1 }] } } })).toThrow(HouseholdError);
    expect(() => checkSpriteManifest({ cell: [56, 84], states: { idle: { south: [{ sheet: '../x.png', row: 0, frames: 2, weight: 1 }] } } })).toThrow(HouseholdError);
    expect(() => checkSpriteManifest({ cell: [56, 84], states: { idle: { south: [{ row: 0, frames: 2, weight: 1, rare: 'yes' }] } } })).toThrow(HouseholdError);
  });

  it('picks an animation by weight at each beat, never the same rare one twice in a row; a facing with none uses south', () => {
    const usual = { row: 7, frames: 17, weight: 85 }, rare = { sheet: 'idle-rare.png', row: 0, frames: 12, weight: 15, rare: true };
    const m = { cell: [56, 84] as [number, number], states: { idle: { south: [usual, rare], 'south-east': [{ row: 8, frames: 17, weight: 1 }] }, error: { south: [{ row: 1, frames: 17, weight: 1 }], 'south-east': [{ row: 2, frames: 17, weight: 1 }] }, waiting: { south: [{ row: 16, frames: 17, weight: 1 }] } } };
    expect(pick([usual, rare], undefined, 0.5)).toBe(usual);
    expect(pick([usual, rare], undefined, 0.9)).toBe(rare);
    expect(pick([usual, rare], rare, 0.99)).toBe(usual);   // after a rare one, never a rare one
    expect(pick([usual, rare], usual, 0.9)).toBe(rare);    // the usual one may be followed by a rare one
    let prev: typeof usual | undefined, twice = 0;
    for (let i = 0; i < 2000; i++) { const v = pick([usual, rare], prev); if (v === rare && prev === rare) twice++; prev = v; }
    expect(twice).toBe(0);
    let rares = 0;
    for (let i = 0; i < 2000; i++) if (pick([usual, rare], undefined) === rare) rares++;
    expect(rares / 2000).toBeGreaterThan(0.1); expect(rares / 2000).toBeLessThan(0.2);
    expect(variantsFor(m, 'idle', 'south-east')).toEqual({ list: m.states.idle['south-east'], flip: false });
    expect(variantsFor(m, 'error', 'south-west')).toEqual({ list: m.states.error['south-east'], flip: true });
    expect(variantsFor(m, 'idle', 'south-west')).toEqual({ list: m.states.idle['south-east'], flip: true });
    expect(variantsFor(m, 'thinking', 'south-east')).toEqual({ list: m.states.idle.south, flip: false });
    expect(variantsFor(m, 'needs-input', 'south-east')).toEqual({ list: m.states.waiting.south, flip: false });
  });

  it('is set from the command line, checked first: a PNG and a sprite sheet\'s JSON, for an agent of the household', async () => {
    const { png, json } = sheet();
    const m = manifestFromPixelLab(JSON.parse(json.toString()));
    expect(() => setSprite(h, 'art', m, { 'sheet.png': Buffer.from('GIF89a') })).toThrow(HouseholdError);
    expect(() => setSprite(h, 'art', m, {})).toThrow(HouseholdError);   // names sheet.png, which isn't given or kept
    expect(() => setSprite(h, 'nobody', m, { 'sheet.png': png })).toThrow(HouseholdError);
    // A sheet without south: no face (idle facing south is the one every pixel face has).
    expect(() => manifestFromPixelLab(JSON.parse(sheet(['south-east']).json.toString()))).toThrow(HouseholdError);
    expect(spriteOf(h, 'art')).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'loom-pixel-src-'));
    writeFileSync(join(dir, 'a.png'), png); writeFileSync(join(dir, 'a.json'), json);
    const out: string[] = [];
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: { ...process.env, LOOM_HOME: h.home } };
    expect(await runHousehold(['sprite', 'art', join(dir, 'a.png'), join(dir, 'a.json'), '--weight', 'idle=85', '--variant', 'Crack Neck=idle:15:rare'], io as never)).toBe(0);
    expect(spriteOf(h, 'art')).toMatchObject({ facings: ['south', 'south-east', 'south-west'] });
    expect(JSON.parse(readFileSync(join(h.home, 'faces', 'art', 'manifest.json'), 'utf-8')).states.idle.south).toEqual([{ row: 7, frames: 17, weight: 85 }, { row: 19, frames: 17, weight: 15, rare: true }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rides on the agent\'s mark, and is served only to someone signed in, for an agent that has one', async () => {
    const cookie = await signIn();
    const view = await (await fetch(`${base}/`, { headers: { cookie, accept: 'application/json' } })).json() as { chrome: { shell: { agents: Array<{ id: string; face: { sprite?: { facings: string[]; v: string; base: string } } }> } } };
    const [art, mark] = ['art', 'mark'].map((id) => view.chrome.shell.agents.find((a) => a.id === id)!);
    expect(art.face.sprite).toMatchObject({ facings: ['south', 'south-east', 'south-west'], base: '/faces/art/' });
    expect(mark.face.sprite).toBeUndefined();
    const png = await fetch(`${base}/faces/art/sheet.png?v=${art.face.sprite!.v}`, { headers: { cookie } });
    expect((await fetch(`${base}/faces/art/other.png`, { headers: { cookie } })).status).toBe(404);   // not named by its manifest
    expect([png.status, png.headers.get('content-type'), png.headers.get('cache-control')]).toEqual([200, 'image/png', 'private, max-age=31536000, immutable']);
    expect((await (await fetch(`${base}/faces/art/manifest.json`, { headers: { cookie } })).json()).states.waiting).toEqual({ south: [{ row: 16, frames: 17, weight: 1 }] });
    expect((await fetch(`${base}/faces/mark/sheet.png`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/faces/art/sheet.png`, { redirect: 'manual' })).status).not.toBe(200);
  });

  it.runIf(built && chrome)('in a browser: whole pixels, 2x on the card; the drawn face for an agent without one, and for everyone with Pixel faces off', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    const face = page.locator('.loom-identity .loom-pixel-face canvas').first();
    await face.waitFor({ timeout: 15_000 });
    expect(await face.evaluate((c) => [getComputedStyle(c).imageRendering, c.getBoundingClientRect().width, (c as HTMLCanvasElement).width])).toEqual(['pixelated', 96, 48]);
    expect(await page.locator('.loom-identity').count()).toBe(2);
    expect(await page.locator('.loom-identity [data-slot="agent-face"]').count()).toBe(1);   // Mark's, drawn
    await page.goto(`${base}/appearance`);
    await page.getByRole('radio', { name: 'Off' }).first().click();
    await page.goto(`${base}/`);
    await page.locator('.loom-identity [data-slot="agent-face"]').nth(1).waitFor({ timeout: 15_000 });
    expect(await page.locator('.loom-pixel-face').count()).toBe(0);
    await ctx.close();
  }, 60_000);
});
