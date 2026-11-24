import { talkPath } from '../comms/shared-query';

export interface TriggerRun {
  event: number;
  kind: 'mail' | 'program';
  at: string;
  job: {state:string; startedAt:string|null; endedAt:string|null} | null;
  usage: {tokensOut:number|null; largestContext:number|null; wallMs:number|null} | null;
  conversation: {id:string; venue:string; place:string} | null;
}

function runDuration(run: TriggerRun) {
  const ms = run.usage?.wallMs ?? (run.job?.startedAt && run.job.endedAt
    ? Date.parse(run.job.endedAt) - Date.parse(run.job.startedAt) : null);
  if (ms == null || !Number.isFinite(ms) || ms < 0) return;
  if (ms < 1000) return ms+' ms';
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? seconds+' s' : Math.floor(seconds / 60)+' min '+seconds % 60+' s';
}

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
