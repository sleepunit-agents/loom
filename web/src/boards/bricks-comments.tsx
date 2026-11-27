/** The `comments` brick: a ticket's comments, newest first, and the form that adds one (docs/specs/boards.md,
 * "The first bricks"). */
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { Reply } from '../pair/reply';
import { Action, Lead, Loading, Note, Problem, Time, Unavailable, useOwnFlag, words, type BodyProps } from './brick-kit';
import { useTicketAction } from './ticket-action';

type Comment = { seq: number; text: string; actor: string; at: string };
export function Comments({ params, form, act, raise }: BodyProps) {
  const id = words(params.ticket);
  const read = useDataQuery<{ ticket: { title: string; taskCommentsByTask: Comment[] } | null }>(
    'query BrickComments($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){title taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}}){seq text actor at}}}',
    { id }, { keep: true });
  const own = useOwnFlag(read.data?.ticket?.taskCommentsByTask.length, raise, (was, now) => (now > was ? 'New comment' : null));
  const { busy, error, run } = useTicketAction(act, own);
  const [text, setText] = useState('');
  const t = read.data?.ticket;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !t) return <Unavailable what="ticket" />;
  const add = async (e: FormEvent) => { e.preventDefault(); if (text.trim() && await run('comment', { id, text: text.trim() })) setText(''); };
  if (form === 'compact') return <p className="board-brief">{t.taskCommentsByTask.length ? `${t.taskCommentsByTask.length} · latest from ${t.taskCommentsByTask[0].actor}: ${t.taskCommentsByTask[0].text}` : 'No comments yet'}</p>;
  const notes = t.taskCommentsByTask.slice(0, form === 'primary' ? 30 : 4);
  return (
    <>
      <Lead>{t.title}</Lead>
      <form className="board-pick" onSubmit={(e) => void add(e)}>
        <input className="board-input" aria-label="Add a comment" placeholder="Add a comment…" value={text} onChange={(e) => setText(e.target.value)} />
        <Action submit disabled={busy || !text.trim()}>Add</Action>
      </form>
      <Problem>{error}</Problem>
      {notes.length ? (
        <ol className="board-comments">
          {notes.map((n) => (
            <li key={n.seq}>
              <p className="board-meta"><b>{n.actor}</b><Time at={n.at} /></p>
              <Reply words={n.text} />
            </li>
          ))}
        </ol>
      ) : <Note>No comments yet.</Note>}
      {t.taskCommentsByTask.length > notes.length && <Note>and {t.taskCommentsByTask.length - notes.length} earlier</Note>}
    </>
  );
}
