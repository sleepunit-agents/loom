/** The `comments` brick: a ticket's comments, newest first, and the form that adds one (docs/specs/boards.md,
 * "The first bricks"). */
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { Reply } from '../pair/reply';
import { Loading, Unavailable, useOwnFlag, words, type BodyProps } from './brick-kit';
import { useTicketAction } from './ticket-action';

type Note = { seq: number; text: string; actor: string; at: string };
export function Comments({ params, form, act, raise }: BodyProps) {
  const id = words(params.ticket);
  const read = useDataQuery<{ ticket: { title: string; taskCommentsByTask: Note[] } | null }>(
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
      <p className="board-lead">{t.title}</p>
      <form className="board-line" onSubmit={(e) => void add(e)}>
        <input className="board-input" aria-label="Add a comment" placeholder="Add a comment…" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="board-action" disabled={busy || !text.trim()}>Add</button>
      </form>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {notes.length ? (
        <ol className="board-notes">
          {notes.map((n) => (
            <li key={n.seq}>
              <small>{n.actor} · {new Date(n.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
              <Reply words={n.text} />
            </li>
          ))}
        </ol>
      ) : <p className="text-muted-foreground">No comments yet.</p>}
    </>
  );
}
