import { useState } from 'react';
import { BotIcon, TerminalIcon, WrenchIcon } from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './ui/trace';
import { CodeBlock, CodeBlockContent } from './ui/code-block';
import type { WorkNode } from './work-tree';

// Compositions from shadcn/ui's Terminal, Tool, and Subagent examples.
export function WorkTrace({ node, latestTerminal }: { node: WorkNode; latestTerminal?: number }) {
  const [chosen, choose] = useState<boolean | null>(null);
  const first = node.events[0],
    last = node.events[node.events.length - 1];
  const label = (last.tool || 'Work step').split(' → ').at(-1)!;
  const terminal = label === 'Terminal',
    agent = label.startsWith('Subagent');
  const Icon = terminal ? TerminalIcon : agent ? BotIcon : WrenchIcon;
  const command = terminal && first.cardState === 'running' ? first.words : undefined;
  const facts = node.events.flatMap((e) => [
    e.stepInfo?.exit != null ? 'Exit ' + e.stepInfo.exit : null,
    e.stepInfo?.parent ? 'Parent · ' + e.stepInfo.parent : null,
  ]);
  const output = node.events
    .flatMap((e) => [
      e.words !== label && !(e === first && command && node.events.length > 1) ? e.words : null,
      e.stepDetails?.detail,
      e.stepDetails?.body,
      e.stepDetails?.result,
      ...(e.stepDetails?.items || []).map((item) => item.text + ' · ' + item.state),
    ])
    .filter((v): v is string => !!v)
    .join('\n');
  return (
    <Trace>
      <TraceCollapsible
        open={chosen ?? (terminal && node.events.some((e) => e.seq === latestTerminal))}
        onOpenChange={choose}
      >
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <Icon />
            </TraceIcon>
            <TraceTitle>{command || label}</TraceTitle>
            <TraceDescription>{last.cardState || 'Recorded'}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className={agent ? 'flex flex-col gap-3' : undefined}>
          {node.children.map((child) => (
            <WorkTrace key={child.events[0].seq} node={child} latestTerminal={latestTerminal} />
          ))}
          {output &&
            (agent ? (
              <p>{output}</p>
            ) : (
              <CodeBlock size="sm" variant={last.cardState === 'failed' ? 'destructive' : 'default'}>
                <CodeBlockContent wrap className="max-h-64">
                  {output}
                </CodeBlockContent>
              </CodeBlock>
            ))}
          {facts.map((f, i) => f && <p key={i}>{f}</p>)}
          {!output && !node.children.length && !facts.some(Boolean) && (
            <p>
              {label} · {last.cardState || 'Recorded'}
            </p>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
