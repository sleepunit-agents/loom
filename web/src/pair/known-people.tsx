import { useDataQuery } from '../data/graphql';
type Account = { platform: string; workspace: string; account: string };
type Card = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  agent: string | null;
  card: { summary: string | null };
  fields: { key: string }[];
  ownership: { owner: boolean } | null;
};
type People = { cards: Card[]; links: { slug: string; member: string }[] };
const query = `query PairKnownPeople{
  cards:memoryPeople(includeRemovedAgents:false){id slug name kind agent card{summary} fields{key} ownership{owner} }
  links:memoryPeopleMemberLinks{slug member}
}`;
export type Contact = {
  slug: string;
  name: string;
  id: string;
  member?: string;
  summary?: string;
  channels: string[];
  agents: string[];
  relationships: { agent: string; id: string; summary: string | null }[];
};
export function groupPeople(data: People): Contact[] {
  const groups = new Map<string, Card[]>();

  for (const c of data.cards)
    if (c.kind === 'person') {
      const rows = groups.get(c.slug) || [];
      rows.push(c);
      groups.set(c.slug, rows);
    }
  return [...groups.values()].map((cards) => {
    const primary = cards.find((c) => !c.agent) ?? cards[0];
    const members = new Set<string>();
    if (primary.ownership) members.add(primary.slug);
    for (const link of data.links) if (link.slug === primary.slug) members.add(link.member);
    const channels = new Set(cards.flatMap((c) => c.fields.map((f) => f.key)));
    return {
      slug: primary.slug,
      name: primary.name,
      id: primary.id,
      member: members.size === 1 ? [...members][0] : undefined,
      summary: primary.card.summary || cards.find((c) => c.card.summary)?.card.summary || undefined,
      channels: [...channels].sort(),
      relationships: cards.flatMap((c) =>
        c.agent ? [{ agent: c.agent, id: c.id, summary: c.card.summary }] : [],
      ),
      agents: cards.flatMap((c) => (c.agent ? [c.agent] : [])).sort(),
    };
  });
}
export function useKnownPeople(enabled: boolean) {
  const read = useDataQuery<People>(query, {}, { pause: !enabled });
  return { status: read.status, contacts: read.data ? groupPeople(read.data) : [] };
}
const label = (key: string) =>
  ({ slack: 'Slack', discord: 'Discord', github: 'GitHub', email: 'Email' })[key] ?? key;
export function contactMeta(c: Contact) {
  return c.channels.map(label).join(' · ') || 'Contact';
}
export function ContactFacts({ contact }: { contact: Contact }) {
  const read = useDataQuery<{
    person: {
      fields: { key: string; value: string; label: string | null }[];
      sightings: (Account & { label: string | null; seenAt: string })[];
    } | null;
  }>(
    'query PairContactFacts($id:String!){person:memoryPerson(id:$id){fields{key value label} sightings{platform workspace account label seenAt}}}',
    { id: contact.id },
  );
  const p = read.data?.person;
  return (
    <div className="space-y-3 text-sm [overflow-wrap:anywhere]">
      {read.status !== 'live' ? (
        <p role="status">
          {read.status === 'loading' ? 'Loading contact details…' : 'Contact details unavailable.'}
        </p>
      ) : (
        p && (
          <>
            {!!p.fields.length && (
              <section>
                <h2 className="font-medium">Contact details</h2>
                <dl className="space-y-1">
                  {p.fields.map((f) => (
                    <div key={f.key}>
                      <dt className="inline font-medium">{label(f.key)} </dt>
                      <dd className="inline">{[f.label, f.value].filter(Boolean).join(' · ')}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {!!p.sightings.length && (
              <section>
                <h2 className="font-medium">Last seen</h2>
                <ul>
                  {p.sightings.map((s) => (
                    <li key={JSON.stringify([s.platform, s.workspace, s.account])}>
                      {label(s.platform)} · {s.label || s.account} · {new Date(s.seenAt).toLocaleDateString()}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )
      )}
    </div>
  );
}
