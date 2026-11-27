import { talkPath } from '../comms/shared-query';
import { runDuration, type TriggerRun } from './runs';
export type { TriggerRun } from './runs';

export function RecentRuns({runs,format,go}:{runs:TriggerRun[];format:Intl.DateTimeFormat;go?:(path:string)=>void}) {
  if (!runs.length) return null;
  return <section aria-label="Recent runs"><h2>Recent runs</h2><ol className="grid gap-2">
    {runs.map(run=>{
      const href=run.conversation ? talkPath(run.conversation) : undefined;
      const details=[runDuration(run),
        run.usage?.tokensOut != null && run.usage.tokensOut.toLocaleString()+' output tokens',
        run.usage?.largestContext != null && run.usage.largestContext.toLocaleString()+' peak context tokens',
      ].filter(Boolean);
      return <li key={run.event+'-'+run.kind}>
        <time dateTime={run.at}>{format.format(new Date(run.at))}</time>
        {' · '}{run.kind==='program'?'Program':'Agent wake'} · {run.job?.state ?? 'delivered'}
        {details.length > 0 && ' · '+details.join(' · ')}
        {href && <> · <a className="underline" href={href} onClick={event=>{
          if(go && event.button===0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey){
            event.preventDefault();go(href);
          }
        }}>Open conversation</a></>}
      </li>;
    })}
  </ol></section>;
}
