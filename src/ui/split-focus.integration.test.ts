/** Split's delayed focus effect: real Chrome, including background state updates. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
describe.runIf(chrome && existsSync(`${root}web/node_modules/react`))('Split focus ownership', () => {
  let browser: Browser, script: string;
  beforeAll(async () => {
    const result = await build({ stdin: { contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Split } from './src/split';
      function App() {
        const [open, setOpen] = useState(false);
        window.closeReader = () => setOpen(false);
        return <><section className="loom-tile" data-focused="" id="people" style={{width:400}}>
          <Split label="People" folders={[]} folder="" onFolder={()=>{}} listTitle="People"
            list={<button data-split-row onClick={()=>setOpen(true)}>Art</button>}
            reader={<p>Art reader</p>} open={open} onBack={()=>setOpen(false)} backLabel="Back" />
          </section><button id="activity" onClick={()=>document.querySelector('#people').removeAttribute('data-focused')}>Activity</button></>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `, resolveDir: `${root}web`, loader: 'tsx' }, bundle: true, write: false, loader: { ".css": "empty" }, format: 'iife', jsx: 'automatic', tsconfig: `${root}web/tsconfig.app.json` });
    script = result.outputFiles[0].text;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });
  it('focused open and Escape return focus; background reader close preserves the chosen app', async () => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p.setContent('<div id="root"></div>');
    await p.addScriptTag({ content: script });
    await expect.poll(() => p.locator('.loom-split').getAttribute('data-mode')).toBe('one');
    const row = p.locator('[data-split-row]');
    await row.click();
    await expect.poll(() => p.locator('.loom-split__reader').evaluate(e => e === document.activeElement)).toBe(true);
    await p.keyboard.press('Escape');
    await expect.poll(() => row.evaluate(e => e === document.activeElement)).toBe(true);
    await row.click();
    await expect.poll(() => p.locator('.loom-split__reader').evaluate(e => e === document.activeElement)).toBe(true);
    await p.click('#activity');
    await p.evaluate(() => (window as unknown as { closeReader: () => void }).closeReader());
    await expect.poll(() => p.locator('.loom-split__reader').count()).toBe(0);
    // Passive effects can occur after the reader disappears; don't poll the transient state.
    await p.waitForTimeout(300);
    expect(await p.locator('#activity').evaluate(e => e === document.activeElement)).toBe(true);
    await p.close();
  });
});
