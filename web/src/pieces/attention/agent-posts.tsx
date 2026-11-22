import { age } from '../projects/model';
import './agent-posts.css';

export interface AgentPost {
  id: string;
  at: string;
  words: string;
}

export interface AgentPostPreview {
  thread: string;
  title: string;
  latest: AgentPost;
  parent: Pick<AgentPost, 'id' | 'words'> | null;
}

/** Both desk surfaces receive the viewer's authorized thread previews, newest post first. */
export function AgentPostFeed({ threads, compact = false, open, now }: {
  threads: readonly AgentPostPreview[];
  compact?: boolean;
  open(thread: string): void;
  now: number;
}) {
  if (!threads.length) return null;
  const shown = compact ? threads.slice(0, 1) : threads;
  return <ul className="desk-agent-posts" data-compact={compact || undefined} aria-label="Activity threads">
    {shown.map(({ thread, title, latest, parent }) =>
      <li key={thread}>
        <button type="button" onClick={() => open(thread)}>
          <span className="desk-agent-post-heading">
            <strong>{title}</strong>
            <time dateTime={latest.at}>{age(latest.at, now)}</time>
          </span>
          {parent && <small className="desk-agent-post-parent">{parent.words}</small>}
          <span className="desk-agent-post-words">{latest.words}</span>
        </button>
      </li>)}
  </ul>;
}

export function AgentPostHistory({ title, posts, now }: {
  title: string;
  posts: readonly AgentPost[];
  now: number;
}) {
  return <ol className="desk-agent-history" aria-label={title}>
    {posts.map(post => <li key={post.id}>
      <time dateTime={post.at}>{age(post.at, now)}</time>
      <p>{post.words}</p>
    </li>)}
  </ol>;
}
