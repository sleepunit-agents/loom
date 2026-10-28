/**
 * The blocks added for the page's next look: meter, code (with a Copy
 * button), status, and a page's own refresh. Validated like every block, and
 * rendered as data: every string escaped.
 */
import { describe, it, expect } from 'vitest';
import { parseManifest, parsePage } from './vocab.js';
import { renderDashboard, renderPage, CORE, type Chrome, renderHouseHome } from './render.js';
import { whereLabel } from './data.js';
import { identityFacts } from './household-pages.js';

const chrome: Chrome = { agent: 'Test', nav: [], clock: 'now', csrf: 'c'.repeat(64), skipped: [] };
const ctx = { source: CORE, path: '', query: {}, csrf: 'c'.repeat(64) };
const page = (blocks: unknown[], extra: Record<string, unknown> = {}) => parsePage({ title: 'T', sections: [{ id: 's', blocks }], ...extra });

describe('meter, code and status blocks', () => {
  it('a table on a phone is compact rows: title, a short value on the right, two label-value pairs, the rest under more', () => {
    const p = parsePage({ title: 'Clock', sections: [{ id: 's', blocks: [{ type: 'table', columns: ['name', 'when', 'runs', 'next', 'extra'],
      rows: [['groom', '17:47 sun', 'groom.md', '11-01 17:47', 'x'], ['long', 'a value much longer than twenty-four characters', 'r', 'n']] }] }] });
    const html = renderPage(p as Exclude<typeof p, string>, ctx, chrome);
    expect(html).toContain('<div class="trow"><div class="tmain"><span class="ttitle">groom</span><span class="tline"><span class="tpair"><span class="tl">runs</span> groom.md</span>');
    expect(html).toContain('<details><summary>more</summary><dl><dt>extra</dt><dd>x</dd></dl></details></div><span class="tside">17:47 sun</span>');
    // A long second value leads the line instead of crowding the right.
    expect(html).toMatch(/<span class="ttitle">long<\/span><span class="tline"><span class="tpair"><span class="tl">when<\/span> a value much longer/);
    expect(html).not.toContain('+ 1 more field');
  });

  it('a long list of plain choices is a dropdown; a short one stays radios', () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `p${i}`, label: `Person ${i}` }));
    const long = page([{ type: 'form', action: 'pick', submit: 'Save', fields: [{ name: 'who', label: 'Who', kind: 'choice', value: 'p3', options: opts(12) }] }]);
    const html = renderPage(long as Exclude<typeof long, string>, ctx, chrome);
    expect(html).toMatch(/<select id="[^"]+" name="who">/);
    expect(html).toContain('<option value="p3" selected>Person 3</option>');
    const short = page([{ type: 'form', action: 'pick', submit: 'Save', fields: [{ name: 'who', label: 'Who', kind: 'choice', options: opts(6) }] }]);
    expect(renderPage(short as Exclude<typeof short, string>, ctx, chrome)).not.toContain('<select');
  });

  it('a list row may carry one action, inline, that asks first when it is danger', () => {
    const p = page([{ type: 'list', items: [{ text: 'laptop', meta: 'used 3 days ago', act: { action: 'revoke', label: 'Revoke', tone: 'danger', confirm: 'Signed out at once.', fields: { label: 'laptop' } } }] }]);
    const html = renderPage(p as Exclude<typeof p, string>, ctx, chrome);
    expect(html).toContain('<input type="hidden" name="label" value="laptop"><button class="row-act danger" type="submit" data-confirm="Signed out at once.">Revoke</button>');
    expect(typeof page([{ type: 'list', items: [{ text: 'x', act: { action: 'bad action!', label: 'x' } }] }])).toBe('string');
  });

  it('an identity gives its bio and voice', () => {
    expect(identityFacts('# Gabe\n\nGabe keeps the books.\n\n## Voice\n\nDry, curious.\n\nMore.\n')).toEqual({ bio: 'Gabe keeps the books.', voice: 'Dry, curious.' });
    expect(identityFacts('# Art\n\nYou are Art.\n\n## Communication\n\nBe direct.\n')).toEqual({ bio: 'You are Art.', voice: 'Be direct.' });
  });

  it('a filters search field carries a magnifier', () => {
    const p = page([{ type: 'filters', param: 'd', search: 'Search 3 facts', options: [{ value: '', label: 'All' }] }]);
    expect(renderPage(p as Exclude<typeof p, string>, ctx, chrome)).toMatch(/<svg class="search-icon"[^>]*>[\s\S]*?<\/svg><input type="search"/);
  });

  it('an ask may carry up to two actions, drawn on its card and posted to its source', () => {
    const m = parseManifest({ v: 2, asks: [{ text: 'Renew the login', page: '', actions: [{ action: 'renew', label: 'Renew', tone: 'primary' }, { action: 'later', label: 'Later' }] }] });
    expect(typeof m === 'string' ? m : m.asks[0].actions?.map((b) => b.label)).toEqual(['Renew', 'Later']);
    expect(typeof parseManifest({ v: 2, asks: [{ text: 'x', actions: [1, 2, 3].map((n) => ({ action: `a${n}`, label: 'x' })) }] })).toBe('string');
    const html = renderDashboard({ label: 'Household', thread: [], tiles: [], asks: [{ text: 'Renew the login', source: { id: 'subs', base: '/p/subs/' }, actions: [{ action: 'renew', label: 'Renew', tone: 'primary' }, { action: 'later', label: 'Later' }] }] }, ctx, chrome);
    expect(html).toMatch(/<div class="ask-acts"><form class="button-form" method="post" action="\/act\/subs">[\s\S]*?>Renew<\/button>[\s\S]*?>Later<\/button>/);
  });

  it('a where reads the way a person says it', () => {
    expect(whereLabel('slack:dm:patrick-kells')).toBe('Slack DM · Patrick Kells');
    expect(whereLabel('discord:#pond')).toBe('Discord #pond');
    expect(whereLabel('wake:w-1a2b3c')).toBe('Wake');
    expect(whereLabel('letters')).toBe('Letters');
    expect(whereLabel('?')).toBe('');
  });

  it('Home carries a live dot in its head, and a long tile value is set smaller', () => {
    const html = renderDashboard({ label: 'Household', asks: [], thread: [], tiles: [
      { label: 'Work', value: '19 in progress', source: CORE }, { label: 'Boxes', value: '1 box', source: CORE }] }, ctx, chrome);
    expect(html).toContain('<span class="head-live" data-live-status></span></header>');
    // Once: the footer doesn't say it again.
    expect(html.match(/<span[^>]*data-live-status/g)).toHaveLength(1);
    expect(html).toContain('<span class="value long">19 in progress</span>');
    expect(html).toContain('<span class="value">1 box</span>');
  });

  it('the house Home says it is live once, in its head', () => {
    const html = renderHouseHome({ headline: "Everyone's fine", needs: 0, cards: [], moving: [] }, ctx, chrome);
    expect(html).toContain('<span class="head-live" data-live-status></span></header>');
    expect(html.match(/<span[^>]*data-live-status/g)).toHaveLength(1);
  });

  it('Your call shows three cards; past four, the rest fold under N more', () => {
    const ask = (n: number) => ({ text: `ask ${n}`, source: CORE, page: '' });
    const html = (n: number) => renderDashboard({ label: 'Household', asks: Array.from({ length: n }, (_, i) => ask(i)), tiles: [], thread: [] }, ctx, chrome);
    expect(html(4)).not.toContain('<details class="more-asks"');
    expect(html(10)).toContain('<details class="more-asks"><summary>7 more</summary>');
  });

  it('one stat alone is the page\'s hero; two or more are the grid', () => {
    const one = page([{ type: 'stats', items: [{ label: 'Art wakes next', value: '9:30 AM', detail: 'in 14 minutes' }] }]);
    expect(renderPage(one as Exclude<typeof one, string>, ctx, chrome)).toContain('<dl class="stats one">');
    const two = page([{ type: 'stats', items: [{ label: 'a', value: '1' }, { label: 'b', value: '2' }] }]);
    expect(renderPage(two as Exclude<typeof two, string>, ctx, chrome)).toContain('<dl class="stats">');
  });

  it('a page with nothing on it says whose it is, under its intro', () => {
    const html = renderPage({ title: 'Tasks', intro: 'A work store.', sections: [] }, ctx, chrome);
    expect(html).toContain('<p class="intro">A work store.</p>');
    expect(html).toContain('<p class="empty-state">Tasks has nothing yet.</p>');
    expect(renderPage({ title: 'Not found', sections: [] }, ctx, chrome)).toContain('There&#39;s nothing here.');
  });

  it('a meter is a fraction, drawn as a bar with its percent', () => {
    const p = page([{ type: 'meter', items: [{ label: '5h window', value: 0.42, detail: 'resets 13:00', tone: 'warn' }, { label: '7d', value: 1 }] }]);
    expect(typeof p).not.toBe('string');
    const html = renderPage(p as Exclude<typeof p, string>, ctx, chrome);
    expect(html).toContain('5h window');
    expect(html).toContain('style="width:42%"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('meter tone-warn');
    for (const bad of [1.5, -0.1, '0.4', Number.NaN]) {
      expect(page([{ type: 'meter', items: [{ label: 'x', value: bad }] }])).toMatch(/meter.value/);
    }
  });

  it('a code block is escaped text with a Copy button', () => {
    const p = page([{ type: 'code', label: 'Sign-in link', text: 'loom token link --page-url "https://x"<script>' }]);
    const html = renderPage(p as Exclude<typeof p, string>, ctx, chrome);
    expect(html).toContain('<pre><code>loom token link --page-url &quot;https://x&quot;&lt;script&gt;</code></pre>');
    expect(html).toContain('data-copy');
    expect(html).toContain('Sign-in link');
  });

  it('status rows are a dot in a tone, a label, and optional text, meta and page', () => {
    const p = page([{ type: 'status', items: [
      { label: 'discord', tone: 'ok', text: 'connected', meta: '2 bodies', page: 'bridge/discord' },
      { label: 'slack', tone: 'bad', text: 'dark since 13:02' },
      { label: 'mail' },
    ] }]);
    const html = renderPage(p as Exclude<typeof p, string>, ctx, chrome);
    // Tone is a shape and a word as well as a color: ● ▲ ◆ ○, named for a screen reader.
    expect(html).toContain('<li class="tone-ok"><svg class="glyph" viewBox="0 0 10 10" role="img" aria-label="ok"');
    expect(html).toContain('dark since 13:02');
    expect(html).toContain('<li class="tone-muted"><svg class="glyph" viewBox="0 0 10 10" role="img" aria-label="inactive"');
    expect(page([{ type: 'status', items: [{ label: 'x', tone: 'purple' }] }])).toMatch(/tone/);
  });

  it('a page may ask to be refreshed, every 2 to 300 seconds, forms or not', () => {
    const p = page([{ type: 'form', action: 'a', submit: 'Go', fields: [{ name: 'n', label: 'N', kind: 'text' }] }], { refresh: 3 });
    expect(renderPage(p as Exclude<typeof p, string>, ctx, chrome)).toContain('<meta http-equiv="refresh" content="3">');
    expect(renderPage(p as Exclude<typeof p, string>, ctx, chrome)).toContain('data-live="3"');
    expect(page([], { refresh: 1 })).toMatch(/refresh/);
    expect(page([], { refresh: 301 })).toMatch(/refresh/);
    // Without it, a page with a form still doesn't refresh.
    const still = page([{ type: 'form', action: 'a', submit: 'Go', fields: [{ name: 'n', label: 'N', kind: 'text' }] }]);
    expect(renderPage(still as Exclude<typeof still, string>, ctx, chrome)).not.toContain('http-equiv="refresh"');
  });

  it('every page loads loom\'s own app script, and only loom\'s', () => {
    const p = page([]);
    const html = renderPage(p as Exclude<typeof p, string>, ctx, chrome);
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html.match(/<script\b/gi)?.length).toBe(1);
  });
});

describe('the manifest for Home and the Inbox (t-1618)', () => {
  const ok = (v: unknown) => { const m = parseManifest(v); if (typeof m === 'string') throw new Error(m); return m; };

  it('an ask says what it is, whether it needs the owner, and when it stops mattering', () => {
    const m = ok({ v: 2, asks: [
      { text: 'Push the fix to onterris/pond', kind: 'permission', agent: 'art', at: '2026-10-27T18:00:00Z', expires: '2026-10-27T19:00:00Z' },
      { text: 'Proposed memory', kind: 'decision', attention: false },
      { text: 'Tonight or tomorrow?', kind: 'reply' },
      { text: 'An old-style ask' },
    ] });
    expect(m.asks.map((a) => [a.kind, a.attention, a.expires])).toEqual([
      ['permission', undefined, '2026-10-27T19:00:00Z'], ['decision', false, undefined], ['reply', undefined, undefined], [undefined, undefined, undefined]]);
    expect(typeof parseManifest({ v: 2, asks: [{ text: 'x', kind: 'fyi' }] })).toBe('string');
    expect(typeof parseManifest({ v: 2, asks: [{ text: 'x', expires: 'soon' }] })).toBe('string');
  });

  it('notices and answered items are the Inbox\'s FYI and history; each needs its time', () => {
    const m = ok({ v: 2,
      notices: [{ text: 'one joined loom', at: '2026-10-27T18:22:44Z', agent: 'art' }],
      answered: [{ text: 'A box asks to join: evil', outcome: 'Blocked.', at: '2026-10-26T18:00:00Z', kind: 'permission' }] });
    expect(m.notices?.[0].text).toBe('one joined loom');
    expect(m.answered?.[0]).toMatchObject({ outcome: 'Blocked.', kind: 'permission' });
    expect(parseManifest({ v: 2, notices: [{ text: 'no time' }] })).toBe('notice.at is required');
    expect(typeof parseManifest({ v: 2, notices: Array.from({ length: 21 }, () => ({ text: 'x', at: '2026-10-27T18:00:00Z' })) })).toBe('string');
  });

  it('a piece reports each agent\'s state and up to four readings for its card', () => {
    const m = ok({ v: 2, agents: {
      art: { state: 'working', reason: 'house h-52 on one', readings: [{ label: 'Bridges', value: 'Discord ✓ Slack ✓', tone: 'ok' }] },
      mark: { readings: [{ label: 'Fuel', value: '81% of the week', detail: 'resets Thu' }] },
    } });
    expect(m.agents?.art).toMatchObject({ state: 'working', readings: [{ label: 'Bridges' }] });
    expect(m.agents?.mark.state).toBeUndefined();
    expect(typeof parseManifest({ v: 2, agents: { art: { state: 'asleep' } } })).toBe('string');
    expect(typeof parseManifest({ v: 2, agents: { Art: { readings: [] } } })).toBe('string');
    expect(typeof parseManifest({ v: 2, agents: { art: { readings: Array.from({ length: 5 }, () => ({ label: 'x', value: 'y' })) } } })).toBe('string');
  });

  it('a tab or a section says whether it is the household\'s or an agent\'s', () => {
    expect(ok({ v: 2, tab: { label: 'Clock', level: 'agent' } }).tab).toEqual({ label: 'Clock', level: 'agent' });
    expect(typeof parseManifest({ v: 2, tab: { label: 'Clock', level: 'everyone' } })).toBe('string');
    const p = parsePage({ title: 'Clock', sections: [{ id: 'wakes', level: 'agent', blocks: [] }] });
    expect(typeof p === 'string' ? p : p.sections[0].level).toBe('agent');
  });
});
