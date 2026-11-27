import { lazy, Suspense, type ReactNode } from 'react';
import { Badge } from './ui/badge';
import { ModuleCard } from './module-card';
import { Reply } from './reply';
import {
  relatedFields,
  Secondary,
  ticketRow,
  ticketView,
  type Group,
  type Related,
  type ScopeView,
  type SecondaryState,
  type View,
} from './ticket-view';
const ProjectTrends = lazy(() => import('./project-trends'));
type Work = (v: View) => void;
type Memory = Map<string, SecondaryState>;
type Project = {
  id: string;
  name: string;
  goal: string | null;
  lifecycle: string;
  projectMembersByProject: { member: string }[];
};
type PullSummary = {
  id: string;
  title: string;
  repository: string;
  number: number;
  state: string;
  review: string;
  checks: string;
};
type Total = { status: string; count: number };
type Scope = { totals: Total[]; pullTotals: Total[]; pullCount: number; pulls: PullSummary[] };
export type ProjectOverview = {
  project: Project | null;
  working: Related[];
  recent: Related[];
  epics: Related[];
  scope: Scope | null;
  recentChanges: { repository: string }[];
  claims: { agent: string; paused: boolean }[];
  mapped: { projects: { id: string; repositories: string[] }[] } | null;
};
const recentTickets =
  'orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:10';
export const projectQuery = `query PairProject($id:String!){
  project:projectsSingle(where:{id:{eq:$id}}){id name goal lifecycle projectMembersByProject{member}}
  claims:projectClaimStates(project:$id){agent paused}
  recentChanges:changes(where:{project:{eq:$id}},orderBy:{updatedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:30){repository}
  mapped:householdSharing{projects{id repositories}}
  scope:contextScopeWork(project:$id,offset:0){totals{status count} pullTotals{status count} pullCount pulls{id title repository number state review checks}}
  working:tasks(where:{project:{eq:$id},status:{eq:in_progress}},${recentTickets}){${relatedFields}}
  recent:tasks(where:{project:{eq:$id}},${recentTickets}){${relatedFields}}
  epics:tasks(where:{project:{eq:$id},type:{eq:epic},status:{ne:closed}},${recentTickets}){${relatedFields}}
}`;
export function viewHash(v: View) {
  const p = new URLSearchParams();
  if ('project' in v) {
    p.set('project', v.project);
    if (v.kind !== 'project') p.set(v.kind, v.ref);
  } else if (v.kind === 'pull') p.set('pull', v.ref);
  else p.set('ticket', v.ticket);
  return '#' + p.toString();
}
export function hashView(hash: string): View | null {
  const p = new URLSearchParams(hash.slice(1)),
    project = p.get('project');
  if (project) {
    for (const kind of ['repository', 'agent', 'member'] as const) {
      const ref = p.get(kind);
      if (ref) return { kind, project, ref };
    }
    return { kind: 'project', project };
  }
  const pull = p.get('pull'),
    ticket = p.get('ticket');
  if (pull) return { kind: 'pull', ref: pull };
  return ticket && /^t-\d+$/.test(ticket) ? ticketView(ticket) : null;
}
export function ViewLink({ view, work, children }: { view: View; work: Work; children: ReactNode }) {
  return (
    <a
      className="underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
      href={viewHash(view)}
      onClick={(e) => {
        if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          work(view);
        }
      }}
    >
      {children}
    </a>
  );
}
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-medium">{name}</h2>
      <div className="text-sm text-card-body [overflow-wrap:anywhere]">{children}</div>
    </section>
  );
}
const readable = (s: string) => s.replaceAll('_', ' ');
function totals(rows: Total[]) {
  const order = ['open', 'in_progress', 'merged', 'closed'];
  return [...rows]
    .sort(
      (a, b) =>
        (order.includes(a.status) ? order.indexOf(a.status) : order.length) -
        (order.includes(b.status) ? order.indexOf(b.status) : order.length),
    )
    .map((r) => r.count + ' ' + readable(r.status))
    .join(' · ');
}
function pullRow(p: PullSummary) {
  const repo = p.repository.replace(/^github:/, '');
  return {
    title: p.title,
    state: p.state,
    meta: repo + ' #' + p.number,
    detail: 'Checks: ' + p.checks + ' · Review: ' + readable(p.review),
    target: { kind: 'pull' as const, ref: 'https://github.com/' + repo + '/pull/' + p.number },
  };
}
export function ProjectCanvas({ data, work, memory }: { data: ProjectOverview; work: Work; memory: Memory }) {
  const p = data.project!;
  const scope = data.scope;
  const groups: Group[] = [
    { name: 'In progress', rows: data.working.map(ticketRow) },
    { name: 'Recently updated', rows: data.recent.map(ticketRow) },
    { name: 'Active epics', rows: data.epics.map(ticketRow) },
    { name: 'Recent PRs', rows: scope?.pulls.map(pullRow) || [] },
    { name: 'Board', rows: [], boardProject: p.id },
    {
      name: 'Trends',
      rows: [],
      content: (
        <Suspense fallback={<p>Opening trends…</p>}>
          <ProjectTrends project={p.id} />
        </Suspense>
      ),
    },
  ];
  const mapped = data.mapped?.projects.find((row) => row.id === p.id);
  const repositories = mapped?.repositories || [
    ...new Set(data.recentChanges.map((pr) => 'github:' + pr.repository.replace(/^github:/, ''))),
  ];
  const links = [
    ...data.claims.map((r) => ({ kind: 'agent' as const, ref: r.agent })),
    ...p.projectMembersByProject.map((r) => ({ kind: 'member' as const, ref: r.member })),
  ];
  return (
    <>
      <ModuleCard
        title={p.name}
        description="Project overview"
        action={<Badge variant="secondary">{p.lifecycle}</Badge>}
      >
        {p.goal && (
          <Fact name="Goal">
            <Reply words={p.goal} />
          </Fact>
        )}
        {scope && (
          <>
            <Fact name="Tickets">{totals(scope.totals) || 'No visible tickets'}</Fact>
            <Fact name="Pull requests">{totals(scope.pullTotals) || 'No visible pull requests'}</Fact>
          </>
        )}
        {data.recent[0] && (
          <Fact name="Last ticket update">
            <ViewLink view={ticketView(data.recent[0].id)} work={work}>
              {data.recent[0].title}
            </ViewLink>{' '}
            · {new Date(data.recent[0].changedAt).toLocaleDateString()}
          </Fact>
        )}
        {repositories.length > 0 && (
          <Fact name={mapped ? 'Repositories' : 'Repositories in recent PRs'}>
            <div className="flex flex-wrap gap-x-3">
              {repositories.map((repository) => (
                <ViewLink
                  key={repository}
                  view={{ kind: 'repository', project: p.id, ref: repository }}
                  work={work}
                >
                  {repository.replace(/^github:/, '')}
                </ViewLink>
              ))}
            </div>
          </Fact>
        )}
        {links.length > 0 && (
          <Fact name="People and agents">
            <div className="flex flex-wrap gap-x-3">
              {links.map((l) => (
                <span key={l.kind + l.ref}>
                  <ViewLink view={{ ...l, project: p.id }} work={work}>
                    {l.ref}
                  </ViewLink>{' '}
                  · {l.kind}
                </span>
              ))}
            </div>
          </Fact>
        )}
      </ModuleCard>
      <Secondary
        view={{ kind: 'project', project: p.id }}
        memory={memory}
        work={work}
        groups={groups.filter((g) => g.rows.length || g.boardProject || g.content)}
      />
    </>
  );
}

type PullRecord = PullSummary & {
  project: string | null;
  body: string;
  url: string;
  authorLogin: string;
  branch: string;
  baseBranch: string;
  updatedAt: string;
  waitingOn: string;
  changeChecksByChange: { name: string; state: string }[];
  changeTasksByChange: { taskRow: Related | null }[];
};
export type EntityData = {
  record?: PullRecord[];
  mapped?: { projects: { id: string; repositories: string[] }[] } | null;
  pulls?: PullSummary[];
  membership?: { agent?: string; member?: string; paused?: boolean }[];
  assigned?: Related[];
};
const pullFields = 'id title repository number state review checks';
export const entityQueries = {
  pull: `query PairPull($ref:String!){record:changes(where:{url:{eq:$ref}},limit:1){${pullFields} project url body authorLogin branch baseBranch updatedAt waitingOn changeChecksByChange{name state} changeTasksByChange{taskRow{${relatedFields}}}}}`,
  repository: `query PairRepo($id:String!,$repo:String!){mapped:householdSharing{projects{id repositories}}
 pulls:changes(where:{repository:{eq:$repo},project:{eq:$id}},orderBy:{updatedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:30){${pullFields}}}`,
  agent: `query PairAgentWork($id:String!,$ref:String!){membership:projectClaimStates(project:$id){agent paused}
 assigned:tasks(where:{project:{eq:$id},assignee:{eq:$ref}},${recentTickets}){${relatedFields}}}`,
  member: `query PairMemberWork($id:String!,$ref:String!){membership:projectMembers(where:{project:{eq:$id},member:{eq:$ref}}){member}
 assigned:tasks(where:{project:{eq:$id},assignee:{eq:$ref}},${recentTickets}){${relatedFields}}}`,
};
export function EntityCanvas({
  view,
  data,
  work,
  memory,
}: {
  view: ScopeView | { kind: 'pull'; ref: string };
  data: EntityData;
  work: Work;
  memory: Memory;
}) {
  let groups: Group[] = [];
  let core;
  if (view.kind === 'pull') {
    const pr = data.record?.[0];
    if (!pr) return <p role="status">Pull request unavailable.</p>;
    const repo = pr.repository.replace(/^github:/, '');
    groups = [
      {
        name: 'Linked tickets',
        rows: pr.changeTasksByChange.flatMap((l) => (l.taskRow ? [ticketRow(l.taskRow)] : [])),
      },
    ];
    core = (
      <ModuleCard
        title={pr.title}
        description={
          <>
            {pr.project ? (
              <ViewLink view={{ kind: 'repository', project: pr.project, ref: 'github:' + repo }} work={work}>
                {repo}
              </ViewLink>
            ) : (
              repo
            )}{' '}
            #{pr.number} · {pr.authorLogin}
          </>
        }
        action={<Badge variant="secondary">{pr.state}</Badge>}
      >
        {pr.project && (
          <Fact name="Project">
            <ViewLink view={{ kind: 'project', project: pr.project }} work={work}>
              {pr.project}
            </ViewLink>
          </Fact>
        )}
        <Fact name="Review">
          {readable(pr.review)} · Checks {pr.checks}
          {pr.state === 'open' && ' · Waiting on ' + pr.waitingOn}
        </Fact>
        {pr.branch && (
          <Fact name="Branches">
            {pr.branch} → {pr.baseBranch}
          </Fact>
        )}
        {pr.changeChecksByChange.length > 0 && (
          <details>
            <summary className="cursor-pointer">Checks · {pr.changeChecksByChange.length}</summary>
            <ul className="space-y-1 py-2 text-sm">
              {pr.changeChecksByChange.map((c) => (
                <li key={c.name}>
                  {c.name} · {c.state}
                </li>
              ))}
            </ul>
          </details>
        )}
        {pr.body && (
          <details>
            <summary className="cursor-pointer">Description</summary>
            <Reply words={pr.body} />
          </details>
        )}
        <a className="text-sm underline" href={pr.url} target="_blank" rel="noreferrer">
          Open pull request
        </a>
      </ModuleCard>
    );
  } else {
    const repo = view.kind === 'repository';
    if (
      repo
        ? !(
            data.pulls?.length ||
            data.mapped?.projects.find((r) => r.id === view.project)?.repositories.includes(view.ref)
          )
        : !data.membership?.some((r) => (r.agent || r.member) === view.ref)
    )
      return <p role="status">Record unavailable in this project.</p>;
    groups = repo
      ? [{ name: 'Recent PRs', rows: (data.pulls || []).map(pullRow) }]
      : [{ name: 'Recent assignments', rows: (data.assigned || []).map(ticketRow) }];
    const latest = groups[0].rows[0];
    core = (
      <ModuleCard
        title={view.ref.replace(/^github:/, '')}
        description={
          <>
            {repo ? 'Repository' : view.kind === 'agent' ? 'Project agent' : 'Project member'} ·{' '}
            <ViewLink view={{ kind: 'project', project: view.project }} work={work}>
              {view.project}
            </ViewLink>
          </>
        }
      >
        <Fact name={repo ? 'Latest pull request' : 'Latest assigned ticket'}>
          {latest ? (
            <>
              <ViewLink view={latest.target} work={work}>
                {latest.title}
              </ViewLink>
              {latest.state && ' · ' + readable(latest.state)}
            </>
          ) : repo ? (
            'No visible pull requests for this repository in the project.'
          ) : (
            'No visible assignments in this project.'
          )}
        </Fact>
        {view.kind === 'agent' && (
          <Fact name="Project claims">
            {data.membership?.find((r) => r.agent === view.ref)?.paused ? 'Paused' : 'Enabled'}
          </Fact>
        )}
        {repo && /^github:[\w.-]+\/[\w.-]+$/.test(view.ref) && (
          <a
            className="text-sm underline"
            href={'https://github.com/' + view.ref.slice(7)}
            target="_blank"
            rel="noreferrer"
          >
            Open repository
          </a>
        )}
      </ModuleCard>
    );
  }
  return (
    <>
      {core}
      <Secondary view={view} memory={memory} work={work} groups={groups.filter((g) => g.rows.length)} />
    </>
  );
}
