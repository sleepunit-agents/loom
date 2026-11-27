/** The `person` brick's card: what the desktop's People reader shows for one person (pieces/people), read with its
 * selections (memory/queries.ts): the shared card under the id People uses, `commons:<slug>` (memoryPerson), and,
 * from the directory People lists (memoryPeople), the relationship cards of the agents the member may read. A
 * member's card is the shared card whose slug is their member id; their open tickets are drawn under it. Read-only:
 * People's reader changes nothing either. */
import type { ReactNode } from 'react';
import { memoryQueries, type PersonOpen } from '../memory/queries';
import { useMemoryQuery, useMemoryRecord } from '../memory/query';
import { contactLink, contacts, type Person } from '../pieces/people/model';
import { Chip, Excerpt, Fact, Facts, Few, Lead, Loading, More, Note, Row, Rows, Section, State, Time, Unavailable, count, type Tone } from './brick-kit';
import type { Form } from './layout';

const id = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,119}$/;
const agentChip = (agent: string) => id.test(agent) ? <Chip key={agent} place={{ brick: 'agent', params: { agent } }}>{agent}</Chip> : <span key={agent}>{agent}</span>;
const said = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value));
/** How far a recorded address can be trusted, in the record's own word. */
const fieldTone = (state: string): Tone => (state === 'fresh' ? 'good' : state === 'stale' || state === 'aging' ? 'waiting' : 'neutral');
const projectTone = (status: string): Tone => (status === 'active' ? 'working' : 'muted');

/** Where someone is reached: the kind of address, the address, and under it what is known about it. Big, an
 * address People links is a link, with when it was verified and its source. */
function Reach({ person, big }: { person: Person; big: boolean }) {
  return (
    <Facts>{person.fields.map((f) => {
      const href = big ? contactLink(f.key, person.card.where[f.key]?.value) : undefined;
      return (
        <Fact key={f.key} label={f.key}>
          <span className="board-person-reach">
            <span>{href ? <a href={href}>{f.value}</a> : f.value}</span>
            <small>{f.label && <span>{f.label}</span>}<State tone={fieldTone(f.state)}>{f.state}</State>
              {big && f.verifiedAt && <span>verified <Time at={f.verifiedAt} /></span>}{big && f.source && <span>Source: {f.source}</span>}</small>
          </span>
        </Fact>
      );
    })}</Facts>
  );
}
const How = ({ person }: { person: Person }) => <Facts>{Object.entries(person.card.how ?? {}).map(([key, value]) => <Fact key={key} label={key}>{said(value)}</Fact>)}</Facts>;

/** One agent's relationship card, as People draws it: its summary, how old it is, its facts, the permissions it
 * records and the notes behind it. Loom hands over only the cards and notes this member may read. */
function Relationship({ card }: { card: Person }) {
  return (
    <div className="board-person-card" data-relationship={card.agent}>
      <div className="board-meta">{agentChip(card.agent ?? '')}<span>Updated <Time at={card.updated} /></span><span>{count(card.newer, 'memory', 'memories')} newer than this card</span></div>
      {card.card.summary && <p className="board-person-summary">{card.card.summary}</p>}
      {Object.keys(card.card.how ?? {}).length > 0 && <How person={card} />}
      {card.fields.length > 0 && <Reach person={card} big />}
      {card.card.may.length > 0 && <Note>Recorded permissions: {card.card.may.map((m) => `${m.text} · ${m.source}`).join('; ')}. These records do not grant access.</Note>}
      {card.evidence.length
        ? card.evidence.map((e, i) => (
            <details key={i} className="board-person-note">
              <summary><span>{e.title}</span><Time at={e.created} /></summary>
              <p className="whitespace-pre-wrap">{e.content}</p><Note>{e.category}</Note>
            </details>
          ))
        : <Note>No active evidence recorded.</Note>}
    </div>
  );
}

function Card({ person, relationships, form }: { person: PersonOpen; relationships: Person[]; form?: Form }) {
  const big = form === 'primary';
  const projects = person.projects.map((p) => ({ ...p, place: id.test(p.slug) ? { brick: 'project', params: { project: p.slug } } : undefined }));
  return (
    <>
      <Lead>{person.name}</Lead>
      {person.card.summary && (big ? <p className="board-person-summary">{person.card.summary}</p> : <Excerpt lines={2}><p className="board-person-summary">{person.card.summary}</p></Excerpt>)}
      {big && person.mergedFrom && <Note>{person.mergedFrom} was merged into {person.slug}.</Note>}
      <Section title="How to reach them">{!person.fields.length ? <Note>No contact details recorded.</Note> : big ? <Reach person={person} big />
        : <Few of={person.fields} first={person.fields.length}>{(fields, hidden) => <><Reach person={{ ...person, fields: [...fields] }} big={false} /><More n={hidden} /></>}</Few>}</Section>
      {big && !!person.sightings?.length && (
        <Section title="Last seen">
          <Rows>{person.sightings.map((s) => (
            <Row key={JSON.stringify([s.platform, s.workspace, s.account])} title={`${s.platform === 'slack' ? 'Slack' : 'Discord'}: ${s.label ?? s.account}`}
              meta={<span className="font-mono">{s.workspace} · {s.account}</span>} end={<Time at={s.seenAt} />} />
          ))}</Rows>
        </Section>
      )}
      {big && Object.keys(person.card.how ?? {}).length > 0 && <Section title="Facts"><How person={person} /></Section>}
      {big && person.ownership && <Section title="Owns"><div className="board-meta">{person.ownership.owner ? 'The household and every agent' : person.ownership.agents.map(agentChip)}</div></Section>}
      {big && <Section title="Relationships">{relationships.length ? relationships.map((r) => <Relationship key={r.id} card={r} />) : <Note>No relationship cards available to you.</Note>}</Section>}
      {big && (
        <Section title="Projects">
          {projects.length
            ? <Rows>{projects.map((p) => <Row key={p.agent + ':' + p.slug} place={p.place} title={p.name} end={<><State tone={projectTone(p.status)}>{p.status}</State><span>{p.agent}</span></>} />)}</Rows>
            : <Note>No linked projects.</Note>}
        </Section>
      )}
      {big && (
        <Section title="Conversations">
          {!person.conversations?.available ? <Note>Conversation service is not available yet.</Note>
            : person.conversations.rows.length
              ? <Rows>{person.conversations.rows.map((c) => <Row key={c.id} place={id.test(c.id) ? { brick: 'session', params: { session: c.id } } : undefined} title={c.title} />)}</Rows>
              : <Note>No conversations of yours with this contact.</Note>}
        </Section>
      )}
      {big && <Note>Contact details and relationship notes do not grant access.</Note>}
    </>
  );
}

/** A contact, or a member when `tickets` is given: the member's open tickets, drawn by the brick as before. */
export function Contact({ slug, form, tickets, count: ticketCount }: { slug: string; form?: Form; tickets?: ReactNode; /** The tickets as one line, for the side form of a member who has a card. */ count?: ReactNode }) {
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
      {tickets && <Section title="Open tickets">{ticketCount ?? tickets}</Section>}
    </>
  );
}
