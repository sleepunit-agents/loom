/** The generic drawer works with native controls, hidden controls and an empty list. */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
describe.runIf(chrome)('kit drawer native focus', () => {
  for (const contents of ['links', 'controls', 'empty', 'coarse']) it(contents, async () => {
    const web = fileURLToPath(new URL('../../web', import.meta.url));
    const bundle = await build({ stdin: { resolveDir: web, loader: 'tsx', contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { DrawerSplit, useDrawerSplit, SplitDrawerButton } from './src/kit/drawer-split';
      function App() {
        const layout = useDrawerSplit({active: true, twoFrom: 900, resetKey: 'one'});
        const list = ${(contents === 'links' || contents === 'coarse') ? '<div><a hidden href="#hidden">Hidden</a><a href="#first">First</a><a href="#middle">Middle</a><a href="#last">Last</a></div>'
          : contents === 'controls' ? '<div><input disabled aria-label="Disabled"/><textarea aria-label="First"/><input aria-label="Middle"/><select aria-label="Last"><option>Option</option></select><button style={{display:"none"}}>Hidden</button></div>'
            : '<p>No items</p>'};
        return <DrawerSplit layout={layout} label="Items" list={list} reader={<div>{layout.drawer && <SplitDrawerButton {...layout.drawer} label="Items" />}<input aria-label="Reader"/></div>} blank={null} />;
      }
      createRoot(document.getElementById('root')).render(<App/>);` },
      bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    });
    const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 560, height: 800 }, hasTouch: contents === 'coarse', reducedMotion: 'reduce' });
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ content: ':root { --v-text: black; --v-paper: white; --v-border: black; --v-scrim: #3338; --shadow-float: none; }' + readFileSync(`${web}/src/kit/drawer-split.css`, 'utf8') });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const trigger = page.getByRole('button', { name: 'Items', exact: true });
      const idle = await trigger.evaluate((el) => getComputedStyle(el).backgroundColor);
      if (contents === 'coarse') { await trigger.tap(); } else await trigger.click();
      const panel = page.locator('.loom-drawer-split__panel');
      expect(await panel.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
      expect(await page.locator('.loom-drawer-split__scrim').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
      if (contents === 'empty') {
        expect(await panel.evaluate((el) => el === document.activeElement)).toBe(true);
        for (const key of ['Tab', 'Shift+Tab']) { await page.keyboard.press(key); expect(await panel.evaluate((el) => el === document.activeElement)).toBe(true); }
      } else {
        const first = contents !== 'controls' ? panel.getByRole('link', { name: 'First', exact: true }) : panel.getByRole('textbox', { name: 'First', exact: true });
        const last = contents !== 'controls' ? panel.getByRole('link', { name: 'Last', exact: true }) : panel.getByRole('combobox', { name: 'Last', exact: true });
        expect(await first.evaluate((el) => el === document.activeElement)).toBe(true);
        const middle = contents !== 'controls' ? panel.getByRole('link', { name: 'Middle', exact: true }) : panel.getByRole('textbox', { name: 'Middle', exact: true });
        await page.keyboard.press('Tab'); expect(await middle.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press('Tab'); expect(await last.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press('Shift+Tab'); expect(await middle.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press('Shift+Tab'); expect(await first.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press('Shift+Tab'); expect(await last.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press('Tab'); expect(await first.evaluate((el) => el === document.activeElement)).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
      expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
      if (contents === 'coarse') {
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        expect(await trigger.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(idle);
      }
      expect(await page.getByRole('textbox', { name: 'Reader' }).isEnabled()).toBe(true);
    } finally { await browser.close(); }
  }, 30_000);
});
