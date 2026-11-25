import { workTicketPath } from '../../../../src/task-route';
import { useDataQuery } from '../../data/graphql';
import { Empty, Error, LinkButton, List, Loading, Pager, Row, Section } from '../../kit';
import { unfiledBase, unfiledPageSize, unfiledPath, workUnfiledQuery } from './query';

type Ticket = {id:string; title:string; status:'open'|'in_progress'|'closed'; changedAt:string};
const statusWords = {open:'Open', in_progress:'In progress', closed:'Closed'};
export function UnfiledTickets({page,go}:{page:number;go:(path:string)=>void}) {
  const feed = useDataQuery<{unfiled:Ticket[]}>(workUnfiledQuery,{offset:Math.max(page,0)*unfiledPageSize},{pause:page<0});
  if (page<0) return <Empty title="Page unavailable"><LinkButton onClick={()=>go(unfiledBase)}>First page</LinkButton></Empty>;
  if (feed.status==='loading' || feed.settling) return <Loading label="Reading unfiled tickets…"/>;
  if (feed.status!=='live' || !feed.data) return <Error text="Unfiled tickets are unavailable."/>;
  const rows = feed.data.unfiled.slice(0,unfiledPageSize);
  if (!rows.length) return page>0
    ? <Empty title="No more unfiled tickets"><LinkButton onClick={()=>go(unfiledBase)}>First page</LinkButton></Empty>
    : <Empty title="No unfiled tickets" text="Every ticket you can see belongs to a project."/>;
  return <>
    <Section label="Tickets with no project"><List label="Unfiled tickets">{rows.map(ticket=>
      <Row key={ticket.id} title={ticket.title} status={statusWords[ticket.status]} onClick={()=>go(workTicketPath(ticket.id))}/>
    )}</List></Section>
    <Pager label="Unfiled tickets" hasPrevious={page>0} hasNext={feed.data.unfiled.length>unfiledPageSize}
      previous={()=>go(unfiledPath(page-1))} next={()=>go(unfiledPath(page+1))}/>
  </>;
}
