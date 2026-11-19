import { Button } from '../../kit';
import { HomeMessageComposer } from './home-composer';
import { stamp } from './time';
import { threadPath, type Summaries } from './home-comms-data';
export { useHomeComms, threadPath } from './home-comms-data';
export function HomeConversations({agent,name,reading,go}:{agent:string;name:string;reading?:Summaries;go(path:string):void}) {
 const summary=reading?.summaries.find(s=>s.agent===agent);
 return <section aria-label={`${name} conversations`} className="grid min-w-0 gap-2"><h3>Recent conversations</h3>
 {!reading?<p>Conversations unavailable.</p>:<>
 {summary?.last?<Button variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal text-left" onClick={()=>go(threadPath(summary.last!.thread))}>{summary.last.title||'Recent conversation'} · {stamp(summary.last.at)}</Button>:<p>No conversations yet.</p>}
 {summary?.unread&&summary.first?<><Button variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal text-left" onClick={()=>go(threadPath(summary.first!.thread))}>{summary.unread} unread {summary.unread===1?'thread':'threads'}</Button></>:<p>No unread threads.</p>}
 </>}
 </section>;
}
/** The message bar on an agent's card: its words name it ("Message Art"), so it has no heading or label of its own. */
export function HomeComposer({agent,name,reading,go}:{agent:string;name:string;reading?:Summaries;go(path:string):void}) {
 return <div className="desk-home-compose" data-compose={agent}>{reading?.agents.includes(agent)?<HomeMessageComposer key={`${reading.member}:${agent}`} member={reading.member} agent={agent} name={name} onOpened={id=>go(threadPath(id))} />:<p>Connect to start a conversation.</p>}</div>;
}
