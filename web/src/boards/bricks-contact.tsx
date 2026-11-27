/** The `person` brick's card: what the desktop's People reader shows for one person (pieces/people), read with its
 * selections (memory/queries.ts): the shared card under the id People uses, `commons:<slug>` (memoryPerson), and,
 * from the directory People lists (memoryPeople), the relationship cards of the agents the member may read. A
 * member's card is the shared card whose slug is their member id; their open tickets are drawn under it. Read-only:
 * People's reader changes nothing either. */
import type { ReactNode } from 'react';
import { memoryQueries, type PersonOpen } from '../memory/queries';
import { useMemoryQuery, useMemoryRecord } from '../memory/query';
import { contactLink, contacts, type Person } from '../pieces/people/model';
import { Chip, Loading, Unavailable } from './bricks';
import type { Form } from './layout';

const id = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,119}$/;
const agentChip = (agent: string) => id.test(agent) ? <Chip key={agent} place={{ brick: 'agent', params: { agent } }}>{agent}</Chip> : <span key={agent}>{agent}</span>;
const day = (at: string) => at.slice(0, 10);
const said = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value));

/** Where someone is reached. Big, an address People links is a link, with when it was verified and its source. */
function Fields({ person, big }: { person: Person; big: boolean }) {
  return <>{person.fields.map((f) => {
    const href = big ? contactLink(f.key, person.card.where[f.key]?.value) : undefined;
    return (
      <span key={f.key} className="block">{f.key}: {f.label ? f.label + ' · ' : ''}{href ? <a className="underline" href={href}>{f.value}</a> : f.value} · {f.state}
        {big && f.verifiedAt ? ` · verified ${day(f.verifiedAt)}` : ''}{big && f.source ? ` · Source: ${f.source}` : ''}</span>
    );
  })}</>;
}
const Facts = ({ person }: { person: Person }) => <>{Object.entries(person.card.how ?? {}).map(([key, value]) => <span key={key} className="block">{key}: {said(value)}</span>)}</>;

/** One agent's relationship card, as People draws it: its summary, how old it is, its facts, the permissions it
 * records and the notes behind it. Loom hands over only the cards and notes this member may read. */
function Relationship({ card }: { card: Person }) {
  return (
    <div data-relationship={card.agent}>
      <div className="board-line">{agentChip(card.agent ?? '')}<span className="text-muted-foreground">Updated {day(card.updated)} · {card.newer} memories newer than this card</span></div>
      {card.card.summary && <p>{card.card.summary}</p>}
      <Facts person={card} />
      {card.fields.length > 0 && <Fields person={card} big />}
      {card.card.may.length > 0 && <p>Recorded permissions: {card.card.may.map((m) => `${m.text} · ${m.source}`).join('; ')}. These records do not grant access.</p>}
      {card.evidence.length
        ? card.evidence.map((e, i) => <details key={i}><summary>{e.title} · {day(e.created)}</summary><p className="whitespace-pre-wrap">{e.content}</p><p className="text-muted-foreground">{e.category}</p></details>)
        : <p className="text-muted-foreground">No active evidence recorded.</p>}
    </div>
  );
}

function Card({ person, relationships, form }: { person: PersonOpen; relationships: Person[]; form?: Form }) {
  const big = form === 'primary';
  return (
    <>
      <p className="board-lead">{person.name}</p>
      {person.card.summary && <p>{person.card.summary}</p>}
      {big && person.mergedFrom && <p className="text-muted-foreground">{person.mergedFrom} was merged into {person.slug}.</p>}
      <dl style={{ marginTop: '.8rem' }}>
        {big && person.ownership && <div><dt>Owns</dt><dd className="board-line">{person.ownership.owner ? 'The household and every agent' : person.ownership.agents.map(agentChip)}</dd></div>}
        <div><dt>How to reach them</dt><dd>{person.fields.length ? <Fields person={person} big={big} /> : <span className="text-muted-foreground">No contact details recorded.</span>}</dd></div>
        {big && !!person.sightings?.length && <div><dt>Last seen</dt><dd>{person.sightings.map((s) => (
          <span key={JSON.stringify([s.platform, s.workspace, s.account])} className="block">{s.platform === 'slack' ? 'Slack' : 'Discord'}: {s.label ?? s.account} · {new Date(s.seenAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {s.workspace} · {s.account}</span>))}</dd></div>}
        {big && Object.keys(person.card.how ?? {}).length > 0 && <div><dt>Facts</dt><dd><Facts person={person} /></dd></div>}
        {!big && relationships.length > 0 && <div><dt>Known to</dt><dd className="board-line">{relationships.map((r) => agentChip(r.agent ?? ''))}</dd></div>}
        {big && <div><dt>Relationships</dt><dd>{relationships.length ? relationships.map((r) => <Relationship key={r.id} card={r} />) : <span className="text-muted-foreground">No relationship cards available to you.</span>}</dd></div>}
        {(big || person.projects.length > 0) && <div><dt>Projects</dt><dd className="board-line">{person.projects.length ? person.projects.map((p) => (
          <span key={p.agent + ':' + p.slug}>{id.test(p.slug) ? <Chip place={{ brick: 'project', params: { project: p.slug } }}>{p.name}</Chip> : p.name} · {p.status} · {p.agent}</span>))
          : <span className="text-muted-foreground">No linked projects.</span>}</dd></div>}
        {big && <div><dt>Conversations</dt><dd className="board-line">{!person.conversations?.available ? <span className="text-muted-foreground">Conversation service is not available yet.</span>
          : person.conversations.rows.length ? person.conversations.rows.map((c) => id.test(c.id) ? <Chip key={c.id} place={{ brick: 'session', params: { session: c.id } }}>{c.title}</Chip> : <span key={c.id}>{c.title}</span>)
          : <span className="text-muted-foreground">No conversations of yours with this contact.</span>}</dd></div>}
      </dl>
      {big && <p className="text-muted-foreground">Contact details and relationship notes do not grant access.</p>}
    </>
  );
}

/** A contact, or a member when `tickets` is given: the member's open tickets, drawn by the brick as before. */
export function Contact({ slug, form, tickets }: { slug: string; form?: Form; tickets?: ReactNode }) {
  const compact = form === 'compact';
  const read = useMemoryRecord(tickets && compact ? undefined : memoryQueries.person('commons:' + slug));
  const directory = useMemoryQuery(compact ? undefined : memoryQueries.people());
  const person = read.records[0];
  if (tickets && (compact || read.status !== 'live' || !person)) return <>{tickets}</>;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !person) return <Unavailable what="person" />;
  if (compact) return <p className="board-brief">{person.name}{person.card.summary ? ' · ' + person.card.summary : ''}</p>;
  const relationships = directory.status === 'live' && directory.value ? contacts(directory.value, 'all', '', '').find((g) => g.person.slug === person.slug)?.relationships.filter((r) => r.agent) ?? [] : [];
  return (
    <>
      <Card person={person} relationships={relationships} form={form} />
      {tickets && <dl><div><dt>Open tickets</dt><dd>{tickets}</dd></div></dl>}
    </>
  );
}
