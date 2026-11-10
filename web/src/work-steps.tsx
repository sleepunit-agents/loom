// A job's work as the Claude app shows it (t-2109; Jonathan, 2026-11-10): each step a row with a plain name, how long
// it took and how it went, folded until opened; opened, its whole command (with a prompt), its output as a terminal
// shows it (colours kept) or its diff in green and red. A helper's steps nest under the step that started it, with a
// count and a total time. The job's own words between steps are plain prose; the plan is a checklist on top. All of it
// is the owner's: Comms is his alone (the server says so), and the runtime keeps other people's words out.
import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import './work-steps.css';
import { RefText } from './comms-refs';
import { ansiRuns, isPlan, isText, pastLimit, spanOf, stepOf, stepsUnder, took, wordsOf, workTree, type WorkCard, type WorkNode } from './steps';

const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'file_change']);
const SHELL_TOOLS = new Set(['Bash', 'command_execution']);

/** Shown text with its colours as styled runs: text only, never markup. */
function Ansi({ text }: { text: string }) {
  return <>{ansiRuns(text).map((r, i) => (r.fg || r.bold ? <span key={i} className="work-ansi" data-fg={r.fg} data-bold={r.bold ? '' : undefined}>{r.text}</span> : r.text))}</>;
}

/** An edit's diff: each line green when added, red when removed (read past any colour code), its colours as runs. */
function Diff({ text }: { text: string }) {
  return <>{text.split('\n').map((l, i) => {
    const plain = ansiRuns(l).map((r) => r.text).join('');
    return <span key={i} className="work-diff" data-d={plain.startsWith('@@') ? 'hunk' : plain.startsWith('+') ? 'add' : plain.startsWith('-') ? 'rm' : undefined}><Ansi text={l} />{'\n'}</span>;
  })}</>;
}

/** The plan as a checklist (the newest plan card's items). */
export function Plan({ card }: { card: WorkCard }) {
  const items = wordsOf(card).items;
  if (!items?.length) return card.text ? <p className="work-plan work-plan--line loom-data">{card.text}</p> : null;
  const done = items.filter((x) => x.state === 'done').length;
  return (
    <section className="work-plan" aria-label="Plan">
      <h3 className="work-plan__head loom-data">PLAN · {done}/{items.length}</h3>
      <ul>{items.map((x, i) => <li key={i} data-state={x.state}><span aria-hidden className="work-plan__box">{x.state === 'done' ? '✓' : x.state === 'now' ? '›' : ''}</span><span className="work-plan__text">{x.text}</span></li>)}</ul>
    </section>
  );
}

function Status({ c }: { c: WorkCard }) {
  const s = stepOf(c);
  if (s === 'current') return <Spinner size="sm" className="work-row__icon" aria-label="Running" />;
  if (s === 'error') return <Icon name="circle-alert" size="sm" className="work-row__icon" data-state="failed" aria-label="Failed" />;
  return <Icon name="circle-check" size="sm" className="work-row__icon" data-state="done" aria-label="Done" />;
}

function Row({ n, now, owner }: { n: WorkNode<WorkCard>; now: number; owner?: string }) {
  const [open, setOpen] = useState(false);
  const { c } = n;
  if (isText(c)) {
    const w = wordsOf(c);
    return <div className="work-text"><Ansi text={w.body ?? c.text ?? ''} />{n.kids.length ? <Rows nodes={n.kids} now={now} owner={owner} /> : null}</div>;
  }
  const w = wordsOf(c);
  const tool = String(c.card?.tool ?? '');
  const { start, end } = spanOf(c);
  const time = took((end ?? now) - start);
  const exit = Number.isInteger(c.card?.exit) ? c.card!.exit as number : null;
  const limit = Number.isInteger(c.card?.limit) ? (c.card!.limit as number) * 1000 : null;
  const over = pastLimit(c, now);
  const count = n.kids.length ? stepsUnder(n) : 0;
  const has = !!(w.detail || w.body || w.result || n.kids.length);
  return (
    <li className="work-row" data-state={stepOf(c)} data-open={open || undefined}>
      <button type="button" className="work-row__head" aria-expanded={open} disabled={!has} onClick={() => setOpen(!open)}>
        <Status c={c} />
        {/* A label's refs become chips, as in a reply (comms.md, "Chips"). */}
        <span className="work-row__name">{c.text ? <RefText text={c.text} owner={owner} /> : 'A step (older than this thread keeps)'}</span>
        {count > 0 && <span className="work-row__count loom-data">{count} step{count === 1 ? '' : 's'}</span>}
        {stepOf(c) === 'error' && exit !== null && <span className="work-row__exit loom-data">exit {exit}</span>}
        {over && <span className="work-row__over loom-data">past its {took(limit!)} limit</span>}
        <span className="work-row__time loom-data">{time}</span>
        {has && <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" className="work-row__chev" />}
      </button>
      {open && (
        <div className="work-row__more">
          {(w.detail || w.body) && (
            <pre className="work-term" data-kind={SHELL_TOOLS.has(tool) ? 'shell' : DIFF_TOOLS.has(tool) ? 'diff' : 'text'}>
              {w.detail && SHELL_TOOLS.has(tool) ? <span className="work-term__prompt"><span aria-hidden>$ </span>{w.detail}{'\n'}</span> : w.detail ? <span className="work-term__prompt">{w.detail}{'\n'}</span> : null}
              {w.body ? (DIFF_TOOLS.has(tool) ? <Diff text={w.body} /> : <Ansi text={w.body} />) : null}
            </pre>
          )}
          {w.result && <p className="work-row__result loom-data">{w.result}</p>}
          {n.kids.length > 0 && <Rows nodes={n.kids} now={now} owner={owner} />}
        </div>
      )}
    </li>
  );
}

function Rows({ nodes, now, owner }: { nodes: Array<WorkNode<WorkCard>>; now: number; owner?: string }) {
  // Prose sits between rows as itself; rows group into lists.
  const out: ReactNode[] = [];
  let list: Array<WorkNode<WorkCard>> = [];
  const flush = () => { if (list.length) { out.push(<ul key={`l${list[0].c.seq}`} className="work-rows">{list.map((x) => <Row key={x.c.seq} n={x} now={now} owner={owner} />)}</ul>); list = []; } };
  for (const x of nodes) { if (isText(x.c)) { flush(); out.push(<Row key={x.c.seq} n={x} now={now} owner={owner} />); } else list.push(x); }
  flush();
  return <>{out}</>;
}

/** A run's work: the plan on top, then its steps and words in order. */
export function WorkSteps({ cards, now, owner }: { cards: WorkCard[]; now: number; owner?: string }) {
  const plan = cards.filter(isPlan).at(-1);
  return (
    <div className="work">
      {plan && <Plan card={plan} />}
      <Rows nodes={workTree(cards)} now={now} owner={owner} />
    </div>
  );
}
