import { HomeMessageComposer } from './home-composer';
import { threadPath, type Summaries } from './home-comms-data';
export { useHomeComms, threadPath } from './home-comms-data';
/** The message bar on an agent's card: its words name it ("Message Art"), so it has no heading or label of its own. */
export function HomeComposer({agent,name,reading,go}:{agent:string;name:string;reading?:Summaries;go(path:string):void}) {
 return <div className="desk-home-compose" data-compose={agent}>{reading?.agents.includes(agent)?<HomeMessageComposer key={`${reading.member}:${agent}`} member={reading.member} agent={agent} name={name} onOpened={id=>go(threadPath(id))} />:<p>Connect to start a conversation.</p>}</div>;
}
