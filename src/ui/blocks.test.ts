/**
 * The blocks added for the page's next look: meter, code (with a Copy
 * button), status, and a page's own refresh. Validated like every block; the
 * app draws them from the data.
 */
import { describe, it, expect } from 'vitest';
import { parseManifest, parsePage, splitPage } from './vocab.js';
import { pageHref } from './render.js';
import type { Block, Page } from './vocab.js';
import { whereLabel } from './data.js';
import { identityFacts } from './household-pages.js';

const ok = (p: Page | string): Page => { if (typeof p === 'string') throw new Error(p); return p; };
const page = (blocks: unknown[], extra: Record<string, unknown> = {}) => parsePage({ title: 'T', sections: [{ id: 's', blocks }], ...extra });

describe('meter, code and status blocks', () => {
  it('a long list of plain choices keeps every option and its chosen value', () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `p${i}`, label: `Person ${i}` }));
    const long = ok(page([{ type: 'form', action: 'pick', submit: 'Save', fields: [{ name: 'who', label: 'Who', kind: 'choice', value: 'p3', options: opts(12) }] }]));
    const form = long.sections[0].blocks[0] as Extract<Block, { type: 'form' }>;
    expect(form.fields[0]).toMatchObject({ name: 'who', kind: 'choice', value: 'p3' });
    expect(form.fields[0].options).toHaveLength(12);
  });

  it('a list row may carry one action, that asks first when it is danger', () => {
    const p = ok(page([{ type: 'list', items: [{ text: 'laptop', meta: 'used 3 days ago', act: { action: 'revoke', label: 'Revoke', tone: 'danger', confirm: 'Signed out at once.', fields: { label: 'laptop' } } }] }]));
    const list = p.sections[0].blocks[0] as Extract<Block, { type: 'list' }>;
    expect(list.items[0].act).toEqual({ action: 'revoke', label: 'Revoke', tone: 'danger', confirm: 'Signed out at once.', fields: { label: 'laptop' } });
    expect(typeof page([{ type: 'list', items: [{ text: 'x', act: { action: 'bad action!', label: 'x' } }] }])).toBe('string');
  });

  it('an identity gives its bio and voice', () => {
    expect(identityFacts('# Gabe\n\nGabe keeps the books.\n\n## Voice\n\nDry, curious.\n\nMore.\n')).toEqual({ bio: 'Gabe keeps the books.', voice: 'Dry, curious.' });
    expect(identityFacts('# Art\n\nYou are Art.\n\n## Communication\n\nBe direct.\n')).toEqual({ bio: 'You are Art.', voice: 'Be direct.' });
  });

  it('an ask may carry up to three actions', () => {
    const m = parseManifest({ v: 2, asks: [{ text: 'Renew the login', page: '', actions: [{ action: 'renew', label: 'Renew', tone: 'primary' }, { action: 'later', label: 'Later' }] }] });
    expect(typeof m === 'string' ? m : m.asks[0].actions?.map((b) => b.label)).toEqual(['Renew', 'Later']);
    expect(typeof parseManifest({ v: 2, asks: [{ text: 'x', actions: [1, 2, 3, 4].map((n) => ({ action: `a${n}`, label: 'x' })) }] })).toBe('string');
  });

  it('a where reads the way a person says it', () => {
    expect(whereLabel('slack:dm:patrick-kells')).toBe('Slack DM · Patrick Kells');
    expect(whereLabel('discord:#pond')).toBe('Discord #pond');
    expect(whereLabel('wake:w-1a2b3c')).toBe('Wake');
    expect(whereLabel('letters')).toBe('Letters');
    expect(whereLabel('?')).toBe('');
  });

  it('a meter is a fraction from 0 to 1, with its tone and detail', () => {
    const p = ok(page([{ type: 'meter', items: [{ label: '5h window', value: 0.42, detail: 'resets 13:00', tone: 'warn' }, { label: '7d', value: 1 }] }]));
    const meter = p.sections[0].blocks[0] as Extract<Block, { type: 'meter' }>;
    expect(meter.items[0]).toMatchObject({ label: '5h window', value: 0.42, detail: 'resets 13:00', tone: 'warn' });
    expect(meter.items[1]).toMatchObject({ label: '7d', value: 1 });
    for (const bad of [1.5, -0.1, '0.4', Number.NaN]) {
      expect(page([{ type: 'meter', items: [{ label: 'x', value: bad }] }])).toMatch(/meter.value/);
    }
  });

  it('a code block keeps its text verbatim, as data, and its label', () => {
    const text = 'loom token link --page-url "https://x"<script>';
    const p = ok(page([{ type: 'code', label: 'Sign-in link', text }]));
    expect(p.sections[0].blocks[0]).toMatchObject({ type: 'code', label: 'Sign-in link', text });
  });

  it('status rows are a tone, a label, and optional text, meta and page', () => {
    const p = ok(page([{ type: 'status', items: [
      { label: 'discord', tone: 'ok', text: 'connected', meta: '2 bodies', page: 'bridge/discord' },
      { label: 'slack', tone: 'bad', text: 'dark since 13:02' },
      { label: 'mail' },
    ] }]));
    const status = p.sections[0].blocks[0] as Extract<Block, { type: 'status' }>;
    expect(status.items[0]).toMatchObject({ label: 'discord', tone: 'ok', text: 'connected', meta: '2 bodies', page: 'bridge/discord' });
    expect(status.items[1]).toMatchObject({ label: 'slack', tone: 'bad', text: 'dark since 13:02' });
    expect(status.items[2].label).toBe('mail');
    expect(status.items[2].tone).toBeUndefined();
    expect(page([{ type: 'status', items: [{ label: 'x', tone: 'purple' }] }])).toMatch(/tone/);
  });

  it('a page may ask to be refreshed, every 2 to 300 seconds, forms or not', () => {
    const p = ok(page([{ type: 'form', action: 'a', submit: 'Go', fields: [{ name: 'n', label: 'N', kind: 'text' }] }], { refresh: 3 }));
    expect(p.refresh).toBe(3);
    expect(page([], { refresh: 1 })).toMatch(/refresh/);
    expect(page([], { refresh: 301 })).toMatch(/refresh/);
    // Without it, a page with a form still doesn't refresh.
    const still = ok(page([{ type: 'form', action: 'a', submit: 'Go', fields: [{ name: 'n', label: 'N', kind: 'text' }] }]));
    expect(still.refresh).toBeUndefined();
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
    expect(ok({ v: 2, tab: { label: 'Clock' }, agentTab: { label: 'Clock' } }).agentTab).toEqual({ label: 'Clock' });
    expect(typeof parseManifest({ v: 2, agentTab: { label: {} } })).toBe('string');
    // A piece links to its own pages on an agent's tab, or the household's: never another piece's.
    expect(splitPage('agent:art')).toMatchObject({ core: false, path: '', agent: 'art' });
    expect(splitPage('agent:art/schedule/art/x?y=1')).toMatchObject({ path: 'schedule/art/x', agent: 'art', query: { y: '1' } });
    expect(splitPage('household:lane/x')).toMatchObject({ path: 'lane/x', household: true });
    expect(splitPage('agent:art/loom:pieces')).toBeNull();
    expect(splitPage('agent:Bad')).toBeNull();
    expect(pageHref('agent:mark/next', { id: 'wake', base: '/p/wake/' })).toBe('/a/mark/p/wake/next');
    expect(pageHref('household:lane/x', { id: 'wake', base: '/a/art/p/wake/' })).toBe('/p/wake/lane/x');
    expect(pageHref('agent:mark', { id: 'loom', base: '/' })).toBe('#');
    expect(typeof parseManifest({ v: 2, tab: { label: 'Clock', level: 'everyone' } })).toBe('string');
    const p = parsePage({ title: 'Clock', sections: [{ id: 'wakes', level: 'agent', blocks: [] }] });
    expect(typeof p === 'string' ? p : p.sections[0].level).toBe('agent');
  });
});
