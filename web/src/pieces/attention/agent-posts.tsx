import { age } from '../projects/model';
import './agent-posts.css';

export interface AgentPost {
  id: string;
  at: string;
  words: string;
  work?: readonly { id: string; title: string; state: string; href: string }[];
}

export interface AgentPostPreview {
  thread: string;
  title: string;
  latest: AgentPost;
  parent: Pick<AgentPost, 'id' | 'words'> | null;
}

function PostWork({ post, go }: { post: AgentPost; go?(href: string): void }) {
  if (!post.work?.length) return null;
  return <ul className="desk-agent-post-work" aria-label="Related work">
    {post.work.map(link => <li key={link.id}><a href={link.href} onClick={event=>{
      if (!go || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go(link.href);
    }}>{link.title} · {link.state}</a></li>)}
  </ul>;
}

/** Both desk surfaces receive the viewer's authorized thread previews, newest post first. */
export function AgentPostFeed({ threads, compact = false, open, go, now }: {
  threads: readonly AgentPostPreview[];
  compact?: boolean;
  open(thread: string): void;
  go?(href: string): void;
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
        {!compact && <PostWork post={latest} go={go}/>}
      </li>)}
  </ul>;
}

export function AgentPostHistory({ title, posts, now, go }: {
  title: string;
  posts: readonly AgentPost[];
  go?(href: string): void;
  now: number;
}) {
  return <ol className="desk-agent-history" aria-label={title}>
    {posts.map(post => <li key={post.id}>
      <time dateTime={post.at}>{age(post.at, now)}</time>
      <p>{post.words}</p>
      <PostWork post={post} go={go}/>
    </li>)}
  </ol>;
}
