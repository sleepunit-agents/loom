import MarkdownIt from 'markdown-it';
import { useMemo } from 'react';

const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
md.disable('image');
md.validateLink = (href) => /^https?:\/\//i.test(href);
// Convert plain ticket references after markdown parsing, so code, fenced output,
// existing links and literal HTML retain their original meaning.
md.core.ruler.after('inline', 'pair-tickets', (state) => {
  for (const block of state.tokens) {
    if (!block.children) continue;
    let linked = false;
    block.children = block.children.flatMap((token) => {
      if (token.type === 'link_open') linked = true;
      if (token.type === 'link_close') linked = false;
      if (linked || token.type !== 'text') return [token];
      return token.content.split(/(\bt-\d+\b)/gi).flatMap((part) => {
        const word = new state.Token('text', '', 0);
        word.content = part;
        if (!/^t-\d+$/i.test(part)) return [word];
        const open = new state.Token('link_open', 'a', 1);
        open.attrSet('href', '?ticket=' + part.toLowerCase());
        return [open, word, new state.Token('link_close', 'a', -1)];
      });
    });
  }
});
export function Reply({ words }: { words: string }) {
  const html = useMemo(() => md.render(words), [words]);
  return (
    <div
      className="space-y-2 whitespace-normal [&_a]:underline [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_ol]:list-decimal [&_ul]:list-disc [&_li]:ml-4"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
