import { describe, it, expect } from 'vitest';
import { prose } from './prose.js';
import { parsePage } from './vocab.js';

describe('prose: markdown, with raw HTML off', () => {
  it('never lets HTML through, in text, marks, code or links', () => {
    const out = prose('<SCRIPT>alert(1)</SCRIPT> **<img src=x onerror=y>** `<b>` [x](https://e.com/"onmouseover=z)\n\n<div onclick=z>hi</div>');
    expect(out).not.toMatch(/<\s*(script|img|b|div)[\s>]/i);
    expect(out).toContain('&lt;SCRIPT&gt;');
    expect(out).toContain('<code>&lt;b&gt;</code>');
    expect(out).not.toMatch(/href="[^"]*"onmouseover/);
  });

  it('links only http(s), opening outside the page; no images', () => {
    expect(prose('[ok](https://example.com/a?b=1&c=2)')).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">ok</a>');
    for (const bad of ['[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](data:text/html,hi)', '[x](/local)', '[x](vbscript:y)']) {
      expect(prose(bad)).not.toContain('<a ');
    }
    expect(prose('![pic](https://example.com/p.png)')).not.toContain('<img');
  });

  it('headings sit under the page\'s own; marks, lists, quotes and code as markdown has them', () => {
    expect(prose('# Top\n## Sub')).toBe('<h3>Top</h3>\n<h4>Sub</h4>\n');
    expect(prose('a **b** *c* `**d**` snake_case_name 2 * 3 * 4')).toBe('<p>a <strong>b</strong> <em>c</em> <code>**d**</code> snake_case_name 2 * 3 * 4</p>\n');
    expect(prose('- a\n- b\n\n1. x\n\n> said')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n<ol>\n<li>x</li>\n</ol>\n<blockquote>\n<p>said</p>\n</blockquote>\n');
    expect(prose('```\n<raw> & *kept*\n```')).toBe('<pre><code>&lt;raw&gt; &amp; *kept*\n</code></pre>\n');
    expect(prose('one\ntwo')).toBe('<p>one<br>\ntwo</p>\n');
  });

  it('a piece can send one, up to 20,000 characters', () => {
    const page = (text: string) => parsePage({ title: 'T', sections: [{ id: 's', blocks: [{ type: 'prose', text }] }] });
    expect(page('**hi**')).toMatchObject({ sections: [{ blocks: [{ type: 'prose', text: '**hi**' }] }] });
    expect(page('x'.repeat(20001))).toMatch(/longer than 20000/);
  });
});
