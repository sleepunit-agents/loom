import { NativeSelect } from '../../kit/native-select';
import { useRef,useState,type FormEvent } from 'react';
import { Button,Input } from '../../kit';
import { newId } from '../../data/id';
import type { BridgeConnectionRow,BridgeChannelRow,BridgePersonRow,BridgeSendRow,BridgesSnapshot } from '../bridges-view';
import {useSettingRequest,type Navigation} from '../attention/setting-request';
import {bridgeCommand,commandWords} from './command';
export {bridgeCommand} from './command';
function useCommand(){
 const pending=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 return {busy,message,async run(input:object){if(pending.current)return;pending.current=true;setBusy(true);setMessage('');try{setMessage(await bridgeCommand(input)?commandWords.saved:commandWords.notConfirmed);}finally{pending.current=false;setBusy(false);}}};
}
const field=(data:FormData,name:string)=>String(data.get(name)??'').trim();
const lines=(data:FormData,name:string)=>field(data,name).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
function Address({row,fixed=false}:{row?:{platform:string;workspace:string};fixed?:boolean}){return <><label>Platform<NativeSelect name="platform" disabled={fixed} defaultValue={row?.platform??'discord'}><option value="discord">Discord</option><option value="slack">Slack</option></NativeSelect>{fixed&&<input type="hidden" name="platform" value={row?.platform}/>}</label><label>Server or workspace ID<Input name="workspace" readOnly={fixed} defaultValue={row?.workspace} required maxLength={200}/></label></>;}
function AgentChoice({name, agents, current}: {name:string;agents?:ReadonlySet<string>;current?:string}) {
 return <NativeSelect key={current&&agents?.has(current)?current:''} name={name} required defaultValue={current&&agents?.has(current)?current:''}>
  <option value="" disabled>Choose an agent</option>
  {Array.from(agents??[]).map(id=><option key={id}>{id}</option>)}
 </NativeSelect>;
}
export function ConnectionControl({go,row,filters=[],agents}:Navigation&{row?:BridgeConnectionRow;filters?:BridgesSnapshot['filters'];agents?:ReadonlySet<string>}){
 const request=useSettingRequest({go},'bridge setting change','Bridge change request');
 const save=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const data=new FormData(event.currentTarget);request.prepare({action:'connection',id:row?.id??newId(),platform:row?.platform??field(data,'platform'),workspace:row?.workspace??field(data,'workspace'),agent:row?.agent??field(data,'agent'),botUser:row?.botUser??field(data,'botUser'),tokenSecret:field(data,'tokenSecret'),appSecret:field(data,'appSecret')||null,enabled:data.has('enabled'),only:lines(data,'only'),ignore:lines(data,'ignore')});};
 return <><form onChange={request.clear} onSubmit={save} className="grid gap-3"><Address row={row} fixed={!!row}/><label>Agent ID{row?<Input name="agent" readOnly defaultValue={row.agent}/>:<AgentChoice name="agent" agents={agents}/> }</label><label>Bot user ID<Input name="botUser" readOnly={!!row} defaultValue={row?.botUser} required maxLength={200}/></label>
  <label>Bot token secret name<Input name="tokenSecret" defaultValue={row?.tokenSecret} required maxLength={200}/></label><label>Slack app token secret name<Input name="appSecret" defaultValue={row?.appSecret??''} maxLength={200}/></label>
  <label><input name="enabled" type="checkbox" defaultChecked={row?.enabled??true}/>Enabled</label>
  {(['only','ignore'] as const).map(rule=><label key={rule}>{rule==='only'?'Only channels (one per line)':'Ignored channels (one per line)'}<textarea name={rule} defaultValue={filters.filter(f=>f.rule===rule).map(f=>f.channel).join('\n')}/></label>)}
  <Button type="submit" disabled={request.disabled}>Review connection</Button>{row&&<p>To use a different bot, workspace or agent, create a new connection.</p>}{row&&<Button type="button" variant="danger-quiet" disabled={request.disabled} onClick={()=>request.prepare({action:'disconnect',id:row.id})}>Disconnect</Button>}
 </form>{request.reader}</>;
}
export function ChannelControl({go,row,agents}:Navigation&{row?:BridgeChannelRow;agents?:ReadonlySet<string>}){
 const request=useSettingRequest({go},'bridge setting change','Bridge change request');return <><form onChange={request.clear} className="grid gap-3" onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);request.prepare({action:'channel',platform:row?.platform??field(data,'platform'),workspace:row?.workspace??field(data,'workspace'),channel:row?.channel??field(data,'channel'),answers:field(data,'answers'),botsMayTalk:data.has('botsMayTalk')});}}>
  <Address row={row} fixed={!!row}/><label>Channel ID<Input name="channel" readOnly={!!row} defaultValue={row?.channel} required maxLength={200}/></label><label>Agent answering when nobody is addressed<AgentChoice name="answers" agents={agents} current={row?.answers}/></label><label><input name="botsMayTalk" type="checkbox" defaultChecked={row?.botsMayTalk}/>Bots may talk</label><Button type="submit" disabled={request.disabled}>Review channel rule</Button>
  {row&&<Button type="button" variant="danger-quiet" disabled={request.disabled} onClick={()=>request.prepare({action:'removeChannel',platform:row.platform,workspace:row.workspace,channel:row.channel})}>Remove channel rule</Button>}
 </form>{request.reader}</>;
}
export function PersonControl({go,row}:Navigation&{row?:BridgePersonRow}){
 const request=useSettingRequest({go},'bridge setting change','Bridge change request');return <><form onChange={request.clear} className="grid gap-3" onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);request.prepare({action:'person',platform:row?.platform??field(data,'platform'),workspace:row?.workspace??field(data,'workspace'),user:row?.user??field(data,'user'),member:field(data,'member')});}}>
  <Address row={row} fixed={!!row}/><label>Outside user ID<Input name="user" readOnly={!!row} defaultValue={row?.user} required maxLength={200}/></label><label>Household member ID<Input name="member" defaultValue={row?.member} required maxLength={200}/></label><Button type="submit" disabled={request.disabled}>Review person link</Button>
  {row&&<Button type="button" variant="danger-quiet" disabled={request.disabled} onClick={()=>request.prepare({action:'removePerson',platform:row.platform,workspace:row.workspace,user:row.user})}>Remove person link</Button>}
 </form>{request.reader}</>;
}
export function SendControl({row}:{row:BridgeSendRow}){
 const command=useCommand();return ['held','uncertain'].includes(row.state)?<section><p>Review the current delivery before deciding.</p>{row.state==='held'&&<Button disabled={command.busy} onClick={()=>void command.run({action:'review',id:row.id,decision:'release'})}>Release send</Button>}<Button disabled={command.busy} onClick={()=>void command.run({action:'review',id:row.id,decision:'dismiss'})}>Dismiss send</Button><p role="status">{command.message}</p></section>:null;
}
