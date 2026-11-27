import { Input } from './ui/input';
import { ContactFacts, contactMeta, useKnownPeople, type Contact } from './known-people';
import { useEffect, useRef, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { ModuleCard } from './module-card';
import { ViewLink, ViewPreview } from './entity-preview';
import {
  indexNames,
  viewKey,
  type IndexName,
  type IndexView,
  type ProfileView,
  type View,
} from './ticket-view';
import { Button } from './ui/button';
import {
  Folder,
  Users,
  Bot,
  GitFork,
  Ticket,
  Layers,
  GitPullRequest,
  MessageSquare,
  ChevronRight,
} from 'lucide-react';
import { Badge } from './ui/badge';

type Entry = { view: View; title: string; meta?: string; detail?: string | null };
type Project = {
  id: string;
  name: string;
  goal: string | null;
  lifecycle: string;
  projectMembersByProject: { member: string }[];
};
type Roster = {
  projects: Project[];
  members: { id: string; role: string }[];
  agents: { id: string; about: string }[];
  householdSharing: { projects: { id: string; agents: string[]; repositories: string[] }[] } | null;
  workspaceRepositories: { repository: string; project: string | null; count: number }[];
};
type Work = (view: View) => void;
const rosterQuery = `query PairDirectoryRoster {
  projects(orderBy:{name:{direction:asc,priority:1},id:{direction:asc,priority:0}}){id name goal lifecycle projectMembersByProject{member}}
  members(orderBy:{id:{direction:asc,priority:0}}){id role}
  agents(orderBy:{id:{direction:asc,priority:0}}){id about}
  householdSharing{projects{id agents repositories}} workspaceRepositories{repository project count}
}`;
const size = 24;
const repoName = (s: string) => s.replace(/^github:/, '');
const collections = {
  projects: Folder,
  people: Users,
  agents: Bot,
  repositories: GitFork,
  tickets: Ticket,
  epics: Layers,
  pulls: GitPullRequest,
  comments: MessageSquare,
};
export function BrowseHome({ work }: { work: Work }) {
  return (
    <ModuleCard title="Browse" description="Across projects">
      <ul className="grid gap-x-6 sm:grid-cols-2">
        {(Object.keys(collections) as (keyof typeof collections)[]).map((ref) => {
          const Icon = collections[ref];
          return (
            <li key={ref} className="border-b">
              <ViewPreview view={{ kind: 'index', ref }} menu="entity">
                <a
                  className="flex items-center gap-3 rounded-sm py-3 text-sm hover:bg-muted/50"
                  href={'#index=' + ref}
                  onClick={(e) => {
                    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
                      e.preventDefault();
                      work({ kind: 'index', ref });
                    }
                  }}
                >
                  <Icon className="size-4 text-muted-foreground" />
                  {indexNames[ref]}
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                </a>
              </ViewPreview>
            </li>
          );
        })}
      </ul>
    </ModuleCard>
  );
}
const profileIndex = (role: ProfileView['role']) =>
  role === 'member' || role === 'contact' ? 'people' : role === 'agent' ? 'agents' : 'repositories';
function rosterEntries(list: IndexName, r: Roster, contacts: Contact[]): Entry[] {
  if (list === 'projects')
    return r.projects.map((p) => ({
      view: { kind: 'project', project: p.id },
      title: p.name,
      meta: p.lifecycle,
      detail: p.goal,
    }));
  if (list === 'people') {
    const people = new Map(r.members.map((p) => [p.id, p.role]));
    for (const p of r.projects)
      for (const { member } of p.projectMembersByProject)
        if (!people.has(member)) people.set(member, 'member');
    const entries: Entry[] = [];
    for (const c of contacts) {
      if (c.member && people.has(c.member)) continue;
      entries.push({
        view: { kind: 'profile', role: 'contact', ref: c.slug },
        title: c.name,
        meta: contactMeta(c),
        detail: c.summary,
      });
    }
    for (const [ref, role] of people) {
      const c = contacts.find((c) => c.member === ref);
      entries.push({
        view: { kind: 'profile', role: 'member', ref },
        title: c?.name || ref,
        meta: [role, c && contactMeta(c)].filter(Boolean).join(' · '),
        detail: c?.summary,
      });
    }
    return entries.sort((a, b) => a.title.localeCompare(b.title));
  }
  if (list === 'agents')
    return r.agents.map((a) => ({
      view: { kind: 'profile', role: 'agent', ref: a.id },
      title: a.id,
      detail: a.about,
    }));
  const repos = new Map<string, number>();
  for (const p of r.householdSharing?.projects || [])
    for (const repo of p.repositories) repos.set(repoName(repo), 0);
  for (const row of r.workspaceRepositories) {
    const repo = repoName(row.repository);
    repos.set(repo, (repos.get(repo) || 0) + row.count);
  }
  return [...repos]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, n]) => ({
      view: { kind: 'profile', role: 'repository', ref: 'github:' + repo },
      title: repo,
      meta: n + ' pull request' + (n === 1 ? '' : 's'),
    }));
}
function Rows({ entries, work }: { entries: Entry[]; work: Work }) {
  return (
    <ul className="divide-y">
      {entries.map((row) => (
        <li key={JSON.stringify(row.view)} className="space-y-1 py-2 text-sm [overflow-wrap:anywhere]">
          <ViewLink view={row.view} work={work}>
            {row.title}
          </ViewLink>
          {row.meta && <span className="ml-2 text-xs text-muted-foreground">{row.meta}</span>}
          {row.detail && <p className="line-clamp-2 text-card-body">{row.detail}</p>}
        </li>
      ))}
    </ul>
  );
}
type Records = {
  total: number;
  tickets?: { id: string; title: string; status: string; project: string | null; type: string }[];
  pulls?: { url: string; title: string; state: string; repository: string; number: number }[];
  comments?: { task: string; seq: number; text: string; actor: string; at: string }[];
};
function recordQuery(list: IndexName, role?: ProfileView['role']) {
  const filtered = !!role;
  const ref = filtered ? ', $ref:String!' : '';
  const arg = filtered ? (list === 'pulls' ? ',repository:$ref' : `,assignee:$ref,actorKind:"${role}"`) : '';
  const where = filtered
    ? list === 'pulls'
      ? 'where:{repository:{eq:$ref}},'
      : `where:{assignee:{eq:$ref},assigneeKind:{eq:${role}}},`
    : list === 'epics'
      ? 'where:{type:{eq:epic}},'
      : '';
  const args = (field: string, id: string) =>
    where +
    'orderBy:{' +
    field +
    ':{direction:desc,priority:1},' +
    id +
    ':{direction:desc,priority:0}},offset:$offset,limit:' +
    size;
  const rows =
    list === 'pulls'
      ? `pulls:changes(${args('updatedAt', 'id')}){url title state repository number}`
      : list === 'comments'
        ? `comments:taskComments(${args('at', 'seq')}){task seq text actor at}`
        : `tickets:tasks(${args('changedAt', 'id')}){id title status project type}`;
  return `query PairDirectoryPage($offset:Int!${ref}){total:workspaceListCount(list:"${list}"${arg}) ${rows}}`;
}
function LoadMore({ load }: { load: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const next = useRef(load);
  next.current = load;
  useEffect(() => {
    const node = button.current;
    if (!node || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          next.current();
        }
      },
      { root: null, rootMargin: '0px 0px 200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <Button ref={button} size="sm" variant="ghost" onClick={load}>
      Load more
    </Button>
  );
}
function RecordsList({
  list,
  filter,
  role,
  work,
  page,
  move,
  batch = 0,
  seen = new Set<string>(),
}: {
  list: IndexName;
  filter?: string;
  role?: ProfileView['role'];
  work: Work;
  batch?: number;
  seen?: Set<string>;
  page: number;
  move: (page: number) => void;
}) {
  const read = useDataQuery<Records>(
    recordQuery(list, role),
    filter ? { offset: batch * size, ref: filter } : { offset: batch * size },
  );
  const data = read.data;
  if (!data || read.status !== 'live')
    return <p role="status">{read.status === 'loading' ? 'Loading records…' : 'Records unavailable.'}</p>;
  const rows: Entry[] = data.pulls
    ? data.pulls.map((p) => ({
        view: { kind: 'pull', ref: p.url },
        title: p.title,
        meta: p.repository + ' #' + p.number + ' · ' + p.state,
      }))
    : data.comments
      ? data.comments.map((c) => ({
          view: { kind: 'comment', ticket: c.task, ref: String(c.seq) },
          title: c.actor + ' · ' + c.task,
          meta: new Date(c.at).toLocaleDateString(),
          detail: c.text,
        }))
      : (data.tickets || []).map((t) => ({
          view: { kind: 'ticket', ticket: t.id },
          title: t.title,
          meta: [t.id, t.project, t.status.replaceAll('_', ' ')].filter(Boolean).join(' · '),
        }));
  const ids = new Set(seen);
  const distinct = rows.filter((row) => {
    const id = viewKey(row.view);
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
  const more = rows.length === size && (batch + 1) * size < data.total;
  return (
    <>
      {distinct.length > 0 ? <Rows entries={distinct} work={work} /> : !batch && <p>No visible records.</p>}
      {more &&
        (batch < page ? (
          <RecordsList
            list={list}
            role={role}
            filter={filter}
            work={work}
            page={page}
            move={move}
            batch={batch + 1}
            seen={ids}
          />
        ) : (
          <LoadMore load={() => move(batch + 1)} />
        ))}
    </>
  );
}
export function WorkspaceIndex({
  view,
  work,
  pages,
  peopleSearch,
}: {
  view: IndexView | ProfileView;
  work: Work;
  pages: Map<string, number>;
  peopleSearch: { current: string };
}) {
  const list = view.kind === 'index' ? view.ref : profileIndex(view.role);
  const roster = ['projects', 'people', 'agents', 'repositories'].includes(list);
  const read = useDataQuery<Roster>(rosterQuery, undefined, { pause: !roster });
  const known = useKnownPeople(list === 'people');
  const [search, searchFor] = useState(list === 'people' ? peopleSearch.current : '');
  const key = JSON.stringify(view);
  const [page, setPage] = useState(() => pages.get(key) || 0);
  function move(n: number) {
    pages.set(key, n);
    setPage(n);
  }
  if (view.kind === 'index') {
    const entries = read.data && roster ? rosterEntries(list, read.data, known.contacts) : [];
    const matching = search
      ? entries.filter((e) =>
          [e.title, e.meta, e.view.kind === 'profile' && e.view.ref]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(search.toLowerCase().trim()),
        )
      : entries;

    return (
      <ModuleCard
        title={indexNames[list]}
        description={
          <ViewLink view={{ kind: 'index', ref: 'browse' }} work={work}>
            Browse
          </ViewLink>
        }
        toolbar={list === 'people' && (
          <Input
            type="search"
            aria-label="Find a person"
            placeholder="Find a person…"
            value={search}
            onChange={(e) => {
              peopleSearch.current = e.target.value;
              searchFor(e.target.value);
              move(0);
            }}
          />
        )}
      >
        {list === 'people' && known.status === 'offline' && (
          <p role="status">Contact directory unavailable.</p>
        )}
        {roster ? (
          read.status !== 'live' || (list === 'people' && known.status === 'loading') ? (
            <p role="status">
              {read.status === 'loading' || known.status === 'loading'
                ? 'Loading directory…'
                : 'Directory unavailable.'}
            </p>
          ) : (
            <>
              {matching.length ? (
                <Rows entries={matching} work={work} />
              ) : (
                <p>{search ? 'No people match this search.' : 'No visible records.'}</p>
              )}
            </>
          )
        ) : (
          <RecordsList list={list} page={page} move={move} work={work} />
        )}
      </ModuleCard>
    );
  }
  const r = read.data;
  const contacts = known.contacts.filter((c) =>
    view.role === 'contact' ? c.slug === view.ref : view.role === 'member' && c.member === view.ref,
  );
  if (view.role === 'contact') {
    const c = contacts[0];
    return (
      <ModuleCard
        title={c?.name || view.ref}
        description={
          <ViewLink view={{ kind: 'index', ref: 'people' }} work={work}>
            People
          </ViewLink>
        }
        action={<Badge variant="secondary">Contact</Badge>}
      >
        {c ? (
          <>
            {c.summary && <p>{c.summary}</p>}
            <ContactFacts contact={c} />
          </>
        ) : (
          <p role="status">{known.status === 'loading' ? 'Opening contact…' : 'Contact unavailable.'}</p>
        )}
      </ModuleCard>
    );
  }
  const entry =
    r &&
    rosterEntries(list, r, known.contacts).find(
      (row) => row.view.kind === 'profile' && row.view.ref === view.ref,
    );
  const projects =
    r?.projects.filter((p) => {
      const shared = r.householdSharing?.projects.find((x) => x.id === p.id);
      if (view.role === 'member') return p.projectMembersByProject.some((x) => x.member === view.ref);
      if (view.role === 'agent') return shared?.agents.includes(view.ref);
      return (
        shared?.repositories.some((repo) => repoName(repo) === repoName(view.ref)) ||
        r.workspaceRepositories.some(
          (x) => x.project === p.id && repoName(x.repository) === repoName(view.ref),
        )
      );
    }) || [];
  return (
    <ModuleCard
      title={entry?.title || repoName(view.ref)}
      description={
        <ViewLink view={{ kind: 'index', ref: list }} work={work}>
          {indexNames[list]}
        </ViewLink>
      }
      action={<Badge variant="secondary">{view.role}</Badge>}
    >
      {read.status !== 'live' ? (
        <p role="status">{read.status === 'loading' ? 'Opening profile…' : 'Profile unavailable.'}</p>
      ) : !entry ? (
        <p>No visible profile.</p>
      ) : (
        <>
          {entry.detail && <p>{entry.detail}</p>}
          {contacts.map((c) => (
            <ContactFacts key={c.slug} contact={c} />
          ))}
          {projects.length > 0 && (
            <section>
              <h2 className="font-medium">Projects</h2>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {projects.map((p) => (
                  <ViewLink
                    key={p.id}
                    view={
                      view.role === 'agent'
                        ? { kind: 'project', project: p.id }
                        : {
                            kind: view.role === 'repository' ? 'repository' : 'member',
                            ref: view.ref,
                            project: p.id,
                          }
                    }
                    work={work}
                  >
                    {p.name}
                  </ViewLink>
                ))}
              </div>
            </section>
          )}
          <section>
            <h2 className="font-medium">
              {view.role === 'repository' ? 'Pull requests' : 'Assigned tickets'}
            </h2>
            <RecordsList
              list={view.role === 'repository' ? 'pulls' : 'tickets'}
              role={view.role}
              filter={view.role === 'repository' ? repoName(view.ref) : view.ref}
              page={page}
              move={move}
              work={work}
            />
          </section>
        </>
      )}
    </ModuleCard>
  );
}
