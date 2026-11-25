import { useState } from 'react';
import { Body, Pager, Section } from '../../kit';
import { useAgentNames } from '../../data/names';
import { displayName } from '../../kit/words';
import { NeedChip } from '../attention/needs-band';
import { bandSize, useDeskWaitingBand, useDeskWaitingCounts } from '../attention/waiting';

export function ProjectNeeds({project,go}:{project:string;go:(path:string)=>void}) {
  const [requested,setRequested] = useState(0);
  const counts = useDeskWaitingCounts(project);
  const count = counts.total ?? 0;
  const last = Math.max(0,Math.ceil(count/bandSize)-1);
  const page = Math.min(requested,last);
  const band = useDeskWaitingBand(project,page*bandSize);
  const names = useAgentNames();
  if (counts.status === 'live' && !count) return null;
  return <Section label={counts.status==='live' ? `Needs you · ${count}` : 'Needs you'}>
    {counts.status==='live' && band.status==='live' ? <ul className="desk-needs-items">{band.items.map(item=>
      <NeedChip key={item.id} item={item} who={item.agent ? displayName(item.agent,names) : 'Household'} go={go}/>
    )}</ul> : <Body quiet>{counts.status==='loading' || band.status==='loading' ? 'Checking questions…' : 'Questions unavailable.'}</Body>}
    <Pager label="Project questions" hasPrevious={page>0} hasNext={page<last} previous={()=>setRequested(page-1)} next={()=>setRequested(page+1)}/>
  </Section>;
}
