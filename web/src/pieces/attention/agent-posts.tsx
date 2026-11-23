import { useLayoutEffect, useRef } from 'react';
import { reducedMotion } from '../../access';
import { threadPath } from './home-comms-data';
import { Button } from '../../kit';
import { age } from '../projects/model';
import './agent-posts.css';

export interface AgentPost {
  id: string;
  at: string;
  words: string;
  source?: string;
  work?: readonly { id: string; title: string; state: string; href: string }[];
}

export interface AgentPostPreview {
  thread: string;
  title: string;
  latest: AgentPost;
  parent: Pick<AgentPost, 'id' | 'words'> | null;
}

function excerpt(words: string, limit: number) {
  const line = words.trim().replace(/\s+/gu, ' ');
  const characters = Array.from(line);
  if (characters.length <= limit) return line;
  const prefix = characters.slice(0, limit).join('');
  const boundary = prefix.lastIndexOf(' ');
  return (boundary > limit / 2 ? prefix.slice(0, boundary) : prefix) + '…';
}

function PostWork({ post, go }: { post: AgentPost; go?(href: string): void }) {
  if (!post.work?.length) return null;
  return <details className="desk-agent-post-receipts">
    <summary>Show the work</summary>
    <ul className="desk-agent-post-work" aria-label="Related work">
      {post.work.map(link => <li key={link.id}><a href={link.href} onClick={event=>{
        if (!go || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        go(link.href);
      }}>{link.title} · {link.state}</a></li>)}
    </ul>
  </details>;
}

/** Both desk surfaces receive the viewer's authorized thread previews, newest post first. */
export function AgentPostFeed({ threads, compact = false, open, go, now }: {
  threads: readonly AgentPostPreview[];
  compact?: boolean;
  open(thread: string): void;
  go?(href: string): void;
  now: number;
}) {
  const feed = useRef<HTMLUListElement>(null);
  const latestId = threads[0]?.latest.id;
  const previousId = useRef(latestId);
  useLayoutEffect(() => {
    const arrived = previousId.current && latestId && previousId.current !== latestId;
    previousId.current = latestId;
    const line = feed.current?.querySelector<HTMLElement>('.desk-agent-post-words');
    if (!arrived || !line?.animate || reducedMotion()) return;
    const motion = line.animate([{opacity: .35, transform: 'translateY(3px)'}, {opacity: 1, transform: 'none'}],
      {duration: 240, easing: 'ease-out'});
    return () => motion.cancel();
  }, [latestId]);
  if (!threads.length) return null;
  const shown = compact ? threads.slice(0, 1) : threads;
  return <ul ref={feed} className="desk-agent-posts" data-compact={compact || undefined} aria-label="Activity threads">
    {shown.map(({ thread, title, latest, parent }) =>
      <li key={thread}>
        <button type="button" onClick={() => open(thread)}>
          {compact && <span className="desk-agent-post-words" data-post-id={latest.id}>{excerpt(latest.words, 160)}</span>}
          <span className="desk-agent-post-heading">
            <strong>{title}</strong>
            <time dateTime={latest.at}>{age(latest.at, now)}</time>
          </span>
          {!compact && parent && <small className="desk-agent-post-parent">{excerpt(parent.words, 64)}</small>}
          {!compact && <span className="desk-agent-post-words" data-post-id={latest.id}>{latest.words}</span>}
        </button>
        {!compact && <PostWork post={latest} go={go}/>}
      </li>)}
  </ul>;
}

export function AgentPostHistory({ title, posts, now, go, continued = false }: {
  title: string;
  posts: readonly AgentPost[];
  continued?: boolean;
  go?(href: string): void;
  now: number;
}) {
  return <ol className="desk-agent-history" aria-label={title}>
    {posts.map((post,index) => <li key={post.id} data-reply={continued || index > 0 || undefined}>
      <time dateTime={post.at}>{age(post.at, now)}</time>
      <p>{post.words}</p>
      <PostWork post={post} go={go}/>
      {post.source && go && posts[index+1]?.source!==post.source &&
        <Button variant="ghost" onClick={()=>go(threadPath(post.source!))}>Source conversation</Button>}
    </li>)}
  </ol>;
}
