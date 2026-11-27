/** The conversation's transcript, shared by the ticket screen and the boards page: the live tail of a
 * thread, its work trace, and the pages before it. */
import { useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { PaperclipIcon } from 'lucide-react';
import { useDataQuery } from '../data/graphql';
import { useDeadline } from '../pieces/comms/use-deadline';
import type { CommsMessage, CommsThread } from '../pieces/comms-view/model';
import { TicketReference } from './entity-preview';
import { Button } from './ui/button';
import { Attachment, AttachmentContent, AttachmentGroup, AttachmentTitle, AttachmentMedia } from './ui/attachment';
import { MessageScrollerItem } from './ui/message-scroller';
import { Message, MessageContent, MessageHeader } from './ui/message';
import { Bubble, BubbleContent } from './ui/bubble';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from './ui/trace';
import { WorkTrace } from './work-trace';
import { workTree, type EventMessage } from './work-tree';
import { Reply } from './reply';
import { conversationText } from './conversation-text';

const fields =
  'hasFiles clientId run seq kind sender at words wordsKeepUntil inboxItem tool cardState delivery verdict notice{error} stepInfo{parent exit limit t0 t1} stepDetails{detail body result items{text state}}';
export const historyQuery =
  'query PairLog($id:String!,$before:Int){thread:commsThread(id:$id){id member agent project conversation working readSeq} rows:commsMessages(thread:$id,beforeSeq:$before,limit:50){' +
  fields +
  '}}';

function TicketLinks({ words }: { words: string }) {
  if (/^ {0,3}(`{3,}|~{3,})/m.test(words)) return <Reply words={words} />;
  return (
    <>
      {words.split(/(\bt-\d+\b)/gi).map((v, i) =>
        /^t-\d+$/i.test(v) ? (
          <TicketReference className="underline" key={i} id={v.toLowerCase()}>
            {v}
          </TicketReference>
        ) : (
          v
        ),
      )}
    </>
  );
}

function RunDetails({ id }: { id: string }) {
  const read = useDataQuery<{
    jobUsage: {
      state: string;
      usage: { harness: string; model: string; tools: { name: string; count: number }[] | null } | null;
    } | null;
  }>('query PairRun($id:String!){jobUsage(id:$id){state usage{harness model tools{name count}}}}', { id });
  const run = read.data?.jobUsage;
  if (read.status !== 'live' || !run?.usage) return null;
  return (
    <Trace className="pair-run-details">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>Run details</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p>
            {run.usage.harness} · {run.usage.model} · {run.state}
          </p>
          {run.usage.tools?.map((t) => (
            <p key={t.name}>
              {t.name} × {t.count}
            </p>
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
function Entry({ m }: { m: EventMessage }) {
  const mine = m.kind === 'message' || m.kind === 'answer';
  let words = m.words;
  let attachments: string[] = [];
  const marker = m.hasFiles && m.kind === 'message' && words?.match(/(?:^|\n)Attached files: (\[[^\n]*\])$/);
  if (marker && words) {
    try {
      const names: unknown = JSON.parse(marker[1]);
      if (Array.isArray(names) && names.length && names.every(name => typeof name === 'string')) {
        attachments = names;
        words = words.slice(0,marker.index);
      }
    } catch { /* Keep ordinary prose containing the same label. */ }
  }
  if (words) words = conversationText(m.kind, words);
  return (
    <Message align={mine ? 'end' : 'start'}>
      <MessageContent>
        <MessageHeader>
          {mine ? 'You' : m.sender === 'art' ? 'Art' : m.sender} ·{' '}
          {new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </MessageHeader>
        <Bubble variant={mine ? 'secondary' : 'ghost'} align={mine ? 'end' : 'start'}>
          <BubbleContent className="whitespace-pre-wrap break-words">
            {m.kind === 'reply' && words ? (
              <Reply words={words} />
            ) : (
              <TicketLinks
                words={
                  words ||
                  m.notice?.error ||
                  m.verdict ||
                  (attachments.length ? '' : 'Content unavailable')
                }
              />
            )}
            {attachments.length > 0 && <AttachmentGroup aria-label="Sent attachments">
              {attachments.map((name,index) => <Attachment key={index} size="xs">
                <AttachmentMedia><PaperclipIcon /></AttachmentMedia>
                <AttachmentContent><AttachmentTitle title={name}>{name}</AttachmentTitle></AttachmentContent>
              </Attachment>)}
            </AttachmentGroup>}
          </BubbleContent>
        </Bubble>
        {m.kind === 'reply' && m.run && <RunDetails id={m.run} />}
        {m.delivery === 'failed' && <small>Delivery failed</small>}
      </MessageContent>
    </Message>
  );
}
export type ThreadTail = {
  last: number;
  read: number;
  working: boolean;
  conversation: string;
  tool: string | null;
  update: boolean;
  status: 'connecting' | 'live' | 'unavailable';
};
export const emptyTail: ThreadTail = {
  last: 0,
  read: 0,
  working: false,
  conversation: '',
  tool: null,
  update: false,
  status: 'connecting',
};

export type Feed = { thread: CommsThread | null; rows: CommsMessage[] };
export function TranscriptPage({
  id,
  before,
  visible,
  onTail,
}: {
  id: string;
  before?: number;
  visible: boolean;
  onTail?: (tail: ThreadTail) => void;
}) {
  const read = useDataQuery<Feed>(historyQuery, { id, before: before ?? null });
  const [older, showOlder] = useState(false),
    rows = read.data?.rows || [];
  const now = useDeadline(rows.map((m) => m.wordsKeepUntil));
  const latest = rows.at(-1);
  const last = latest?.seq || 0;
  const thread = read.data?.thread;
  const initialTail = useRef<number | null>(null);
  useEffect(() => {
    if (visible && read.status === 'live' && initialTail.current === null) initialTail.current = last;
  }, [visible, read.status, last]);
  const status =
    read.status === 'live' && thread ? 'live' : read.status === 'loading' ? 'connecting' : 'unavailable';
  const working = !!thread?.working,
    readSeq = thread?.readSeq || 0,
    conversation = thread?.conversation || '';
  const tool =
    working && latest?.kind === 'card' && latest.cardState === 'running' ? latest.tool || null : null;
  const update = rows.some((m) => m.seq > readSeq && m.kind === 'reply');
  useEffect(() => {
    if (status !== 'connecting')
      onTail?.({ last, read: readSeq, working, conversation, tool, update, status });
  }, [last, readSeq, working, conversation, tool, update, status, onTail]);
  if (read.status !== 'live' || !read.data?.thread)
    return visible ? (
      <p role="status">{read.status === 'loading' ? 'Opening conversation…' : 'Conversation unavailable.'}</p>
    ) : null;
  if (!visible) return null;
  const latestTerminal = rows.findLast(
    (m) => m.kind === 'card' && m.tool?.endsWith('Terminal') && m.cardState !== 'running',
  )?.seq;
  return (
    <>
      {rows.length === 50 &&
        (older ? (
          <TranscriptPage id={id} before={rows[0].seq} visible />
        ) : (
          <Button variant="ghost" onClick={() => showOlder(true)}>
            Earlier messages
          </Button>
        ))}
      {workTree(
        rows.map((m) =>
          Date.parse(m.wordsKeepUntil ?? '') > now ? m : { ...m, words: null, stepDetails: null },
        ),
      ).map((node) => (
        <MessageScrollerItem key={node.events[0].seq} messageId={String(node.events[0].seq)} data-arrived={initialTail.current !== null && node.events[0].seq > initialTail.current || undefined}>
          {node.events[0].kind === 'card' ? (
            <WorkTrace
              key={node.events[0].seq}
              node={node}
              latestTerminal={before ? undefined : latestTerminal}
            />
          ) : (
            <Entry key={node.events[0].seq} m={node.events[0]} />
          )}
        </MessageScrollerItem>
      ))}
      {!before && <span hidden data-tail-seq={last} />}
    </>
  );
}
export function threadId(prefix: string, parts: (string | null)[]) {
  return (
    prefix +
    Array.from(sha256(new TextEncoder().encode(JSON.stringify(parts))), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('')
  );
}
