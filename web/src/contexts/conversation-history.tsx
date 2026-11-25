import { DeskMember } from '../signin/desk-member';
import { ThreadControls } from './thread-controls';
import { ArchivedQuestions } from '../pieces/comms/archived-questions';
import { entityAddress } from './entities';
import { useContext, useMemo, useState } from 'react';
import { useSelection } from '../data/graphql/selection';
import { commsThreadSelection, retainedCommsMessage } from '../pieces/comms/shared-query';
import { useDeadline } from '../pieces/comms/use-deadline';

/** Each page stays subscribed to the authorized, retention-aware thread reader. */
export function ConversationHistory({ thread }: { thread: string }) {
  const member = useContext(DeskMember);
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors.at(-1);
  const selection = useMemo(() => commsThreadSelection(thread, before), [thread, before]);
  const reading = useSelection(selection);
  const page = reading.status === 'live' && reading.data?.thread?.id === thread ? reading.data : undefined;
  const now = useDeadline(page?.messages.map((message) => message.wordsKeepUntil) ?? []);
  if (!page)
    return <p role="status">{reading.status === 'loading' ? 'Opening history…' : 'History unavailable.'}</p>;
  const rows = page.messages.slice(-50).map((message) => retainedCommsMessage(message, now));
  return (
    <section className="conversationHistory" aria-label="Conversation history">
      <h3>Conversation history</h3>
      <div className="historyPages">
        {page.messages.length > rows.length && (
          <button onClick={() => setCursors([...cursors, rows[0].seq])}>Earlier messages</button>
        )}
        {before !== undefined && (
          <button onClick={() => setCursors(cursors.slice(0, -1))}>Newer messages</button>
        )}
      </div>
      {rows.length === 0 && <p>No messages yet.</p>}
      {rows.map((m) => (
        <article key={m.seq}>
          <small>
            {m.sender} · {new Date(m.at).toLocaleString()} · {m.kind}
          </small>
          <button
            onClick={() => {
              location.hash = entityAddress({ kind: 'message', id: String(m.seq), scope: thread });
            }}
          >
            Open message {m.seq}
          </button>
          {m.words && <p>{m.words.replace(/^\[Loom context · [^\n]+\]\n/, '')}</p>}
          {m.inboxItem && m.kind === 'ask' && (
            <button
              onClick={() => {
                location.hash = entityAddress({ kind: 'question', id: m.inboxItem! });
              }}
            >
              Open question
            </button>
          )}
          {page.refs
            .filter((ref) => ref.messageSeq === m.seq)
            .map(({ ref }) =>
              /^t-\d+$/.test(ref) || /^a-/.test(ref) ? (
                <button
                  key={ref}
                  onClick={() => {
                    location.hash = entityAddress({
                      kind: ref.startsWith('t-') ? 'ticket' : 'approval',
                      id: ref,
                    });
                  }}
                >
                  {ref}
                </button>
              ) : (
                <small key={ref}>{ref}</small>
              ),
            )}
          {m.tool && (
            <p>
              {m.tool} · {m.cardState}
            </p>
          )}
          {m.stepDetails?.detail && <p>{m.stepDetails.detail}</p>}
          {m.stepDetails?.result && <p>{m.stepDetails.result}</p>}
          {m.delivery && <small>Delivery · {m.delivery}</small>}
          {m.notice?.error && <p>{m.notice.error}</p>}
        </article>
      ))}
      {page.archivedQuestions.length > 0 && (
        <ArchivedQuestions thread={thread} first={page.archivedQuestions} name={(id) => id} />
      )}
      {page.thread && page.thread.member === member && (
        <ThreadControls
          thread={page.thread}
          leave={() => {
            location.hash = entityAddress({ kind: 'conversation' });
          }}
        />
      )}
    </section>
  );
}
