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
    await checkFrequentRows(page,app);
    return {ok:true,reason:'The scheduled wake appeared at its household time. Navigating away and back preserved its day. Firing it early moved it to the actual firing time with a fired result, and its reader opened after reload. Four recurring times shared one row in Day and Week, with live outcomes and the next time; three times kept their hourly rows.'};
  } finally {
    await context?.close();
    await app.close();
  }
}

async function checkFrequentRows(page, app) {
  const add = (note,times) => app.writes.run(()=>app.services.tempo.triggers.set({
    ownerKind:'member', owner:'alex', sourceKind:'time', times, days:'wed',
    lifespan:'until-stopped', targetKind:'inbox', toKind:'person', to:'alex', instructions:note, note,
  })).value;
  const title = 'Water the seedlings';
  const trigger = add(title,'12:00,13:00,14:00,15:00');
  add('Check the greenhouse','12:15,13:15,14:15');
  await page.goto(app.url+'/p/tempo');
  const day = page.getByRole('region',{name:'Day schedule',exact:true});
  const row = day.getByRole('region',{name:'Frequent triggers'}).getByRole('button',{name:new RegExp(title)});
  await row.getByText(/4 scheduled.*Next 12:00 PM/i).waitFor();
  assert.equal(await day.getByRole('button',{name:new RegExp(title)}).count(),1);
  assert.equal(await day.getByRole('button',{name:/Check the greenhouse/}).count(),3);
  app.writes.run(()=>app.services.tempo.triggers.runNow(trigger.id));
  await row.getByText(/1 fired.*4 scheduled/i).waitFor();
  await row.click();
  await page.getByRole('heading',{name:title,exact:true}).waitFor();
  await page.goto(app.url+'/p/tempo');
  await page.getByRole('button',{name:'Week',exact:true}).click();
  const week = page.getByRole('region',{name:'Week schedule'});
  await week.getByRole('region',{name:'Frequent triggers'}).getByRole('button',{name:new RegExp(title)}).waitFor();
  assert.equal(await week.getByRole('button',{name:new RegExp(title)}).count(),1);
}
