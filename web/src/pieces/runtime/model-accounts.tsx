import {useState} from 'react';
import {fullTime} from '../../kit/time';
import {useDataQuery} from '../../data/graphql';
import {liveAgents} from '../../data/live-agents';
import {Search,Loading,Error as ErrorView} from '../../kit';
import {runtimeAccountsQuery} from './model-query';
export {runtimeAccountsQuery} from './model-query';
type Summary={__typename:'RuntimeAccountSummary';label:string;level:string};
type UsageWindow={window:string;usage:number|null;usageReadAt:string|null;resetsAt:string|null;reserve:number|null};
type Login={box:{id:string;name:string};place:'host'|'containers';harness:string;state:'signed-in'|'signed-out';expiresAt:string|null;checkedAt:string};
type Detail={__typename:'RuntimeAccountDetail';label:string;level:string;id:string;owner:string;provider:string;usage:number|null;usageReadAt:string|null;resetsAt:string|null;hasRoom:boolean;windows:UsageWindow[];logins:Login[];signedInOn:{id:string;name:string}[]};
export type RuntimeAccount=Summary|Detail;
export type AgentModel={agent:string;model:string;position:number};
const time=(value:string|null,zone?:string)=>value?fullTime(value,zone):'Not available';
const percent=(n:number)=>Math.round(n*100)+'%';
const windowName=(name:string)=>({week:'Week',weekly:'Week','five-hour':'Five hours','5h':'Five hours'}[name]??name);
function AccountDetails({account,zone}:{account:Detail;zone?:string}){
 return <div className="grid gap-4">
  <p>Owner: {account.owner} · Provider: {account.provider}</p>
  <section aria-label="Usage"><h4>Usage</h4>
   {account.windows?.length?account.windows.map(w=><div key={w.window} className="grid gap-1">
    <strong>{windowName(w.window)}</strong>
    {w.usage===null?<p>Not read yet</p>:<p><meter aria-label={windowName(w.window)} min={0} max={1} value={w.usage}/> {percent(w.usage)}</p>}
    {w.usageReadAt&&<p>Read {time(w.usageReadAt,zone)}</p>}{w.resetsAt&&<p>Resets {time(w.resetsAt,zone)}</p>}
    {w.reserve!==null&&<p>Reserve {percent(w.reserve)}</p>}
   </div>):<dl><dt>Usage</dt><dd>{account.usage===null?'Not read yet':percent(account.usage)}</dd>
    <dt>Read</dt><dd>{time(account.usageReadAt,zone)}</dd><dt>Resets</dt><dd>{time(account.resetsAt,zone)}</dd></dl>}
   <p>Has room: {account.hasRoom?'Yes':'No'}</p>
  </section>
  <section aria-label="Sign-ins"><h4>Sign-ins</h4>
   {account.logins?.length?account.logins.map(login=><div key={JSON.stringify([login.box.id,login.place,login.harness])}>
    <strong>{login.box.name}</strong> · {login.harness} · {login.place==='host'?'On the machine':'In houses'}
    <p>{login.state==='signed-in'?'Signed in':'Signed out'} · Checked {time(login.checkedAt,zone)}</p>
    {login.expiresAt&&<p>Ends {time(login.expiresAt,zone)}</p>}
   </div>):<p>No sign-ins reported.</p>}
   <p>Configured machines: {account.signedInOn.map(box=>box.name).join(' · ')||'No machines'}</p>
  </section>
 </div>;
}
/** Current query policy chooses account columns and visible agents.
 * No retained private details survive an unavailable selection. */
export function RuntimeAccounts(){
 const feed=useDataQuery<{modelAccounts:RuntimeAccount[];agentModels:AgentModel[];agents?:{id:string;removedAt:string|null}[]|null;deskTime:{timezone:string}|null}>(runtimeAccountsQuery);
 const [search,setSearch]=useState('');
 const rows=feed.status==='live'?feed.data?.modelAccounts:undefined;
 const zone=feed.data?.deskTime?.timezone,groups=new Map<string,AgentModel[]>();
 // Preferences are listed for agents in use; a removed agent keeps its rows for a restore.
 const roster = feed.data?.agents;
 const inUse = roster ? new Set(liveAgents(roster).map(agent => agent.id)) : undefined;
 if(rows)for(const row of feed.data?.agentModels??[])if(!inUse||inUse.has(row.agent))groups.set(row.agent,[...(groups.get(row.agent)??[]),row]);
 const services=new Map<string|null,RuntimeAccount[]>();
 const needle=search.trim().toLowerCase();
 for(const account of rows??[]){
  const provider=account.__typename==='RuntimeAccountDetail'?account.provider:null;
  if(![account.label,provider??''].some(value=>value.toLowerCase().includes(needle)))continue;
  const group=services.get(provider)??[];
  group.push(account);
  services.set(provider,group);
 }
 return <section aria-label="Subscriptions" className="grid gap-4">
  {feed.status==='loading'?<Loading label="Opening subscriptions…"/>:!rows?<ErrorView text="Subscriptions are unavailable. Check the connection."/>:<>
   <Search label="Search subscriptions" value={search} onChange={setSearch}/>
   {!rows.length?<p>No model accounts yet.</p>:!services.size?<p>No matching subscriptions.</p>:[...services].map(([provider,accounts])=>{
    const level=accounts.some(a=>a.level==='almost full')?'almost full':accounts.some(a=>a.level==='getting full')?'getting full':accounts[0].level;
    return <details open key={JSON.stringify(provider)} className="grid gap-2"><summary>{provider??'Shared summaries'} · {accounts.length} · {level}</summary>
     {accounts.map((account,index)=>account.__typename==='RuntimeAccountSummary'?<p key={index}>{account.label} · {account.level}</p>:
      <details key={account.id} className="rounded-xl border p-4"><summary>{account.label} · {account.owner} · {account.level}</summary>
       <AccountDetails account={account} zone={zone}/>
      </details>)}
    </details>;
   })}
   <section aria-label="Agent models" className="grid gap-3"><h3>Models in preference order</h3>
    {!groups.size?<p>No model preferences yet.</p>:[...groups].map(([agent,models])=><article key={agent} className="rounded-xl border p-4"><h4>{agent}</h4><ol className="list-inside list-decimal">{models.map(row=><li key={row.model}>{row.model}</li>)}</ol></article>)}
   </section>
  </>}
 </section>;
}
