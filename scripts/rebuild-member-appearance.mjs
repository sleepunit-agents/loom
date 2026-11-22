import assert from 'node:assert/strict';
import {join} from 'node:path';

const switches = ['Pixel faces', 'Sound', 'Haptics', 'One window at a time', 'Allow zoom'];
const choices = ['Look', 'Desk background', 'Reduce motion', 'Higher contrast'];

async function readAppearance(page) {
  const panel = page.getByRole('region', {name: 'Appearance tile', exact: true});
  await panel.getByRole('switch', {name: 'Sound', exact: true}).and(page.locator(':enabled')).waitFor();
  const state = {};
  for (const label of choices) {
    state[label] = await panel.getByRole('radiogroup', {name: label, exact: true}).getByRole('radio', {checked: true}).innerText();
  }
  for (const label of switches) {
    state[label] = await panel.getByRole('switch', {name: label, exact: true}).isChecked();
  }
  return state;
}

export async function memberAppearance({page: alex, app, browser, out}) {
  const context = await browser.newContext({serviceWorkers: 'block', reducedMotion: 'reduce'});
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === app.url ? route.continue() : route.abort());
    await context.routeWebSocket(url => url.origin !== app.url.replace(/^http/, 'ws'), route => route.close());
    const robin = await context.newPage();
    await robin.goto(app.signinLink('robin'));
    await robin.getByRole('button', {name: 'Sign in', exact: true}).click();
    await robin.locator('.next-shell').waitFor();
    for (const page of [alex, robin]) await page.goto(app.url + '/p/appearance');
    const original = await readAppearance(alex);
    const current = await readAppearance(robin);
    const target = {};
    const alternatives = [['Low Light', 'Daylight'], ['Contours', 'Depth'], ['Off', 'On'], ['Off', 'On']];
    const panel = robin.getByRole('region', {name: 'Appearance tile', exact: true});
    for (const [index, label] of [...choices, ...switches].entries()) {
      const radio = index < choices.length;
      target[label] = radio ? alternatives[index].find(value => value !== original[label]) : !original[label];
      if (current[label] === target[label]) continue;
      const control = radio
        ? panel.getByRole('radiogroup', {name: label, exact: true}).getByRole('radio', {name: target[label], exact: true})
        : panel.getByRole('switch', {name: label, exact: true});
      const [response] = await Promise.all([
        robin.waitForResponse(r => new URL(r.url()).pathname === '/api/household/setPreferences' && r.request().method() === 'POST'),
        control.click()
      ]);
      assert.ok(response.ok() && (await response.json()).ok, label);
      await panel.getByRole('status').filter({hasText: 'Saved.'}).waitFor();
      assert.equal((await readAppearance(robin))[label], target[label], label);
    }
    for (const [page, expected, member] of [[alex, original, 'alex'], [robin, target, 'robin']]) {
      await page.reload();
      assert.deepEqual(await readAppearance(page), expected, member);
      await page.screenshot({path: join(out, 'appearance-' + member + '.png')});
    }
    return {ok: true, reason: 'Alex and Robin kept different looks, backgrounds, motion, contrast and all five switches after reloading both desks.', screenshot: 'appearance-robin.png', members: {alex: original, robin: target}};
  } catch (error) {
    return {ok: false, error: String(error)};
  } finally {
    await context.close();
  }
}
