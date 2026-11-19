import { useRef, useState } from 'react';
import { useTaskCommandSubmitter } from '../../data/task-command';
import { AnswerSection } from '../inbox-view/answer';
import type { InboxItem } from '../inbox-view/model';
/** A task owns its answer. Bind it to this immutable Inbox delivery so a
 * replaced question cannot receive an answer from an old card or retry.
 * It is drawn as the same answer section every Inbox item has; a task takes
 * Yes, No or words, and is closed in Tasks, so it offers no Mark done or Dismiss. */
export function TaskQuestionAnswer({item,compact}: {item: InboxItem;compact?:boolean}) {
  const submit = useTaskCommandSubmitter();
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const locked = useRef(false);
  if (item.state !== 'waiting' || !item.body || !item.answers || item.source !== 'task' || item.waitsOnKind !== 'task' || !item.waitsOnId) return null;
  const answer = async (answer: 'yes'|'no'|'words', words?: string) => {
    if (locked.current || answer === 'words' && !words?.trim()) return;
    locked.current = true;setBusy(true);setError('');
    try { await submit({action:'answer',id:item.waitsOnId!,question:item.id,answer,...(answer==='words'?{text:words!.trim()}:{})}); }
    catch {setError('Could not save your answer. Reconnect and try again.');}
    finally {locked.current=false;setBusy(false);}
  };
  return <>
    <AnswerSection answers={item.answers} busy={busy} compact={compact} onAnswer={(verdict, words) => { if (verdict === 'yes' || verdict === 'no' || verdict === 'words') void answer(verdict, words); }}/>
    {error&&<p role="alert">{error}</p>}
  </>;
}
