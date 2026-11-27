import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { ModuleCard } from './module-card';
import { ViewLink } from './entity-preview';
import {
  indexNames,
  ListPager,
  type IndexName,
  type IndexView,
  type ProfileView,
  type View,
} from './ticket-view';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
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
const size = 8;
const repoName = (s: string) => s.replace(/^github:/, '');
const names = Object.keys(indexNames) as IndexName[];
const profileIndex = (role: ProfileView['role']) =>
  role === 'member' ? 'people' : role === 'agent' ? 'agents' : 'repositories';
function rosterEntries(list: IndexName, r: Roster): Entry[] {
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
    return [...people]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ref, role]) => ({ view: { kind: 'profile', role: 'member', ref }, title: ref, meta: role }));
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
function RecordsList({
  list,
  filter,
  role,
  work,
  page,
  move,
}: {
  list: IndexName;
  filter?: string;
  role?: ProfileView['role'];
  work: Work;
  page: number;
  move: (page: number) => void;
}) {
  const read = useDataQuery<Records>(
    recordQuery(list, role),
    filter ? { offset: page * size, ref: filter } : { offset: page * size },
    { keep: true },
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
  return (
    <>
      <div aria-busy={!!read.settling} inert={!!read.settling}>
        {rows.length ? <Rows entries={rows} work={work} /> : <p>No visible records on this page.</p>}
      </div>
      <ListPager
        name={indexNames[list]}
        page={page}
        size={size}
        total={data.total}
        count={rows.length}
        pending={read.settling}
        hasNext={(page + 1) * size < data.total}
        update={(v) => move(v.page)}
      />
    </>
  );
}
export function WorkspaceIndex({
  view,
  work,
  pages,
}: {
  view: IndexView | ProfileView;
  work: Work;
  pages: Map<string, number>;
}) {
  const list = view.kind === 'index' ? view.ref : profileIndex(view.role);
  const roster = ['projects', 'people', 'agents', 'repositories'].includes(list);
  const read = useDataQuery<Roster>(rosterQuery, undefined, { pause: !roster });
  const key = JSON.stringify(view);
  const [page, setPage] = useState(() => pages.get(key) || 0);
  function move(n: number) {
    pages.set(key, n);
    setPage(n);
  }
  const picker = (
    <NativeSelect
      aria-label="Browse collection"
      value={list}
      size="sm"
      onChange={(e) => work({ kind: 'index', ref: e.target.value as IndexName })}
    >
      {names.map((k) => (
        <NativeSelectOption key={k} value={k}>
          {indexNames[k]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
  if (view.kind === 'index') {
    const entries = read.data && roster ? rosterEntries(list, read.data) : [];
    const slice = entries.slice(page * size, (page + 1) * size);
    return (
      <ModuleCard title={indexNames[list]} description="Across projects" action={picker}>
        {roster ? (
          read.status !== 'live' ? (
            <p role="status">{read.status === 'loading' ? 'Loading directory…' : 'Directory unavailable.'}</p>
          ) : (
            <>
              {slice.length ? <Rows entries={slice} work={work} /> : <p>No visible records on this page.</p>}
              <ListPager
                name={indexNames[list]}
                page={page}
                size={size}
                total={entries.length}
                count={slice.length}
                hasNext={(page + 1) * size < entries.length}
                update={(v) => move(v.page)}
              />
            </>
          )
        ) : (
          <RecordsList list={list} page={page} move={move} work={work} />
        )}
      </ModuleCard>
    );
  }
  const r = read.data;
  const entry =
    r && rosterEntries(list, r).find((row) => row.view.kind === 'profile' && row.view.ref === view.ref);
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
                        : { kind: view.role, ref: view.ref, project: p.id }
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
