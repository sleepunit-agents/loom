import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import { Button, Loading, Row } from '../../kit';
import type { InboxItem } from '../inbox-view/model';
import { retainedInboxItem } from './inbox-query';

export const deskWaitingCountsQuery = `query DeskWaitingCounts {
  homeComms { member }
  inboxFolders { needs agents { id needs } }
}`;
export interface WaitingCountsData { homeComms:{member:string}|null; inboxFolders:{needs:number;agents:{id:string;needs:number}[]} }
export interface WaitingCounts {status:DataQuerySnapshot<unknown>['status'];member?:string;total?:number;agents:ReadonlyMap<string,number>}
export function waitingCounts(query:DataQuerySnapshot<WaitingCountsData>):WaitingCounts {
  const empty=(status:WaitingCounts['status']):WaitingCounts=>({status,agents:new Map()});
  if(query.status!=='live')return empty(query.status);
  if(!query.data)return empty('loading');
  if(!query.data.homeComms?.member)return empty('denied');
  const folders=query.data.inboxFolders;
  if(!folders||!Number.isSafeInteger(folders.needs)||folders.needs<0||!Array.isArray(folders.agents))return empty('offline');
  const agents=new Map<string,number>();
  for(const row of folders.agents){
    if(typeof row.id!=='string'||agents.has(row.id)||!Number.isSafeInteger(row.needs)||row.needs<0)return empty('offline');
    agents.set(row.id,row.needs);
  }
  return {status:'live',member:query.data.homeComms.member,total:folders.needs,agents};
}
/** Counts and signals never select message wording. */
export function useDeskWaitingCounts():WaitingCounts {
  const query=useDataQuery<WaitingCountsData>(deskWaitingCountsQuery);
  return useMemo(()=>waitingCounts(query),[query]);
}
const fields='id toKind to source agent at state volume answers thread bodyKeepUntil body { words why } read refs';
export const deskWaitingFirstQuery=`query DeskWaitingFirst { homeComms { member } inboxItems(folder:"needs",limit:1) { ${fields} } }`;
export const deskAgentWaitingQuery=`query DeskAgentWaiting($agent:String!) { homeComms { member } inboxItems(folder:"needs",agent:$agent,limit:1) { ${fields} } }`;
export interface WaitingPreviewData {homeComms:{member:string}|null;inboxItems:WaitingWire[]}
export interface WaitingPreview {status:WaitingCounts['status'];item?:InboxItem}
type WaitingWire=InboxItem&{toKind:string;to:string};
function validWaiting(row:WaitingWire,agent?:string):boolean {
  return !(typeof row.id!=='string'||typeof row.source!=='string'||typeof row.at!=='string'||row.state!=='waiting'
    ||!['full','dim'].includes(row.volume)||!['yes-no','words'].includes(row.answers??'')||typeof row.read!=='boolean'
    ||!Array.isArray(row.refs)||row.refs.some(ref=>typeof ref!=='string')||agent!==undefined&&row.agent!==agent
    ||row.body&&(typeof row.body.words!=='string'||row.body.why!=null&&typeof row.body.why!=='string'));
}
export function waitingPreview(query:DataQuerySnapshot<WaitingPreviewData>,now:number,agent?:string):WaitingPreview {
  if(query.status!=='live')return {status:query.status};
  if(!query.data)return {status:'loading'};
  const member=query.data.homeComms?.member;
  if(!member)return {status:'denied'};
  if(!Array.isArray(query.data.inboxItems)||query.data.inboxItems.length>1)return {status:'offline'};
  const row=query.data.inboxItems[0];
  if(!row)return {status:'live'};
  if(row.toKind!=='person'||row.to!==member)return {status:'denied'};
  if(!validWaiting(row,agent))return {status:'offline'};
  return {status:'live',item:retainedInboxItem(row,now)};
}
export function useDeskWaitingPreview(agent?:string):WaitingPreview {
  const query=useDataQuery<WaitingPreviewData>(agent===undefined?deskWaitingFirstQuery:deskAgentWaitingQuery,agent===undefined?undefined:{agent});
  const [tick,setTick]=useState(0);
  const preview=useMemo(()=>waitingPreview(query,Date.now(),agent),[query,agent,tick]);
  const deadline=preview.item?.thread&&preview.item.body?Date.parse(preview.item.bodyKeepUntil??''):NaN;
  useEffect(()=>{
    if(!Number.isFinite(deadline)||deadline<=Date.now())return;
    const timer=setTimeout(()=>setTick(value=>value+1),Math.min(2147483647,Math.max(1,deadline-Date.now())));
    return()=>clearTimeout(timer);
  },[deadline,tick]);
  return preview;
}
/** Home's band: the first three waiting asks in one small request, with what says whether a Yes or No can be
 * given where the ask stands (who may answer, what it waits on, and whether its buttons have lines of their own). */
export const bandSize=3;
export const deskWaitingBandQuery=`query DeskWaitingBand { homeComms { member } inboxItems(folder:"needs",limit:${bandSize}) { ${fields.replace('body { words why }','body { words why ifYes ifNo }')} canAnswer waitsOnKind } }`;
export interface WaitingBand {status:WaitingCounts['status'];items:InboxItem[]}
export function waitingBand(query:DataQuerySnapshot<WaitingPreviewData>,now:number):WaitingBand {
  const none=(status:WaitingBand['status']):WaitingBand=>({status,items:[]});
  if(query.status!=='live')return none(query.status);
  if(!query.data)return none('loading');
  const member=query.data.homeComms?.member;
  if(!member)return none('denied');
  const rows=query.data.inboxItems;
  if(!Array.isArray(rows)||rows.length>bandSize)return none('offline');
  if(rows.some(row=>row.toKind!=='person'||row.to!==member))return none('denied');
  if(rows.some(row=>!validWaiting(row)))return none('offline');
  return {status:'live',items:rows.map(row=>retainedInboxItem(row,now))};
}
export function useDeskWaitingBand():WaitingBand {
  const query=useDataQuery<WaitingPreviewData>(deskWaitingBandQuery);
  const [tick,setTick]=useState(0);
  const band=useMemo(()=>waitingBand(query,Date.now()),[query,tick]);
  const deadline=Math.min(...band.items.filter(item=>item.thread&&item.body).map(item=>Date.parse(item.bodyKeepUntil??'')).filter(Number.isFinite),Infinity);
  useEffect(()=>{
    if(!Number.isFinite(deadline)||deadline<=Date.now())return;
    const timer=setTimeout(()=>setTick(value=>value+1),Math.min(2147483647,Math.max(1,deadline-Date.now())));
    return()=>clearTimeout(timer);
  },[deadline,tick]);
  return band;
}
export const waitingPath=(id?:string)=>id?`/p/inbox-preview/ask/${encodeURIComponent(id)}`:'/p/inbox-preview';
/** Only visible previews request words. Answers stay in the actual Inbox. */
export function WaitingRow({agent,go,onChange}:{agent?:string;go(path:string):void;onChange?():void}) {
  const preview=useDeskWaitingPreview(agent);
  const previous=useRef(preview);
  useLayoutEffect(()=>{if(previous.current!==preview){previous.current=preview;onChange?.();}},[preview,onChange]);
  if(preview.status==='loading')return <Loading label="Opening waiting item…"/>;
  if(preview.status!=='live')return <p>Waiting item unavailable. <Button variant="outline" type="button" onClick={()=>go(waitingPath())}>Open Inbox</Button></p>;
  const item=preview.item;
  if(!item)return <Button variant="outline" type="button" onClick={()=>go(waitingPath())}>Open Inbox</Button>;
  const words=item.body?.words||'Open it in the Inbox to read it.';
  return <Row layout="stack" title={item.volume==='dim'?words.split('\n')[0]:words}
    meta={item.volume==='dim'?undefined:item.body?.why} status={item.agent??'Household'} onClick={()=>go(waitingPath(item.id))}/>;
}
