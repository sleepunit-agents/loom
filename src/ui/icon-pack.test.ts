// @vitest-environment node
/**
 * Icons without Lucide's 1,700 names on the first page (web/src/components/ui/icon.tsx; t-1875): an authored icon draws
 * at once; any other name waits for the lazy Lucide pack, which draws it, or, for a name nothing has, a plain circle.
 * Nothing throws. A server render made before the pack (what a page hydrates) has no strokes for a name the authored set
 * lacks, so hydration matches whatever the browser has loaded since.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { Icon, loadLucideIcons } from '../../web/src/components/ui/icon';
import { iconFor } from '../../web/src/safe';
import { getLucideIcon } from '../../web/src/lib/cojeev/lucide-icon-data';
import { iconData } from '../../web/src/lib/cojeev/icon-data';

const root = new URL('../../', import.meta.url).pathname;
const draw = (name: string) => renderToStaticMarkup(h(Icon, { name }));
/** The glyph's drawn shapes, in order: tag and geometry. */
const strokes = (svg: string) => [...svg.matchAll(/<(path|circle|line|rect|ellipse|polyline|polygon)\b([^>]*)>/g)]
  .map((m) => `${m[1]} ${[...m[2].matchAll(/\b(d|cx|cy|r|x1|x2|y1|y2|x|y|width|height|rx|ry|points)="([^"]*)"/g)].map((a) => a[2]).join(' ')}`);
const shapes = (nodes: Array<{ tag: string; attrs: Record<string, string> }>) => nodes.map((n) => `${n.tag} ${Object.entries(n.attrs).filter(([k]) => /^(d|cx|cy|r|x1|x2|y1|y2|x|y|width|height|rx|ry|points)$/.test(k)).map(([, v]) => v).join(' ')}`);

describe('icons, with the Lucide pack lazy', () => {
  it('before the pack: an authored icon draws; a Lucide name and a name nothing has keep an empty footprint, and nothing throws', () => {
    expect(strokes(draw('house'))).toEqual(shapes(iconData.house));
    for (const name of ['alarm-clock', 'no-such-icon']) {
      const svg = draw(name);
      expect(svg).toContain(`data-icon-name="${name}"`);
      expect(strokes(svg), name).toEqual([]);
    }
  });
  it('once the pack is here: a Lucide name draws its own strokes, and a name nothing has draws the plain circle', async () => {
    await loadLucideIcons();
    expect(iconData['alarm-clock']).toBeUndefined();
    expect(strokes(draw('alarm-clock'))).toEqual(shapes(getLucideIcon('alarm-clock')!));
    expect(strokes(draw('no-such-icon'))).toEqual(shapes(iconData.circle));
    expect(strokes(draw('house'))).toEqual(shapes(iconData.house));
  });
  it('iconFor passes any name through, and only no name at all is the circle', () => {
    expect([iconFor('alarm-clock'), iconFor('no-such-icon'), iconFor(undefined), iconFor('')]).toEqual(['alarm-clock', 'no-such-icon', 'circle', 'circle']);
  });
  it.runIf(existsSync(`${root}dist/web/index.html`))('the first page carries no Lucide name list (only the lazy pack has the names)', () => {
    const index = readFileSync(`${root}dist/web/index.html`, 'utf-8');
    const first = [...index.matchAll(/(?:src|href)="\/app\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    expect(first.length).toBeGreaterThan(1);
    // A name only Lucide has (no authored icon or alias): in the build only the lazy pack may spell it.
    const hits = first.filter((f) => readFileSync(`${root}dist/web/${f}`, 'utf-8').includes('a-large-small'));
    expect(hits).toEqual([]);
  });
});
