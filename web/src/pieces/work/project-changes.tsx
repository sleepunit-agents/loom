import {useDataQuery} from '../../data/graphql';
import {Body,Empty,Error,List,Loading,Pager,Row,Section} from '../../kit';

type Change={id:string;repository:string;number:number;title:string;state:string;draft:boolean;checks:string;review:string;changeTasksByChange:{task:string}[]};
type Sync={readAt:string|null;failed:boolean;nextAt:string|null};
const size=40;
const query=`query WorkProjectChanges($project:String!,$offset:Int!){
  changes(where:{project:{eq:$project}},orderBy:{updatedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:41,offset:$offset){
    id repository number title state draft checks review changeTasksByChange(limit:1){task}
  }
  changeSync{readAt failed nextAt}
}`;
export function ProjectChanges({project,path,go}:{project:string;path:string;go:(path:string)=>void}) {
  const base='/p/work/project/'+encodeURIComponent(project)+'/changes';
  const raw=new URLSearchParams(path.split('?')[1]).get('page') ?? '1';
  const valid=/^[1-9]\d{0,5}$/.test(raw);
  const page=valid ? Number(raw)-1 : 0;
  const result=useDataQuery<{changes:Change[];changeSync:Sync[]}>(query,{project,offset:page*size},{pause:!valid});
  const openPage=(n:number)=>go(n ? base+'?page='+(n+1) : base);
  if(!valid)return <Empty title="Page unavailable"/>;
  if(result.status==='loading'||result.settling)return <Loading label="Reading project pull requests…"/>;
  if(result.status!=='live'||!result.data)return <Error text="Project pull requests are unavailable."/>;
  const sync=result.data.changeSync[0], rows=result.data.changes;
  return <Section label="Pull requests">
    <Body quiet>{sync?.failed && 'Latest GitHub read failed. '}{sync?.readAt
      ? 'Last successful household GitHub read '+new Date(sync.readAt).toLocaleString()+'.'
      : sync ? 'No successful household GitHub read recorded.' : 'GitHub read time unavailable.'}</Body>
    {rows.length ? <List label="Project pull requests">{rows.slice(0,size).map(pr=><Row key={pr.id} title={pr.title}
      meta={pr.repository.replace(/^github:/,'')+' #'+pr.number+' · '+(pr.changeTasksByChange.length ? 'Linked ticket' : 'No visible ticket link')}
      status={pr.state==='open' ? [pr.draft?'Draft':'Open','checks '+pr.checks,pr.review.replaceAll('_',' ')].join(' · ') : pr.state}
      onClick={()=>go('/p/changes-preview/change/'+encodeURIComponent(pr.id))}/>)}</List> :
      <Empty title={page?'No more pull requests':'No visible pull requests for this project'}/>}
    <Pager label="Project pull requests" hasPrevious={page>0} hasNext={rows.length>size}
      previous={()=>openPage(page-1)} next={()=>openPage(page+1)}/>
  </Section>;
}
