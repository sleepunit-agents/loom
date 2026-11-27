import { TicketReference, ViewPreview } from './entity-preview';
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
    <div className="pair-prose space-y-3 whitespace-normal [&_a]:underline [&_ol]:list-decimal [&_ul]:list-disc">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, ticketReferences]}
        disallowedElements={['img']}
        urlTransform={(url) => (/^(https?:\/\/|\?ticket=t-\d+$)/i.test(url) ? url : '')}
        components={{
          a: ({ href, children }) => {
            const id = href?.match(/^\?ticket=(t-\d+)$/i)?.[1];
            const pull = href?.match(/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)\/?(?:[?#].*)?$/i);
            if (pull)
              return (
                <ViewPreview view={{ kind: 'pull', ref: pull[1] }} intent="Open this pull request on GitHub.">
                  <a href={href}>{children}</a>
                </ViewPreview>
              );
            return id ? (
              <TicketReference id={id.toLowerCase()}>{children}</TicketReference>
            ) : (
              <a href={href}>{children}</a>
            );
          },
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
