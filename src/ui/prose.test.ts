import { describe, it, expect } from 'vitest';
import { prose, inline } from './prose.js';
import { parsePage } from './vocab.js';

describe('prose: a markdown subset, escaped first', () => {
  it('never lets HTML through, in text, marks, code or links', () => {
    const out = prose('<script>alert(1)</script> **<img src=x onerror=y>** `<b>` [<i>x</i>](https://e.com/"onmouseover=z)');
    expect(out).not.toMatch(/<(script|img|b|i)[\s>]/);
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<strong>&lt;img src=x onerror=y&gt;</strong>');
    expect(out).toContain('<code>&lt;b&gt;</code>');
    expect(out).not.toContain('"onmouseover');
  });

  it('links only http(s)', () => {
    expect(prose('[ok](https://example.com/a?b=1&c=2)')).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">ok</a>');
    for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](/local)']) expect(prose(bad)).not.toContain('<a ');
  });

  it('marks: bold, italic, code — and code keeps its stars', () => {
    expect(inline('a **b** *c* _d_ `**e**`')).toBe('a <strong>b</strong> <em>c</em> <em>d</em> <code>**e**</code>');
    expect(inline('2 * 3 * 4 and snake_case_name')).toBe('2 * 3 * 4 and snake_case_name');
  });

  it('blocks: headings (under the page\'s own), lists, quotes, code, paragraphs', () => {
    const out = prose('# Top\n\nOne line\nnext line\n\n- a\n- **b**\n  continued\n\n1. x\n2. y\n\n> said\n\n```\n<raw> & *kept*\n```');
    expect(out).toBe('<h3>Top</h3><p>One line<br>next line</p><ul><li>a</li><li><strong>b</strong> continued</li></ul>'
      + '<ol><li>x</li><li>y</li></ol><blockquote>said</blockquote><pre class="prose-code"><code>&lt;raw&gt; &amp; *kept*</code></pre>');
  });

  it('a piece can send one, up to 20,000 characters', () => {
    const page = (text: string) => parsePage({ title: 'T', sections: [{ id: 's', blocks: [{ type: 'prose', text }] }] });
    expect(page('**hi**')).toMatchObject({ sections: [{ blocks: [{ type: 'prose', text: '**hi**' }] }] });
    expect(page('x'.repeat(20001))).toMatch(/longer than 20000/);
  });
});
