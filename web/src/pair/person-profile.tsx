import { useDataQuery } from '../data/graphql';
import { Reply } from './reply';
import { ModuleCard } from './module-card';
import { ContactFacts, type Contact } from './known-people';
import { ViewLink } from './entity-preview';
import {
  Secondary,
  ticketRow,
  relatedFields,
  type Related,
  type Group,
  type SecondaryState,
  type ProfileView,
  type View,
} from './ticket-view';
import { Badge } from './ui/badge';

type Conversation = {
  id: string;
  label: string;
  venue: string;
  agent: string;
  lastAt: string;
  turnCount: number;
};
type Task = Related & {
  assigneeKind: string | null;
  ownerKind: string;
  owner: string | null;
  askedByKind: string | null;
  askedBy: string | null;
  createdByKind: string;
  createdBy: string;
  sourceKind: string | null;
  sourceId: string | null;
};
const convoFields = 'id label venue agent lastAt turnCount';
const taskFields =
  relatedFields +
  ' assigneeKind ownerKind owner askedByKind askedBy createdByKind createdBy sourceKind sourceId';
function PersonTasks({
  member,
  conversations,
  offset,
  render,
}: {
  member?: string;
  conversations: string[];
  offset: number;
  render: (tasks: Task[], more: boolean, status: string) => React.ReactNode;
}) {
  const withSources = conversations.length > 0 || !member;
  const filters = withSources ? ['{sourceKind:{eq:"conversation"},sourceId:{inArray:$ids}}'] : [];
  if (member)
    for (const field of ['owner', 'assignee', 'createdBy', 'askedBy'])
      filters.push('{' + field + 'Kind:{eq:member},' + field + ':{eq:$member}}');
  const query = `query PersonTasks(${withSources ? '$ids:[String!]!,' : ''}$offset:Int!${member ? ',$member:String!' : ''}){tasks(where:{OR:[${filters.join(',')}]},orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},offset:$offset,limit:6){${taskFields}}}`;
  const read = useDataQuery<{ tasks: Task[] }>(
    query,
    { offset, ...(member ? { member } : {}), ...(withSources ? { ids: conversations } : {}) },
    { keep: true, pause: !member && !conversations.length },
  );
  const rows = read.data?.tasks || [];
  return render(
    rows,
    rows.length > 5,
    member || conversations.length ? (read.settling ? 'loading' : read.status) : 'live',
  );
}
function aboutTask(t: Task, member: string | undefined, ids: string[]) {
  const row = ticketRow(t);
  const reasons = [];
  if (member) {
    if (t.assigneeKind === 'member' && t.assignee === member) reasons.push('Assigned');
    if (t.askedByKind === 'member' && t.askedBy === member) reasons.push('Requested');
    if (t.createdByKind === 'member' && t.createdBy === member) reasons.push('Created');
    if (t.ownerKind === 'member' && t.owner === member) reasons.push('Owns');
  }
  if (t.sourceKind === 'conversation' && t.sourceId && ids.includes(t.sourceId))
    reasons.push('From conversation');
  return {
    ...row,
    meta: [row.meta, reasons.join(' · ')].filter(Boolean).join(' · '),
    state: [...reasons, row.state].filter(Boolean).join(' · '),
  };
}

export function PersonProfile({
  view,
  contacts,
  title,
  role,
  projects,
  work,
  memory,
}: {
  view: ProfileView;
  contacts: Contact[];
  title: string;
  role: string;
  projects: { id: string; name: string }[];
  work: (v: View) => void;
  memory: Map<string, SecondaryState>;
}) {
  const member = view.role === 'member' ? view.ref : undefined;
  const slugs = [...new Set([...contacts.map((c) => c.slug), ...(member ? [member] : [])])];
  const query = `query PairPersonConversations($people:[String!]!${member ? ',$member:String!' : ''}){
   participants:conversationPeople(where:{whoKind:{eq:person},who:{inArray:$people}}){conversationRow{${convoFields}}}
   ${member ? `direct:conversations(where:{member:{eq:$member}}){${convoFields}}` : ''}
 }`;
  const read = useDataQuery<{
    participants: { conversationRow: Conversation | null }[];
    direct?: Conversation[];
  }>(query, member ? { people: slugs, member } : { people: slugs });
  const unique = new Map<string, Conversation>();
  for (const c of [
    ...(read.data?.direct || []),
    ...(read.data?.participants.map((p) => p.conversationRow) || []),
  ])
    if (c) unique.set(c.id, c);
  const conversations = [...unique.values()].sort(
    (a, b) => b.lastAt.localeCompare(a.lastAt) || a.id.localeCompare(b.id),
  );
  const ids = conversations.map((c) => c.id);
  const channels = [
    ...new Set(
      contacts
        .flatMap((c) => c.channels)
        .filter((k) => ['slack', 'discord', 'github', 'email', 'phone', 'website'].includes(k)),
    ),
  ];
  const relationships = contacts.flatMap((c) => c.relationships);
  const agents = [...new Set(relationships.map((r) => r.agent))];
  const summary = contacts.find((c) => c.summary)?.summary;
  return (
    <>
      <ModuleCard
        title={title}
        description={
          <ViewLink view={{ kind: 'index', ref: 'people' }} work={work}>
            People
          </ViewLink>
        }
        action={<Badge variant="secondary">{role}</Badge>}
      >
        {summary && <p className="line-clamp-3 text-sm text-card-body">{summary.split(/\n\s*\n/)[0]}</p>}
        {agents.length > 0 && (
          <section>
            <h2 className="text-xs text-muted-foreground">Known to</h2>
            <div className="flex flex-wrap gap-2">
              {agents.map((agent) => (
                <ViewLink key={agent} view={{ kind: 'profile', role: 'agent', ref: agent }} work={work}>
                  {agent}
                </ViewLink>
              ))}
            </div>
          </section>
        )}
        {channels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {channels.map((k) => (
              <Badge key={k} variant="outline">
                {channelLabel(k)}
              </Badge>
            ))}
          </div>
        )}
      </ModuleCard>
      <PersonTasks
        member={member}
        conversations={ids}
        offset={0}
        render={(tasks, more, status) => {
          const groups: Group[] = [];
          if (conversations.length)
            groups.push({
              name: 'Conversations',
              rows: [],
              content: (
                <ul className="divide-y">
                  {conversations.map((c) => (
                    <li className="space-y-1 py-2 text-sm" key={c.id}>
                      <a
                        className="font-medium underline-offset-2 hover:underline"
                        href={'/p/comms-preview/conversation/' + encodeURIComponent(c.id)}
                      >
                        {c.label || 'Conversation with ' + c.agent}
                      </a>
                      <p className="text-xs text-muted-foreground">
                        {channelLabel(c.venue)} · {c.agent} · {new Date(c.lastAt).toLocaleDateString()} ·{' '}
                        {c.turnCount} turns
                      </p>
                    </li>
                  ))}
                </ul>
              ),
            });
          if (tasks.length)
            groups.push({
              name: 'Tickets',
              rows: tasks.map((t) => aboutTask(t, member, ids)),
              browse: more
                ? (offset, next) =>
                    offset === 0 ? (
                      next()
                    ) : (
                      <PersonTasks
                        member={member}
                        conversations={ids}
                        offset={offset}
                        render={(rs, hasNext, s) =>
                          next({
                            rows: rs.slice(0, 5).map((t) => aboutTask(t, member, ids)),
                            hasNext,
                            status: s === 'offline' ? 'Tickets unavailable.' : undefined,
                            pending: s === 'loading',
                          })
                        }
                      />
                    )
                : undefined,
            });
          if (projects.length)
            groups.push({
              name: 'Projects',
              rows: projects.map((p) => ({
                title: p.name,
                detail: 'Project member',
                target: { kind: 'project', project: p.id },
              })),
            });
          if (relationships.length)
            groups.push({
              name: 'Relationships',
              rows: [],
              content: (
                <div className="space-y-3">
                  {relationships.map((r) => (
                    <section key={r.id}>
                      <ViewLink work={work} view={{ kind: 'profile', role: 'agent', ref: r.agent }}>
                        {r.agent}
                      </ViewLink>
                      {r.summary && <Reply words={r.summary} />}
                      <RelationshipNotes id={r.id} />
                    </section>
                  ))}
                </div>
              ),
            });
          if (contacts.length)
            groups.push({
              name: 'Contact details',
              rows: [],
              content: (
                <div className="space-y-3">
                  {summary && !relationships.some((r) => r.summary === summary) && <Reply words={summary} />}
                  {contacts.map((c) => (
                    <ContactFacts key={c.id} contact={c} />
                  ))}
                </div>
              ),
            });
          if (read.status !== 'live' || status !== 'live')
            groups.push({
              name: 'Activity',
              rows: [],
              content: (
                <p role="status">
                  {read.status === 'offline' || status === 'offline'
                    ? 'Activity unavailable.'
                    : 'Loading activity…'}
                </p>
              ),
            });
          if (!groups.length)
            groups.push({
              name: 'Activity',
              rows: [],
              content: <p className="text-sm text-muted-foreground">No linked activity yet.</p>,
            });
          return <Secondary groups={groups} work={work} memory={memory} view={view} />;
        }}
      />
    </>
  );
}
function channelLabel(key: string) {
  return { slack: 'Slack', discord: 'Discord', github: 'GitHub', email: 'Email', loom: 'Loom' }[key] || key;
}

function RelationshipNotes({ id }: { id: string }) {
  const read = useDataQuery<{
    person: { evidence: { created: string; title: string; content: string }[] } | null;
  }>(
    'query PairRelationshipNotes($id:String!){person:memoryPerson(id:$id){evidence{created title content}}}',
    { id },
  );
  const notes = read.data?.person?.evidence || [];
  if (!notes.length) return null;
  return (
    <ul className="mt-2 divide-y">
      {notes.map((n, i) => (
        <li key={n.created + i}>
          <details className="py-1 text-sm">
            <summary className="cursor-pointer">{n.title}</summary>
            <div className="py-2">
              <Reply words={n.content} />
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
