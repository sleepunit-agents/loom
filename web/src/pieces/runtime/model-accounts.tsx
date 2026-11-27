import {ToolbarControls} from '../../kit/toolbar';
import {memberOperation} from '../../data/operation';
import {WeeklyUsage} from './weekly-usage';
import {Fragment,useState} from 'react';
import {useDeadline} from '../comms/use-deadline';
import {fullTime} from '../../kit/time';
import {useDataQuery} from '../../data/graphql';
import {Button,Search,Loading,Error as ErrorView} from '../../kit';
import {accountServices,loginCounts,loginLine,loginState,modelGroups,runtimeAccountsQuery,serviceLevel,serviceNeedsSignIn,subscriptionWords,usageReadStale,usagePercent as percent,windowName,type AgentModel,type RuntimeAccountDetail as Detail,type RuntimeAccountsData} from './model-query';
export {runtimeAccountsQuery} from './model-query';
export type {RuntimeAccount,AgentModel} from './model-query';
const time=(value:string|null,zone?:string)=>value?fullTime(value,zone):'Not available';
function SignInButton({account,box}:{account:string;box:string}){
 const [state,setState]=useState<'ready'|'sending'|'sent'|'failed'>('ready');
 async function ask(){
  if(state==='sending'||state==='sent')return;
  setState('sending');
  try{await memberOperation('runtime.accountSignIn',{account,box});setState('sent');}
  catch{setState('failed');}
 }
 return <div><Button disabled={state==='sending'||state==='sent'} onClick={()=>void ask()}>Sign in on this machine</Button>
  {state==='sent'&&<p role="status">{subscriptionWords.signInSent}</p>}
  {state==='failed'&&<p role="status">{subscriptionWords.signInFailed}</p>}</div>;
}
function UsageReadTime({at,zone}:{at:string|null;zone?:string}){
 const read=Date.parse(at??'');
 const deadline=Number.isFinite(read)?new Date(read+3_600_001).toISOString():null;
 const now=useDeadline([deadline]);
 if(!deadline)return <>Not available</>;
 return <>{time(at,zone)}{usageReadStale(read,now)&&subscriptionWords.stale}</>;
}
function AccountCard({account,zone,active,go}:{account:Detail;zone?:string;active:boolean;go?:(path:string)=>void}){
 const [open,setOpen]=useState(false);
 const logins=account.logins ?? [];
 const {signedIn,attention,lastKnown}=loginCounts(account);
 return <details className="rounded-xl border p-4" onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>{account.label} · {account.owner} · {account.level} · {logins.length ? `${signedIn} signed in` : 'No sign-ins reported'}
   {attention>0 && ` · ${attention} ${attention===1?'needs':'need'} attention`}
   {lastKnown>0 && ` · ${lastKnown} last known`}
   {!!account.pendingSignIns?.length && ' · Sign-in requested'}
  </summary>
  <div className="grid gap-4">
  <section aria-label="Usage"><h4>Usage</h4>
   {account.windows?.length?account.windows.map(w=><div key={w.window} className="grid gap-1">
    <strong>{windowName(w.window)}</strong>
    {w.usage===null?<p>Not read yet</p>:<p><meter aria-label={windowName(w.window)} min={0} max={1} value={w.usage}/> {percent(w.usage)}</p>}
    {w.usageReadAt&&<p>Read <UsageReadTime at={w.usageReadAt} zone={zone}/></p>}{w.resetsAt&&<p>Resets {time(w.resetsAt,zone)}</p>}
   </div>):<dl><dt>Usage</dt><dd>{account.usage===null?'Not read yet':percent(account.usage)}</dd>
    <dt>Read</dt><dd><UsageReadTime at={account.usageReadAt} zone={zone}/></dd><dt>Resets</dt><dd>{time(account.resetsAt,zone)}</dd></dl>}
   {open&&<WeeklyUsage accountId={account.id} go={go}/>}
   <p>Has room: {account.hasRoom?'Yes':'No'}</p>
  </section>
  <section aria-label="Sign-ins"><h4>Sign-ins</h4>
   {account.pendingSignIns?.map(box=><p key={box.id}>{box.name} · Sign-in requested</p>)}
   {account.logins?.length?account.logins.map(login=><div key={JSON.stringify([login.box.id,login.place,login.harness])} className={login.reporting?undefined:'[color:var(--muted-foreground)]'}>
    <strong>{login.box.name}</strong> · {loginLine(login)}
    <p>{loginState(login)} · Checked {time(login.checkedAt,zone)}</p>
    {login.expiresAt&&<p>{login.expired?'Ended':'Ends'} {time(login.expiresAt,zone)}</p>}
    {active&&login.canRequest&&<SignInButton account={account.id} box={login.box.id}/>}
   </div>):!account.pendingSignIns?.length&&<p>No sign-ins reported.</p>}
  </section>
  <section aria-label="Settings"><h4>Settings</h4>
   <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
    <dt>Label</dt><dd>{account.label}</dd>
    <dt>Owner</dt><dd>{account.owner}</dd>
    <dt>Service</dt><dd>{account.provider}</dd>
    <dt>Configured machines</dt><dd>{account.signedInOn.map(box=>box.name).join(' · ')||'No machines'}</dd>
    {account.windows?.map(w=>w.reserve!==null&&<Fragment key={w.window}>
     <dt>{windowName(w.window)} reserve</dt><dd>{percent(w.reserve)}</dd>
    </Fragment>)}
   </dl>
  </section>
 </div></details>;
}
/** Current query policy chooses account columns and visible agents.
 * No retained private details survive an unavailable selection. */
export function RuntimeAccounts({active=true,go}:{active?:boolean;go?:(path:string)=>void}={}){
 const feed=useDataQuery<RuntimeAccountsData>(runtimeAccountsQuery);
 const [weeklyOpen,setWeeklyOpen]=useState(false);
 const [search,setSearch]=useState('');
 const [attentionOnly,setAttentionOnly]=useState(false);
 const rows=feed.status==='live'?feed.data?.modelAccounts:undefined;
 const zone=feed.data?.deskTime?.timezone;
 // Preferences are listed for agents in use; a removed agent keeps its rows for a restore.
 const groups=rows?modelGroups(feed.data):new Map<string,AgentModel[]>();
 const services=accountServices(rows??[],search,attentionOnly);
 return <section aria-label="Subscriptions" className="grid gap-4">
  {feed.status==='loading'?<Loading label="Opening subscriptions…"/>:!rows?<ErrorView text="Subscriptions are unavailable. Check the connection."/>:<>
   {rows.some(row=>row.__typename==='RuntimeAccountDetail')&&<details onToggle={event=>setWeeklyOpen(event.currentTarget.open)}>
    <summary>Weekly usage across subscriptions</summary>{weeklyOpen&&<WeeklyUsage go={go}/>}
   </details>}
   <ToolbarControls>
   <Search label="Search subscriptions" value={search} onChange={setSearch}/>
   <label><input type="checkbox" checked={attentionOnly} onChange={event=>setAttentionOnly(event.target.checked)}/> Needs attention</label>
   </ToolbarControls>
   {!rows.length?<p>No model accounts yet.</p>:!services.size?<p>No matching subscriptions.</p>:[...services].map(([provider,accounts])=>{
    return <details open key={JSON.stringify(provider)} className="grid gap-2"><summary>{provider??'Shared summaries'} · {accounts.length} · {serviceLevel(accounts)}{serviceNeedsSignIn(accounts)&&' · Sign-in needed'}</summary>
     {accounts.map((account,index)=>account.__typename==='RuntimeAccountSummary'?<p key={index}>{account.label} · {account.level}</p>:
      <AccountCard key={account.id} account={account} zone={zone} active={active} go={go}/>)}
    </details>;
   })}
   <section aria-label="Agent models" className="grid gap-3"><h3>Models in preference order</h3>
    {!groups.size?<p>No model preferences yet.</p>:[...groups].map(([agent,models])=><article key={agent} className="rounded-xl border p-4"><h4>{agent}</h4><ol className="list-inside list-decimal">{models.map((row,index)=><li key={row.model}>{row.model}{index===0 && ' · Primary'}</li>)}</ol></article>)}
   </section>
  </>}
 </section>;
}
