import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';

export async function phoneTask({browser, home, out}) {
  const contexts = [];
  let app;
  try {
    await exampleHome(home);
    app = await startSharedHome({home, port: 0, webRoot: resolve('dist/web'), stdout() {}});
    const devices = [];
    for (const [member, mobile] of [['alex', false], ['robin', true]]) {
      const context = await browser.newContext({
        viewport: mobile ? {width: 390, height: 844} : {width: 1440, height: 900},
        isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', serviceWorkers: 'block',
      });
      contexts.push(context);
      await context.route('**/*', route => new URL(route.request().url()).origin === app.url ? route.continue() : route.abort());
      await context.routeWebSocket(url => url.origin !== app.url.replace(/^http/, 'ws'), route => route.close());
      const page = await context.newPage();
      await page.goto(app.signinLink(member));
      await page.getByRole('button', {name: 'Sign in', exact: true}).click();
      await page.locator('.next-shell').waitFor();
      await page.goto(app.url + '/p/tasks-preview?folder=progress');
      const tasks = page.getByRole('region', {name: 'Tasks tile', exact: true});
      await tasks.locator('[data-split-row]').filter({hasText: 'Compare garden pumps'}).click();
      await tasks.getByText('Compared three fictitious models.', {exact: true}).waitFor();
      devices.push({page, tasks});
    }

    const [desktop, phone] = devices;
    for (const [author, message] of [[desktop, 'Desktop found the replacement.'], [phone, 'Phone confirmed the dimensions.']]) {
      await author.tasks.getByRole('button', {name: 'Comment', exact: true}).click();
      const form = author.tasks.getByRole('form', {name: 'Add comment', exact: true});
      await form.getByLabel('Comment', {exact: true}).fill(message);
      await form.getByRole('button', {name: 'Add comment', exact: true}).click();
      for (const {tasks} of devices) await tasks.getByText(message, {exact: true}).waitFor();
    }
    await phone.page.reload();
    await phone.tasks.getByText('Phone confirmed the dimensions.', {exact: true}).waitFor();
    assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    const question = 'Are the mounting holes aligned?';
    await desktop.tasks.getByRole('button', {name: 'More for this task', exact: true}).click();
    await desktop.tasks.getByRole('button', {name: 'Ask a person', exact: true}).click();
    const ask = desktop.tasks.getByRole('form', {name: 'Ask a person', exact: true});
    await ask.getByRole('combobox', {name: 'Person', exact: true}).selectOption('robin');
    for (const [label, text] of [['Question', question], ['If yes', 'Fit the pump.'], ['If no', 'Measure again.']]) {
      await ask.getByLabel(label, {exact: true}).fill(text);
    }
    await ask.getByRole('button', {name: 'Ask', exact: true}).click();
    await ask.waitFor({state: 'hidden'});

    await phone.page.locator('.loom-desk-boot').waitFor({state: 'hidden'});
    await phone.page.getByRole('button', {name: 'Open Inbox', exact: true}).tap();
    const inbox = phone.page.getByRole('region', {name: 'Inbox tile', exact: true});
    await inbox.locator('[data-split-row]').filter({hasText: question}).tap();
    const yes = inbox.getByRole('button', {name: 'Yes', exact: true});
    await yes.tap();
    await yes.waitFor({state: 'hidden'});
    await desktop.tasks.getByText('Yes, to: ' + question, {exact: false}).waitFor();
    const screenshot = 'action-phone-task.png';
    await phone.page.screenshot({path: join(out, screenshot)});
    return {ok: true, screenshot, reason: 'Two signed-in members exchanged task comments live. The phone reopened the task after reload and answered the desktop question through its dock and Inbox.'};
  } finally {
    try { await Promise.all(contexts.map(context => context.close())); }
    finally { await app?.close(); }
  }
}
