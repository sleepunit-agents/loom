// Screenshots and checks for the docs site. Usage: NODE_PATH=... node shoot.js <outdir> [full]
const { chromium } = require('playwright-core');
const path = require('path');
(async () => {
  const out = process.argv[2], full = process.argv[3] === 'full';
  const browser = await chromium.launch();
  const base = 'file://' + path.join(__dirname, 'site') + '/';
  for (const pg of (process.argv[4] ? process.argv[4].split(',') : ['index','conversations','desk','tasks','approvals','tempo','changes','inbox','memory','machines','models','bridges','secrets','people','signing-in','outside','data','measuring','decided'])) {
    for (const [tag, w, h] of [['desk', 1440, 900], ['phone', 400, 800]]) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
        const page = await ctx.newPage();
        const errs = [];
        page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
        page.on('pageerror', e => errs.push(String(e)));
        await page.goto(base + pg + '.html');
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(150);
        const o = await page.evaluate(() => {
          const de = document.documentElement, bad = [];
          for (const el of document.querySelectorAll('main *')) {
            const r = el.getBoundingClientRect();
            if (r.width && r.right > de.clientWidth + 1) bad.push(el.className + ':' + Math.round(r.right));
          }
          return { sw: de.scrollWidth, cw: de.clientWidth, h: de.scrollHeight, bad: bad.slice(0, 6) };
        });
        console.log(pg, tag, scheme, JSON.stringify(o), errs.length ? 'ERRORS ' + errs.join('|') : 'no errors');
        await page.screenshot({ path: path.join(out, `${pg}-${tag}-${scheme}.png`), fullPage: full });
        await ctx.close();
      }
    }
  }
  await browser.close();
})();
