import {ToolbarControls} from '../../kit/toolbar';
import {NativeSelect} from '../../kit/native-select';
import {taskPath} from '../../../../src/task-route';
import {useDataQuery} from '../../data/graphql';
import {useAgentNames} from '../../data/names';
import {Body,Empty,Error,LinkButton,Loading,Pager,Row,Section} from '../../kit';
import {displayName} from '../../kit/words';

const pageSize=50;
const query=`query ProjectBoard($project:String!,$epic:String,$offset:Int!){
  epics:tasks(where:{project:{eq:$project},type:{eq:epic}},orderBy:{title:{direction:asc,priority:1},id:{direction:asc,priority:0}}){id title}
  projectBoardTickets(project:$project,epic:$epic,offset:$offset,limit:51){id project title assignee lane reason}
  finished:projectBoardTickets(project:$project,epic:$epic,finished:true,limit:5){id title reason}
}`;
interface Card {id:string;title:string;project:string;assignee:string|null;lane:string;reason:string|null}
export function ProjectBoard({project,path,go}:{project:string;path:string;go:(path:string)=>void}) {
  const [base,search] = path.split('?');
  const params = new URLSearchParams(search);
  const epic = params.get('epic') || null;
  const rawPage = params.get('page') ?? '1';
  const valid = /^[1-9]\d{0,5}$/.test(rawPage);
  const page = valid ? Number(rawPage)-1 : 0;
  function openPage(filter:string|null,index:number) {
    const next = new URLSearchParams();
    if (filter) next.set('epic',filter);
    if (index) next.set('page',String(index+1));
    go(next.size ? base+'?'+next : base);
  }
  const feed=useDataQuery<{epics:{id:string;title:string}[];projectBoardTickets:Card[];finished:Pick<Card,'id'|'title'|'reason'>[]}>(
    query,{project,epic,offset:page*pageSize},{pause:!valid});
  const names=useAgentNames();
  if (!valid) return <Empty title="Page unavailable"><LinkButton onClick={()=>openPage(epic,0)}>First page</LinkButton></Empty>;
  if (feed.status==='loading' || feed.settling) return <Loading label="Opening board…"/>;
  if (feed.status!=='live' || !feed.data) return <Error text="Ticket board unavailable."/>;
  if (epic && !feed.data.epics.some(row=>row.id===epic)) return <Empty title="Epic unavailable"><LinkButton onClick={()=>openPage(null,0)}>All epics</LinkButton></Empty>;
  const rows=feed.data.projectBoardTickets.filter(row=>row.project===project);
  const cards=rows.slice(0,pageSize);
  return <>
    {feed.data.epics.length>0 && <ToolbarControls><label className="work-board-filter">Epic <NativeSelect value={epic ?? ''} onChange={event=>openPage(event.target.value || null,0)}>
      <option value="">All epics</option>{feed.data.epics.map(row=><option key={row.id} value={row.id}>{row.title}</option>)}
    </NativeSelect></label></ToolbarControls>}
    <div className="work-lanes">
      {['Working','Waiting','Verifying'].map(lane=><Section key={lane} label={lane} className="work-lane" data-stage={lane}>
        {cards.filter(card=>card.lane===lane).map(card=><Row key={card.id} layout="stack" title={card.title}
          meta={card.reason} status={card.assignee ? displayName(card.assignee,names) : undefined} onClick={()=>go(taskPath(card.id,project))}/>)}
        {!cards.some(card=>card.lane===lane) && <Body quiet>No tickets</Body>}
      </Section>)}
      <Section label="Recently finished" className="work-lane" data-stage="Finished">{feed.data.finished.map(card=><Row key={card.id} layout="stack" title={card.title}
        status={card.reason ?? undefined} onClick={()=>go(taskPath(card.id,project))}/>)}
        {!feed.data.finished.length && <Body quiet>No closed tickets</Body>}
      </Section>
    </div>
    <Pager label="Active board tickets" hasPrevious={page>0} hasNext={rows.length>pageSize} previous={()=>openPage(epic,page-1)} next={()=>openPage(epic,page+1)}/>
  </>;
}
