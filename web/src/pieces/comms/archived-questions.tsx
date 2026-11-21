import { useMemo, useState } from 'react';
import { Button } from '../../kit';
import { useSelection } from '../../data/graphql/selection';
import { useDeadline } from './use-deadline';
import { fullTime } from '../../kit/time';

export interface ArchivedQuestion {
  thread:string; ref:string; raisedAt:string; verdict:string|null; answeredBy:string|null; answeredAt:string|null; wordsKeepUntil:string;
  body:{text:string;kind?:string;why?:string;if_yes?:string;if_no?:string;fine?:string;refs?:string[];relayedFrom?:string}|null;
}
export const archivedQuestionFields = 'thread ref raisedAt verdict answeredBy answeredAt wordsKeepUntil body{text kind why if_yes if_no fine refs relayedFrom}';
type Props = {thread:string;first:ArchivedQuestion[];name(id:string):string;zone?:string};
export function ArchivedQuestions({thread,first,name,zone}:Props) {
  const [offset,setOffset]=useState(0);
  const selection=useMemo(()=>({
    query:`query EarlierArchivedQuestions($thread:String!,$offset:Int!){commsArchivedQuestions(thread:$thread,offset:$offset,limit:51){${archivedQuestionFields}}}`,
    variables:{thread,offset},
    decode(data:Record<string,unknown>){return data.commsArchivedQuestions as ArchivedQuestion[];},
  }),[thread,offset]);
  const page=useSelection(selection,{pause:offset===0});
  const rows=offset===0?first:page.status==='live'?page.data??[]:[];
  const now=useDeadline(rows.map(row=>row.wordsKeepUntil));
  if(!first.length)return null;
  return <section aria-label="Archived questions"><h3>Archived questions</h3>
    {rows.slice(0,50).filter(row=>row.thread===thread).map(row=>{
      const body=Date.parse(row.wordsKeepUntil)>now?row.body:null;
      return <article key={row.ref}><time dateTime={row.raisedAt}>{fullTime(row.raisedAt,zone)}</time>
        <p>{body?.text??'Question text unavailable'}</p>
        {body?.why&&<p>{body.why}</p>}{body?.if_yes&&<p>{body.kind==='permission'?'If approved':'If yes'} · {body.if_yes}</p>}{body?.if_no&&<p>{body.kind==='permission'?'If denied':'If no'} · {body.if_no}</p>}
        {body?.fine&&<p>{body.fine}</p>}{body?.refs?.length?<p>{body.refs.join(', ')}</p>:null}
        {body?.relayedFrom&&<p>Relayed from {body.relayedFrom}</p>}
        <p>{row.verdict?<>Recorded outcome · {row.verdict}{row.answeredBy&&<> · {name(row.answeredBy)}</>}{row.answeredAt&&<> · {fullTime(row.answeredAt,zone)}</>}</>:'No answer recorded'}</p>
      </article>;
    })}
    {offset>0&&<Button onClick={()=>setOffset(offset-50)}>Newer questions</Button>}
    {rows.length>50&&<Button onClick={()=>setOffset(offset+50)}>Earlier questions</Button>}
  </section>;
}
