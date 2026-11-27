import { useHouseholdZone } from '../../data/zone';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './doing.css';
import { claimedPath, doingMeta, doingPhrase, useDoing, type DoingReading } from './doing-model';
export * from './doing-model';

/** A card that says what its agent is doing in more than one place (its state word, its list) reads once, here. */
export function WithDoing({ agent, onChange, children }: { agent: string; onChange?(): void; children(doing: DoingReading): ReactNode }) {
  const doing = useDoing(agent), previous = useRef(doing);
  useLayoutEffect(() => { if (previous.current !== doing) { previous.current = doing; onChange?.(); } }, [doing, onChange]);
  return <>{children(doing)}</>;
}

const fallbackName = (id: string) => id ? id[0].toUpperCase() + id.slice(1) : id;
/** A two-letter mark per kind: drawn in mono, so every look has it and it reads at a pill's size. */
const marks: Record<string, string> = { terminal: '>_', discord: 'DC', slack: 'SL', loom: 'LM', handoff: 'HO', trigger: 'TP', wake: 'WK', task: 'TK', job: 'JB', private: '··' };

/** The lead of an agent's card: one pill per thing it is doing, each opening what it names. Compact (the rail,
 * a folded card) leaves the quiet line to the pill's title. */
export function Doing({ doing, name, agent, names, go, compact = false, label }: {
  doing: DoingReading; name: string; /** The agent's id: with it, the tasks it has only claimed are one quiet line under the pills (never on a compact card). */ agent?: string; names?: ReadonlyMap<string, string>; go(path: string): void; compact?: boolean; label?: string;
}) {
  const zone = useHouseholdZone();
  const named = (id: string) => names?.get(id) ?? fallbackName(id);
  if (doing.status !== 'live') return <p className="desk-doing-quiet" role="status">{doing.status === 'loading' ? 'Checking…' : 'Can’t tell what it is doing right now.'}</p>;
  const opens = (href: string) => (event: { button?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; preventDefault(): void }) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); go(href);
  };
  const claimed = !compact && agent && doing.claimed > 0 ? <a className="desk-doing-claimed" href={claimedPath(agent)} onClick={opens(claimedPath(agent))}>
    {doing.claimed} {doing.claimed === 1 ? 'task' : 'tasks'} in progress ›</a> : null;
  if (!doing.items.length) return <><p className="desk-doing-quiet">Nothing right now.</p>{claimed}</>;
  return <><ul className="desk-doing" data-compact={compact || undefined} aria-label={label ?? `What ${name} is doing`}>
    {doing.items.map(item => {
      const phrase = doingPhrase(item, named), meta = doingMeta(item, zone);
      const inside = <><span className="desk-doing-mark" aria-hidden="true">{marks[item.kind] ?? marks.job}</span>
        <span className="desk-doing-words"><span className="desk-doing-phrase">{phrase}</span>{!compact && meta && <span className="desk-doing-meta">{meta}</span>}</span></>;
      const href = item.href;
      return <li key={`${item.kind}:${item.id}`} data-kind={item.kind} data-quiet={item.quietSince ? '' : undefined}>{href
        ? <a className="desk-doing-pill" href={href} title={compact ? meta : undefined} onClick={opens(href)}>{inside}</a>
        : <span className="desk-doing-pill" title={compact ? meta : undefined}>{inside}</span>}</li>;
    })}
    {doing.more > 0 && <li className="desk-doing-more">+{doing.more} more</li>}
  </ul>{claimed}</>;
}
