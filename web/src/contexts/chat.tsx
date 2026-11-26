import { readSplit, splitPrefix } from './split';
import { ChatReferences } from './chat-references';
import { openLinkedEntity } from './entity-links';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { useDiscussion } from './discussion';
import type { CommsMessage } from '../pieces/comms-view/model';
import { memberOperation } from '../data/operation';
import { ConversationHistory } from './conversation-history';
const Question = lazy(async () => ({
  default: (await import('../pieces/comms/inline-question')).InlineQuestion,
}));
const title = (id: string) => id.slice(0, 1).toUpperCase() + id.slice(1);
export function Chat({
  name,
  agent,
  discussion,
  visible,
  onClose,
  onSend,
  receipts,
  subject,
  subjectRef,
  excerpt,
}: {
  name: string;
  agent: string;
  discussion: ReturnType<typeof useDiscussion>;
  visible: boolean;
  onClose(): void;
  onSend(words: string): Promise<boolean>;
  receipts: string[];
  subject?: string;
  subjectRef?: string;
  excerpt?: string;
}) {
  const [draft, setDraft] = useState('');
  const [included, setIncluded] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  const read = useRef(0),
    bottom = useRef(true),
    lock = useRef(false);
  const last = discussion.messages.at(-1)?.seq || 0;
  useEffect(() => {
    if (!visible) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () =>
      document.documentElement.style.setProperty(
        '--keyboard-inset',
        Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) + 'px',
      );
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      viewport.removeEventListener('scroll', resize);
      document.documentElement.style.removeProperty('--keyboard-inset');
    };
  }, [visible]);
  useEffect(() => {
    if (visible) {
      void discussion.enter();
      input.current?.focus({ preventScroll: true });
    }
  }, [visible, agent]);
  useEffect(() => {
    if (!visible || document.hidden) return;
    if (bottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
    if (last > Math.max(read.current, discussion.readSeq) && discussion.thread) {
      read.current = last;
      void memberOperation('comms.change', { thread: discussion.thread, change: 'read', seq: last }).catch(
        () => {
          read.current = 0;
        },
      );
    }
  }, [visible, last, discussion.readSeq, discussion.thread]);
  async function submit() {
    const text = draft.trim();
    if (!text || lock.current) return;
    lock.current = true;
    try {
      if (
        await onSend(
          included && included === subjectRef && excerpt
            ? text + '\n\nRecord details shared with you:\n' + excerpt
            : text,
        )
      ) {
        bottom.current = true;
        setDraft((prev) => (prev.trim() === text ? '' : prev));
        input.current?.focus();
      }
    } finally {
      lock.current = false;
    }
  }
  function printable(m: CommsMessage) {
    const text = m.words?.replace(/^\[Loom context · [^\n]+\]\n/, '') || '';
    if (m.kind === 'message' && text.startsWith(splitPrefix))
      return text.split('\nRequest: ')[1] || 'Split this task';
    if (m.kind === 'reply' && readSplit(text)) return 'I drafted two child tickets for you to review.';
    if (m.kind === 'message' && text.startsWith('Review the decision evidence for '))
      return 'Review the decision evidence.';
    if (m.kind === 'message' && text.startsWith('Interpret this workspace request: '))
      return text.split('. Current modules:')[0].replace('Interpret this workspace request: ', '');
    if (m.kind === 'reply' && text.trim().startsWith('{')) {
      try {
        const value = JSON.parse(text);
        if (Array.isArray(value.findings) && typeof value.question === 'string') return value.question;
        if (Array.isArray(value.add) && Array.isArray(value.remove))
          return 'I have a layout proposal for this view.';
      } catch {
        /* Plain text reply. */
      }
    }
    return text;
  }
  return (
    <aside className="chatWindow" aria-label={'You and ' + title(agent) + ' · ' + name}>
      <div className="chatTitle">
        <strong>
          You and {title(agent)} · {name}
        </strong>
        <button onClick={onClose} aria-label="Close chat">
          ×
        </button>
      </div>
      <div
        className="transcript"
        ref={list}
        onScroll={() => {
          const el = list.current!;
          bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }}
      >
        {!discussion.available && !discussion.error && (
          <p role="status">
            {discussion.unavailable ? 'Conversation unavailable.' : 'Opening conversation…'}
          </p>
        )}
        {discussion.messages
          .filter((m) => m.kind !== 'notice' && m.kind !== 'ask')
          .map((m) => (
            <article key={m.seq} className={m.kind === 'message' || m.kind === 'answer' ? 'mine' : 'theirs'}>
              <small>
                {m.kind === 'message' || m.kind === 'answer' ? 'You' : title(m.sender)} ·{' '}
                {new Date(m.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </small>
              <p>
                <ChatReferences words={printable(m)} />
              </p>
              {m.delivery === 'failed' && <small>Delivery failed</small>}
            </article>
          ))}
        {discussion.questions.map((id) => (
          <Suspense key={id} fallback={<p>Opening question…</p>}>
            <Question id={id} go={openLinkedEntity} contextWorkspace writable readVisible={visible} />
          </Suspense>
        ))}
        {(receipts.length > 0 || discussion.available) && (
          <details onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
            <summary>Conversation details</summary>
            {receipts.map((r, i) => (
              <p key={i}>{r}</p>
            ))}
            {historyOpen && discussion.available && (
              <ConversationHistory key={discussion.thread} thread={discussion.thread} />
            )}
          </details>
        )}
      </div>
      <form
        className="chatComposer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {subject && (
          <div className="chatSubject">
            <strong>About {subject}</strong>
            {excerpt && (
              <details>
                <summary>Record details</summary>
                <pre>{excerpt}</pre>
                <label>
                  <input
                    type="checkbox"
                    checked={included === subjectRef}
                    onChange={(e) => setIncluded(e.target.checked ? subjectRef || '' : '')}
                  />
                  Include these details in my message
                </label>
              </details>
            )}
          </div>
        )}
        <textarea
          ref={input}
          rows={2}
          aria-label={'Message ' + title(agent)}
          placeholder={'Message ' + title(agent) + '…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button disabled={!draft.trim() || discussion.busy}>Send</button>
        {discussion.error && <small role="alert">{discussion.error}</small>}
      </form>
    </aside>
  );
}
