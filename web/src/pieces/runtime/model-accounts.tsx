import {useDataQuery} from '../../data/graphql';
import {Loading,Error as ErrorView} from '../../kit';
export const runtimeAccountsQuery=`query RuntimeModelAccounts {
 deskTime { timezone }
 agentModels { agent model position }
 modelAccounts {
  __typename
  ... on RuntimeAccount { label level }
  ... on RuntimeAccountDetail { id owner provider usage usageReadAt resetsAt hasRoom signedInOn { id name } }
 }
}`;
type Summary={__typename:'RuntimeAccountSummary';label:string;level:string};
type Detail={__typename:'RuntimeAccountDetail';label:string;level:string;id:string;owner:string;provider:string;usage:number|null;usageReadAt:string|null;resetsAt:string|null;hasRoom:boolean;signedInOn:{id:string;name:string}[]};
export type RuntimeAccount=Summary|Detail;
export type AgentModel={agent:string;model:string;position:number};
const time=(value:string|null,zone:string)=>value?new Date(value).toLocaleString('en-US',{timeZone:zone})+' '+zone:'Not available';
/** Current query policy chooses account columns and visible agents.
 * No retained private details survive an unavailable selection. */
export function RuntimeAccounts(){
 const feed=useDataQuery<{modelAccounts:RuntimeAccount[];agentModels:AgentModel[];deskTime:{timezone:string}}>(runtimeAccountsQuery);
 const rows=feed.status==='live'?feed.data?.modelAccounts:undefined;
 const zone=feed.data?.deskTime?.timezone??'UTC',groups=new Map<string,AgentModel[]>();
 if(rows)for(const row of feed.data?.agentModels??[])groups.set(row.agent,[...(groups.get(row.agent)??[]),row]);
 return <section aria-label="Models and accounts" className="grid gap-4">
  <h2>Models and accounts</h2>
  {feed.status==='loading'?<Loading label="Opening models and accounts…"/>:!rows?<ErrorView text="Models and accounts are unavailable. Check the connection."/>:<>
   <section aria-label="Model accounts" className="grid gap-3"><h3>Model accounts</h3>
   {!rows.length?<p>No model accounts yet.</p>:rows.map((account,index)=><article key={index} className="grid gap-2 rounded-xl border p-4">
    <h4>{account.label}</h4>
    {account.__typename==='RuntimeAccountSummary'?<p>Level: {account.level}</p>:<>
     <p>Owner: {account.owner} · Provider: {account.provider}</p>
     <dl className="grid gap-2">
      <div><dt>Usage</dt><dd>{account.usage===null?'Not read yet':Math.round(account.usage*100)+'%'}</dd></div>
      <div><dt>Read</dt><dd>{time(account.usageReadAt,zone)}</dd></div>
      <div><dt>Resets</dt><dd>{time(account.resetsAt,zone)}</dd></div>
      <div><dt>Signed in on</dt><dd>{account.signedInOn.length?account.signedInOn.map(box=>box.name).join(' · '):'No machines'}</dd></div>
      <div><dt>Has room</dt><dd>{account.hasRoom?'Yes':'No'}</dd></div>
     </dl>
    </>}
   </article>)}</section>
   <section aria-label="Agent models" className="grid gap-3"><h3>Models in preference order</h3>
    {!groups.size?<p>No model preferences yet.</p>:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([agent,models])=><article key={agent} className="rounded-xl border p-4"><h4>{agent}</h4><ol className="list-inside list-decimal">{models.sort((a,b)=>a.position-b.position).map(row=><li key={row.position}>{row.model}</li>)}</ol></article>)}
   </section>
  </>}
 </section>;
}
