import { lazy, Suspense, useMemo } from 'react';
import type { HLJSApi } from 'highlight.js';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from './ui/code-block';

type TokenProps = { source: string; language: string };
function tokens(engine: HLJSApi, { source, language }: TokenProps) {
  if (language === 'auto') {
    const match = engine.highlightAuto(source, [
      'bash',
      'javascript',
      'typescript',
      'python',
      'sql',
      'xml',
      'css',
      'rust',
      'java',
      'cpp',
    ]);
    return match.relevance >= 5 ? match.value : null;
  }
  return engine.getLanguage(language)
    ? engine.highlight(source, { language, ignoreIllegals: true }).value
    : null;
}

function tokenRenderer(engine: HLJSApi) {
  return function Tokens(props: TokenProps) {
    const { source, language } = props;
    const html = useMemo(() => tokens(engine, { source, language }), [source, language]);
    // highlight.js escapes the source before adding its token spans.
    return html === null ? <>{source}</> : <span dangerouslySetInnerHTML={{ __html: html }} />;
  };
}

const plain = { default: ({ source }: TokenProps) => <>{source}</> };
const OtherGrammar = lazy(() =>
  import('highlight.js')
    .then(({ default: engine }) => ({ default: tokenRenderer(engine) }))
    .catch(() => plain),
);
const ColoredTokens = lazy(() =>
  Promise.all([import('highlight.js/lib/common'), import('highlight.js/styles/github.css')])
    .then(([{ default: common }]) => {
      const CommonTokens = tokenRenderer(common);
      return {
        default: (props: TokenProps) =>
          props.language === 'auto' || common.getLanguage(props.language) ? (
            <CommonTokens {...props} />
          ) : (
            <OtherGrammar {...props} />
          ),
      };
    })
    .catch(() => plain),
);

function outputLanguage(source: string) {
  const trimmed = source.trimStart();
  if (/^(diff --git |--- [^\n]+\n\+\+\+ )/.test(trimmed)) return 'diff';
  if (/^#!.*\b(?:ba|z|da)?sh\b/.test(trimmed)) return 'bash';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(source);
      return 'json';
    } catch {
      /* Unstructured output. */
    }
  }
}

export function Highlight({ source, language }: { source: string; language?: string }) {
  if (source.length > 100_000) return <>{source}</>;
  const grammar = language?.toLowerCase() || outputLanguage(source);
  if (!grammar) return <>{source}</>;
  return (
    <Suspense fallback={source}>
      <ColoredTokens source={source} language={grammar} />
    </Suspense>
  );
}

export function SourceBlock({
  source,
  language,
  failed,
}: {
  source: string;
  language?: string;
  failed?: boolean;
}) {
  return (
    <CodeBlock size="sm" variant={failed ? 'destructive' : 'default'}>
      <CodeBlockActions>
        <CodeBlockCopyButton value={source} />
      </CodeBlockActions>
      <CodeBlockContent wrap className="max-h-64">
        <Highlight source={source} language={language} />
      </CodeBlockContent>
    </CodeBlock>
  );
}
