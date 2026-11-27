#!/usr/bin/env node
// Photographs the bricks' gallery (src/boards/gallery; build it first with `npm --prefix web run gallery:build`).
//
//   node web/scripts/gallery-shots.mjs <out dir> [--dist <built gallery>] [--scale 2] [--scheme dark,light]
//                                      [--brick ticket,lanes] [--only bricks|figures|sheets]
//
// Into <out dir>, for each colour scheme:
//   <scheme>/<brick>.png                      every scene and form of one brick, side by side
//   <scheme>/<brick>.<scene>.<form>.png       one drawing
//   sheet-<side|compact|primary|phone>-<scheme>.png   every brick's default scene in that form, on one image
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const flag = (name, otherwise) => { const at = args.indexOf('--' + name); return at < 0 ? otherwise : args.splice(at, 2)[1]; };
const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.resolve(flag('dist', process.env.GALLERY_OUT || path.join(here, '../../dist/gallery')));
const scale = Number(flag('scale', '2')), schemes = flag('scheme', 'dark,light').split(','), only = flag('only', '');
const wanted = flag('brick', '').split(',').filter(Boolean);
const out = path.resolve(args[0] || '');
if (!args[0]) { console.error('usage: gallery-shots.mjs <out dir> [--dist dir] [--scale n] [--scheme dark,light] [--brick a,b] [--only bricks|figures|sheets]'); process.exit(2); }
if (!existsSync(path.join(dist, 'gallery.html'))) { console.error(`No built gallery in ${dist}. Run: npm --prefix web run gallery:build`); process.exit(2); }

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const file = path.join(dist, decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (!file.startsWith(dist)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/gallery.html`;

const { chromium } = createRequire(path.join(here, '../../package.json'))('playwright-core');
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const sheetWidths = { side: 1440, compact: 1440, primary: 2260, phone: 1600 };
let count = 0;
try {
  for (const scheme of schemes) {
    await mkdir(path.join(out, scheme), { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: scale, colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(`[${scheme}] page error: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'warning' && message.text().startsWith('gallery:')) console.error(message.text()); });
    const open = async (search) => { await page.goto(`${base}?scheme=${scheme}${search}`, { waitUntil: 'networkidle' }); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700); };
    if (only !== 'sheets') {
      for (const brick of wanted.length ? wanted : ['']) {
        await open(brick ? '&brick=' + brick : '');
        if (only !== 'figures') for (const section of await page.locator('.gallery-brick').all()) {
          const name = (await section.locator('figure').first().getAttribute('data-shot'))?.split('.')[0];
          if (name) { await section.screenshot({ path: path.join(out, scheme, name + '.png') }); count++; }
        }
        if (only !== 'bricks') for (const figure of await page.locator('figure[data-shot]').all()) {
          await figure.screenshot({ path: path.join(out, scheme, (await figure.getAttribute('data-shot')) + '.png') }); count++;
        }
      }
    }
    if (!wanted.length && only !== 'bricks' && only !== 'figures') for (const [sheet, width] of Object.entries(sheetWidths)) {
      await page.setViewportSize({ width, height: 1000 });
      await open('&sheet=' + sheet);
      await page.screenshot({ path: path.join(out, `sheet-${sheet}-${scheme}.png`), fullPage: true }); count++;
    }
    await context.close();
  }
} finally { await browser.close(); server.close(); }
console.log(`${count} images in ${out}`);
