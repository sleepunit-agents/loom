/** Real DOM activation: React's delegated events must preserve sibling action independence. */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
describe.runIf(chrome)('kit row DOM activation', () => {
  it('keeps mouse, Enter and Space opening and trailing actions independent', async () => {
    const web = fileURLToPath(new URL('../../web', import.meta.url));
    const bundle = await build({
      stdin: { contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Row } from './src/kit/app';
        window.operations = [];
        createRoot(document.getElementById('root')).render(React.createElement(Row, {
          title: 'One', onClick: () => window.operations.push('open'),
          actions: React.createElement('button', { onClick: () => window.operations.push('done') }, 'Done')
        }));`, resolveDir: web, loader: 'tsx' },
      bundle: true, write: false, format: 'iife', jsx: 'automatic',
      alias: { '@': `${web}/src` }, loader: { '.css': 'empty' },
    });
    const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const open = page.getByRole('button', { name: 'One', exact: true });
      const done = page.getByRole('button', { name: 'Done', exact: true });
      await open.waitFor();
      expect(await page.locator('button button').count()).toBe(0);
      for (const activation of ['click', 'Enter', 'Space']) {
        for (const [target, operation] of [[done, 'done'], [open, 'open']] as const) {
          await page.evaluate(() => { (window as unknown as { operations: string[] }).operations = []; });
          if (activation === 'click') await target.click();
          else { await target.focus(); await target.press(activation); }
          expect(await page.evaluate(() => (window as unknown as { operations: string[] }).operations)).toEqual([operation]);
        }
      }
    } finally { await browser.close(); }
  }, 30_000);
});
