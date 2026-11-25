import { useEffect, useState } from 'react';
import { taskPath } from '../../../../src/task-route';
import { useDataQuery } from '../../data/graphql';
import { Body, Error, LinkButton, Loading, Row, Section } from '../../kit';

const query = `query WorkCatchUp($since:String!) {
  projects(orderBy:{name:{direction:asc,priority:1},id:{direction:asc,priority:0}}) {
    id name lifecycle
    tasksByProject(where:{changedAt:{gt:$since}},orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:4) {
      id title changedAt createdAt startedAt closedAt status closeReason ask
      taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}},limit:1){at text}
    }
  }
}`;
type Ticket = {
  id:string; title:string; changedAt:string; createdAt:string; startedAt:string|null; closedAt:string|null;
  status:string; closeReason:string|null; ask:string|null; taskCommentsByTask:{at:string;text:string}[];
};
type Project = { id:string; name:string; lifecycle:string; tasksByProject:Ticket[] };

function headline(ticket:Ticket,since:string) {
  const latest = ticket.taskCommentsByTask[0];
  if (ticket.status==='closed' && ticket.closedAt===ticket.changedAt) {
    return ticket.closeReason==='done' ? 'Completed' : 'Closed' + (ticket.closeReason ? ' · '+ticket.closeReason : '');
  }
  if (latest && latest.at>since) return latest.text;
  if (ticket.ask) return ticket.ask;
  if (ticket.startedAt===ticket.changedAt) return 'Work started';
  if (ticket.createdAt===ticket.changedAt) return 'Ticket opened';
  return 'Ticket updated';
}

export function CatchUp({member,go}:{member:string;go:(path:string)=>void}) {
  const key = 'loom.work.last-visit.'+member;
  const [since] = useState(()=>{
    try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
  });
  const feed = useDataQuery<{projects:Project[]}>(query,{since});
  const live = feed.status==='live' && !feed.settling;
  const projects = live ? feed.data?.projects.filter(p=>p.lifecycle!=='removed' && p.tasksByProject.length) ?? [] : [];
  const latest = projects.reduce((max,p)=>p.tasksByProject[0].changedAt>max ? p.tasksByProject[0].changedAt : max,'');
  useEffect(()=>{
    if (!latest) return;
    try {
      if (latest>(localStorage.getItem(key) ?? '')) localStorage.setItem(key,latest);
    } catch { /* A browser without storage still gets the recent activity view. */ }
  },[key,latest]);
  if (feed.status==='loading' || feed.settling) return <Loading label="Reading project updates…"/>;
  if (!live) return <Error text="Project updates unavailable."/>;
  return <Section label={since ? 'Since your last visit on this desktop' : 'Recent project updates'}>
    {projects.map(project=><section key={project.id} aria-label={project.name+' updates'}>
      <LinkButton onClick={()=>go('/p/work/project/'+project.id)}>{project.name}</LinkButton>
      {project.tasksByProject.slice(0,3).map(ticket=><Row key={ticket.id} layout="stack" title={ticket.title}
        meta={headline(ticket,since)} onClick={()=>go(taskPath(ticket.id))}/>)}
      {project.tasksByProject.length>3 && <LinkButton onClick={()=>go('/p/work/project/'+project.id)}>More in {project.name}</LinkButton>}
    </section>)}
    {!projects.length && <Body quiet>{since ? 'No project tickets have changed since your last visit.' : 'No recent ticket updates.'}</Body>}
  </Section>;
}
