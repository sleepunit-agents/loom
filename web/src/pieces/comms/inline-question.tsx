import { useEffect, useMemo, useState } from 'react';
import { conversationOperation as mutate } from './operations';
import { useSelection, type QuerySelection } from '../../data/graphql/selection';
import { InboxQuestionCard } from '../inbox-view';
import type { InboxActions, InboxItem } from '../inbox-view/model';
import { inboxSourcePath, retainedInboxItem } from '../attention/inbox-query';
const query = `query InlineQuestion($id:String!){inboxItem(id:$id){id toKind to source sourceId fromId agent project thread at state volume answers waitsOnKind waitsOnId
 bodyKeepUntil answerKeepUntil body{words why ifYes ifNo link} read refs answer answerText answeredBy answeredAt resolution}}`;
export function inlineQuestionSelection(id: string): QuerySelection<InboxItem | null> {
  return { query, variables: { id }, decode: data => data.inboxItem as InboxItem | null };
}
/** Inline questions use the same Inbox item and authenticated operations. */
export function InlineQuestion({ id, go, writable }: { id: string; go(path: string): void; writable: boolean }) {
  const reading = useSelection(useMemo(() => inlineQuestionSelection(id), [id]));
  const [now, setNow] = useState(Date.now);
  const item = reading.status === 'live' ? reading.data : null;
  useEffect(() => {
    if (!item) return;
    const deadlines = [item.bodyKeepUntil, item.answerKeepUntil].map(at => Date.parse(at ?? '')).filter(at => Number.isFinite(at) && at > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(1, Math.min(...deadlines) - Date.now())));
    return () => clearTimeout(timer);
  }, [item, now]);

  const actions: InboxActions | undefined = item && writable ? {
    read: item => mutate('inbox.read', { item }, true),
    answer: (item, answer, words) => mutate('inbox.answer', { item, answer, ...(words ? { words } : {}) }),
    openSource: inboxSourcePath(item) ? item => { const path = inboxSourcePath(item); if (path) go(path); } : undefined,
  } : undefined;
  return <InboxQuestionCard id={id} inline actions={actions} snapshot={{ status: reading.status,
    items: item ? [retainedInboxItem(item, Math.max(now, Date.now()))] : [] }} />;
}
