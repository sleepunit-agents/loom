/** A `person` brick for a contact: the shared card the desktop's People app opens (pieces/people), read with its
 * selection (memory/queries.ts, memoryPerson) under the id it uses for a contact, `commons:<slug>`. */
import { memoryQueries } from '../memory/queries';
import { useMemoryRecord } from '../memory/query';
import { Loading, Unavailable } from './bricks';
import type { Form } from './layout';

export function Contact({ slug, form }: { slug: string; form?: Form }) {
  const read = useMemoryRecord(memoryQueries.person('commons:' + slug));
  const person = read.records[0];
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !person) return <Unavailable what="person" />;
  if (form === 'compact') return <p className="board-brief">{person.name}{person.card.summary ? ' · ' + person.card.summary : ''}</p>;
  return (
    <>
      <p className="board-lead">{person.name}</p>
      {person.card.summary && <p>{person.card.summary}</p>}
      <dl style={{ marginTop: '.8rem' }}>
        <div><dt>How to reach them</dt><dd>{person.fields.length
          ? person.fields.map((f) => <span key={f.key} className="block">{f.key}: {f.label ? f.label + ' · ' : ''}{f.value} · {f.state}</span>)
          : <span className="text-muted-foreground">No contact details recorded.</span>}</dd></div>
        {person.projects.length > 0 && <div><dt>Projects</dt><dd>{person.projects.map((p) => <span key={p.agent + ':' + p.slug} className="block">{p.name} · {p.status} · {p.agent}</span>)}</dd></div>}
      </dl>
    </>
  );
}
