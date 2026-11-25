import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Signin from '../shell/signin';
import { useDataQuery } from '../data/graphql';
import type { SharedTask, SharedTaskComment } from '../pieces/tasks/shared-view';
import '../looks/looks.css';
import './style.css';
import face from './art.png';

const ticketId = 't-9';
const query = `query ContextTicket($id:String!) {
  ticket:tasksSingle(where:{id:{eq:$id}}) {
    id title status goal doneWhen createdAt createdBy closeReason ask
    taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}}) {seq at actor text}
  }
}`;
type Note = Pick<SharedTaskComment,'seq'|'at'|'actor'|'text'>;
type Ticket = Pick<SharedTask,'id'|'title'|'status'|'goal'|'doneWhen'|'createdAt'|'createdBy'|'closeReason'|'ask'> & {taskCommentsByTask: Note[]};
type Intent = 'history'|'decision';
const labels = {history:'What happened?', decision:'What needs a decision?'};
const intentFromAddress = ():Intent => location.hash === '#history' ? 'history' : 'decision';
const date = (value:string) => new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});

function Module({title,children,core=false}:{title:string;children:ReactNode;core?:boolean}) {
  return <section className={'module'+(core?' core':'')}><h2>{title}</h2>{children}</section>;
}
function Source({note}:{note:Note}) {
  return <details className="source"><summary>Read note · {date(note.at)}</summary><p>{note.text}</p><small>{note.actor} · Note {note.seq}</small></details>;
}
// Keep note text and its preview behind the same authorized read.
function noteLead(note:Note) {
  const words=note.text.replace(/^(?:night shift )?\d{4}-\d{2}-\d{2}[^:]{0,30}:\s*/i,'');
  const first=words.split(/(?<=[.!?])\s+/)[0];
  return first.length<=95 ? first : first.slice(0,92).replace(/\s+\S*$/,'')+'…';
}
function Timeline({notes}:{notes:Note[]}) {
  return <ol className="timeline">{notes.map(note=><li key={note.seq}><time dateTime={note.at}>{date(note.at)}</time>
    <details><summary>{noteLead(note)}</summary><p>{note.text}</p><small>{note.actor} · Note {note.seq}</small></details></li>)}</ol>;
}
function Brief({ticket}:{ticket:Ticket}) {
  return <Module title="Original brief"><p>{ticket.goal}</p>{ticket.createdAt && <small>Opened {date(ticket.createdAt)} by {ticket.createdBy}</small>}</Module>;
}
function Decision({ticket}:{ticket:Ticket}) {
  const notes=ticket.taskCommentsByTask;
  const sample=notes.find(note=>note.seq===7), verification=notes.find(note=>note.seq===8);
  const request=notes.find(note=>note.seq===2);
  const openIssue=verification?.text.match(/(?:^|(?<=\. ))[^.]*remains a separate decision[^.]*\./i)?.[0];
  const counts=sample?.text.match(/\((\d+)\s*\/\s*(\d+)\)/);
  return <>
    <Module core title={ticket.status==='closed'?'Outcome':'Decision in scope'}>
      <h3>{ticket.status==='closed'?'Ticket closed':ticket.ask || openIssue || ticket.goal}</h3>
      {ticket.closeReason && <p>{ticket.closeReason}</p>}
      {ticket.status!=='closed' && <details className="source"><summary>Completion criterion</summary><p>{ticket.doneWhen}</p></details>}
      {request && <Source note={request}/>}
    </Module>
    {sample && <Module title="Routing sample">{counts && <><div className="measure">{counts[1]} <span>/ {counts[2]}</span></div><p>Sampled memories classified as misfiled</p></>}<Source note={sample}/></Module>}
    {verification && <Module title="Duplicate handling"><p>{verification.text.split('. ')[0]}.</p><Source note={verification}/></Module>}
    {notes[0] && notes[0].seq>8 && <Module title="Latest update"><p>{notes[0].text}</p><small>{date(notes[0].at)}</small></Module>}
  </>;
}
function Workspace({ticket}:{ticket:Ticket}) {
  const [intent,focus]=useState(intentFromAddress),[bar,openBar]=useState(false);
  const [command,setCommand]=useState(''),[miss,setMiss]=useState(false);
  const [extras,setExtras]=useState({history:false,decision:false});
  const [turns,setTurns]=useState<string[]>([]),[chat,showChat]=useState(false);
  const input=useRef<HTMLInputElement>(null), dock=useRef<HTMLButtonElement>(null);
  const notes=ticket.taskCommentsByTask;
  useEffect(()=>{
    const change=()=>{focus(intentFromAddress());setMiss(false);};
    const key=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openBar(v=>!v);}};
    window.addEventListener('hashchange',change);window.addEventListener('keydown',key);
    return ()=>{window.removeEventListener('hashchange',change);window.removeEventListener('keydown',key);};
  },[]);
  useEffect(()=>{if(bar) input.current?.focus();},[bar]);
  function closeBar(){openBar(false);setCommand('');dock.current?.focus();}
  function run(words:string){
    const value=words.trim().toLowerCase();if(!value)return;
    const extra=intent==='history'?'decision criteria':'history';
    let result:string;
    if(/^(add|show|include)\b/.test(value) && value.includes(extra)){
      setExtras(current=>({...current,[intent]:true}));result='Added '+extra+' to this view.';
    } else if(/decision|needs? (me|my)|attention/.test(value)){
      location.hash='decision';result='Opened the decision view.';
    } else if(/what happened|history|catch me up/.test(value)){
      location.hash='history';result='Opened the history view.';
    } else {
      setMiss(true);setTurns(t=>[...t,words+' — No matching view.']);closeBar();return;
    }
    setMiss(false);setTurns(t=>[...t,words+' — '+result]);closeBar();
  }
  return <div className="workspace"><header><span className="wordmark">loom</span><span className="context">Loom</span>
    <button className="chatToggle" aria-expanded={chat} onClick={()=>showChat(v=>!v)}>Conversation</button></header>
    <main><nav aria-label="Open views">{(['decision','history'] as const).map(key=><a key={key} aria-current={intent===key?'page':undefined} href={'#'+key}>{labels[key]}</a>)}</nav>
    <div className="subject"><small>{ticket.id.toUpperCase()} <span>·</span> {ticket.status.replace('_',' ')}</small><h1>{ticket.title}</h1></div>
    <div className="layout"><div className="viewStack">{(['decision','history'] as const).map(view=><div key={view} hidden={view!==intent}><div className="modules">
    {view==='decision'?<Decision ticket={ticket}/>:<>
      <Module core title="Ticket history"><Timeline notes={notes}/>{!notes.length && <p>No notes yet.</p>}</Module>
      <Brief ticket={ticket}/>
      {notes[0] && <Module title="Latest recorded finding"><p>{notes[0].text}</p><small>{notes[0].actor} · {date(notes[0].at)}</small></Module>}
    </>}
    {extras[view] && <Module title={view==='decision'?'Ticket history':'Decision criteria'}>{view==='decision'?<Timeline notes={notes}/>:<p>{ticket.doneWhen}</p>}
      <button onClick={()=>setExtras(current=>({...current,[intent]:false}))}>Remove from view</button></Module>}
    {miss && view===intent && <Module title="Which view did you mean?"><button onClick={()=>run(labels.history)}>{labels.history}</button> <button onClick={()=>run(labels.decision)}>{labels.decision}</button> <button onClick={()=>setMiss(false)}>Dismiss</button></Module>}
    </div></div>)}</div>{chat && <aside><h2>Conversation</h2>{turns.length?turns.map((t,i)=><p key={i}>{t}</p>):<p>Your view requests appear here.</p>}</aside>}</div></main>
    <div className="dock">{bar && <form onSubmit={e=>{e.preventDefault();run(command);}} onKeyDown={e=>{if(e.key==='Escape')closeBar();}}>
      <label htmlFor="intent">What would you like to see?</label><input ref={input} id="intent" value={command} onChange={e=>setCommand(e.target.value)} autoComplete="off"/>
      <div className="suggestions">{[labels.history,labels.decision,intent==='decision'?'Add history':'Add decision criteria'].map(s=><button type="button" key={s} onClick={()=>run(s)}>{s}</button>)}</div>
    </form>}<button className="art" ref={dock} aria-expanded={bar} onClick={()=>openBar(v=>!v)}><img src={face} alt=""/><strong>Art</strong><span>Adjust view</span><kbd>⌘ / Ctrl K</kbd></button></div>
    </div>;
}
function App(){
  const read=useDataQuery<{ticket:Ticket|null}>(query,{id:ticketId});
  if(read.status!=='live'||!read.data?.ticket)return <main role="status">{read.status==='loading'?'Opening ticket…':read.status==='live'?'Ticket unavailable.':'Connection unavailable. Reconnecting…'}</main>;
  return <Workspace ticket={read.data.ticket}/>;
}
createRoot(document.getElementById('root')!).render(<Signin><App/></Signin>);
