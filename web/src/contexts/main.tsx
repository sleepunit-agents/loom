import { SplitProposal, splitFor, splitPrompt } from './split';
import { newId } from '../data/id';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Signin from '../shell/signin';
import { useDataQuery } from '../data/graphql';
import type { SharedTask, SharedTaskComment } from '../pieces/tasks/shared-view';
import '../looks/looks.css';
import './style.css';
import { Portrait } from './portrait';
import { Chat } from './chat';
import { Ring, keep, kept, type Place, type Visit, type Details } from './ring';

import { useTaskCommandSubmitter } from '../data/task-command';
import { Head } from '../kit/reader';
import { DeskMember } from '../signin/desk-member';
import { evidence, reviewRequest, readReview } from './evidence';
import { useDiscussion } from './discussion';
import { EntityModule } from './entity-module';
import { entityAddress, entityAt, entityName, entityRequest, type EntityTarget } from './entities';

// Existing history and decision links without a subject belong to the original ticket.
const ticketId = new URL(location.href).searchParams.get('ticket') || 't-9';
const ignoreQuote = () => {};
const query = `query ContextTicket($id:String!) {
  ticket:tasksSingle(where:{id:{eq:$id}}) {
    id title status goal doneWhen createdAt createdBy closeReason ask projectRow {id name}
    changeTasksByTask {changeRow {id number title state checks}}
    taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}}) {seq at actor text}
  }
}`;
type Note = Pick<SharedTaskComment, 'seq' | 'at' | 'actor' | 'text'>;
type Ticket = Pick<
  SharedTask,
  'id' | 'title' | 'status' | 'goal' | 'doneWhen' | 'createdAt' | 'createdBy' | 'closeReason' | 'ask'
> & {
  projectRow: { id: string; name: string } | null;
  changeTasksByTask: {
    changeRow: { id: string; number: number; title: string; state: string; checks: string } | null;
  }[];
  taskCommentsByTask: Note[];
};
type Intent = 'history' | 'decision';
const labels = { history: 'What happened?', decision: 'What needs a decision?' };
const intentFromAddress = (): Intent => (location.hash === '#history' ? 'history' : 'decision');
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function Source({ note }: { note: Note }) {
  return (
    <details className="source">
      <summary>Read note · {date(note.at)}</summary>
      <p>{note.text}</p>
      <small>
        {note.actor} · Note {note.seq}
      </small>
    </details>
  );
}
// Keep note text and its preview behind the same authorized read.
function noteLead(note: Note) {
  const words = note.text.replace(/^(?:night shift )?\d{4}-\d{2}-\d{2}[^:]{0,30}:\s*/i, '');
  const first = words.split(/(?<=[.!?])\s+/)[0];
  return first.length <= 95 ? first : first.slice(0, 92).replace(/\s+\S*$/, '') + '…';
}
function Timeline({ notes }: { notes: Note[] }) {
  return (
    <ol className="timeline">
      {notes.map((note) => (
        <li key={note.seq}>
          <time dateTime={note.at}>{date(note.at)}</time>
          <details>
            <summary>{noteLead(note)}</summary>
            <p>{note.text}</p>
            <small>
              {note.actor} · Note {note.seq}
            </small>
          </details>
        </li>
      ))}
    </ol>
  );
}
const moduleLabels = {
  decision: 'Decision in scope',
  sample: 'Reported measurement',
  finding: 'Recorded finding',
  history: 'Ticket history',
  brief: 'Original brief',
  latest: 'Latest update',
  criteria: 'Completion criterion',
  project: 'Project',
  changes: 'Pull requests',
};
type Kind = keyof typeof moduleLabels;
const defaults: Record<Intent, Kind[]> = {
  decision: ['decision', 'sample', 'finding', 'changes', 'project'],
  history: ['history', 'latest', 'brief', 'changes', 'project'],
};
type Edits = Partial<Record<Intent, { added: Kind[]; removed: Kind[] }>>;
function readEdits(key: string): Edits {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    for (const view of ['decision', 'history'])
      for (const field of ['added', 'removed']) {
        if (
          saved[view] &&
          !(
            Array.isArray(saved[view][field]) &&
            saved[view][field].every((k: unknown) => typeof k === 'string' && Object.hasOwn(moduleLabels, k))
          )
        )
          return {};
      }
    return saved || {};
  } catch {
    return {};
  }
}
function BlueprintTicket({
  words,
  ticket,
  member,
  filed,
}: {
  words: string;
  ticket: Pick<Ticket, 'id' | 'projectRow'>;
  member: string;
  filed(): void;
}) {
  const submit = useTaskCommandSubmitter(),
    lock = useRef(false);
  const [state, setState] = useState<'idle' | 'filing' | 'failed'>('idle');
  async function file() {
    if (lock.current) return;
    lock.current = true;
    setState('filing');
    try {
      await submit({
        action: 'create',
        input: {
          type: 'feature',
          title: ('Blueprint request: ' + words).slice(0, 180),
          goal: words,
          why: 'No matching view for ' + ticket.id,
          doneWhen: 'A matching view can be opened from the context.',
          description: 'Requested from ' + ticket.id,
          priority: 2,
          project: ticket.projectRow?.id ?? null,
          owner: { kind: 'member', id: member },
        },
      });
      filed();
    } catch {
      setState('failed');
    } finally {
      lock.current = false;
    }
  }
  return (
    <>
      <button disabled={state === 'filing'} onClick={() => void file()}>
        {state === 'filing' ? 'Filing…' : 'File blueprint ticket'}
      </button>
      {state === 'failed' && <p role="alert">Could not confirm filing. Retry to check the same ticket.</p>}
    </>
  );
}
function Workspace({
  homeProject,
  ticket,
  member,
  place,
  active,
  visit,
  report,
}: {
  ticket: Ticket | null;
  homeProject: string;
  member: string;
  place: Place;
  active: boolean;
  visit: Visit | null;
  report: (id: string, d: Details) => void;
}) {
  const project = ticket?.projectRow,
    projectId = project?.id || '',
    home = place.id === 'loom',
    agent = place.agent;
  const storage = JSON.stringify([
    'loom-context-v2',
    member,
    home ? projectId : place.id,
    ticket?.id || 'workspace',
  ]);
  const discussion = useDiscussion(
    homeProject,
    agent,
    member,
    JSON.stringify(['loom-context-thread', member, home ? homeProject : place.id]),
    home ? undefined : place.id,
  );
  const lastFocus = 'context-focus:' + member + ':' + place.id;
  const [entity, setEntity] = useState<EntityTarget | null>(() => {
    const ref = (active && location.hash.slice(1)) || kept(lastFocus);
    return ref ? entityAt(ref) : home ? { kind: 'ticket' } : null;
  });
  const recordViewKey = lastFocus + ':record';
  const selectedAddress = entity ? entityAddress(entity) : '';
  function savedAddresses(key: string, fallback: string[]) {
    try {
      const raw: unknown = JSON.parse(kept(key) || 'null');
      if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string' && !!entityAt(v));
    } catch {
      /* Former or unavailable storage. */
    }
    return fallback.filter((v) => !!entityAt(v));
  }
  const [recordViews, setRecordViews] = useState<string[]>(() =>
    savedAddresses(recordViewKey + ':all', [kept(recordViewKey)]),
  );
  useEffect(() => {
    if (selectedAddress)
      setRecordViews((previous) => {
        if (previous.includes(selectedAddress)) return previous;
        const next = [...previous, selectedAddress];
        keep(recordViewKey + ':all', JSON.stringify(next));
        return next;
      });
  }, [selectedAddress, recordViewKey]);
  const hasTicket = !!ticket;
  const legacyPins = 'context-modules:' + member + ':' + place.id;
  const [excerpt, setExcerpt] = useState('');
  function openEntity(target: EntityTarget) {
    setEntity(target);
    location.hash = entityAddress(target);
    openBar(false);
  }
  const [intent, focus] = useState<Intent>(() =>
    ((active ? location.hash.slice(1) : '') || kept(lastFocus)) === 'history' ? 'history' : 'decision',
  );
  const [bar, openBar] = useState(false),
    [chat, showChat] = useState(!home);
  const views: Intent[] = ['decision', 'history'];
  const [opened, setOpened] = useState<Intent[]>(() => {
    if (!ticket) return [];
    try {
      const stored = JSON.parse(localStorage.getItem(storage + 'views') || 'null');
      if (Array.isArray(stored)) {
        const kept = views.filter((v) => stored.includes(v));
        if (active && views.includes(location.hash.slice(1) as Intent) && !kept.includes(intent))
          kept.push(intent);
        return kept;
      }
    } catch {
      /* Fresh context. */
    }
    return active && ['#decision', '#history'].includes(location.hash) ? [intent] : [];
  });
  const current = opened.includes(intent) ? intent : opened[0];
  const viewKey = selectedAddress || current || 'context';
  const pinsKey = legacyPins + ':views';
  const [pinsByView, setPinsByView] = useState<Record<string, string[]>>(() => {
    try {
      const value = JSON.parse(kept(pinsKey) || 'null');
      if (value && typeof value === 'object' && !Array.isArray(value))
        return Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string[]] =>
              Array.isArray(entry[1]) && entry[1].every((ref) => typeof ref === 'string' && entityAt(ref)),
          ),
        );
    } catch {
      /* Preserve readable legacy pins on the initial view. */
    }
    return { [viewKey]: savedAddresses(legacyPins, []) };
  });
  const pinned = pinsByView[viewKey] || [];
  const [choosingDestination, chooseDestination] = useState('');
  const elsewhere = [...opened, ...recordViews].filter(
    (ref) => ref !== viewKey && !(pinsByView[ref] || []).includes(viewKey),
  );
  function keepModules(next: string[], destination = viewKey) {
    setPinsByView((previous) => {
      const updated = { ...previous, [destination]: next };
      keep(pinsKey, JSON.stringify(updated));
      return updated;
    });
  }
  function closeRecord(ref: string) {
    const next = recordViews.filter((v) => v !== ref);
    keep(recordViewKey + ':all', JSON.stringify(next));
    setRecordViews(next);
    if (selectedAddress === ref) {
      const address = next.at(-1) || current || 'context';
      setEntity(entityAt(address));
      location.hash = address;
    }
  }
  function rememberViews(next: Intent[]) {
    setOpened(next);
    try {
      localStorage.setItem(storage + 'views', JSON.stringify(next));
    } catch {
      /* Session only */
    }
  }
  function closeView(view: Intent) {
    const next = opened.filter((v) => v !== view);
    rememberViews(next);
    if (!entity && current === view) {
      const target = next[0];
      location.hash = target || 'context';
      if (target) focus(target);
    }
    record('Closed ' + labels[view]);
  }
  const [command, setCommand] = useState(''),
    [miss, setMiss] = useState<{ view: Intent; words: string } | null>(null);
  const [edits, setEdits] = useState<Edits>(() => readEdits(storage));
  const input = useRef<HTMLInputElement>(null),
    dock = useRef<HTMLButtonElement>(null);
  const notes = ticket?.taskCommentsByTask || [],
    lead = evidence(notes);
  const changes = (ticket?.changeTasksByTask || []).flatMap((link) =>
    link.changeRow ? [link.changeRow] : [],
  );
  const reviewWords = reviewRequest(ticket?.id || '', notes[0]?.seq ?? 0);
  const reviewMarker =
    '[Loom context · ' + (ticket?.id || '') + ' · ' + labels.decision + ']\n' + reviewWords;
  const latestRequest = discussion.messages.findLast((m) => m.kind === 'message' && m.words === reviewMarker);
  const latestReview =
    latestRequest &&
    discussion.messages
      .filter((m) => m.kind === 'reply' && m.sender === agent && m.seq > latestRequest.seq)
      .map((m) => readReview(m.words || '', ticket?.id || '', notes))
      .findLast(Boolean);
  const [confirmed, setConfirmed] = useState<Record<string, Intent>>({});
  const [receipts, setReceipts] = useState<string[]>([]);
  function record(words: string) {
    setReceipts((previous) => [...previous.slice(-49), words]);
  }
  async function phraseKey(words: string) {
    const normalized = words
      .trim()
      .toLowerCase()
      .replace(/[?.!]$/, '');
    if (!crypto.subtle) return normalized;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function confirmRoute(words: string, view: Intent) {
    const key = await phraseKey(words);
    setConfirmed((previous) => ({ ...previous, [key]: view }));
    if (crypto.subtle) {
      try {
        localStorage.setItem(storage + 'route:' + key, view);
      } catch {
        /* Session only */
      }
    }
    record('Confirmed “' + labels[view] + '” for this request.');
    navigate(view);
  }
  const [dismissed, setDismissed] = useState(0);
  const [result, setResult] = useState<{ view: Intent; seq: number; notify: boolean } | null>(null);
  const awaiting = useRef<{ view: Intent; clientId: string } | null>(null);
  const [waiting, setWaiting] = useState<Intent | null>(null);
  useEffect(() => {
    const change = () => {
      if (!active) return;
      const target = entityAt(location.hash.slice(1));
      setEntity(target);
      if (!hasTicket || target || location.hash === '#context') return;
      const view = intentFromAddress();
      focus(view);
      setOpened((previous) => (previous.includes(view) ? previous : [...previous, view]));
    };
    const key = (event: KeyboardEvent) => {
      if (!active) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openBar((v) => !v);
      }
      if (event.altKey && event.code === 'Backquote') {
        event.preventDefault();
        const addresses = [...opened, ...recordViews];
        if (addresses.length > 1)
          location.hash =
            addresses[(addresses.indexOf(selectedAddress || current || '') + 1) % addresses.length];
      }
      if (event.key === 'Escape') {
        openBar(false);
      }
    };
    window.addEventListener('hashchange', change);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('hashchange', change);
      window.removeEventListener('keydown', key);
    };
  }, [opened, current, active, hasTicket, recordViews, selectedAddress]);
  useEffect(() => {
    if (bar) input.current?.focus();
  }, [bar]);
  useEffect(() => {
    const pending = awaiting.current;
    if (!pending) return;
    const sent = discussion.messages.findLast((m) => m.kind === 'message' && m.clientId === pending.clientId);
    const subsequent =
      sent &&
      discussion.messages.filter((m) => m.seq > sent.seq && (m.kind === 'message' || m.kind === 'reply'));
    const reply = subsequent?.some((m) => m.kind === 'message')
      ? undefined
      : subsequent?.findLast((m) => m.kind === 'reply');
    if (sent?.delivery === 'failed' || subsequent?.some((m) => m.kind === 'message')) {
      awaiting.current = null;
      setWaiting(null);
    }
    if (reply && !discussion.working) {
      setResult({ view: pending.view, seq: reply.seq, notify: !!entity || current !== pending.view });
      awaiting.current = null;
      setWaiting(null);
    }
  }, [discussion.messages, discussion.working, current, entity]);
  const visible = (view: Intent) => {
    const edit = edits[view];
    return [...new Set([...defaults[view], ...(edit?.added || [])])].filter(
      (k) => !edit?.removed.includes(k) && available(k),
    );
  };
  function available(k: Kind) {
    if (k === 'sample') return !!lead.measurement;
    if (k === 'finding') return !!lead.finding;
    if (k === 'latest') return !!notes.length;
    if (k === 'project') return !!project;
    if (k === 'changes') return !!changes.length;
    return true;
  }
  function adjust(view: Intent, k: Kind, add: boolean) {
    if (k === defaults[view][0]) return;
    record((add ? 'Added ' : 'Removed ') + moduleLabels[k] + ' · ' + labels[view]);
    setEdits((previous) => {
      const prev = previous[view] || { added: [], removed: [] };
      const added = prev.added.filter((x) => x !== k),
        removed = prev.removed.filter((x) => x !== k);
      if (add) added.push(k);
      else removed.push(k);
      const next = { ...previous, [view]: { added, removed } };
      try {
        localStorage.setItem(storage, JSON.stringify(next));
      } catch {
        /* Still applies in this window. */
      }
      return next;
    });
    setMiss(null);
  }
  function closeBar() {
    openBar(false);
    setCommand('');
    dock.current?.focus();
  }
  function navigate(view: Intent) {
    if (!ticket) return;
    if (!opened.includes(view)) rememberViews([...opened, view]);
    focus(view);
    location.hash = view;
    setMiss(null);
    closeBar();
  }
  async function route(words: string) {
    const text = words
      .trim()
      .toLowerCase()
      .replace(/[?.!]$/, '');
    if (!text) return;
    const target = entityRequest(words);
    if (target) {
      openEntity(target);
      return;
    }
    for (const view of ['history', 'decision'] as const)
      if ([labels[view].slice(0, -1).toLowerCase(), 'open ' + view, view].includes(text)) {
        navigate(view);
        return;
      }
    const match = /^(add|include|remove|hide) (?:the )?(.+?)(?: (?:here|to this view))?$/.exec(text);
    if (match) {
      const aliases: Record<string, Kind> = {
        history: 'history',
        'decision criteria': 'criteria',
        measurement: 'sample',
        finding: 'finding',
        brief: 'brief',
      };
      const k =
        aliases[match[2]] ||
        (Object.keys(moduleLabels).find((key) => moduleLabels[key as Kind].toLowerCase() === match[2]) as
          Kind | undefined);
      if (k && available(k) && current && k !== defaults[current][0]) {
        adjust(current, k, ['add', 'include'].includes(match[1]));
        closeBar();
        return;
      }
    }
    const key = await phraseKey(words);
    let choice = confirmed[key];
    if (crypto.subtle) {
      try {
        choice = (localStorage.getItem(storage + 'route:' + key) as Intent) || choice;
      } catch {
        /* Session only */
      }
    }
    if (choice === 'history' || choice === 'decision') {
      navigate(choice);
      return;
    }
    if (!current) navigate(intent);
    setMiss({ view: current || intent, words: words.trim() });
    closeBar();
  }
  async function ask(words: string, view: Intent) {
    if (!ticket || !words.trim() || discussion.busy) return;
    if (!opened.includes(view)) navigate(view);
    const origin = { ticket: ticket.id, view: labels[view] };
    setWaiting(view);
    setResult(null);
    setMiss(null);
    closeBar();
    if (
      !(await discussion.send(words.trim(), origin, (id) => {
        awaiting.current = { view, clientId: id };
      }))
    ) {
      awaiting.current = null;
      setWaiting(null);
      setCommand(words);
      openBar(true);
    }
  }
  function arrange(words: string, view: Intent) {
    const options = (Object.keys(moduleLabels) as Kind[]).filter((k) => available(k));
    return ask(
      'Interpret this workspace request: ' +
        JSON.stringify(words) +
        '. Current modules: ' +
        visible(view).join(', ') +
        '. Available modules: ' +
        options.join(', ') +
        '. Return JSON only: {"view":"' +
        view +
        '","add":[],"remove":[]} using those module IDs. ' +
        'Preserve the core module. If the request instead needs an explanation, answer in ordinary text. Do not change the underlying ticket.',
      view,
    );
  }
  function proposal(words: string, view: Intent) {
    try {
      const data = JSON.parse(
        words
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, ''),
      );
      if (data.view !== view || !Array.isArray(data.add) || !Array.isArray(data.remove)) return;
      const valid = (k: unknown): k is Kind =>
        typeof k === 'string' &&
        Object.hasOwn(moduleLabels, k) &&
        k !== defaults[view][0] &&
        available(k as Kind);
      if (![...data.add, ...data.remove].every(valid) || data.add.some((k: Kind) => data.remove.includes(k)))
        return;
      const add: Kind[] = data.add.filter((k: Kind) => !visible(view).includes(k));
      const remove: Kind[] = data.remove.filter((k: Kind) => visible(view).includes(k));
      return { add, remove };
    } catch {
      return;
    }
  }
  function body(k: Kind): ReactNode {
    if (!ticket) return null;
    switch (k) {
      case 'decision':
        return (
          <>
            <h3>
              {ticket.status === 'closed'
                ? ticket.closeReason || 'Ticket closed'
                : ticket.ask || latestReview?.question || lead.decision?.text || ticket.goal}
            </h3>
            {latestReview && (
              <div>
                <small>{agent}’s evidence review</small>
                {latestReview.findings.map((f, i) => (
                  <div className="citation" key={i}>
                    <p>{f.quote}</p>
                    <Source note={f.note} />
                  </div>
                ))}
              </div>
            )}
            {ticket.status !== 'closed' && !latestReview && !ticket.ask && lead.decision && (
              <Source note={lead.decision.note} />
            )}
            {agent && ticket.status !== 'closed' && (
              <button disabled={discussion.busy} onClick={() => void ask(reviewWords, 'decision')}>
                {latestReview ? 'Refresh evidence review' : 'Review evidence with ' + agent}
              </button>
            )}
            {ticket.doneWhen && (
              <details className="source">
                <summary>Completion criterion</summary>
                <p>{ticket.doneWhen}</p>
              </details>
            )}
          </>
        );
      case 'sample':
        return (
          lead.measurement && (
            <>
              <div className="measure">
                {lead.measurement.numerator} <span>/ {lead.measurement.denominator}</span>
              </div>
              <p>{lead.measurement.text}</p>
              <Source note={lead.measurement.note} />
            </>
          )
        );
      case 'finding':
        return (
          lead.finding && (
            <>
              <p>{lead.finding.text}</p>
              <Source note={lead.finding.note} />
            </>
          )
        );
      case 'history':
        return notes.length ? <Timeline notes={notes} /> : <p>No notes yet.</p>;
      case 'brief':
        return (
          <>
            <p>{ticket.goal}</p>
            {ticket.createdAt && (
              <small>
                Opened {date(ticket.createdAt)} by {ticket.createdBy}
              </small>
            )}
          </>
        );
      case 'criteria':
        return <p>{ticket.doneWhen || 'No completion criterion recorded.'}</p>;
      case 'latest':
        return (
          <>
            <p>{noteLead(notes[0])}</p>
            <Source note={notes[0]} />
          </>
        );
      case 'project':
        return (
          <button onClick={() => openEntity({ kind: 'project', id: projectId })}>{project?.name}</button>
        );
      case 'changes':
        return changes.map((c) => (
          <p key={c.id}>
            <button onClick={() => openEntity({ kind: 'change', id: c.id })}>
              #{c.number} {c.title}
            </button>
            <br />
            <small>
              {c.state} · {c.checks}
            </small>
          </p>
        ));
    }
  }
  const response = discussion.messages.find((m) => m.seq === result?.seq);
  useEffect(() => {
    if (!result || (!entity && current === result.view) || result.seq === dismissed) return;
    const timer = setTimeout(() => setDismissed(result.seq), 6500);
    return () => clearTimeout(timer);
  }, [result, current, dismissed, entity]);
  const proposed = result && response && proposal(response.words || '', result.view);

  function renderModules(view: Intent) {
    if (!ticket) return null;
    const list = visible(view),
      core = defaults[view][0];
    const isFar = (k: Kind) =>
      k === 'project' || k === 'brief' || (k === 'changes' && changes.every((c) => c.state !== 'open'));
    const render = (k: Kind) => {
      const core = k === defaults[view][0],
        far = isFar(k);
      const panel = (
        <>
          <Head
            actions={
              !core && (
                <button
                  className="remove"
                  aria-label={'Remove ' + moduleLabels[k]}
                  onClick={() => adjust(view, k, false)}
                >
                  ×
                </button>
              )
            }
          >
            <h2>{k === 'decision' && ticket.status === 'closed' ? 'Outcome' : moduleLabels[k]}</h2>
          </Head>
          {core && (
            <>
              <small>
                <button onClick={() => openEntity({ kind: 'ticket', id: ticket.id })}>
                  {ticket.id.toUpperCase()}
                </button>{' '}
                · {ticket.status.replace('_', ' ')}
              </small>
              <h1>{ticket.title}</h1>
            </>
          )}
          {body(k)}
        </>
      );
      return far ? (
        <details className="module far" key={k}>
          <summary>{moduleLabels[k]}</summary>
          {panel}
        </details>
      ) : (
        <section className={'module ' + (core ? 'core' : 'near')} key={k}>
          {panel}
        </section>
      );
    };
    return (
      <>
        {render(core)}
        <div className="nearStrip">{list.filter((k) => k !== core && !isFar(k)).map(render)}</div>
        {list.filter(isFar).map(render)}
      </>
    );
  }
  useEffect(() => {
    if (!visit || !active) return;
    if (visit.chat) showChat(true);
    if (visit.focus) setEntity(entityAt(visit.focus));
    if (hasTicket && (visit.focus === 'history' || visit.focus === 'decision')) {
      const v = visit.focus;
      focus(v);
      setOpened((prev) => (prev.includes(v) ? prev : [...prev, v]));
    }
  }, [visit, active, hasTicket]);
  const reply = discussion.messages.findLast((m) => m.kind === 'reply'),
    unread = reply && reply.seq > discussion.readSeq;
  const failed = discussion.messages.at(-1)?.delivery === 'failed';
  const reason = discussion.questions.length
    ? 'Question for you'
    : failed
      ? 'Delivery failed'
      : unread
        ? 'Reply from ' + (agent === 'art' ? 'Art' : agent)
        : '';
  const attentionMessage = discussion.questions[0]
    ? discussion.messages.find((m) => m.inboxItem === discussion.questions[0])
    : reply;
  const preceding = discussion.messages.findLast(
    (m) => m.kind === 'message' && m.seq <= (attentionMessage?.seq ?? Infinity),
  );
  const originMarker = preceding?.words?.split('\n')[0].match(/ · (entity\/[^\]]+)\]$/)?.[1];
  const origin =
    originMarker && entityAt(originMarker)
      ? originMarker
      : preceding?.words?.split('\n')[0].includes(labels.history)
        ? 'history'
        : preceding?.words?.split('\n')[0].includes(labels.decision)
          ? 'decision'
          : 'context';
  const focusKey = entity ? entityAddress(entity) : current || 'context';
  useEffect(() => {
    keep(lastFocus, focusKey);
    report(place.id, {
      views: [...opened.map((v) => labels[v]), ...recordViews.map((ref) => entityName(entityAt(ref)!))],
      focus: focusKey,
      reason,
      origin,
      event: reply?.seq || 0,
      question: discussion.questions[0],
    });
  }, [
    lastFocus,
    focusKey,
    opened,
    recordViews,
    reason,
    origin,
    reply?.seq,
    discussion.questions[0],
    place.id,
    report,
  ]);
  const focusedId = entity
    ? entity.kind === 'ticket'
      ? entity.id
      : undefined
    : current
      ? ticket?.id
      : undefined;
  const subjectRead = useDataQuery<{ subject: { id: string; project: string | null } | null }>(
    'query ContextSubject($id:String!){subject:tasksSingle(where:{id:{eq:$id}}){id project}}',
    { id: focusedId || '' },
    { pause: !active || !focusedId },
  );
  const subject =
    subjectRead.status === 'live' && subjectRead.data?.subject?.id === focusedId
      ? subjectRead.data?.subject
      : null;
  const latestProject =
    entity?.kind === 'project' ? entity.id : subject?.project || (home ? homeProject : undefined);
  const directory = useDataQuery<{
    projects: { id: string; name: string; tasksByProject: { id: string }[] }[];
  }>(
    'query ContextProjects {projects{id name tasksByProject(orderBy:{createdAt:{direction:desc,priority:1},position:{direction:desc,priority:0}},limit:1){id}}}',
    {},
    { pause: !active },
  );
  function projectNamed(name: string | undefined) {
    return directory.data?.projects.find(
      (p) =>
        name && (p.id.toLowerCase() === name.toLowerCase() || p.name.toLowerCase() === name.toLowerCase()),
    );
  }
  const split = subject ? splitFor(discussion.messages, focusKey, agent) : undefined;
  const [routingMiss, setRoutingMiss] = useState<{ words: string; ref: string } | null>(null);
  const [routeError, setRouteError] = useState('');
  async function sendChat(words: string) {
    const text = words.trim().replace(/[?.!]+$/, '');
    setRouteError('');
    const namedProject =
      /^(?:(?:show|open|check) (?:me )?(?:the )?)?(?:project (?:health|status)(?: of| for|:)?|(?:status|health) of (?:project|the project))\s+(.+)$/i.exec(
        text,
      );
    if (namedProject) {
      openEntity({ kind: 'project', id: projectNamed(namedProject[1].trim())?.id || namedProject[1].trim() });
      record(words);
      return true;
    }
    const latest =
      /^(?:show|open|find) (?:me )?(?:the )?(?:latest|newest|most recent) (?:task|ticket)(?: in (.+))?$/i.exec(
        text,
      );
    if (latest) {
      const id = projectNamed(latest[1]?.trim() || latestProject)?.tasksByProject[0]?.id;
      if (!id) {
        setRouteError(
          directory.status === 'live'
            ? 'No visible tickets in this project.'
            : 'Project tickets unavailable.',
        );
        return false;
      }
      openEntity({ kind: 'ticket', id });
      record(words);
      return true;
    }
    if (
      /^(?:i think we should |let.s |please )?split (?:this|the task|this task)(?: in(?:to)? .*)?$/i.test(
        text,
      )
    ) {
      if (!subject) {
        setRouteError('Open a ticket to split it.');
        return false;
      }
      return discussion.send(
        splitPrompt(words, newId(), subject.id),
        { ticket: subject.id, view: focusKey },
        () => {},
      );
    }
    if (
      /^(?:(?:how.s|how is) (?:the |this )?project (?:doing|looking)(?: overall)?|(?:open |show (?:me )?)?(?:the )?project health)$/i.test(
        text,
      )
    ) {
      const id = entity?.kind === 'project' ? entity.id : subject?.project;
      if (!id) {
        setRouteError('Open a project or one of its tickets first.');
        return false;
      }
      openEntity({ kind: 'project', id });
      record(words);
      return true;
    }
    const explicit = text.match(/\bt-\d+\b/i)?.[0].toLowerCase();
    if (
      (subject || explicit) &&
      /^(?:show |open |what happened|history|what needs a decision|decisions)/i.test(text) &&
      /history|what happened|decision/i.test(text)
    ) {
      openEntity({
        kind: 'ticket',
        id: explicit || subject!.id,
        view: /history|happened/i.test(text) ? 'history' : 'decision',
      });
      record(words);
      return true;
    }
    if (
      subject &&
      /^(?:add|include|let.s (?:add|see)|show me) .*(?:history|past prs|last batch of prs)/i.test(text)
    ) {
      const module = entityAddress({ kind: 'ticket', id: subject.id, view: 'history' });
      keepModules([...new Set([...pinned, module])]);
      record(words);
      return true;
    }
    const add = /^(?:add|keep) (.+?) (?:alongside|as a module|beside this view)[.!]?$/i.exec(words.trim());
    if (add) {
      const module = add[1].toLowerCase() === 'this' ? entity : entityRequest('open ' + add[1]);
      if (module?.id) {
        keepModules([...new Set([...pinned, entityAddress(module)])]);
        record(words);
        return true;
      }
    }
    const requested = entityRequest(words);
    if (requested) {
      openEntity(requested);
      record(words);
      return true;
    }
    if (/^(show |open |find |list |bring up )/i.test(text)) {
      const target =
        entity || (subject ? { kind: 'ticket' as const, id: subject.id } : { kind: 'ticket' as const });
      if (!entity) openEntity(target);
      const ref = entityAddress(target);
      if (kept(lastFocus + ':confirmed:' + (await phraseKey(words))) !== ref) setRoutingMiss({ words, ref });
      return true;
    }
    if (!entity && /^(?:add|include|remove|hide) /i.test(text)) {
      await route(words);
      return true;
    }
    const view = current;
    return discussion.send(
      words,
      entity
        ? { ticket: entityName(entity), view: entityAddress(entity) }
        : { ticket: view && ticket ? ticket.id : place.name, view: view ? labels[view] : 'Conversation' },
      () => {},
    );
  }
  function sendForm() {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendChat(command).then((ok) => {
            if (ok) closeBar();
          });
        }}
      >
        <label htmlFor={'intent-' + place.id}>What would you like to see?</label>
        <input
          ref={input}
          id={'intent-' + place.id}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          autoComplete="off"
        />
        <div className="suggestions">
          {[
            labels.history,
            labels.decision,
            ...(Object.keys(moduleLabels) as Kind[])
              .filter((k) => available(k) && !!current && !visible(current).includes(k))
              .map((k) => 'Add ' + moduleLabels[k]),
          ].map((s) => (
            <button type="button" key={s} onClick={() => void sendChat(s)}>
              {s}
            </button>
          ))}
        </div>
        {command.trim() && (
          <div>
            <button type="submit" disabled={discussion.busy}>
              Send
            </button>
          </div>
        )}
        {discussion.error && <p role="alert">{discussion.error}</p>}
      </form>
    );
  }
  return (
    <div className="workspace">
      <main>
        <nav aria-label="Open views">
          {opened.map((v) => (
            <span className="viewTab" key={v}>
              <a href={'#' + v} aria-current={!entity && v === current ? 'page' : undefined}>
                {labels[v]}
              </a>
              <button className="remove" aria-label={'Close ' + labels[v]} onClick={() => closeView(v)}>
                ×
              </button>
            </span>
          ))}
          {recordViews.map((ref) => {
            const target = entityAt(ref)!;
            return (
              <span className="viewTab" key={ref}>
                <a href={'#' + ref} aria-current={selectedAddress === ref ? 'page' : undefined}>
                  {entityName(target)}
                </a>
                <button
                  className="remove"
                  aria-label={'Close ' + entityName(target)}
                  onClick={() => closeRecord(ref)}
                >
                  ×
                </button>
              </span>
            );
          })}
          {!recordViews.length && (
            <button onClick={() => openEntity({ kind: 'ticket' })}>Explore records</button>
          )}
          {opened.length === 2 && <button onClick={() => openBar(true)}>View options</button>}
          {ticket && opened.length < 2 && <button onClick={() => openBar(true)}>Open view</button>}
        </nav>
        <div className="layout">
          <div className="viewStack">
            {active && entity && (
              <EntityModule
                key={entityAddress(entity)}
                target={entity}
                open={openEntity}
                quote={setExcerpt}
                pin={entity.id && elsewhere.length ? () => chooseDestination(viewKey) : undefined}
                talk={() => showChat(true)}
              />
            )}
            {active && entity && choosingDestination === viewKey && (
              <section className="module near">
                <h3>Keep alongside which view?</h3>
                {elsewhere.map((ref) => (
                  <button
                    key={ref}
                    onClick={() => {
                      keepModules([...(pinsByView[ref] || []), viewKey], ref);
                      chooseDestination('');
                      record('Added ' + entityName(entity) + ' to ' + ref);
                    }}
                  >
                    {entityAt(ref) ? entityName(entityAt(ref)!) : labels[ref as Intent]}
                  </button>
                ))}
                <button onClick={() => chooseDestination('')}>Cancel</button>
              </section>
            )}
            {active && routeError && <p role="alert">{routeError}</p>}
            {active && routingMiss?.ref === focusKey && (
              <section className="module near">
                <h3>Is this the view you meant?</h3>
                <p>{routingMiss.words}</p>
                <button
                  onClick={async () => {
                    const { words, ref } = routingMiss;
                    keep(lastFocus + ':confirmed:' + (await phraseKey(words)), ref);
                    setRoutingMiss(null);
                    record('Confirmed route for ' + words);
                  }}
                >
                  Route is correct
                </button>
                <button
                  onClick={() => {
                    openEntity(
                      subject?.project ? { kind: 'project', id: subject.project } : { kind: 'project' },
                    );
                    setRoutingMiss(null);
                  }}
                >
                  Try another view
                </button>
                <BlueprintTicket
                  words={routingMiss.words}
                  ticket={{
                    id: subject?.id || focusKey,
                    projectRow: subject?.project ? { id: subject.project, name: subject.project } : null,
                  }}
                  member={member}
                  filed={() => {
                    record('Filed blueprint ticket');
                    setRoutingMiss(null);
                  }}
                />
                <button aria-label="Dismiss routing question" onClick={() => setRoutingMiss(null)}>
                  ×
                </button>
              </section>
            )}
            {active && subject && split && (
              <SplitProposal
                key={split.id}
                id={split.id}
                initial={split.drafts}
                parent={subject.id}
                project={subject.project}
                working={discussion.working}
                open={openEntity}
                receipt={(words) => {
                  record(words);
                  void discussion.send(words, { ticket: subject.id, view: focusKey }, () => {});
                }}
              />
            )}
            {!entity && !opened.length && (
              <section className="module core">
                <h1>{place.name}</h1>
                <button onClick={() => showChat(true)}>Talk to Art</button>
              </section>
            )}
            {opened.map((view) => (
              <div key={view} hidden={!!entity || view !== current}>
                <div className="modules">
                  {renderModules(view)}
                  {miss?.view === view && (
                    <section className="module">
                      <h2>Which view did you mean?</h2>
                      <p>{miss.words}</p>
                      {(['history', 'decision'] as const).map((v) => (
                        <button key={v} onClick={() => void confirmRoute(miss.words, v)}>
                          {v === view ? 'This view is right' : labels[v]}
                        </button>
                      ))}
                      {agent && (
                        <button disabled={!!waiting} onClick={() => void arrange(miss.words, view)}>
                          Ask {agent} to arrange this view
                        </button>
                      )}
                      {ticket && (
                        <BlueprintTicket
                          words={miss.words}
                          ticket={ticket}
                          member={member}
                          filed={() => {
                            record('Filed blueprint ticket · ' + labels[view]);
                            setMiss(null);
                          }}
                        />
                      )}
                      <button onClick={() => setMiss(null)}>Dismiss</button>
                    </section>
                  )}
                  {waiting === view && (
                    <section className="module" role="status">
                      <h2>
                        {agent} ·{' '}
                        {discussion.busy ? 'Sending' : discussion.working ? 'Working' : 'Awaiting reply'}
                      </h2>
                      <button onClick={() => showChat(true)}>Open conversation</button>
                      <button
                        onClick={() => {
                          awaiting.current = null;
                          setWaiting(null);
                        }}
                      >
                        Dismiss status
                      </button>
                    </section>
                  )}
                  {result?.view === view &&
                    response &&
                    !readReview(response.words || '', ticket?.id || '', notes) && (
                      <section className="module">
                        <h2>{response.sender}</h2>
                        {proposed ? (
                          <>
                            {proposed.add.map((k) => (
                              <p key={k}>Add {moduleLabels[k]}</p>
                            ))}
                            {proposed.remove.map((k) => (
                              <p key={k}>Remove {moduleLabels[k]}</p>
                            ))}
                            {proposed.add.length + proposed.remove.length > 0 ? (
                              <button
                                onClick={() => {
                                  proposed.add.forEach((k) => adjust(view, k, true));
                                  proposed.remove.forEach((k) => adjust(view, k, false));
                                }}
                              >
                                Apply to this view
                              </button>
                            ) : (
                              <p>View matches the proposal.</p>
                            )}
                          </>
                        ) : (
                          <p>{response.words}</p>
                        )}
                      </section>
                    )}
                </div>
              </div>
            ))}
            {active &&
              pinned
                .filter((ref) => ref !== focusKey)
                .map((ref) => {
                  const target = entityAt(ref)!;
                  return (
                    <div className="companionModule" key={ref}>
                      <button
                        onClick={() => keepModules(pinned.filter((v) => v !== ref))}
                        aria-label={'Remove ' + entityName(target)}
                      >
                        ×
                      </button>
                      <EntityModule
                        companion
                        target={target}
                        quote={ignoreQuote}
                        open={openEntity}
                        talk={() => {
                          openEntity(target);
                          showChat(true);
                        }}
                      />
                    </div>
                  );
                })}
          </div>
          {chat && (
            <Chat
              name={place.name}
              agent={agent || 'Art'}
              discussion={discussion}
              visible={active}
              onClose={() => showChat(false)}
              onSend={sendChat}
              subject={entity ? entityName(entity) : undefined}
              subjectRef={entity ? entityAddress(entity) : undefined}
              excerpt={entity ? excerpt : undefined}
              receipts={receipts}
            />
          )}
        </div>
      </main>
      <div className="dock">
        {active &&
          unread &&
          originMarker &&
          entityAt(originMarker) &&
          originMarker !== focusKey &&
          reply.seq !== dismissed && (
            <div className="ding" role="status">
              Art replied about {entityName(entityAt(originMarker)!)}{' '}
              <button
                onClick={() => {
                  setDismissed(reply.seq);
                  openEntity(entityAt(originMarker)!);
                  showChat(true);
                }}
              >
                Show me
              </button>
              <button aria-label="Dismiss notification" onClick={() => setDismissed(reply.seq)}>
                ×
              </button>
            </div>
          )}
        {result?.notify && result.seq !== dismissed && response && (entity || current !== result.view) && (
          <div className="ding" role="status">
            Reply from {response.sender}{' '}
            <button
              onClick={() => {
                setDismissed(result.seq);
                navigate(result.view);
              }}
            >
              Show me
            </button>
            <button aria-label="Dismiss notification" onClick={() => setDismissed(result.seq)}>
              ×
            </button>
          </div>
        )}
        {bar && sendForm()}
        <button className="art" ref={dock} aria-expanded={chat} onClick={() => showChat((v) => !v)}>
          <Portrait
            state={
              failed || discussion.error
                ? 'error'
                : discussion.questions.length
                  ? 'needs-input'
                  : discussion.busy
                    ? 'thinking'
                    : discussion.working || waiting
                      ? 'working'
                      : result || unread
                        ? 'complete'
                        : 'idle'
            }
          />
          <span className="artWords">
            <strong>Art</strong>
            <span>
              {discussion.working
                ? 'Working'
                : discussion.questions.length
                  ? 'Has a question for you'
                  : 'Talk to Art'}
            </span>
          </span>
        </button>
        <button
          className="quickDock"
          aria-expanded={bar}
          aria-label="Quick command"
          onClick={() => openBar((v) => !v)}
        >
          <kbd>⌘ / Ctrl K</kbd>
        </button>
      </div>
    </div>
  );
}
function App() {
  const member = useContext(DeskMember);
  const read = useDataQuery<{ ticket: Ticket | null }>(query, { id: ticketId });
  const home = useDataQuery<{
    project: { id: string; name: string } | null;
    agent: string | null;
    homeComms: { member: string; agents: string[] } | null;
  }>(
    '{project:projectsSingle(where:{id:{eq:"loom"}}){id name} agent:workDiscussionAgent(kind:"project",id:"loom") homeComms{member agents}}',
  );
  if (home.status !== 'live' || !member)
    return (
      <main role="status">
        {home.status === 'loading' ? 'Opening workspace…' : 'Workspace unavailable. Reconnecting…'}
      </main>
    );
  const project = home.data?.project;
  const agent = home.data?.agent || home.data?.homeComms?.agents[0] || null;
  const ticket = read.status === 'live' ? read.data?.ticket || null : null;
  // Wait for an explicitly requested ticket view. Record modules and personal conversations can open independently.
  if (read.status === 'loading' && ['#history', '#decision'].includes(location.hash))
    return <main role="status">Opening ticket…</main>;
  return (
    <Ring key={member} member={member} agent={agent} project={project?.name || 'Loom'}>
      {(place, active, visit, report) => (
        <Workspace
          ticket={ticket}
          homeProject={home.data?.agent ? project?.id || '' : ''}
          member={member}
          place={place}
          active={active}
          visit={visit}
          report={report}
        />
      )}
    </Ring>
  );
}
createRoot(document.getElementById('root')!).render(
  <Signin>
    <App />
  </Signin>,
);
