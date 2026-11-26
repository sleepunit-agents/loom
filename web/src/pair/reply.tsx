import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { visit, SKIP } from 'unist-util-visit';
import type { Root, PhrasingContent } from 'mdast';
import { SourceBlock } from './highlight';

function ticketReferences() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (node.type === 'link' || node.type === 'linkReference') return SKIP;
      if (node.type !== 'text' || index == null || !parent) return;
      const parts = node.value.split(/(\bt-\d+\b)/gi);
      if (parts.length === 1) return;
      const children: PhrasingContent[] = parts.map((value, i) =>
        i % 2
          ? { type: 'link', url: '?ticket=' + value.toLowerCase(), children: [{ type: 'text', value }] }
          : { type: 'text', value },
      );
      parent.children.splice(index, 1, ...children);
      return index + children.length;
    });
  };
}

export function Reply({ words }: { words: string }) {
  return (
    <div className="space-y-2 whitespace-normal [&_a]:underline [&_ol]:list-decimal [&_ul]:list-disc [&_li]:ml-4">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, ticketReferences]}
        disallowedElements={['img']}
        urlTransform={(url) => (/^(https?:\/\/|\?ticket=t-\d+$)/i.test(url) ? url : '')}
        components={{
          pre: ({ node, children }) => {
            const code = node?.children[0];
            if (code?.type !== 'element' || code.tagName !== 'code') return <pre>{children}</pre>;
            const source = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
            const language = String(code.properties.className || '').match(/language-([^ ,]+)/)?.[1];
            return <SourceBlock source={source} language={language || 'auto'} />;
          },
        }}
      >
        {words}
      </Markdown>
    </div>
  );
}
