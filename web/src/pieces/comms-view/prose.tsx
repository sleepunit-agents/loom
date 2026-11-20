/** An agent's reply as markdown, in its own chunk so the parser loads with the first reply and not with the app.
 * loom's renderer (src/ui/prose.ts) draws no raw HTML and no images, and links only to http(s), opened outside the
 * page; a reply is words from a model, so nothing less would do. References the server found in the reply are then
 * drawn as chips. A chip's id is a plain id (refs.tsx), so writing it into the markup can add nothing but itself. */
import { useMemo } from 'react';
import { prose } from '../../../../src/ui/prose';
import { refPattern } from './refs';

/** Chips into rendered markup: in its text only, never inside a tag, a link or code. */
export function chipped(html: string, refs: readonly string[], opens: (ref: string) => boolean): string {
  const pattern = refPattern(refs);
  if (!pattern) return html;
  let inside = 0;
  return html.split(/(<[^>]*>)/).map((part, n) => {
    if (n % 2) { const tag = /^<(\/?)(a|code|pre)\b/i.exec(part); if (tag) inside = Math.max(0, inside + (tag[1] ? -1 : 1)); return part; }
    return inside ? part : part.replace(pattern, ref => opens(ref)
      ? `<button type="button" class="loom-kit-chip" data-ref="${ref}" aria-label="Open ${ref}">${ref}</button>` : `<span class="loom-kit-chip">${ref}</span>`);
  }).join('');
}
export default function Prose({ text, refs, openRef }: { text: string; refs: readonly string[]; openRef?(ref: string): (() => void) | undefined }) {
  const html = useMemo(() => chipped(prose(text), refs, ref => !!openRef?.(ref)), [text, refs.join(' '), !!openRef]);
  return <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
    const chip = (event.target as HTMLElement).closest?.('[data-ref]');
    if (chip) openRef?.(chip.getAttribute('data-ref') ?? '')?.();
  }} />;
}
