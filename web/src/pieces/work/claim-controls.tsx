import {useHouseholdZone} from '../../data/zone';
import {briefTime,fullTime} from '../../kit/time';
import {useRef,useState} from 'react';
import {useDataQuery} from '../../data/graphql';
import {useAgentNames} from '../../data/names';
import {memberOperation} from '../../data/operation';
import {Body,Error,LinkButton,Section} from '../../kit';
import {displayName} from '../../kit/words';

type Direction={agent:string;paused:boolean;revision:number;at:string|null};
const query='query WorkClaimStates($project:String!){projectClaimStates(project:$project){agent paused revision at}}';

export function ClaimControls({project}:{project:string}) {
  const feed=useDataQuery<{projectClaimStates:Direction[]}>(query,{project});
  const names=useAgentNames(),zone=useHouseholdZone(),locked=useRef(false);
  const [sending,setSending]=useState(false),[failed,setFailed]=useState(false);
  const rows=feed.status==='live' && !feed.settling ? feed.data?.projectClaimStates : undefined;
  async function change(row:Direction) {
    if(locked.current) return;
    locked.current=true;setSending(true);setFailed(false);
    try {
      await memberOperation('work.setProjectClaims',{project,agent:row.agent,paused:!row.paused,expectedRevision:row.revision});
    } catch {setFailed(true);}
    finally {locked.current=false;setSending(false);}
  }
  if(!rows?.length) return null;
  return <Section label="New ticket claims">{rows.map(row=><div key={row.agent}>
    <Body>{displayName(row.agent,names)} · {row.paused ? 'New claims paused' : 'New claims enabled'}{row.at && <> · <time dateTime={row.at} title={fullTime(row.at,zone)}>{briefTime(row.at,zone)}</time></>}</Body>
    <LinkButton disabled={sending} onClick={()=>void change(row)}>
      {(row.paused ? 'Resume new claims for ' : 'Pause new claims for ')+displayName(row.agent,names)}
    </LinkButton>
  </div>)}{failed && <Error text="The direction could not be saved. Check the current state and try again."/>}</Section>;
}
