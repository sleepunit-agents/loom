import { useState } from 'react';
import { Actions, Button, Input, Section } from '../../kit';
import type { InboxAnswer } from './model';

/** The one answer section an item has, whichever part of loom records the answer: Yes and No where the question
 * takes them, a line for words, and (where the question can be closed without an answer) Mark done and Dismiss. */
export function AnswerSection({ answers, busy, yes = 'Yes', no = 'No', settle, compact, onAnswer }: {
  answers: 'yes-no' | 'words'; busy: boolean; yes?: string; no?: string; settle?: boolean;
  /** In a conversation: the answer alone. The two buttons for a question that takes Yes or No, one line and Record answer for one that takes words. Everything else is the Inbox's. */
  compact?: boolean;
  onAnswer(answer: InboxAnswer, words?: string): void;
}) {
  const [draft, setDraft] = useState('');
  const record = () => { if (draft.trim()) onAnswer('words', draft); };
  if (compact) return <Actions label="Record your answer">
    {answers === 'yes-no' ? <>
      <Button variant="primary" disabled={busy} onClick={() => onAnswer('yes')}>{yes}</Button>
      <Button disabled={busy} onClick={() => onAnswer('no')}>{no}</Button>
    </> : <>
      <Input className="min-w-0 flex-1 basis-40" aria-label="Answer in your own words" placeholder="Answer in your own words" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); record(); } }} />
      <Button variant="primary" disabled={busy || !draft.trim()} onClick={record}>Record answer</Button>
    </>}
  </Actions>;
  return <Section label="Record your answer">
    {answers === 'yes-no' && <Actions>
      <Button variant="primary" disabled={busy} onClick={() => onAnswer('yes')}>{yes}</Button>
      <Button disabled={busy} onClick={() => onAnswer('no')}>{no}</Button>
    </Actions>}
    <Input aria-label="Answer in your own words" placeholder={answers === 'yes-no' ? 'Or answer in your own words' : 'Answer in your own words'}
      value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); record(); } }} />
    <Actions>
      <Button disabled={busy || !draft.trim()} onClick={record}>Record answer</Button>
      {settle && <Button disabled={busy} onClick={() => onAnswer('done')}>Mark done</Button>}
      {settle && <Button disabled={busy} onClick={() => onAnswer('dismiss')}>Dismiss</Button>}
    </Actions>
  </Section>;
}
