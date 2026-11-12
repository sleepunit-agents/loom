// @vitest-environment node
/**
 * loom's one loader (t-1925 B; web/src/components/ui/spinner.tsx): every spinner is it. Drawn here from the component
 * itself, so a Spinner that dropped its size or its segments fails; and read from the built app, so no chunk (Comms,
 * the Inbox, Find, Account: lazy ones too) still carries the old drawings (the orbit, the bloom).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { Spinner } from '../../web/src/components/ui/spinner';

const root = new URL('../../', import.meta.url).pathname;

describe('the loader', () => {
  it('draws its size (md unless asked), four segments, and says it\'s working', () => {
    for (const [size, want] of [[undefined, 'md'], ['sm', 'sm'], ['md', 'md'], ['lg', 'lg']] as const) {
      const html = renderToStaticMarkup(h(Spinner, size ? { size } : {}));
      expect(html, String(size)).toContain(`data-size="${want}"`);
      expect(html).toContain('class="loom-load"');
      expect(html).toMatch(/role="status"/);
      expect(html).toMatch(/aria-label="Working"/);
      expect(html.match(/<i aria-hidden="true"><\/i>/g)?.length).toBe(4);
    }
    expect(renderToStaticMarkup(h(Spinner, { label: 'Checking' }))).toMatch(/aria-label="Checking"/);
  });
  it('its sizes are px in its own stylesheet, never from the text around it', () => {
    const css = readFileSync(`${root}web/src/styles/cojeev/spinner.css`, 'utf-8');
    expect(css).toMatch(/\[data-size="sm"\]\s*\{\s*--s:\s*16px/);
    expect(css).toMatch(/--s:\s*24px/);
    expect(css).toMatch(/\[data-size="lg"\]\s*\{\s*--s:\s*40px/);
    expect(css).not.toMatch(/\d(em|rem)\b/);
  });
  it.runIf(existsSync(`${root}dist/web/index.html`))('no built asset carries the old spinner', () => {
    const dir = `${root}dist/web/assets`;
    const old = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f)).filter((f) => /v-pulse__(orbit|hub|mark|label)/.test(readFileSync(`${dir}/${f}`, 'utf-8')));
    expect(old).toEqual([]);
  });
});
