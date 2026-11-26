import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import type { EntityTarget } from './entities';
type Post = { id: string; at: string; thread: string; agent: string; words: string };
type Review = {
  id: string;
  submittedAt: string;
  login: string | null;
  body: string | null;
  state: string;
  change: string;
  url: string;
};
export function TicketUpdates({ id, open }: { id: string; open: (target: EntityTarget) => void }) {
  const [before, older] = useState<string[]>([]);
  const [cursor, reviewsPage] = useState<Review[]>([]);
  const last = cursor.at(-1);
  const updates = useDataQuery<{ ticketActivityPosts: Post[] }>(
    'query ContextUpdates($id:String!,$before:String!){ticketActivityPosts(task:$id,before:$before,limit:21){id at thread agent words}}',
    { id, before: before.at(-1) || '0' },
  );
  const reviews = useDataQuery<{ taskGithubReviews: Review[] }>(
    'query ContextReviews($id:String!,$at:String,$before:String){taskGithubReviews(task:$id,beforeAt:$at,beforeId:$before){id submittedAt login body state change url}}',
    { id, at: last?.submittedAt ?? null, before: last?.id ?? null },
  );
  const posts = updates.data?.ticketActivityPosts,
    rows = reviews.data?.taskGithubReviews;
  return (
    <>
      <section>
        <h3>Agent updates</h3>
        {updates.status !== 'live' || !posts ? (
          <p>{updates.status === 'loading' ? 'Reading updates…' : 'Updates unavailable.'}</p>
        ) : (
          <>
            {!posts.length && <p>No visible updates on this page.</p>}
            {posts.slice(0, 20).map((p) => (
              <article key={p.id}>
                <small>
                  {p.agent} · {new Date(p.at).toLocaleString()}
                </small>
                <p>{p.words}</p>
                <button onClick={() => open({ kind: 'post', scope: p.agent, id: p.thread })}>
                  Open activity thread
                </button>
              </article>
            ))}
            {before.length > 0 && <button onClick={() => older(before.slice(0, -1))}>Newer updates</button>}
            {posts.length > 20 && (
              <button onClick={() => older([...before, posts[19].id])}>Older updates</button>
            )}
          </>
        )}
      </section>
      <section>
        <h3>GitHub reviews</h3>
        {reviews.status !== 'live' || !rows ? (
          <p>{reviews.status === 'loading' ? 'Reading reviews…' : 'Reviews unavailable.'}</p>
        ) : (
          <>
            {!rows.length && <p>No submitted reviews on this page.</p>}
            {rows.slice(0, 30).map((r) => (
              <article key={r.id}>
                <small>
                  {r.login || 'GitHub reviewer'} · {new Date(r.submittedAt).toLocaleString()}
                </small>
                <p>
                  {r.state} · {r.body}
                </p>
                <button onClick={() => open({ kind: 'change', id: r.change })}>Open reviewed PR</button>
              </article>
            ))}
            {cursor.length > 0 && (
              <button onClick={() => reviewsPage(cursor.slice(0, -1))}>Newer reviews</button>
            )}
            {rows.length > 30 && (
              <button onClick={() => reviewsPage([...cursor, rows[29]])}>Older reviews</button>
            )}
          </>
        )}
      </section>
    </>
  );
}
