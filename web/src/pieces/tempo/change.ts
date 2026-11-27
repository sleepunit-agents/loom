import { z } from 'zod';
import type { ChangeRow, ChangeWords } from '../approval-view/answering';
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
const rows = (value:Timings):ChangeRow[] => [
  {label:'Inbox settle time',value:duration(value.settleSeconds,'second')},
  {label:'Dim ends after',value:duration(value.dimDays,'day')},
  {label:'Mute ends after',value:duration(value.muteDays,'day')},
];
/** The checked change in plain words, for any view of the approval (the desktop's card in ./settings.tsx, the
 * board's brick). Nothing when the stored card is not exactly a Tempo timings change. */
export function tempoChangeWords(approval:Parameters<typeof readTempoChange>[0]):ChangeWords|null {
  const value=readTempoChange(approval);if(!value)return null;
  return {label:'Tempo settings change',heading:`Change Tempo timings for ${value.who.kind} ${value.who.id}`,
    before:rows(value.before),after:rows(value.after),note:'Allow applies these timings. Deny keeps the current timings.'};
}
