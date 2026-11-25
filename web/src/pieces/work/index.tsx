import { ClaimControls } from './claim-controls';
import { WorkDiscussion } from './discuss';
import { useReadingVisible } from '../../data/visibility';
import { CatchUp } from './catch-up';
import { ProjectNeeds } from './project-needs';
import { ProjectBoard } from './board';
import { UnfiledTickets } from './unfiled';
import { taskPath } from '../../../../src/task-route';
import { AppFrame, Body, Empty, Error, LinkButton, List, Loading, Row, Section } from '../../kit';
import { useDataQuery } from '../../data/graphql';
import { unfiledBase, unfiledPage, workHomeQuery, workProjectQuery } from './query';

type Ticket = {id:string; title:string; status:'open'|'in_progress'|'closed'; changedAt:string};
type Project = {id:string; name:string; lifecycle:'active'|'retired'|'removed'};
const base = '/p/work';
const statusWords = {open:'Open', in_progress:'In progress', closed:'Closed'};

export default function Work({visible=true,path=base,go=(href:string)=>location.assign(href)}:{visible?:boolean;path?:string;go?:(href:string)=>void}) {
  const reading = useReadingVisible(visible);
  const viewer = useDataQuery<{homeComms:{member:string}|null}>('query WorkViewer { homeComms { member } }');
  const member = viewer.status==='live' && !viewer.settling ? viewer.data?.homeComms?.member : undefined;
  const [,,,section,sectionId] = path.split('/');
  const projectId = section==='project' ? sectionId : undefined;
  const unfiled = section==='unfiled';
  const decisions = useDataQuery<{inboxProjectNeeds:{project:string;needs:number}[]}>(
    'query WorkProjectDecisions { inboxProjectNeeds { project needs } }', {}, {pause:!!projectId || unfiled || !reading});
  const home = useDataQuery<{projects:(Project & {tasksByProject:Ticket[]})[];inFlight:{id:string;tasksByProject:{id:string}[]}[];unfiled:Ticket[]}>(workHomeQuery, {}, {pause:!!projectId || unfiled});
  const detail = useDataQuery<{project:Project|null;working:Ticket[];recent:Ticket[]}>(workProjectQuery,{id:projectId ?? ''},{pause:!projectId});
  if (unfiled) return <div className="p-4"><AppFrame title="Unfiled tickets" where={path} go={go} crumb={{label:'Work',href:base}}>
    <UnfiledTickets page={unfiledPage(path)} go={go}/>
  </AppFrame></div>;
  const feed = projectId ? detail : home;
  if (feed.status === 'loading' || feed.settling) return <Loading label="Opening Work…"/>;
  if (feed.status !== 'live') return <Error text="Project information is unavailable."/>;
  if (projectId) {
    const project = detail.data?.project;
    if (!project || project.id !== projectId || project.lifecycle==='removed') return <Empty title="Project unavailable"><LinkButton onClick={()=>go(base)}>All projects</LinkButton></Empty>;
    if (path.endsWith('/board')) return <div className="p-4"><AppFrame title={project.name+' board'} where={path} go={go}
      crumb={{label:project.name,href:base+'/project/'+project.id}}><ProjectBoard key={project.id} project={project.id} go={go}/></AppFrame></div>;
    const tickets = (label:string, rows:Ticket[]) => <Section label={label}><List label={label}>{rows.map(ticket=>
      <Row key={ticket.id} title={ticket.title} status={statusWords[ticket.status]} onClick={()=>go(taskPath(ticket.id))}/>
    )}</List></Section>;
    const {working,recent:recentTickets} = detail.data!;
    const recent = recentTickets.filter(ticket=>!working.some(active=>active.id===ticket.id));
    return <div className="p-4"><AppFrame title={project.name} where={path} go={go} crumb={{label:'Work',href:base}}>
      <ProjectNeeds key={project.id} project={project.id} go={go}/>
      {project.lifecycle==='retired' && <Body quiet>Retired project</Body>}
      {project.lifecycle==='active' && working.length>0 && tickets('Claimed tickets',working)}
      {(project.lifecycle==='retired' ? recentTickets : recent).length>0 && tickets('Recent tickets',project.lifecycle==='retired' ? recentTickets : recent)}
      {!recentTickets.length && <Empty title="No tickets here yet"/>}
      {project.lifecycle==='active' && <ClaimControls key={'claims-'+project.id} project={project.id}/>}
      <WorkDiscussion key={'discuss-'+project.id} kind="project" id={project.id} go={go}/>
      <LinkButton onClick={()=>go(base+'/project/'+project.id+'/board')}>Open board</LinkButton>
      <LinkButton onClick={()=>go('/p/tasks-preview/?folder='+encodeURIComponent('project:'+project.id))}>Browse project backlog</LinkButton>
    </AppFrame></div>;
  }
  const projects = home.data?.projects.filter(project=>project.lifecycle!=='removed') ?? [];
  const active = projects.filter(project=>project.lifecycle==='active');
  const workingIds = new Set(home.data?.inFlight.filter(row=>row.tasksByProject.length).map(row=>row.id));
  const activeCount = active.filter(project=>workingIds.has(project.id)).length;
  const needs = new Map(decisions.status==='live' && !decisions.settling
    ? decisions.data?.inboxProjectNeeds.map(row=>[row.project,row.needs]) : []);
  const decisionTotal = projects.reduce((sum,project)=>sum+(needs.get(project.id) ?? 0),0);
  const grid = (rows:typeof projects) => <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">{rows.map(project=>
    <div key={project.id} className="overflow-hidden rounded-lg border border-[var(--v-border)]">
      <Row layout="stack" title={project.name} meta={project.tasksByProject[0]?.title} status={[project.tasksByProject[0] ? statusWords[project.tasksByProject[0].status] : 'No tickets',
        needs.has(project.id) && `Needs you · ${needs.get(project.id)}`].filter(Boolean).join(' · ')} onClick={()=>go(base+'/project/'+project.id)}/>
    </div>
  )}</div>;
  const retired = projects.filter(project=>project.lifecycle==='retired');
  const latestUnfiled = home.data?.unfiled?.[0];
  const context = [
    active.length && `${active.length} active project${active.length===1 ? '' : 's'} · ${activeCount} with claimed tickets`,
    decisionTotal && `${decisionTotal} project question${decisionTotal===1 ? '' : 's'} waiting for you`,
  ].filter(Boolean).join(' · ');
  return <div className="p-4"><AppFrame title="Work" where={base} go={go} context={context || undefined}>
    {grid(active)}
    {latestUnfiled && <div className="overflow-hidden rounded-lg border border-[var(--v-border)]">
      <Row layout="stack" title="Unfiled tickets" meta={latestUnfiled.title} status="Not in a project" onClick={()=>go(unfiledBase)}/>
    </div>}
    {member && reading && <CatchUp key={member} member={member} go={go}/>}
    {retired.length>0 && <details><summary>Retired projects ({retired.length})</summary>{grid(retired)}</details>}
    {!projects.length && !latestUnfiled && <Empty title="No projects yet"/>}
  </AppFrame></div>;
}
