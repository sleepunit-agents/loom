import assert from 'node:assert/strict';
import { FakeClock } from '../dist/core/clock.js';
import { exampleHome } from '../dist/example-home.js';
import { startSharedHome } from '../dist/shared-startup.js';

export async function tempoCalendar({ browser, home }) {
  await exampleHome(home);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Choose two distinct times on one household date regardless of the worker's zone.
  const morning = new Date(2027, 2, 17, 9, 13);
  const afternoon = new Date(2027, 2, 17, 14, 47);
  const clock = new FakeClock(morning.getTime());
  const app = await startSharedHome({ home, clock, port: 0, stdout() {} });
  let context;
  try {
    context = await browser.newContext({locale:'en-US',timezoneId:'Pacific/Honolulu',serviceWorkers:'block'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
    await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(app.signinLink('alex'));
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.locator('.next-shell').waitFor();
    const note = 'Check the seed trays';
    const trigger = app.writes.run(()=>app.services.tempo.triggers.set({
      ownerKind:'member',owner:'alex',sourceKind:'time',times:afternoon.toISOString(),
      lifespan:'once',targetKind:'inbox',toKind:'person',to:'alex',instructions:note,note,
    })).value;
    await page.goto(app.url+'/p/tempo');
    const day = page.getByRole('region',{name:'Day schedule'});
    const row = day.getByRole('button',{name:new RegExp(note)});
    const format = new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'2-digit',minute:'2-digit'});
    const at = date => format.format(date).replace(/\s/g,' ');
    await row.getByText(at(afternoon),{exact:true}).waitFor();
    await day.getByRole('separator',{name:'Now'}).waitFor();
    await page.getByRole('button',{name:'Next day'}).click();
    await page.getByRole('navigation',{name:'Calendar date'}).locator('time[datetime="2027-03-18"]').waitFor();
    await row.waitFor({state:'hidden'});
    assert.equal(await row.count(),0);
    await page.getByRole('button',{name:'Today',exact:true}).click();
    await row.getByText(at(afternoon),{exact:true}).waitFor();
    app.writes.run(()=>app.services.tempo.triggers.runNow(trigger.id));
    await row.getByText('fired',{exact:true}).waitFor();
    await row.getByText(at(morning),{exact:true}).waitFor();
    await page.reload();
    await row.click();
    await page.getByRole('heading',{name:note,exact:true}).waitFor();
    return {ok:true,reason:'The scheduled wake appeared at its household time. Navigating away and back preserved its day. Firing it early moved it to the actual firing time with a fired result, and its reader opened after reload.'};
  } finally {
    await context?.close();
    await app.close();
  }
}
