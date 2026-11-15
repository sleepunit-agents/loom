import { z } from 'zod';
const timings = z.object({ settleSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dimDays: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), muteDays: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const change = z.object({ who: z.object({kind:z.enum(['person','agent']),id:z.string().min(1)}).strict(), before: timings, after: timings }).strict();
type Timings = z.infer<typeof timings>;
/** Presentation only. The unchanged server applies and authorizes the card. */
export function readTempoChange(approval:{kind:string;target:string;details:string;changeSummary:string|null}) {
  if(approval.kind!=='setting')return;
  try {
    const parsed=change.safeParse(JSON.parse(approval.details));if(!parsed.success)return;
    const {who,before,after}=parsed.data;
    if(approval.target!==`tempo:${who.kind}:${who.id}` || approval.changeSummary!==`Tempo for ${who.kind} ${who.id}: settle ${before.settleSeconds} → ${after.settleSeconds} seconds; dim ${before.dimDays} → ${after.dimDays} days; mute ${before.muteDays} → ${after.muteDays} days`)return;
    return parsed.data;
  }catch{return;}
}
const duration = (value:number,unit:string) => `${value} ${unit}${value===1?'':'s'}`;
function Values({value}:{value:Timings}) {
  return <dl className="grid gap-2">
    <div><dt>Inbox settle time</dt><dd>{duration(value.settleSeconds,'second')}</dd></div>
    <div><dt>Dim ends after</dt><dd>{duration(value.dimDays,'day')}</dd></div>
    <div><dt>Mute ends after</dt><dd>{duration(value.muteDays,'day')}</dd></div>
  </dl>;
}
export function renderTempoChange(approval:Parameters<typeof readTempoChange>[0]) {
  const value=readTempoChange(approval);if(!value)return null;
  return <section aria-label="Tempo settings change" className="grid gap-4">
    <h2>Change Tempo timings for {value.who.kind} {value.who.id}</h2>
    <div className="grid gap-4 sm:grid-cols-2">
      <section aria-label="Before"><h3>Before</h3><Values value={value.before}/></section>
      <section aria-label="After"><h3>After</h3><Values value={value.after}/></section>
    </div>
    <p>Allow applies these timings. Deny keeps the current timings.</p>
  </section>;
}
