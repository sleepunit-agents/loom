/** Safe prose, loaded only by readers that need the markdown parser. */
import { useMemo } from 'react';
import { prose } from '../../../src/ui/prose';
export default function Markdown({ text, onLink }: { text: string; onLink?(href: string): boolean }) {
  const html = useMemo(() => prose(text), [text]);
  return <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest('a');
    if (link && onLink?.(link.getAttribute('href') ?? '')) event.preventDefault();
  }} />;
}
