// A thread's asks, inline (docs/specs/comms.md, "Asks inline"): what the agent asked you from this thread, drawn where it
// was raised, as Claude Code or Codex draw a permission prompt. Each IS the Inbox's item (its key, its words, its buttons,
// posted to the same piece through the same /act), so answering it here answers it in the Inbox and the other way round;
// the thread reads again when loom's live stream says something moved. Answered, it stays, saying who answered and how.
//
// Its buttons are live only once loom says, now, that it's still open (/inbox/open?k=, ask-open.ts, the Inbox's rule),
// and loom is asked again right before one is sent. Part of the Comms chunk.
import { useRef, useState } from 'react';
import { useEnv } from './blocks';
import { AgentChatPermission } from '@/components/ui/agent-chat';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LIVE_SAYS, useAskLive } from './ask-open';
import { act, UNSURE, type Source } from './loom';
import { RefText } from './comms-refs';

type Btn = { action: string; label: string; tone?: string; confirm?: string; fields?: Record<string, string> };
/** As loom answers it (src/comms-asks.ts ThreadAskView). */
export type ThreadAsk = {
  key: string; ref: string; at: string; state: 'open' | 'answered';
  kind: 'permission' | 'question'; text: string; why?: string; if_yes?: string; if_no?: string; fine?: string; refs?: string[]; relayedFrom?: string; ownerOnly?: true;
  decide?: { allow: Btn; deny: Btn; source: Source };
  yesNo?: true;
  reply?: { action: string; label: string; fields: Record<string, string>; source: Source };
  buttons?: { list: Btn[]; source: Source };
  more?: { list: Btn[]; source: Source };
  answer?: { verdict: string; by?: string; at?: string };
};

const hhmm = (iso?: string) => { const d = new Date(iso ?? ''); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; };
const person = (slug: string) => slug.split('-').map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1)).join(' ');

/** How it was answered, in words: "Allowed by you · 2:14 PM". */
export function answerWords(a: { verdict: string; by?: string; at?: string }, member: string): string {
  const by = a.by ? (a.by === member ? 'you' : person(a.by)) : '';
  const head = ({ allowed: 'Allowed', denied: 'Denied', yes: 'Answered yes', no: 'Answered no', replied: 'Answered', done: 'Marked done', dismissed: 'Dismissed',
    resolved: 'Cleared itself', expired: 'Expired', gone: 'No longer open' } as Record<string, string>)[a.verdict] ?? 'Answered';
  const who = by && !['resolved', 'expired', 'gone'].includes(a.verdict) ? ` by ${by}` : '';
  const when = hhmm(a.at);
  return `${head}${who}${when ? ` · ${when}` : ''}`;
}
const allowedish = (v: string) => ['allowed', 'yes', 'done', 'replied', 'resolved'].includes(v);
/** What a button's answer is, by what it does: the server's own table (src/comms-asks.ts verdictOf), so the card never
 * says an answer loom didn't record. Any other button answers nothing here: the card says what loom said, and reads again. */
export function verdictOfAction(action: string, fields: Record<string, string>): string | undefined {
  if (action === 'allow') return 'allowed';
  if (action === 'deny') return 'denied';
  if (action === 'needs-answer') return fields.answer === 'yes' || fields.answer === 'no' ? fields.answer : undefined;
  return ({ 'needs-reply': 'replied', 'needs-done': 'done', 'needs-dismiss': 'dismissed' } as Record<string, string>)[action];
}

export function ThreadAskCard({ a, who, member, csrf, owner, onAnswered }: { a: ThreadAsk; who: string; member: string; csrf: string; owner?: string; onAnswered: () => void }) {
  const open = a.state === 'open';
  const { stale } = useEnv();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // Answered here, before loom's new answer lands: shown at once.
  const [mine, setMine] = useState<{ verdict: string; at: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [words, setWords] = useState(false);
  const { live, check } = useAskLive(open && !mine ? { k: a.key } : null);
  const asker = a.relayedFrom ? `${person(a.relayedFrom)}, via ${who}` : who;
  const send = async (b: Btn, source: Source, fields: Record<string, string>): Promise<boolean> => {
    // One at a time, and never from a page loom hasn't confirmed since it was drawn (page.ts fresh).
    if (sending.current || busy || stale) return false;
    const verdict = verdictOfAction(b.action, fields);
    // A danger button, or one that says so, asks first, as the Inbox's does (blocks.tsx ActButton).
    if ((b.tone === 'danger' || b.confirm) && !confirm(b.confirm ?? `${b.label}: are you sure?`)) return false;
    sending.current = true;
    setSaid(null);
    try {
      if (!(await check())) return false;
      setBusy(true);
      const r = await act({ source, path: '', query: {}, csrf }, csrf, b.action, fields);
      if (r.ok) { if (verdict) setMine({ verdict, at: new Date().toISOString() }); setSaid(r.message || null); onAnswered(); return true; }
      setSaid(r.message || 'That didn’t go through.');
      // Unsure whether it landed: read loom's answer again, so the card shows what loom recorded (t-1995).
      if (r.unsure) onAnswered();
      return false;
    } catch {
      // Whatever threw, the card says so and reads again: never a spinner that ends in nothing (t-1995).
      setSaid(UNSURE);
      onAnswered();
      return false;
    } finally { setBusy(false); sending.current = false; }
  };
  const answer = mine ? { ...mine, by: member } : a.answer;
  const done = !!answer;
  const decision = !answer ? 'pending' : allowedish(answer.verdict) ? 'allowed' : 'denied';
  const yesWord = a.kind === 'permission' ? 'If you allow' : 'If yes';
  const noWord = a.kind === 'permission' ? 'If you deny' : 'If no';
  const scope = (a.if_yes || a.if_no || a.fine || a.refs?.length) ? (
    <>
      {(a.if_yes || a.if_no) && (
        <dl className="comms-ask__either">
          {a.if_yes && <><dt>{yesWord}</dt><dd><RefText text={a.if_yes} owner={owner} /></dd></>}
          {a.if_no && <><dt>{noWord}</dt><dd><RefText text={a.if_no} owner={owner} /></dd></>}
        </dl>
      )}
      {a.fine && <p className="comms-ask__fine loom-data">Exactly what this allows: {a.fine}</p>}
      {!!a.refs?.length && <p className="comms-ask__refs loom-data"><RefText text={a.refs.join(' · ')} owner={owner} /></p>}
    </>
  ) : undefined;
  const ok = open && !done && live === 'live' && !busy && !stale;
  const pair: { yes: Btn; no: Btn; src: Source } | null = a.decide?.allow && a.decide.deny ? { yes: a.decide.allow, no: a.decide.deny, src: a.decide.source }
    : a.yesNo && a.reply ? { yes: { action: 'needs-answer', label: 'Yes' } as Btn, no: { action: 'needs-answer', label: 'No' } as Btn, src: a.reply.source } : null;
  const decide = (d: 'allowed' | 'denied') => {
    if (!pair) return;
    const b = d === 'allowed' ? pair.yes : pair.no;
    if (a.decide) void send(b, pair.src, b.fields ?? {});
    else void send(b, pair.src, { ...a.reply!.fields, answer: d === 'allowed' ? 'yes' : 'no' });
  };
  const replyBox = a.reply && open && !done && (
    <div className="comms-ask__reply">
      {pair && !words ? <button type="button" className="comms-ask__words" onClick={() => setWords(true)}>Or answer in your own words</button> : (
        <>
          <label className="comms-ask__label loom-data" htmlFor={`ask-${a.key}`}>{pair ? 'Or answer in your own words' : a.reply.label}</label>
          <Textarea id={`ask-${a.key}`} value={draft} rows={2} placeholder="What should it know or do?" onChange={(e) => setDraft(e.target.value)} disabled={!ok}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) void send({ action: a.reply!.action, label: 'Send' }, a.reply!.source, { ...a.reply!.fields, text: draft }).then((s) => { if (s) setDraft(''); }); }} />
          <div className="flex flex-wrap justify-end gap-2">
            {a.buttons?.list.map((b) => (
              <Button key={b.action + b.label} size="sm" variant="ghost" disabled={!ok} onClick={() => void send(b, a.buttons!.source, b.fields ?? {})}>{b.label}</Button>))}
            <Button size="sm" disabled={!ok || !draft.trim()} onMouseDown={(e) => e.preventDefault()}
              onClick={() => void send({ action: a.reply!.action, label: 'Send' }, a.reply!.source, { ...a.reply!.fields, text: draft }).then((s) => { if (s) setDraft(''); })}>{busy ? 'Sending…' : 'Send'}</Button>
          </div>
        </>
      )}
    </div>
  );
  return (
    <div className="comms-ask" data-state={done ? 'answered' : 'open'} data-kind={a.kind} aria-label={`${asker} asks`}>
      <span className="comms-ask__who loom-data">{hhmm(a.at)} · {asker.toLowerCase()} {done ? 'asked' : 'asks'}</span>
      {pair || done ? (
        <AgentChatPermission title={a.text} description={a.why ?? `${asker} is asking you.`} decision={decision} disabled={!ok}
          onDecision={decide} allowLabel={pair?.yes.label ?? 'Allow once'} denyLabel={pair?.no.label ?? 'Deny'}
          receipt={answer ? answerWords(answer, member) : undefined} scope={scope} />
      ) : (
        <div className="v-agent-chat__permission comms-ask__question" role="group" aria-label={a.text}>
          <h3>{a.text}</h3>
          <p>{a.why ?? `${asker} is asking you.`}</p>
          {scope && <div className="v-agent-chat__scope">{scope}</div>}
        </div>
      )}
      {open && !done && a.ownerOnly && !a.decide && <p className="comms-ask__live" role="status">Only the household’s owner can allow this one: it’s in their Inbox.</p>}
      {replyBox}
      {/* A plain Done or Dismiss with no reply box (a piece's other choices). */}
      {open && !done && [...(!a.reply && a.buttons ? [a.buttons] : []), ...(a.more ? [a.more] : [])].map((g, k) => (
        <div key={k} className="flex flex-wrap justify-end gap-2">{g.list.map((b) => <Button key={b.action + b.label} size="sm" variant={b.tone === 'primary' ? 'default' : 'outline'} disabled={!ok}
          onClick={() => void send(b, g.source, b.fields ?? {})}>{b.label}</Button>)}</div>
      ))}
      {said && <p className="comms-ask__said" role="status">{said}</p>}
      {open && !done && live !== 'live' && <p className="comms-ask__live" role="status" data-live={live}>{LIVE_SAYS[live]}</p>}
    </div>
  );
}
