import { useDataQuery } from '../../data/graphql';
import { LinkButton } from '../../kit';
import { taskPath } from '../../../../src/task-route';

export function WorkSubjectLink({kind,id,go}:{kind:'ticket'|'project';id:string;go:(href:string)=>void}) {
  const ticket=kind==='ticket';
  const query=ticket ? 'query SubjectTicket($id:String!){subject:tasksSingle(where:{id:{eq:$id}}){id label:title}}'
    : 'query SubjectProject($id:String!){subject:projectsSingle(where:{id:{eq:$id}}){id label:name lifecycle}}';
  const feed=useDataQuery<{subject:{id:string;label:string;lifecycle?:string}|null}>(query,{id});
  if(feed.status==='loading' || feed.settling) return <>Opening work item…</>;
  const row=feed.status==='live' ? feed.data?.subject : null;
  if(row?.id!==id || row.lifecycle==='removed') return <>Work item unavailable</>;
  return <LinkButton onClick={()=>go(ticket ? taskPath(id) : '/p/work/project/'+encodeURIComponent(id))}>{row.label}</LinkButton>;
}
