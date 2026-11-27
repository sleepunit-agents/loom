/** One recent run of a trigger, as `tempoRecentRuns` answers it, and how long it took in words. Pure: the
 * desktop's list (./recent-runs.tsx) and the board's `trigger` brick both read it. */
export interface TriggerRun {
  event: number;
  kind: 'mail' | 'program';
  at: string;
  job: {state:string; startedAt:string|null; endedAt:string|null} | null;
  usage: {tokensOut:number|null; largestContext:number|null; wallMs:number|null} | null;
  conversation: {id:string; venue:string; place:string} | null;
}

export function runDuration(run: TriggerRun) {
  const ms = run.usage?.wallMs ?? (run.job?.startedAt && run.job.endedAt
    ? Date.parse(run.job.endedAt) - Date.parse(run.job.startedAt) : null);
  if (ms == null || !Number.isFinite(ms) || ms < 0) return;
  if (ms < 1000) return ms+' ms';
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? seconds+' s' : Math.floor(seconds / 60)+' min '+seconds % 60+' s';
}
/** What a run was and what it came to, with what it used. */
export function runWords(run: TriggerRun): string[] {
  return [(run.kind==='program'?'Program':'Agent wake'), run.job?.state ?? 'delivered', runDuration(run),
    run.usage?.tokensOut != null && run.usage.tokensOut.toLocaleString()+' output tokens',
    run.usage?.largestContext != null && run.usage.largestContext.toLocaleString()+' peak context tokens',
  ].filter((part): part is string => !!part);
}
