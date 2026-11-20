import { useCallback, useMemo, useState } from 'react';
import { useSelection, type QuerySelection } from '../../data/graphql/selection';
import { Pager, Section } from '../../kit';
import { LiveApprovalCard } from '../../data/work-views';
import { InlineQuestion } from './inline-question';
import { conversationApprovalsQuery as query } from './work-query';
/** Source questions already belong to the conversation. No copied chat message,
 * answer state or private wording is kept here. The Inbox query scopes recipients.
 * A question a message in the stream carries is drawn there, where it was asked, and left out here (`placed`):
 * this is the one block, directly over the message bar, for the ones the stream has no place for. */
// Another page keeps the last one's cards and the pager on screen until it answers; each card reads its own
// item by id, and this is mounted per conversation, so nothing here is another conversation's.
export function ConversationQuestions({ conversation, go, readVisible, placed = [], onWaiting }: { conversation: string; go(path: string): void; readVisible: boolean; placed?: readonly string[]; onWaiting?(id: string, waiting: boolean): void }) {
  const [offset, setOffset] = useState(0), [waiting, setWaiting] = useState<readonly string[]>([]);
  const reading = useSelection(useMemo<QuerySelection<{questions:{id:string;sourceId?:string}[];ordinary:{id:string}[];hasNext:boolean}>>(() => ({ query, variables: { conversation, offset },
    decode(data) {
      if (!Array.isArray(data.inboxItems) || data.inboxItems.some(row => !row || typeof row.id !== 'string')) throw Error('Invalid conversation questions');
      if (!Array.isArray(data.taskQuestions) || data.taskQuestions.some(row => !row || typeof row.id !== 'string')) throw Error('Invalid conversation task questions');
      if (!Array.isArray(data.approvals)) throw Error('Invalid conversation approvals');
      return {hasNext:data.inboxItems.length>10||data.taskQuestions.length>10,questions:[...data.inboxItems.slice(0,10),...data.taskQuestions.slice(0,10)] as {id:string;sourceId?:string}[],ordinary:data.approvals as {id:string}[]};
    },
  }), [conversation, offset]), { keep: true });
  const heard = useCallback((id: string, on: boolean) => {
    setWaiting(ids => on === ids.includes(id) ? ids : on ? [...ids, id] : ids.filter(one => one !== id));
    onWaiting?.(id, on);
  }, [onWaiting]);
  if (reading.status !== 'live') return null;
  const all = reading.data?.questions ?? [], ordinary = reading.data?.ordinary ?? [];
  const questionSources = new Set(all.map(item=>item.sourceId));
  const items = all.filter(item => !placed.includes(item.id)), cards = ordinary.slice(0,10).filter(card=>!questionSources.has(card.id));
  const hasNext = !!reading.data?.hasNext || ordinary.length > 10;
  if (!items.length && !cards.length && !offset && !hasNext) return null;
  return <Section label={waiting.length ? 'Waiting on you' : 'Questions in this conversation'}>
    {cards.map(card => <LiveApprovalCard key={card.id} id={card.id} />)}
    {items.map(item => <InlineQuestion key={item.id} id={item.id} go={go} writable readVisible={readVisible} onWaiting={heard} />)}
    <Pager label="Question pages" hasPrevious={offset > 0} hasNext={hasNext} previous={() => setOffset(value => Math.max(0,value-10))} next={() => setOffset(value => value+10)} />
  </Section>;
}
