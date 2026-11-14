import {createContext,useCallback,useContext,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {useRecordScopes} from '../../data';
import {Button} from '../../kit';
import {refBatches,refBits} from './ref-bits';
import {replyHtml} from './render';
interface Card {kind:'task'|'pr'|'conversation';title:string;status:string;tone?:'bad'|'warn'|'ok';url:string}
interface CardsRow {id:string;thread:string;cards:Record<string,unknown>;[key:string]:unknown}
const kindName=(kind:Card['kind'])=>kind==='task'?'Task':kind==='pr'?'Pull request':'Conversation';
const Cards=createContext<ReadonlyMap<string,Card>>(new Map());
/** Navigation comes from the ref's exact identity, never a source-controlled URL. */
export function cardFor(ref:string,value:unknown):Card|undefined{
 if(!value||typeof value!=='object')return;
 const c=value as Card;
 if(typeof c.title!=='string'||c.title.length>200||typeof c.status!=='string'||c.status.length>200)return;
 let urls:string[]=[];
 if(c.kind==='task'&&/^t-\d{1,9}$/.test(ref))urls=[`/p/tasks-preview/task/${ref}`];
 if(c.kind==='conversation'&&/^cv-[0-9a-f]{12}$/.test(ref)&&/^\/p\/comms-preview\/thread\/[a-z0-9-]+$/.test(c.url))urls=[c.url];
 const m=/^github:([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/.exec(ref);
 if(c.kind==='pr'&&m&&![m[1],m[2]].some(s=>s==='.'||s==='..'))urls=[`/p/changes-preview/change/${encodeURIComponent(ref.toLowerCase())}`,`https://github.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}/issues/${m[3]}`];
 if(!urls.includes(c.url))return;
 return {kind:c.kind,title:c.title,status:c.status,url:c.url,...(['bad','warn','ok'].includes(c.tone??'')?{tone:c.tone}:{})};
}
const Navigate=createContext<((path:string)=>void)|undefined>(undefined);
/** Only rendered retained text contributes refs. Live owns refresh/reconnect; no card cache. */
export function ThreadRefs({thread,refs,connected,children,go}:{thread:string;refs:string[];connected:boolean;children:ReactNode;go?:(path:string)=>void}){
 const parentGo=useContext(Navigate);
 const batches=refBatches(refs,thread),scopes=batches.map(refs=>JSON.stringify({thread,refs}));
 const feeds=useRecordScopes<CardsRow>('comms.refCards',scopes),cards=new Map<string,Card>();
 if(connected)for(let i=0;i<scopes.length;i++){
  const feed=feeds[i],row=feed?.status==='live'?feed.records.find(r=>r.id===scopes[i]&&r.thread===thread):undefined;
  if(row?.cards&&typeof row.cards==='object')for(const ref of batches[i]){const c=cardFor(ref,Object.hasOwn(row.cards,ref)?row.cards[ref]:undefined);if(c)cards.set(ref,c);}
 }
 return <Navigate.Provider value={go??parentGo}><Cards.Provider value={cards}>{children}</Cards.Provider></Navigate.Provider>;
}
function CardPopup({card,at,close}:{card:Card;at:HTMLElement;close():void}){
 const go=useContext(Navigate);
 const box=useRef<HTMLDivElement>(null),[pos,setPos]=useState<{left:number;top:number}>();
 useLayoutEffect(()=>{
  const place=()=>{const r=at.getBoundingClientRect(),width=Math.min(300,innerWidth-32),height=box.current?.offsetHeight??140;setPos({left:Math.max(16,Math.min(r.left,innerWidth-width-16)),top:r.bottom+height+8<innerHeight?r.bottom+6:Math.max(8,r.top-height-6)});};
  place();
  const outside=(e:PointerEvent)=>{if(!box.current?.contains(e.target as Node)&&!at.contains(e.target as Node))close();};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();close();at.focus({preventScroll:true});}if(e.key==='Tab'){const nodes=box.current?.querySelectorAll<HTMLElement>('a,button');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};
  window.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',key,true);window.addEventListener('resize',place);const scroller=at.closest('[aria-label="Thread messages"]');scroller?.addEventListener('scroll',close);
  return()=>{window.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',key,true);window.removeEventListener('resize',place);scroller?.removeEventListener('scroll',close);};
 },[at,close]);
 const placed=!!pos;
 useLayoutEffect(()=>{if(placed)box.current?.querySelector<HTMLElement>('a,button')?.focus({preventScroll:true});},[placed]);
 return createPortal(<div ref={box} role="dialog" aria-modal="true" aria-label={`${kindName(card.kind)}: ${card.title}`} className="comms-refcard" style={pos??{visibility:'hidden'}}>
  <p>{kindName(card.kind)}</p><strong>{card.title}</strong><p data-tone={card.tone}>{card.status}</p>
  <a href={card.url} onClick={e=>{if(go&&card.url.startsWith('/')&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey){e.preventDefault();close();go(card.url);}}} {...(card.url.startsWith('https:')?{target:'_blank',rel:'noopener noreferrer'}:{})}>{card.url.startsWith('https:')?'Open on GitHub ↗':'Open'}</a>
  <Button variant="outline" onClick={()=>{close();at.focus({preventScroll:true});}}>Close</Button>
 </div>,document.body);
}
export function RefChip({refId,words}:{refId:string;words:string}){
 const card=useContext(Cards).get(refId),[at,setAt]=useState<HTMLElement>();
 const close=useCallback(()=>setAt(undefined),[]);
 useEffect(()=>{if(!card)setAt(undefined);},[card]);
 if(!card)return <>{words}</>;
 return <><button type="button" className="comms-chip" data-kind={card.kind} data-tone={card.tone} aria-haspopup="dialog" aria-expanded={!!at} aria-label={`${kindName(card.kind)} ${words}: ${card.title}, ${card.status}`} onClick={e=>{e.stopPropagation();setAt(at?undefined:e.currentTarget);}}>{words}</button>{at&&<CardPopup card={card} at={at} close={close}/>}</>;
}
export function RefText({text}:{text:string}){return <>{refBits(text).map((b,i)=>b.ref?<RefChip key={i} refId={b.ref} words={b.text}/>:b.text)}</>;}
/** Markdown's own text renderer marks references, excluding code and links. */
export function RefMarkdown({text}:{text:string}){
 const box=useRef<HTMLDivElement>(null),cards=useContext(Cards),[shown,setShown]=useState<{ref:string;at:HTMLElement;html:string}>();
 const close=useCallback(()=>setShown(undefined),[]);
 const html=replyHtml(text);
 useLayoutEffect(()=>{
  for(const el of box.current?.querySelectorAll<HTMLElement>('[data-comms-ref]')??[]){const card=cards.get(el.dataset.commsRef!);if(card){el.className='comms-chip';el.setAttribute('role','button');el.tabIndex=0;el.setAttribute('aria-haspopup','dialog');el.setAttribute('aria-label',`${kindName(card.kind)} ${el.textContent}: ${card.title}, ${card.status}`);el.dataset.tone=card.tone??'';}else{el.className='';for(const name of ['role','tabindex','aria-haspopup','aria-label','data-tone'])el.removeAttribute(name);}}
 },[html,cards]);
 useEffect(()=>{if(shown&&!cards.has(shown.ref))setShown(undefined);},[cards,shown]);
 const open=(e:React.MouseEvent|React.KeyboardEvent)=>{const el=(e.target as HTMLElement).closest<HTMLElement>('[data-comms-ref][role="button"]');if(!el||!cards.has(el.dataset.commsRef!)||('key'in e&&e.key!=='Enter'&&e.key!==' '))return;e.preventDefault();e.stopPropagation();setShown(shown?.at===el?undefined:{ref:el.dataset.commsRef!,at:el,html});};
 const card=shown&&shown.html===html&&cards.get(shown.ref);
 return <><div ref={box} className="prose break-words" dangerouslySetInnerHTML={{__html:html}} onClick={open} onKeyDown={open}/>{shown&&card&&<CardPopup card={card} at={shown.at} close={close}/>}</>;
}
