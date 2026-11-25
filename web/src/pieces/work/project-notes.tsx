import {useDataQuery} from '../../data/graphql';
import {useAgentNames} from '../../data/names';
import {Body,LinkButton,Section} from '../../kit';
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
    <LinkButton onClick={()=>go('/p/projects-preview/project/'+encodeURIComponent(card.id))}>{displayName(card.agent,names)} · {card.name}</LinkButton>
    {card.goal && <Body>{card.goal}</Body>}{card.summary && <Body quiet>{card.summary}</Body>}
  </div>)}</Section>;
}
