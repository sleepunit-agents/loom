import assert from 'node:assert/strict';
import { FakeClock } from '../dist/core/clock.js';
import { exampleHome } from '../dist/example-home.js';
import { startSharedHome } from '../dist/shared-startup.js';

export async function pausedWake({ browser, home }) {
  const example = await exampleHome(home);
  const clock = new FakeClock(Date.parse(example.createdAt));
  const start = (port) => startSharedHome({ home, host: '127.0.0.1', port, clock, stdout() {} });
  const label = 'Inspect the fictional orchard';
  const id = 'orchard-round';
  let app, context;
  try {
    app = await start(0);
    const origin = app.url,
      port = Number(new URL(origin).port);
    context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await context.routeWebSocket(
      (url) => url.origin !== origin.replace(/^http/, 'ws'),
      (route) => route.close(),
    );
    const page = await context.newPage();
    await page.goto(app.signinLink('alex'));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('.next-shell').waitFor();
    const times = new Date(clock.now() + 60_000).toISOString();
    async function schedule(agent, trigger, words) {
      const response = await page.request.post(origin + '/api/tempo/set', {
        headers: { origin },
        maxRedirects: 0,
        data: {
          id: 'schedule-' + trigger,
          input: {
            id: trigger,
            ownerKind: 'agent',
            owner: agent,
            sourceKind: 'time',
            times,
            lifespan: 'once',
            targetKind: 'inbox',
            toKind: 'agent',
            to: agent,
            instructions: words,
            note: words,
          },
        },
      });
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).ok, true);
    }
    await schedule('fern', id, label);
    const control = 'orchard-control';
    await schedule('moss', control, 'Inspect the garden path');
    const tile = page.getByRole('region', { name: 'Tempo tile', exact: true });
    async function openTrigger() {
      await page.goto(origin + '/p/tempo');
      await tile.getByText(label, { exact: true }).first().click();
    }
    async function restart() {
      await app.close();
      app = undefined;
      app = await start(port);
      clock.advance(0);
    }
    const db = () => app.services.comms.db.$client;
    const state = () => db().prepare('SELECT state FROM triggers WHERE id=?').pluck().get(id);
    const deliveries = (trigger = id) =>
      db()
        .prepare(
          "SELECT i.id,i.[to] recipient,i.words FROM inbox i JOIN inbox_refs r ON r.item=i.id WHERE i.source='trigger' AND r.ref=?",
        )
        .all(trigger);
    await openTrigger();
    await tile.getByRole('button', { name: 'Pause agent', exact: true }).click();
    await tile.getByRole('button', { name: 'Resume agent', exact: true }).waitFor();
    assert.equal(state(), 'held');
    await app.close();
    app = undefined;
    clock.advance(60_000);
    app = await start(port);
    clock.advance(0);
    assert.equal(state(), 'held');
    assert.deepEqual(deliveries(), []);
    const other = deliveries(control);
    assert.equal(other.length, 1);
    assert.equal(other[0].recipient, 'moss');
    await openTrigger();
    const [resumed] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/tempo/resume' && r.request().method() === 'POST',
      ),
      tile.getByRole('button', { name: 'Resume agent', exact: true }).click(),
    ]);
    assert.equal((await resumed.json()).ok, true);
    assert.equal(state(), 'fired');
    const saved = deliveries();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].recipient, 'fern');
    assert.ok(saved[0].words.endsWith(label));
    await restart();
    assert.deepEqual(deliveries(), saved);
    assert.deepEqual(deliveries(control), other);
    assert.equal(
      db().prepare("SELECT count(*) FROM trigger_log WHERE [trigger]=? AND event='fired'").pluck().get(id),
      1,
    );
    return {
      ok: true,
      reason:
        'Moss received the scheduled reminder after restart while Fern stayed paused. Resuming Fern from Tempo delivered her reminder once. Its Inbox ID and single firing survived a second restart.',
    };
  } finally {
    try {
      await context?.close();
    } finally {
      await app?.close();
    }
  }
}
