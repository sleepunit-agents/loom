import { useEffect, useRef, useState } from 'react';
import { Button, Row } from '../../kit';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../components/ui/dropdown-menu';
import { bindRowHold } from './row-hold';

interface Thread {id:string;agent:string;title:string|null;last:number;working:boolean;unread:boolean;pinned:boolean;archived:number|null}
type Action = 'pin' | 'unpin' | 'archive' | 'unarchive';
/** The open target and menu trigger are siblings; a menu action never opens the reader. */
export function ThreadRow({thread:t,selected,disabled,onOpen,onAction}:{thread:Thread;selected:boolean;disabled:boolean;onOpen():void;onAction(action:Action):void}){
 const [open,setOpen]=useState(false);const trigger=useRef<HTMLButtonElement>(null);
 const target=useRef<HTMLButtonElement>(null),hold=useRef<ReturnType<typeof bindRowHold>>(undefined);
 const latest=useRef({disabled,pinned:t.pinned,onAction});latest.current={disabled,pinned:t.pinned,onAction};
 useEffect(()=>{if(!target.current)return;const bound=bindRowHold(target.current,()=>!latest.current.disabled&&!latest.current.pinned,()=>latest.current.onAction('pin'));hold.current=bound;return()=>{bound.dispose();hold.current=undefined;};},[]);
 useEffect(()=>{if(disabled||t.pinned)hold.current?.cancel();},[disabled,t.pinned]);
 const act=(action:Action)=>{setOpen(false);onAction(action);};
 const showMenu=()=>{if(disabled)return;trigger.current?.focus();setOpen(true);};
 return <Row ref={target} title={t.title??`New thread with ${t.agent}`}
  icon={<span className="comms-agent-letter" aria-hidden="true">{Array.from(t.agent)[0]?.toUpperCase()??'?'}</span>}
  meta={<span className="flex flex-wrap gap-x-2"><span>{t.agent}</span><time aria-label="Thread activity time" dateTime={new Date(t.last).toISOString()}>{new Date(t.last).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} CT</time>{t.working&&<span aria-label="Thread working">working…</span>}</span>}
  unread={t.unread} selected={selected} onClick={onOpen}
  onContextMenu={e=>{e.preventDefault();showMenu();}}
  onKeyDown={e=>{if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();showMenu();}}}
  actions={<div onKeyDown={e=>e.stopPropagation()}><DropdownMenu open={open} onOpenChange={next=>setOpen(next&&!disabled)}>
   <DropdownMenuTrigger asChild><Button ref={trigger} variant="outline" disabled={disabled} aria-label={`Actions for ${t.title??`New thread with ${t.agent}`}`}>⋯</Button></DropdownMenuTrigger>
   <DropdownMenuContent align="end" aria-label="Thread actions">
    <DropdownMenuItem disabled={disabled} onSelect={()=>act(t.pinned?'unpin':'pin')}>{t.pinned?'Unpin':'Pin'}</DropdownMenuItem>
    <DropdownMenuItem disabled={disabled} onSelect={()=>act(t.archived===null?'archive':'unarchive')}>{t.archived===null?'Archive':'Unarchive'}</DropdownMenuItem>
   </DropdownMenuContent>
  </DropdownMenu></div>}/>;
}
