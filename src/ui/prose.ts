/**
 * A small markdown subset as HTML, for the `prose` block: what knowledge
 * pages and memories are written in. Everything is escaped first, so no
 * HTML in the source ever reaches the page; the only tags out are the ones
 * made here. Links go out only for http(s).
 *
 *   # / ## / ###        headings (drawn as h3, h4, h5: the page owns h1 and h2)
 *   - x / * x / 1. x    lists
 *   > x                 a quote
 *   ``` … ```           code
 *   **b**  *i* _i_  `c`  [text](https://…)
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** One line's inline marks, on text not yet escaped. */
export function inline(src: string): string {
  // Code spans first, held aside so nothing inside them is read as a mark.
  const held: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${held.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  // Links, held too: [text](https://…). The text still takes marks; the URL is escaped once.
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) =>
    `\u0000${held.push(`<a href="${esc(u)}" rel="noopener noreferrer" target="_blank">${marks(esc(t))}</a>`) - 1}\u0000`);
  s = marks(esc(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]);
}

function marks(s: string): string {
  return s
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');
}

export function prose(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const isList = (l: string) => /^\s*(?:[-*]|\d+[.)])\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre class="prose-code"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { const n = h[1].length + 2; out.push(`<h${n}>${inline(h[2].trim())}</h${n}>`); i++; continue; }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      for (; i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
        if (isList(lines[i])) items.push(lines[i].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !isList(lines[i]) && !/^\s*(```|>|#{1,3}\s)/.test(lines[i]); i++) para.push(lines[i]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}
