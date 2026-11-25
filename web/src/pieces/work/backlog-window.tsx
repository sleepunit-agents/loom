import {useState} from 'react';
import {taskPath} from '../../../../src/task-route';
import {useDataQuery} from '../../data/graphql';
import {Actions,Body,Button,Empty,Error,Field,Fields,Input,LinkButton,List,Loading,Pager,Row,Section} from '../../kit';

const labels = {
  start:'Open at the start', end:'Open at the end', originalEverClosed:'Original tickets that closed',
  originalClosed:'Original tickets still closed',
  originalMovedOut:'Original tickets now elsewhere', addedOpen:'Added to the open backlog',
  created:'Tickets created here', arrivalsClosed:'New tickets that also closed', reopened:'Reopened here',
  movedIn:'Moved into this project', movedOut:'Moved out of this project',
};
type Group=keyof typeof labels;
type Window={coverage:string;from:string;until:string;counts:{key:Group;total:number}[];tickets:{id:string;title:string}[]};
const query=`query WorkBacklogWindow($project:String!,$since:String!,$until:String!,$group:String,$offset:Int!){
  projectBacklogWindow(project:$project,since:$since,until:$until,group:$group,offset:$offset,limit:50){
    coverage from until counts{key total} tickets{id title}
  }
}`;
const iso=(value:string|null)=>value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const local=(iso:string)=>{
  const date=new Date(iso);
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
};
const display=(iso:string)=>new Date(iso).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
function route(project:string,since:string,until:string,group?:Group,page=0) {
  const params=new URLSearchParams({since,until});
  if(group)params.set('group',group);
  if(page)params.set('page',String(page+1));
  return '/p/work/project/'+encodeURIComponent(project)+'/history?'+params;
}
export function BacklogWindow({project,path,detail,go}:{project:string;path:string;detail?:boolean;go:(path:string)=>void}) {
  const [opened]=useState(()=>Date.now());
  const params=new URLSearchParams(path.split('?')[1]);
  const since=iso(params.get('since')) ?? new Date(opened-7*86400000).toISOString();
  const until=iso(params.get('until')) ?? new Date(opened).toISOString();
  const selected=params.get('group');
  const group=selected && Object.hasOwn(labels,selected) ? selected as Group : undefined;
  const rawPage=params.get('page') ?? '1';
  const page=/^[1-9]\d{0,5}$/.test(rawPage) ? Number(rawPage)-1 : 0;
  const [first,setFirst]=useState(local(since)),[last,setLast]=useState(local(until));
  const data=useDataQuery<{projectBacklogWindow:Window|null}>(query,{project,since,until,group:group ?? null,offset:page*50});
  if(data.status==='loading'||data.settling)return <Loading label="Reading backlog history…"/>;
  if(data.status!=='live'||!data.data?.projectBacklogWindow)return <Error text="Backlog history is unavailable."/>;
  const report=data.data.projectBacklogWindow;
  const counts=new Map(report.counts.map(row=>[row.key,row.total]));
  const choose=(key?:Group,n=0)=>go(route(project,since,until,key,n));
  const count=(key:Group)=>counts.get(key) ?? 0;
  return <Section label="Backlog history">
    {detail && <form onSubmit={e=>{
      e.preventDefault();
      const a=iso(first),b=iso(last);
      if(a&&b&&a<=b)go(route(project,a,b));
    }}><Fields><Field label="From"><Input type="datetime-local" value={first} max={last} required onChange={e=>setFirst(e.target.value)}/></Field>
      <Field label="Through"><Input type="datetime-local" value={last} min={first} required onChange={e=>setLast(e.target.value)}/></Field></Fields>
      <Button type="submit">Compare</Button></form>}
    <Body quiet>{display(since)} – {display(until)} · Tickets you can open today</Body>
    {since<report.coverage && <Body quiet>History starts {display(report.coverage)}.</Body>}
    {counts.size>0 && <Body>{count('start')} open at the start · {count('end')} open at the end</Body>}
    {!detail && <LinkButton onClick={()=>choose()}>Compare backlog and see tickets</LinkButton>}
    {detail && counts.size>0 && <>
      <Actions>{(Object.keys(labels) as Group[]).map(key=><LinkButton key={key} aria-pressed={group===key}
        onClick={()=>choose(key)}>{labels[key]} · {count(key)}</LinkButton>)}</Actions>
      {group && <Section label={labels[group]}>
        {report.tickets.length ? <List label={labels[group]}>{report.tickets.map(ticket=><Row key={ticket.id} title={ticket.title}
          onClick={()=>go(taskPath(ticket.id))}/>)}</List> : <Empty title="No tickets on this page"/>}
        <Pager label={labels[group]} hasPrevious={page>0} hasNext={(page+1)*50<count(group)}
          previous={()=>choose(group,page-1)} next={()=>choose(group,page+1)}/>
      </Section>}
    </>}
  </Section>;
}
