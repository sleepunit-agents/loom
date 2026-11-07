// The Projects app's index (docs/specs/projects.md, "The index"; Jonathan's approved redesign, t-1925): a card per
// project, each answering the same questions in the same places — its status, what it is, what's waiting on you (the
// loudest thing on a card, quiet when nothing is), what happened lately, a line of its activity, its open changes and
// their CI, its repos and its people. Its own chunk, loaded only when the index opens, so the first page carries none
// of it. One column in a narrow tile or on a phone, two in a big window, three at very wide (projects.css, by the
// width of the view itself, not the screen's). A card opens the project's hub inside the app.
import './projects.css';
import { Link, Who, useEnv } from './blocks';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import type { CardPerson, ProjectCardView, ProjectCards } from '../../src/ui/project-cards';

const TINTS = ['pink', 'blue', 'yellow', 'olive'] as const;
const tintOf = (slug: string) => TINTS[[...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];

/** Activity over the last days, a day a point; its words say what it counts. */
function Spark({ days, label }: { days: number[]; label: string }) {
  const w = 200, h = 28, max = Math.max(...days, 1);
  const pts = days.map((v, i) => [days.length > 1 ? (i * w) / (days.length - 1) : w, h - 3 - (v / max) * (h - 7)]);
  const line = pts.map((p) => p.join(',')).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="pj-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <polygon points={`0,${h} ${line} ${w},${h}`} className="pj-spark-fill" />
      <polyline points={line} className="pj-spark-line" vectorEffect="non-scaling-stroke" />
      <circle cx={lx - 2} cy={ly} r="2.5" className="pj-spark-dot" />
    </svg>
  );
}

function Faces({ people }: { people: CardPerson[] }) {
  const { ctx } = useEnv();
  if (!people.length) return null;
  const shown = people.slice(0, 4);
  // A name that is one of the household's agents wears that agent's face (a feed's `who` says "Mark", not `mark`).
  const agentOf = (p: CardPerson) => p.agent ?? (ctx.agents?.[p.name.toLowerCase()] ? p.name.toLowerCase() : undefined);
  const name = (p: CardPerson) => ctx.agents?.[agentOf(p) ?? '']?.label || p.name;
  return (
    <span className="pj-faces" aria-label={`People: ${people.map(name).join(', ')}`} role="group">
      {shown.map((p) => <span key={p.agent ?? p.person ?? p.name} className="pj-face" title={name(p)}><Who agent={agentOf(p)} person={p.person ?? p.name} size={24} /></span>)}
      {people.length > shown.length && <span className="pj-face pj-more loom-data">+{people.length - shown.length}</span>}
    </span>
  );
}

function Waiting({ w }: { w: NonNullable<ProjectCardView['waiting']> }) {
  if ('unknown' in w) return <p className="pj-wait pj-wait-none">{w.unknown}</p>;
  if (!w.count) return <p className="pj-wait pj-wait-none">Nothing waiting on you</p>;
  const more = w.count - w.items.length;
  return (
    <p className="pj-wait">
      <b className="loom-data">{w.count} for you</b>
      <span>{w.items.join(' · ')}{more > 0 ? ` · and ${more} more` : ''}</span>
    </p>
  );
}

const REPOS = 6;

function Card({ c }: { c: ProjectCardView }) {
  const id = `pj-${c.agent ?? ''}-${c.slug}`;
  return (
    <article className="pj-card" data-tint={tintOf(c.slug)} data-slug={c.slug} aria-labelledby={id}>
      <div className="pj-top">
        <h3 className="pj-name" id={id}><Link page={c.page} className="pj-link">{c.name}</Link></h3>
        <span className="pj-pill loom-data" data-status={c.status}><span className="pj-dot" aria-hidden="true" />{c.status}</span>
      </div>
      {c.what && <p className="pj-what">{c.what}</p>}
      {c.waiting && <Waiting w={c.waiting} />}
      {c.lately.length > 0 && (
        <div>
          <div className="pj-eb">Lately</div>
          <ul className="pj-acts">
            {c.lately.map((a, n) => (
              <li key={n}><span className="pj-act-text">{a.text}{a.status ? <span className="pj-act-status"> · {a.status}</span> : null}</span><span className="loom-data pj-ago">{a.ago}</span></li>
            ))}
          </ul>
        </div>
      )}
      {c.spark && <Spark days={c.spark.days} label={c.spark.label} />}
      {(c.changes || c.people.length > 0) && (
        <div className="pj-foot">
          {c.changes && (
            <span className="pj-chg loom-data" data-failing={c.changes.failing > 0 || undefined}>
              <AnimatedIcon name="git-pull-request" size="sm" />
              <span><span className="sr-only">Changes: </span>{c.changes.line}</span>
            </span>
          )}
          <Faces people={c.people} />
        </div>
      )}
      {c.repos.length > 0 && (
        <ul className="pj-repos" aria-label="Repos">
          {c.repos.slice(0, REPOS).map((r) => <li key={r} className="loom-data">{r}</li>)}
          {c.repos.length > REPOS && <li className="loom-data" title={c.repos.slice(REPOS).join(', ')}>+{c.repos.length - REPOS}</li>}
        </ul>
      )}
    </article>
  );
}

export function ProjectsView({ cards }: { cards: ProjectCards }) {
  const n = cards.active.length;
  return (
    <div className="loom-projects">
      {n > 0 && <p className="pj-head loom-data">{n} active{cards.waiting ? ` · ${cards.waiting} waiting on you` : ''}</p>}
      {n > 0 && <ul className="pj-grid" aria-label="Active projects">{cards.active.map((c) => <li key={`${c.agent ?? ''}/${c.slug}`}><Card c={c} /></li>)}</ul>}
      {cards.quiet.length > 0 && (
        <details className="pj-quiet" open={n === 0}>
          <summary>Paused and done <span className="loom-data">{cards.quiet.length}</span></summary>
          <ul className="pj-grid" aria-label="Paused and done projects">{cards.quiet.map((c) => <li key={`${c.agent ?? ''}/${c.slug}`}><Card c={c} /></li>)}</ul>
        </details>
      )}
    </div>
  );
}
