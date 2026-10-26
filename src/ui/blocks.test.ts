/**
 * The blocks added for the page's next look: meter, code (with a Copy
 * button), status, and a page's own refresh. Validated like every block, and
 * rendered as data: every string escaped.
 */
import { describe, it, expect } from 'vitest';
import { parsePage } from './vocab.js';
import { renderPage, CORE, type Chrome } from './render.js';

const chrome: Chrome = { agent: 'Test', nav: [], clock: 'now', csrf: 'c'.repeat(64), skipped: [] };
const ctx = { source: CORE, path: '', query: {}, csrf: 'c'.repeat(64) };
const page = (blocks: unknown[], extra: Record<string, unknown> = {}) => parsePage({ title: 'T', sections: [{ id: 's', blocks }], ...extra });

describe('meter, code and status blocks', () => {
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
