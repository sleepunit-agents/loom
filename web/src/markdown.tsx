// A prose block's markdown, drawn (Jonathan, 2026-10-29: Knowledge and Machine "markdown but it's not parsed"): loom's
// own renderer (src/ui/prose.ts: raw HTML off, links only to http(s), no images), in its own chunk, loaded when a page
// has prose. [[a-slug]] links to that knowledge page, inside the app.
import { useMemo } from 'react';
import { prose } from '../../src/ui/prose';
import { useEnv } from './blocks';

const INSIDE = 'https://loom.invalid/knowledge/';

export default function Markdown({ text }: { text: string }) {
  const { go } = useEnv();
  const html = useMemo(() => prose(text.replace(/\[\[([a-z0-9][\w/-]*)(?:\|([^\]]+))?\]\]/gi, (_, slug: string, label?: string) => `[${label ?? slug}](${INSIDE}${slug})`))
    .replaceAll(`href="${INSIDE}`, 'data-inside="" href="/knowledge/'), [text]);
  return (
    <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a[data-inside]');
        if (!a || e.metaKey || e.ctrlKey) return;
        e.preventDefault(); go(a.getAttribute('href')!);
      }} />
  );
}
