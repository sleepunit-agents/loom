import {useState} from 'react';
import {taskPath} from '../../../../src/task-route';
import {useDataQuery} from '../../data/graphql';
import {useAgentNames} from '../../data/names';
import {Body,Error,Loading,Pager,Row,Section} from '../../kit';
import {displayName} from '../../kit/words';

const pageSize=50;
const query=`query ProjectBoard($project:String!,$offset:Int!){
  projectBoardTickets(project:$project,offset:$offset,limit:51){id project title assignee lane reason}
  finished:tasks(where:{project:{eq:$project},status:{eq:closed},type:{ne:epic}},
    orderBy:{closedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:5){id title closeReason}
}`;
interface Card {id:string;title:string;project:string;assignee:string|null;lane:string;reason:string|null}
export function ProjectBoard({project,go}:{project:string;go:(path:string)=>void}) {
  const [page,setPage]=useState(0);
  const feed=useDataQuery<{projectBoardTickets:Card[];finished:{id:string;title:string;closeReason:string|null}[]}>(query,{project,offset:page*pageSize});
  const names=useAgentNames();
  if (feed.status==='loading' || feed.settling) return <Loading label="Opening board…"/>;
  if (feed.status!=='live' || !feed.data) return <Error text="Ticket board unavailable."/>;
  const rows=feed.data.projectBoardTickets.filter(row=>row.project===project);
  const cards=rows.slice(0,pageSize);
  return <>
    <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
      {['Working','Waiting','Verifying'].map(lane=><Section key={lane} label={lane}>
        {cards.filter(card=>card.lane===lane).map(card=><Row key={card.id} layout="stack" title={card.title}
          meta={card.reason} status={card.assignee ? displayName(card.assignee,names) : undefined} onClick={()=>go(taskPath(card.id))}/>)}
        {!cards.some(card=>card.lane===lane) && <Body quiet>No tickets</Body>}
      </Section>)}
      <Section label="Recently finished">{feed.data.finished.map(card=><Row key={card.id} layout="stack" title={card.title}
        status={card.closeReason==='cancelled' ? 'Cancelled' : 'Ticket closed'} onClick={()=>go(taskPath(card.id))}/>)}
        {!feed.data.finished.length && <Body quiet>No closed tickets</Body>}
      </Section>
    </div>
    <Pager label="Active board tickets" hasPrevious={page>0} hasNext={rows.length>pageSize} previous={()=>setPage(page-1)} next={()=>setPage(page+1)}/>
  </>;
}
