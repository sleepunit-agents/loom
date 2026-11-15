import { useMemo, useState } from 'react';
import { useSelection, type QuerySelection } from '../../data/graphql/selection';
import { Button } from '../../kit';
import { LiveApprovalCard } from '../../data/work-views';
import { InlineQuestion } from './inline-question';
import { conversationApprovalsQuery as query } from './work-query';
/** Source questions already belong to the conversation. No copied chat message,
 * answer state or private wording is kept here. The Inbox query scopes recipients. */
export function ConversationQuestions({ conversation, go, readVisible }: { conversation: string; go(path: string): void; readVisible: boolean }) {
  const [offset, setOffset] = useState(0);
  const reading = useSelection(useMemo<QuerySelection<{questions:{id:string;sourceId?:string}[];ordinary:{id:string}[]}>>(() => ({ query, variables: { conversation, offset },
    decode(data) {
      if (!Array.isArray(data.inboxItems) || data.inboxItems.some(row => !row || typeof row.id !== 'string')) throw Error('Invalid conversation questions');
      if (!Array.isArray(data.approvals)) throw Error('Invalid conversation approvals');
      return {questions:data.inboxItems as {id:string;sourceId?:string}[],ordinary:data.approvals as {id:string}[]};
    },
  }), [conversation, offset]));
  if (reading.status !== 'live') return null;
  const items = reading.data?.questions ?? [], ordinary = reading.data?.ordinary ?? [];
  const questionSources = new Set(items.slice(0,10).map(item=>item.sourceId));
  return <section aria-label="Conversation approvals">
    {ordinary.slice(0,10).filter(card=>!questionSources.has(card.id)).map(card => <LiveApprovalCard key={card.id} id={card.id} />)}
    {items.slice(0,10).map(item => <InlineQuestion key={item.id} id={item.id} go={go} writable readVisible={readVisible} />)}
    {(offset > 0 || (items.length > 10 || ordinary.length > 10)) && <nav aria-label="Approval question pages">
      <Button disabled={!offset} onClick={() => setOffset(value => Math.max(0,value-10))}>Newer questions</Button>
      <Button disabled={items.length <= 10 && ordinary.length <= 10} onClick={() => setOffset(value => value+10)}>Older questions</Button>
    </nav>}
  </section>;
}
