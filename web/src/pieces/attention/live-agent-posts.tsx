import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDataQuery } from '../../data/graphql';
import { Body, Button, Loading, Section } from '../../kit';
import { AgentPostFeed, AgentPostHistory, type AgentPost, type AgentPostPreview } from './agent-posts';
import { agentPath } from './home-model';

export const agentFeedQuery = `query AgentActivityFeed($agent:String!,$limit:Int!,$compact:Boolean!,$before:String!="0"){
  agentActivityFeed(agent:$agent,limit:$limit,before:$before){thread title latest{id at words work @skip(if:$compact){id title state href}} parent @skip(if:$compact){id words}}
}`;
export const agentHistoryQuery = `query AgentActivityHistory($agent:String!,$thread:String!,$after:String!,$limit:Int!){
  selected:agentActivityFeed(agent:$agent,thread:$thread,limit:1){title}
  agentActivityHistory(agent:$agent,thread:$thread,after:$after,limit:$limit,newestFirst:true){id at words source work{id title state href}}
}`;
const pageSize = 25;
const previewCount = 5;

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

export function LiveAgentFeed({ agent, compact = false, go, onChange, showEmpty = false, before }: {
  agent: string; compact?: boolean; go(path: string): void; onChange?(): void; showEmpty?: boolean; before?: string;
}) {
  const limit = compact ? 1 : previewCount + 1;
  const query = useDataQuery<{agentActivityFeed: AgentPostPreview[]}>(agentFeedQuery, {agent,limit,compact,before:before ?? '0'});
  const threads = query.status === 'live' ? query.data?.agentActivityFeed : undefined;
  const latest = threads?.[0];
  const previous = useRef(latest);
  useLayoutEffect(() => {
    if (previous.current?.latest.id !== latest?.latest.id || previous.current?.title !== latest?.title) onChange?.();
    previous.current = latest;
  }, [latest, onChange]);
  const now = usePostClock(!!threads?.length);
  const base = agentPath(agent);
  const page = before && before !== '0' ? '?before='+encodeURIComponent(before) : '';
  const firstPage = page && <Button variant="ghost" onClick={()=>go(base)}>Latest activities</Button>;
  if (!threads?.length) {
    if (!showEmpty) return null;
    if (query.status === 'loading') return <Loading label="Opening activity…"/>;
    return <><Body quiet>{threads ? page ? 'No earlier activities.' : 'No updates yet.' : 'Activity unavailable.'}</Body>{firstPage}</>;
  }
  const visible = threads.slice(0,previewCount);
  return <><AgentPostFeed threads={visible} now={now} compact={compact} go={go}
    open={id=>go(base+page+(page?'&':'?')+'activity='+encodeURIComponent(id))}/>
    {firstPage}
    {!compact && threads.length>previewCount && <Button variant="ghost" onClick={()=>go(base+'?before='+encodeURIComponent(visible[visible.length-1].latest.id))}>Earlier activities</Button>}
  </>;
}

export function LiveAgentHistory({ agent, thread, go, before }: {
  agent: string; thread: string; go(path: string): void; before?: string;
}) {
  const [cursors,setCursors] = useState(['0']);
  const after = cursors[cursors.length - 1];
  const query = useDataQuery<{selected: {title:string}[]; agentActivityHistory: (AgentPost & {source: string})[]}>(agentHistoryQuery, {agent,thread,after,limit:pageSize+1});
  const title = query.status === 'live' ? query.data?.selected?.[0]?.title : undefined;
  const posts = query.status === 'live' ? query.data?.agentActivityHistory : undefined;
  const now = usePostClock(!!posts?.length);
  return <Section label={title || "Activity thread"}>
    <Button variant="ghost" onClick={()=>go(agentPath(agent)+(before ? '?before='+encodeURIComponent(before) : ''))}>Back to agent</Button>
    {query.status === 'loading' ? <Loading label="Opening activity…"/> :
      !posts?.length ? <Body quiet>Activity unavailable.</Body> :
      <AgentPostHistory openerId={posts.length<=pageSize ? posts[posts.length-1].id : null} title="Activity posts" posts={posts.slice(0,pageSize)} now={now} go={go}/>}
    {cursors.length>1 && <Button variant="ghost" onClick={()=>setCursors(c=>c.slice(0,-1))}>Newer posts</Button>}
    {posts && posts.length>pageSize && <Button variant="ghost" onClick={()=>setCursors([...cursors,posts[pageSize-1].id])}>Earlier posts</Button>}
  </Section>;
}
