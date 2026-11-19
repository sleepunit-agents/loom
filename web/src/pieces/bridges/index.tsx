import { ConnectionControl,ChannelControl,PersonControl,SendControl } from './controls';
import { useState, type ComponentProps } from 'react';
import { useLiveAgentIds } from '../../data/live-agents';
import { useDataQuery } from '../../data/graphql';
import { BridgesView, type BridgeFolder, type BridgeSelection } from '../bridges-view';
import { bridgesQuery, bridgesSnapshot, type BridgesData } from './data';

const base = '/p/bridges-preview';
const folders = new Set<BridgeFolder>(['connections', 'channels', 'people', 'sends']);
function selection(path: string): { folder: BridgeFolder; selected?: BridgeSelection } {
  const parts = path.split('?')[0].slice(base.length).split('/').filter(Boolean);
  const candidate = parts[0] === 'item' ? parts[1] : parts[0];
  const folder = folders.has(candidate as BridgeFolder) ? candidate as BridgeFolder : 'connections';
  if (parts[0] !== 'item' || !parts[2] || parts.length !== 3 || !folders.has(candidate as BridgeFolder)) return { folder };
  try { return { folder, selected: { folder, id: decodeURIComponent(parts[2]) } }; }
  catch { return { folder }; }
}
function LiveBridges({ path, go }: { path?: string; go?: (path: string) => void }) {
  const [local, setLocal] = useState(base);
  const route = selection(path ?? local), navigate = go ?? setLocal;
  const query=useDataQuery<BridgesData>(bridgesQuery),snapshot=bridgesSnapshot(query);
  const agents = useLiveAgentIds();
  const manage=snapshot.status==='live'&&query.data?.bridgeReader?.manage===true;
  return <BridgesView key={snapshot.member} snapshot={snapshot} member={snapshot.member} {...route}
    select={selected => navigate(selected ? `${base}/item/${selected.folder}/${encodeURIComponent(selected.id)}` : `${base}/${route.folder}`)}
    changeFolder={folder => navigate(`${base}/${folder}`)} cards={!manage?{
      // Reviewing a reply is not only a manager's: a reply in a direct message is reviewed by the people the message
      // is shown to (policy.ts, rules.reviewsReply). The door decides; a reply this person may not review is refused there.
      send:id=>{const row=snapshot.sends.find(row=>row.id===id);return row&&<SendControl key={JSON.stringify(row)} row={row}/>;},
    }:{
      create:route.folder==='sends'?null:<details key={route.folder}><summary>New {route.folder==='connections'?'connection':route.folder==='channels'?'channel rule':'person link'}</summary>{route.folder==='connections'?<ConnectionControl agents={agents}/>:route.folder==='channels'?<ChannelControl agents={agents}/>:<PersonControl/>}</details>,
      connection:id=>{const row=snapshot.connections.find(row=>row.id===id);return row&&<ConnectionControl key={JSON.stringify(row)} row={row} filters={snapshot.filters.filter(f=>f.connection===id)}/>;},
      channel:row=><ChannelControl key={JSON.stringify(row)} row={row} agents={agents}/>,person:row=><PersonControl key={JSON.stringify(row)} row={row}/>,
      send:id=>{const row=snapshot.sends.find(row=>row.id===id);return row&&<SendControl key={JSON.stringify(row)} row={row}/>;},
    }}/>;
}
/** The registered app now reads the generated schema itself. An explicit host
 * may still supply the same view contract, including its approval controls. */
export default function BridgesApp({ shared, ...navigation }: {
  path?: string; go?: (path: string) => void; shared?: ComponentProps<typeof BridgesView>;
} = {}) {
  return shared ? <BridgesView {...shared} /> : <LiveBridges {...navigation} />;
}
