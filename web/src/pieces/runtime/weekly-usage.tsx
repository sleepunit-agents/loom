import {useState} from 'react';
import {useDataQuery} from '../../data/graphql';
import {Loading,Error as ErrorView} from '../../kit';

type Group = {key:string|null;title:string;share:number;href:string|null};
type Week = {window:string;usage:number;unattributed:number;agents:Group[];triggers:Group[];conversations:Group[]};
type Account = {id?:string;label?:string;weeklyUsage?:Week[]|null};
const query = `query WeeklySubscriptions {
  modelAccounts { ... on RuntimeAccountDetail { id label weeklyUsage {
    window usage unattributed agents {key title share href} triggers {key title share href} conversations {key title share href}
  } } }
}`;
const percent = new Intl.NumberFormat(undefined,{style:'percent',maximumFractionDigits:2});
type Dimension = 'agents'|'triggers'|'conversations';

export function WeeklyBreakdown({account}: {account?:string}) {
  const [open,setOpen] = useState(false);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{account?'Where the week went':'Weekly usage across subscriptions'}</summary>
    {open&&<WeeklyUsage accountId={account}/>}
  </details>;
}
function WeeklyUsage({accountId}:{accountId?:string}){
  const feed = useDataQuery<{modelAccounts:Account[]}>(query);
  const [dimension,setDimension] = useState<Dimension>('agents');
  if(feed.status==='loading') return <Loading label="Reading weekly usage…"/>;
  if(feed.status!=='live'||!feed.data) return <ErrorView text="Weekly usage is unavailable."/>;
  const accounts = feed.data.modelAccounts.filter(account=>(!accountId || account.id === accountId) && account.weeklyUsage?.length);
  if(!accounts.length) return <p>No current weekly reading is available.</p>;
  return <div className="grid gap-3">
    <label>Group by <select value={dimension} onChange={event=>setDimension(event.target.value as Dimension)}>
      <option value="agents">Agent</option><option value="triggers">Trigger</option><option value="conversations">Conversation</option>
    </select></label>
    <p>Each percentage is a share of that subscription’s weekly allowance. Loom estimates shares from changes in provider readings and token counts for overlapping jobs.</p>
    {accounts.map(account=>account.weeklyUsage!.map(week=><section key={JSON.stringify([account.id,week.window])}>
      <h4>{account.label} · {week.window} · {percent.format(week.usage)} used</h4>
      <ul>{week[dimension].map(group=><li key={JSON.stringify(group.key)}>
        <meter aria-label={group.title} min={0} max={1} value={group.share}/> {group.href?<a href={group.href}>{group.title}</a>:group.title} · {percent.format(group.share)}
      </li>)}</ul>
      <p>Unattributed · {percent.format(week.unattributed)}</p>
    </section>))}
  </div>;
}
