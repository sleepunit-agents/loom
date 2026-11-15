import { useRef, useState } from 'react';
import { Button, Textarea } from '../../kit';
import { useTaskCommandSubmitter } from '../../data/task-command';
import type { InboxItem } from '../inbox-view/model';
/** A task owns its answer. Bind it to this immutable Inbox delivery so a
 * replaced question cannot receive an answer from an old card or retry. */
export function TaskQuestionAnswer({item}: {item: InboxItem}) {
  const submit = useTaskCommandSubmitter();
  const [words,setWords] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const locked = useRef(false);
  if (item.state !== 'waiting' || !item.body || !item.answers || item.source !== 'task' || item.waitsOnKind !== 'task' || !item.waitsOnId) return null;
  const answer = async (answer: 'yes'|'no'|'words') => {
    if (locked.current || answer === 'words' && !words.trim()) return;
    locked.current = true;setBusy(true);setError('');
    try { await submit({action:'answer',id:item.waitsOnId!,question:item.id,answer,...(answer==='words'?{text:words.trim()}:{})}); }
    catch {setError('Could not save your task answer. Reconnect and try again.');}
    finally {locked.current=false;setBusy(false);}
  };
  return <section aria-label="Answer task question" className="grid gap-2">
    {item.answers==='yes-no' && <div><Button disabled={busy} onClick={()=>void answer('yes')}>Yes</Button><Button disabled={busy} onClick={()=>void answer('no')}>No</Button></div>}
    <Textarea aria-label="Answer task in your own words" value={words} disabled={busy} onChange={event=>setWords(event.target.value)}/>
    <Button disabled={busy||!words.trim()} onClick={()=>void answer('words')}>Record task answer</Button>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
