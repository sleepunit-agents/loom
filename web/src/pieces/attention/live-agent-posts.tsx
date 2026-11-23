import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDataQuery } from '../../data/graphql';
import { Body, Button, Loading, Section } from '../../kit';
import { AgentPostFeed, AgentPostHistory, type AgentPost, type AgentPostPreview } from './agent-posts';
import { agentPath } from './home-model';

export const agentFeedQuery = `query AgentActivityFeed($agent:String!,$limit:Int!,$compact:Boolean!){
  agentActivityFeed(agent:$agent,limit:$limit){thread title latest{id at words work @skip(if:$compact){id title state href}} parent{id words}}
}`;
export const agentHistoryQuery = `query AgentActivityHistory($agent:String!,$thread:String!,$after:String!,$limit:Int!){
  agentActivityHistory(agent:$agent,thread:$thread,after:$after,limit:$limit){id at words source work{id title state href}}
}`;
const pageSize = 25;

function usePostClock(active: boolean) {
  const [now,setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function LiveAgentFeed({ agent, compact = false, go, onChange, showEmpty = false }: {
  agent: string; compact?: boolean; go(path: string): void; onChange?(): void; showEmpty?: boolean;
}) {
  const query = useDataQuery<{agentActivityFeed: AgentPostPreview[]}>(agentFeedQuery, {agent,limit:compact?1:5,compact});
  const threads = query.status === 'live' ? query.data?.agentActivityFeed : undefined;
  const latest = threads?.[0];
  const previous = useRef(latest);
  useLayoutEffect(() => {
    if (previous.current?.latest.id !== latest?.latest.id || previous.current?.title !== latest?.title) onChange?.();
    previous.current = latest;
  }, [latest, onChange]);
  const now = usePostClock(!!threads?.length);
  if (!threads?.length) {
    if (!showEmpty) return null;
    if (query.status === 'loading') return <Loading label="Opening activity…"/>;
    return <Body quiet>{threads ? 'No updates yet.' : 'Activity unavailable.'}</Body>;
  }
  return <AgentPostFeed threads={threads} now={now} compact={compact} go={go}
    open={id=>go(agentPath(agent)+'?activity='+encodeURIComponent(id))}/>;
}

export function LiveAgentHistory({ agent, thread, go }: {
  agent: string; thread: string; go(path: string): void;
}) {
  const previews = useDataQuery<{agentActivityFeed: AgentPostPreview[]}>(agentFeedQuery, {agent,limit:5,compact:false});
  const title = previews.status === 'live' ? previews.data?.agentActivityFeed?.find(row=>row.thread===thread)?.title : undefined;
  const [cursors,setCursors] = useState(['0']);
  const after = cursors[cursors.length - 1];
  const query = useDataQuery<{agentActivityHistory: (AgentPost & {source: string})[]}>(agentHistoryQuery, {agent,thread,after,limit:pageSize+1});
  const posts = query.status === 'live' ? query.data?.agentActivityHistory : undefined;
  const now = usePostClock(!!posts?.length);
  return <Section label={title || "Activity thread"}>
    <Button variant="ghost" onClick={()=>go(agentPath(agent))}>Back to agent</Button>
    {query.status === 'loading' ? <Loading label="Opening activity…"/> :
      !posts?.length ? <Body quiet>Activity unavailable.</Body> :
      <AgentPostHistory continued={after!=='0'} title="Activity posts" posts={posts.slice(0,pageSize)} now={now} go={go}/>}
    {cursors.length>1 && <Button variant="ghost" onClick={()=>setCursors(c=>c.slice(0,-1))}>Earlier posts</Button>}
    {posts && posts.length>pageSize && <Button variant="ghost" onClick={()=>setCursors([...cursors,posts[pageSize-1].id])}>Later posts</Button>}
  </Section>;
}
