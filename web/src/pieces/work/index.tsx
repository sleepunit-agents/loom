import { lazy, Suspense, useState } from 'react';
import './home.css';
import './project.css';
import {WorkFrame} from './toolbar';
import {ProjectNotes,WorkNotes} from './project-notes';
import {ProjectChanges} from './project-changes';
import {BacklogWindow} from './backlog-window';
import { ClaimControls } from './claim-controls';
import { WorkDiscussion } from './discuss';
import { useReadingVisible } from '../../data/visibility';
import { CatchUp, ProjectPosts } from './catch-up';
import { ProjectNeeds } from './project-needs';
import { ProjectBoard } from './board';
import { UnfiledTickets } from './unfiled';
import { taskPath } from '../../../../src/task-route';
import { Body, Empty, Error, List, Loading, Row, Section } from '../../kit';
import { useDataQuery } from '../../data/graphql';
import { unfiledBase, unfiledPage, workHomeQuery, workProjectQuery } from './query';

type Ticket = {id:string; title:string; status:'open'|'in_progress'|'closed'; changedAt:string};
type Project = {id:string; name:string; goal:string|null; lifecycle:'active'|'retired'|'removed'};
const Backlog = lazy(()=>import('../../data/tasks-app'));
const Changes = lazy(()=>import('../../data/work-views').then(module=>({default:module.ChangesApp})));
const base = '/p/work';
const statusWords = {open:'Open', in_progress:'In progress', closed:'Closed'};

export default function Work({visible=true,path=base,go=(href:string)=>location.assign(href)}:{visible?:boolean;path?:string;go?:(href:string)=>void}) {
  const [projectSearch, setProjectSearch] = useState('');
  const reading = useReadingVisible(visible);
  const viewer = useDataQuery<{homeComms:{member:string}|null}>('query WorkViewer { homeComms { member } }');
  const member = viewer.status==='live' && !viewer.settling ? viewer.data?.homeComms?.member : undefined;
  const [,,,section,sectionId] = path.split('?')[0].split('/');
  const projectId = section==='project' ? sectionId : undefined;
  const unfiled = section==='unfiled';
  const backlog = section==='backlog';
  const changes = section==='changes';
  const offHome = !!projectId || unfiled || backlog || changes || section==='notes';
  const decisions = useDataQuery<{inboxProjectNeeds:{project:string;needs:number}[]}>(
    'query WorkProjectDecisions { inboxProjectNeeds { project needs } }', {}, {pause:offHome || !reading});
  const home = useDataQuery<{projects:(Project & {tasksByProject:Ticket[]})[];inFlight:{id:string;tasksByProject:{id:string}[]}[];unfiled:Ticket[]}>(workHomeQuery, {}, {pause:offHome});
  const detail = useDataQuery<{project:Project|null;working:Ticket[];recent:Ticket[]}>(workProjectQuery,{id:projectId ?? ''},{pause:!projectId});
  if (section==='notes') return <WorkFrame title="Work" path={path} go={go}><WorkNotes path={path} go={go}/></WorkFrame>;
  if (changes) return <WorkFrame title="Work" path={path} go={go}>
    <Suspense fallback={<Loading label="Opening pull requests…"/>}><Changes path={path} base={base+'/changes'} go={go}/></Suspense>
  </WorkFrame>;
  if (backlog) return <WorkFrame title="Work" path={path} go={go}>
    <Suspense fallback={<Loading label="Opening backlog…"/>}><Backlog path={path} go={go}/></Suspense>
  </WorkFrame>;
  if (unfiled) return <WorkFrame title="Unfiled tickets" path={path} go={go}>
    <UnfiledTickets page={unfiledPage(path)} go={go}/>
  </WorkFrame>;
  const feed = projectId ? detail : home;
  if (feed.status === 'loading' || feed.settling) return <WorkFrame title="Work" path={path} go={go}><Loading label="Opening Work…"/></WorkFrame>;
  if (feed.status !== 'live') return <WorkFrame title="Work" path={path} go={go}><Error text="Project information is unavailable."/></WorkFrame>;
  if (projectId) {
    const project = detail.data?.project;
    if (!project || project.id !== projectId || project.lifecycle==='removed') return <WorkFrame title="Work" path={path} go={go}><Empty title="Project unavailable"/></WorkFrame>;
    const frame = {title:project.name,path,go,project:project.id};
    const view = path.split('?')[0].split('/')[5];
    if (view==='notes') return <WorkFrame {...frame}><WorkNotes project={project.id} path={path} go={go}/></WorkFrame>;
    if (view==='backlog') return <WorkFrame {...frame}>
      <Suspense fallback={<Loading label="Opening backlog…"/>}><Backlog key={project.id} path={path} go={go} backlogProject={project.id}/></Suspense>
    </WorkFrame>;
    const changeBase = base+'/project/'+encodeURIComponent(project.id)+'/changes';
    if (view==='changes' && path.startsWith(changeBase+'/change/')) return <WorkFrame {...frame}>
      <Suspense fallback={<Loading label="Opening pull request…"/>}><Changes path={path} base={changeBase} project={project.id}
        go={href=>go(href===changeBase && path.includes('?') ? href+path.slice(path.indexOf('?')) : href)}/></Suspense>
    </WorkFrame>;
    if (view==='changes') return <WorkFrame {...frame}><ProjectChanges project={project.id} path={path} go={go}/></WorkFrame>;
    if (view==='history') return <WorkFrame {...frame}><BacklogWindow key={path} project={project.id} path={path} detail go={go}/></WorkFrame>;
    if (view==='board') return <WorkFrame {...frame}><ProjectBoard key={project.id} project={project.id} path={path} go={go}/></WorkFrame>;
    const tickets = (label:string, rows:Ticket[]) => <Section label={label}><List label={label}>{rows.map(ticket=>
      <Row key={ticket.id} title={ticket.title} status={statusWords[ticket.status]} onClick={()=>go(taskPath(ticket.id,project.id))}/>
    )}</List></Section>;
    const {working,recent:recentTickets} = detail.data!;
    const recent = recentTickets.filter(ticket=>!working.some(active=>active.id===ticket.id));
    return <WorkFrame {...frame}>
      {project.goal && <Body>{project.goal}</Body>}
      {project.lifecycle==='retired' && <Body quiet>Retired project</Body>}
      <div className="work-project-panes">
        <div className="work-project-stream">
          <ProjectNeeds key={'needs-'+project.id} project={project.id} go={go}/>
          {project.lifecycle==='active' && working.length>0 && tickets('Claimed tickets',working)}
          <ProjectPosts project={project.id} go={go}/>
          {(project.lifecycle==='retired' ? recentTickets : recent).length>0 && tickets('Recent tickets',project.lifecycle==='retired' ? recentTickets : recent)}
          {!recentTickets.length && <Empty title="No tickets here yet"/>}
        </div>
        <aside className="work-project-side" aria-label="Project tools">
          <WorkDiscussion key={'discuss-'+project.id} kind="project" id={project.id} go={go}/>
          {project.lifecycle==='active' && <ClaimControls key={'claims-'+project.id} project={project.id}/>}
          <ProjectNotes project={project.id} go={go}/>
          <BacklogWindow key={'history-'+project.id} project={project.id} path={path} go={go}/>
        </aside>
      </div>
    </WorkFrame>;
  }
  const projects = home.data?.projects.filter(project=>project.lifecycle!=='removed') ?? [];
  const active = projects.filter(project=>project.lifecycle==='active');
  const workingIds = new Set(home.data?.inFlight.filter(row=>row.tasksByProject.length).map(row=>row.id));
  const activeCount = active.filter(project=>workingIds.has(project.id)).length;
  const needs = new Map(decisions.status==='live' && !decisions.settling
    ? decisions.data?.inboxProjectNeeds.map(row=>[row.project,row.needs]) : []);
  const decisionTotal = projects.reduce((sum,project)=>sum+(needs.get(project.id) ?? 0),0);
  const match = projectSearch.trim().toLocaleLowerCase();
  const matches = (project:Project) => project.name.toLocaleLowerCase().includes(match);
  const grid = (rows:typeof projects) => <div className="work-files">{rows.map(project=>{
    const latest = project.tasksByProject[0];
    const waiting = needs.get(project.id) ?? 0;
    return <article className="work-file" key={project.id} data-waiting={waiting>0 || undefined}>
      <button type="button" data-split-row="" className="work-file-target" onClick={()=>go(base+'/project/'+project.id)}>
        <span className="work-file-name"><i aria-hidden="true" className="work-folder"/>{project.name}</span>
        {project.goal && <span className="work-file-goal">{project.goal}</span>}
        <span className="work-file-latest">
          {latest && <span className="work-ticket-caption">Latest ticket · {statusWords[latest.status]}</span>}
          {latest?.title ?? 'No tickets'}
        </span>
        <span className="work-file-foot">
          {waiting>0 && <strong>Needs you · {waiting}</strong>}
          <span aria-hidden="true" className="work-arrow">↗</span>
        </span>
      </button>
    </article>;
  })}</div>;
  const retired = projects.filter(project=>project.lifecycle==='retired' && matches(project));
  const latestUnfiled = home.data?.unfiled?.[0];
  return <WorkFrame title="Work" path={path} go={go} controls={projects.length>1 &&
    <input type="search" value={projectSearch} onChange={event=>setProjectSearch(event.target.value)}
      aria-label="Find a project" placeholder="Find a project…"/>}>
    <dl className="work-counters" aria-label="Project overview">
      <div><dt>Active projects</dt><dd>{active.length}</dd></div>
      <div><dt>With claimed tickets</dt><dd>{activeCount}</dd></div>
      <div data-waiting={decisionTotal>0 || undefined}><dt>Questions for you</dt>
        <dd>{decisions.status==='live' && !decisions.settling ? decisionTotal : <span aria-label="Count unavailable">—</span>}</dd></div>
    </dl>
    <div className="work-panes">
      <section className="work-directory" aria-label="Project directory">
        <h2>Project directory</h2>
        {grid(active.filter(matches))}
        {match && !projects.some(matches) && <Empty title="No matching projects"/>}
        {retired.length>0 && <details key={match ? 'filtered' : 'all'} open={match ? true : undefined}><summary>Retired projects ({retired.length})</summary>{grid(retired)}</details>}
        {!projects.length && !latestUnfiled && <Empty title="No projects yet"/>}
        {latestUnfiled && <div className="work-unfiled"><Row title="Unfiled tickets" meta={latestUnfiled.title}
          trailing={<span aria-hidden="true">↗</span>} onClick={()=>go(unfiledBase)}/></div>}
      </section>
      {member && reading && <aside className="work-bulletin" aria-label="Project activity"><CatchUp key={member} member={member} go={go}/></aside>}
    </div>
  </WorkFrame>;
}
