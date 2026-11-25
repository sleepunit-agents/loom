import {lazy,Suspense} from 'react';
import {useDataQuery} from '../../data/graphql';
import {useAgentNames} from '../../data/names';
import {Body,LinkButton,Section,Loading,Error} from '../../kit';
import {displayName} from '../../kit/words';

type Contribution={id:string;agent:string;name:string;goal:string|null;summary:string|null};
export function ProjectNotes({project,go}:{project:string;go:(path:string)=>void}) {
  const names=useAgentNames();
  const feed=useDataQuery<{workProjectContributions:Contribution[]}>(`query WorkProjectNotes($project:String!){
    workProjectContributions(project:$project){id agent name goal summary}
  }`,{project});
  if(feed.status==='loading'||feed.settling)return <Body quiet>Reading project notes…</Body>;
  if(feed.status!=='live')return <Body quiet>Project notes unavailable.</Body>;
  const cards=feed.data?.workProjectContributions ?? [];
  if(!cards.length)return null;
  return <Section label="Project notes">{cards.map(card=><div key={card.id}>
    <LinkButton onClick={()=>go('/p/work/project/'+encodeURIComponent(project)+'/notes/project/'+encodeURIComponent(card.id))}>{displayName(card.agent,names)} · {card.name}</LinkButton>
    {card.goal && <Body>{card.goal}</Body>}{card.summary && <Body quiet>{card.summary}</Body>}
  </div>)}</Section>;
}

const Notes = lazy(()=>import('../projects'));
export function WorkNotes({project,path,go}:{project?:string;path:string;go:(path:string)=>void}) {
  const feed=useDataQuery<{workProjectContributions:{id:string}[]}>(
    'query WorkNoteIds($project:String!){workProjectContributions(project:$project){id}}',
    {project:project ?? ''},{pause:!project});
  if(project && (feed.status==='loading' || feed.settling)) return <Loading label="Opening project notes…"/>;
  if(project && feed.status!=='live') return <Error text="Project notes unavailable."/>;
  const base=project ? '/p/work/project/'+encodeURIComponent(project)+'/notes' : '/p/work/notes';
  const ids=project ? new Set(feed.data?.workProjectContributions.map(row=>row.id) ?? []) : undefined;
  return <Suspense fallback={<Loading label="Opening agent notes…"/>}><Notes base={base} path={path} go={go} cardIds={ids}/></Suspense>;
}
