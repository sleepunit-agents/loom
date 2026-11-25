import {useAgentNames} from '../../data/names';
import {displayName} from '../../kit/words';
import { useEffect, useState } from 'react';
import { workTicketPath } from '../../../../src/task-route';
import { useDataQuery } from '../../data/graphql';
import { Body, Error, LinkButton, Loading, Row, Section } from '../../kit';

const query = `query WorkCatchUp($since:String!) {
  projects(orderBy:{name:{direction:asc,priority:1},id:{direction:asc,priority:0}}) {
    id name lifecycle
    tasksByProject(where:{changedAt:{gte:$since}},orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:4) {
      id title changedAt createdAt startedAt closedAt status closeReason ask
      taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}},limit:1){at actor text}
    }
  }
}`;
type Ticket = {
  id:string; title:string; changedAt:string; createdAt:string; startedAt:string|null; closedAt:string|null;
  status:string; closeReason:string|null; ask:string|null; taskCommentsByTask:{at:string;actor:string;text:string}[];
};
type Project = { id:string; name:string; lifecycle:string; tasksByProject:Ticket[] };

function headline(ticket:Ticket,since:string,names:Readonly<Record<string,string>>,post?:Post) {
  const latest = ticket.taskCommentsByTask[0];
  if (ticket.status==='closed' && ticket.closedAt===ticket.changedAt) {
    if (!ticket.closeReason) return 'Closed';
    if (ticket.closeReason==='cancelled') return 'Cancelled';
    if (ticket.closeReason!=='done') return 'Closed · '+excerpt(ticket.closeReason);
    const note = latest && latest.at>since ? latest : undefined;
    const update = post && (!note || post.at>=note.at)
      ? {actor:post.agent,text:post.words} : note;
    return update ? 'Completed · '+displayName(update.actor,names)+' · '+excerpt(update.text) : 'Completed';
  }
  if (latest && latest.at>since) return excerpt(latest.text);
  if (ticket.ask) return ticket.ask;
  if (ticket.startedAt===ticket.changedAt) return 'Work started';
  if (ticket.createdAt===ticket.changedAt) return 'Ticket opened';
  return 'Ticket updated';
}

type Post={project:string;task:string;title:string;id:string;at:string;agent:string;words:string};
const postsQuery = `query WorkPostedUpdates($project:String,$since:String!,$after:String){
  projectActivityHighlights(project:$project,since:$since,after:$after){project task title id at agent words}
}`;
function saved(key:string) {
  try {return localStorage.getItem(key);} catch {return null;}
}
function excerpt(words:string) {
  const line=words.trim().replace(/\s+/g,' ');
  return line.length>220 ? line.slice(0,217)+'…' : line;
}
export function ProjectPosts({project,go}:{project:string;go:(path:string)=>void}) {
  const feed=useDataQuery<{projectActivityHighlights:Post[]}>(postsQuery,{project,since:'',after:null});
  const names=useAgentNames();
  if(feed.status==='loading'||feed.settling)return <Loading label="Reading project activity…"/>;
  if(feed.status!=='live')return <Body quiet>Project activity unavailable.</Body>;
  const posts=feed.data?.projectActivityHighlights ?? [];
  if(!posts.length)return null;
  return <Section label="Latest agent updates">{posts.map(p=><Row key={p.task} title={p.title}
    meta={displayName(p.agent,names)+' · '+excerpt(p.words)} onClick={()=>go(workTicketPath(p.task,project))}/>)}</Section>;
}

export function CatchUp({member,go}:{member:string;go:(path:string)=>void}) {
  const key='loom.work.last-visit.'+member,postKey=key+'.post';
  const [since]=useState(()=>saved(key) ?? '');
  const [after]=useState(()=>saved(postKey));
  const feed=useDataQuery<{projects:Project[]}>(query,{since});
  const activity=useDataQuery<{projectActivityHighlights:Post[]}>(postsQuery,{project:null,since,after});
  const names=useAgentNames();
  const live=feed.status==='live' && !feed.settling;
  const postsLive=activity.status==='live' && !activity.settling;
  const posts=postsLive ? activity.data?.projectActivityHighlights ?? [] : [];
  const grouped=new Map<string,Post[]>();
  for(const post of posts){
    const rows=grouped.get(post.project) ?? [];
    rows.push(post);grouped.set(post.project,rows);
  }
  const projects=live ? (feed.data?.projects ?? []).filter(p=>p.lifecycle!=='removed').map(project=>{
    const updates=new Map((grouped.get(project.id) ?? []).map(post=>[post.task,post]));
    const changed=project.tasksByProject.filter(t=>t.changedAt>since || updates.has(t.id));
    const tickets=new Map(changed.map(t=>{
      const post=updates.get(t.id);
      const closing=t.status==='closed' && t.closedAt===t.changedAt;
      if (post && (post.at>t.changedAt || (!closing && post.at===t.changedAt))) {
        return [t.id,{id:t.id,title:t.title,at:post.at,words:displayName(post.agent,names)+' · '+excerpt(post.words)}] as const;
      }
      return [t.id,{id:t.id,title:t.title,at:t.changedAt,words:headline(t,since,names,post)}] as const;
    }));
    for(const p of updates.values()){
      if(!tickets.has(p.task))tickets.set(p.task,{id:p.task,title:p.title,at:p.at,words:displayName(p.agent,names)+' · '+excerpt(p.words)});
    }
    return {...project,items:[...tickets.values()].sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id))};
  }).filter(p=>p.items.length) : [];
  const latest=projects.reduce((max,p)=>p.items[0].at>max?p.items[0].at:max,'');
  const newest=posts.reduce((max,p)=>Math.max(max,Number(p.id)),0);
  useEffect(()=>{
    try {
      if(latest>(localStorage.getItem(key) ?? ''))localStorage.setItem(key,latest);
      if(postsLive && (localStorage.getItem(postKey)===null || newest>Number(localStorage.getItem(postKey))))localStorage.setItem(postKey,String(newest));
    }catch{/* Read-only storage still supports this visit. */}
  },[key,postKey,latest,newest,postsLive]);
  if (feed.status==='loading'||feed.settling||activity.status==='loading'||activity.settling)return <Loading label="Reading project updates…"/>;
  if(!live)return <Error text="Project updates unavailable."/>;
  return <Section label={since ? 'Since your last visit on this desktop' : 'Recent project updates'}>
    {projects.map(project=><section key={project.id} aria-label={project.name+' updates'}>
      <LinkButton onClick={()=>go('/p/work/project/'+project.id)}>{project.name}</LinkButton>
      {project.items.slice(0,3).map(t=><Row key={t.id} layout="stack" title={t.title}
        meta={t.words} onClick={()=>go(workTicketPath(t.id,project.id))}/>)}
      {project.items.length>3 && <LinkButton onClick={()=>go('/p/work/project/'+project.id)}>More in {project.name}</LinkButton>}
    </section>)}
    {!postsLive && <Body quiet>Agent updates unavailable.</Body>}
    {!projects.length && <Body quiet>{since ? 'No project tickets have changed since your last visit.' : 'No recent ticket updates.'}</Body>}
  </Section>;
}
