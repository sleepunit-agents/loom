// @vitest-environment node
/**
 * A block cut short to fit loom's limits (src/ui/vocab.ts long(), t-1861) is drawn, then says it isn't whole; a whole
 * one is drawn as ever, with nothing beside it.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { BlockView } from '../../web/src/blocks';
import { parsePage, type Page } from './vocab.js';

const first = (text: string) => (parsePage({ title: 'T', sections: [{ id: 's', blocks: [{ type: 'text', text }] }] }) as Page).sections[0].blocks[0];

describe('a block cut short', () => {
  it('draws what fits, then "Cut short"', () => {
    const html = renderToStaticMarkup(h(BlockView, { b: first('w'.repeat(2500)) as never }));
    expect(html).toContain('data-cut');
    expect(html).toContain(`${'w'.repeat(1999)}…`);
    expect(html).toMatch(/Cut short: too long to show whole here\./);
  });
  it('a whole one says nothing more', () => {
    const html = renderToStaticMarkup(h(BlockView, { b: first('all of it') as never }));
    expect(html).toBe('<p class="">all of it</p>');
  });
});
