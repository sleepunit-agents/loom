import {NativeSelect} from '../../kit/native-select';
import {useDeadline} from '../comms/use-deadline';
import {useState} from 'react';
import {useDataQuery} from '../../data/graphql';
import {Loading,Error as ErrorView} from '../../kit';

import {weeklyNote,weeklyUsageQuery as query,type WeeklyAccount as Account,type WeeklyDimension as Dimension} from './model-query';
const percent = new Intl.NumberFormat(undefined,{style:'percent',maximumFractionDigits:2});

export function WeeklyUsage({accountId,go}:{accountId?:string;go?:(path:string)=>void}){
  const feed = useDataQuery<{modelAccounts:Account[]}>(query,{detailId:accountId??null});
  const [dimension,setDimension] = useState<Dimension>('agents');
  const selected = (feed.status==='live' ? feed.data?.modelAccounts ?? [] : []).filter(account=>!accountId || account.id === accountId);
  const now = useDeadline(selected.flatMap(account=>account.weeklyUsage?.map(week=>week.resetsAt) ?? []));
  if(feed.status==='loading') return <Loading label="Reading weekly usage…"/>;
  if(feed.status!=='live'||!feed.data) return <ErrorView text="Weekly usage is unavailable."/>;
  const accounts = selected.map(account=>({...account,weeklyUsage:account.weeklyUsage?.filter(week=>Date.parse(week.resetsAt)>now) ?? []})).filter(account=>account.weeklyUsage.length);
  if(!accounts.length) return <p>No current weekly reading is available.</p>;
  return <div className="grid gap-3">
    <label>Group by <NativeSelect value={dimension} onChange={event=>setDimension(event.target.value as Dimension)}>
      <option value="agents">Agent</option><option value="triggers">Trigger</option><option value="conversations">Conversation</option>
    </NativeSelect></label>
    <p>{weeklyNote}</p>
    {accounts.map(account=>account.weeklyUsage!.map(week=><section key={JSON.stringify([account.id,week.window])}>
      <h4>{account.label} · {week.window} · {percent.format(week.usage)} used</h4>
      <ul>{week[dimension].map(group=><li key={JSON.stringify(group.key)}>
        <meter aria-label={group.title} min={0} max={1} value={group.share}/> {group.href?<a href={group.href} onClick={event=>{
          if(!go||!group.href||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
          event.preventDefault();
          go(group.href);
        }}>{group.title}</a>:group.title} · {percent.format(group.share)}
      </li>)}</ul>
      <p>Unattributed · {percent.format(week.unattributed)}</p>
    </section>))}
  </div>;
}
