import { useRecords } from '../../data';
import { latestStatus, type AgentStatus, type OwnedAgent } from './home-model';

type Minute = { id: string; at: number; timezone: string };
/** Formatting shared with the present desk, without its legacy shell/clock state. */
export function serverTime(at: number, timezone: string, words = false): string {
  try {
    const format = new Intl.DateTimeFormat('en-US', {timeZone:timezone,hour:'numeric',minute:'2-digit',hourCycle:'h12'});
    return words ? `${format.format(at)}, ${timezone} time` : format.formatToParts(at).filter(p=>['hour','minute','literal'].includes(p.type)).map(p=>p.value).join('').trim();
  } catch { return ''; }
}
const glyph = {width:15,height:15,viewBox:'0 0 16 16','aria-hidden':true} as const;
export function BarClock() {
  const time = useRecords<Minute>('household.time');
  const minute = time.status === 'live' ? time.records[0] : undefined;
  const text = minute && serverTime(minute.at, minute.timezone);
  const words = text && minute ? serverTime(minute.at, minute.timezone, true) : 'Loom time unavailable';
  return <span className="next-system-clock loom-sys__clock" title={words} aria-label={words}><span aria-hidden="true">{text || '—:—'}</span></span>;
}
export function BarStatus({ roster, statuses, available, live, go }: { roster: readonly OwnedAgent[]; statuses: readonly AgentStatus[]; available: boolean; live: boolean; go(path:string):void }) {
  const working = roster.filter(a=>latestStatus(statuses,a.id)?.state==='working').length;
  const known = available && roster.every(a=>latestStatus(statuses,a.id)!==undefined);
  const agents = known ? `${working} of ${roster.length} agents at work` : 'Agent status unavailable';
  const signal = live ? 'Live: connected to loom' : 'Live updates unavailable';
  return <span className="next-system-icons loom-sys__icons" role="group" aria-label="Status">
    <span role="img" tabIndex={0} className="loom-sys__icon" data-dim={!live?'':undefined} aria-label={signal}>
      <svg {...glyph}>{[0,1,2,3].map(i=><rect key={i} x={1+i*3.75} y={10-i*3} width={2.6} height={4+i*3} rx={0.7} fill={live||i===0?'currentColor':'none'} stroke="currentColor" strokeWidth={live||i===0?0:0.9}/>)}</svg>
      <span className="loom-sys__tip" aria-hidden="true">{signal}</span>
    </span>
    <a className="loom-sys__icon" href="/p/home-preview" aria-label={agents} onClick={e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();go('/p/home-preview');}}>
      <svg {...glyph} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><circle cx={6} cy={5.5} r={2.5}/><path d="M1.75 13.5a4.25 4.25 0 0 1 8.5 0M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.6a4.25 4.25 0 0 1 2.25 3.9"/></svg>
      <span className="loom-sys__n loom-data" aria-hidden="true">{known?working:'?'}</span><span className="loom-sys__tip" aria-hidden="true">{agents}</span>
    </a>
  </span>;
}
