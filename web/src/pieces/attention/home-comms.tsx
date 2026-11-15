import { Button } from '../../kit';
import { Composer } from '../comms/composer';
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
export function HomeComposer({agent,name,reading,go}:{agent:string;name:string;reading?:Summaries;go(path:string):void}) {
 return <section className="desk-home-compose" aria-label={`Message ${name}`}><h3>Message {name}</h3>{reading?.agents.includes(agent)?<Composer key={`${reading.member}:${agent}`} member={reading.member} agent={agent} onOpened={id=>go(threadPath(id))} enabled />:<p>Connect to start a conversation.</p>}</section>;
}
