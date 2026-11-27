import { useKnownPeople, contactMeta } from './known-people';
import { createContext, useContext, useRef, useId, useState, type ReactElement, type ReactNode } from 'react';
import { useDataQuery } from '../data/graphql';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { indexNames, viewKey, type View, type Related } from './view';
type Project = { name: string; goal: string | null; lifecycle: string };

export const ViewMenuActions = createContext<{
  active: View | null;
  views: View[];
  work: (v: View) => void;
  background: (v: View) => void;
  close: (v: View) => void;
} | null>(null);
type MenuTarget = { view: View; ring?: boolean };
export function EntityPreview({
  link,
  preview,
  intent,
  menu,
}: {
  link: ReactElement;
  preview: ReactNode;
  intent: string;
  menu?: MenuTarget;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const actions = useContext(ViewMenuActions);
  const menuOpen = useRef(false);
  const trigger = (
    <HoverCardTrigger
      asChild
      aria-description={intent}
      aria-describedby={open ? id : undefined}
      onClick={() => setOpen(false)}
    >
      {link}
    </HoverCardTrigger>
  );
  const v = menu?.view;
  const active = v && actions?.active && viewKey(actions.active) === viewKey(v);
  const exists = v && actions?.views.some((i) => viewKey(i) === viewKey(v));
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => setOpen(next && !menuOpen.current)}
      openDelay={350}
      closeDelay={120}
    >
      {actions && v && (!active || menu?.ring) ? (
        <ContextMenu modal={false}
          onOpenChange={(next) => {
            menuOpen.current = next;
            if (next) setOpen(false);
          }}
        >
          <ContextMenuTrigger
            asChild
            onKeyDown={(e) => {
              if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              e.currentTarget.dispatchEvent(
                new MouseEvent('contextmenu', {
                  bubbles: true,
                  cancelable: true,
                  clientX: box.left + 8,
                  clientY: box.bottom,
                }),
              );
            }}
          >
            {trigger}
          </ContextMenuTrigger>
          <ContextMenuContent>
            {!active && (
              <ContextMenuItem onSelect={() => actions.work(v)}>
                {exists ? 'Switch to view' : 'Open view'}
              </ContextMenuItem>
            )}
            {!exists && (
              <ContextMenuItem onSelect={() => actions.background(v)}>Open in background</ContextMenuItem>
            )}
            {menu?.ring && exists && (
              <ContextMenuItem onSelect={() => actions.close(v)}>Close view</ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        trigger
      )}
      <HoverCardContent
        id={id}
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="pair-entity-preview w-72 max-w-[calc(100vw-1.5rem)] space-y-2 p-3"
      >
        {preview}
        <p className="text-xs text-muted-foreground">{intent}</p>
      </HoverCardContent>
    </HoverCard>
  );
}

export function ProjectPreview({ id }: { id: string }) {
  const read = useDataQuery<{ project: Project | null; recent: { id: string; title: string }[] }>(
    `query PairProjectPreview($id:String!){project:projectsSingle(where:{id:{eq:$id}}){name goal lifecycle}
       recent:tasks(where:{project:{eq:$id}},${latest}){id title}}`,
    { id },
  );
  const project = read.data?.project,
    ticket = read.data?.recent[0];
  return (
    <MiniCard
      title={project?.name || id}
      meta={project ? 'Project · ' + project.lifecycle : undefined}
      detail={
        project?.goal ||
        (ticket && 'Latest ticket · ' + ticket.id + ' · ' + ticket.title) ||
        (read.status === 'loading' ? 'Loading details…' : project ? undefined : 'Details unavailable.')
      }
    />
  );
}

export function viewHash(v: View) {
  const p = new URLSearchParams();
  if (v.kind === 'index') p.set('index', v.ref);
  else if (v.kind === 'profile') {
    p.set('profile', v.role);
    p.set('ref', v.ref);
  } else if ('project' in v) {
    p.set('project', v.project);
    if (v.kind !== 'project') p.set(v.kind, v.ref);
  } else if (v.kind === 'pull') p.set('pull', v.ref);
  else {
    p.set('ticket', v.ticket);
    if (v.kind === 'comment' && v.ref) p.set('comment', v.ref);
  }
  return '#' + p.toString();
}

export function ViewLink({
  view,
  work,
  children,
}: {
  view: View;
  work: (view: View) => void;
  children: ReactNode;
}) {
  return (
    <ViewPreview view={view} menu="entity">
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
    </ViewPreview>
  );
}

export function MiniCard({ title, meta, detail }: { title: string; meta?: string; detail?: string | null }) {
  return (
    <div className="space-y-1 [overflow-wrap:anywhere]">
      <strong className="line-clamp-2 font-semibold">{title}</strong>
      {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
      {detail && <p className="line-clamp-3 text-card-body">{detail}</p>}
    </div>
  );
}
const latest = 'orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:1';
const clean = (value: string) => value.replaceAll('_', ' ');
type PreviewData = {
  ticket?: Related | null;
  notes?: { actor: string; at: string; text: string }[];
  pulls?: {
    title: string;
    number: number;
    state: string;
    repository: string;
    checks: string;
    review: string;
  }[];
  assigned?: Related[];
  claims?: { agent: string; paused: boolean }[];
};
function RecordPreview({ view }: { view: Exclude<View, { kind: 'project' | 'index' | 'profile' }> }) {
  let query: string, variables: Record<string, string | number>;
  let title: string;
  if ('project' in view) {
    title = view.ref.replace(/^github:/, '');
    if (view.kind === 'repository') {
      query =
        'query RepoMini($project:String!,$ref:String!){pulls:changes(where:{project:{eq:$project},repository:{eq:$ref}},orderBy:{updatedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:1){number title state}}';
      variables = { project: view.project, ref: title };
    } else {
      query = `query PersonMini($project:String!,$ref:String!){assigned:tasks(where:{project:{eq:$project},assignee:{eq:$ref}},${latest}){id title status}${view.kind === 'agent' ? ' claims:projectClaimStates(project:$project){agent paused}' : ''}}`;
      variables = { project: view.project, ref: view.ref };
    }
  } else if (view.kind === 'pull') {
    title = 'Pull request';
    query =
      'query PullMini($ref:String!){pulls:changes(where:{url:{eq:$ref}},limit:1){number title repository state review checks}}';
    variables = { ref: view.ref };
  } else if (view.kind === 'comment') {
    title = 'Comment on ' + view.ticket;
    query =
      'query NoteMini($id:String!,$seq:Int!){notes:taskComments(where:{task:{eq:$id},seq:{eq:$seq}},limit:1){actor at text}}';
    variables = { id: view.ticket, seq: Number(view.ref) };
  } else {
    title = view.ticket;
    query =
      'query TicketMini($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){id title type status assignee goal}}';
    variables = { id: view.ticket };
  }
  const read = useDataQuery<PreviewData>(query, variables);
  const data = read.data,
    pr = data?.pulls?.[0],
    task = data?.ticket,
    note = data?.notes?.[0];
  if (read.status !== 'live')
    return (
      <MiniCard
        title={title}
        detail={read.status === 'loading' ? 'Loading details…' : 'Details unavailable.'}
      />
    );
  if ('project' in view) {
    const assignment = data?.assigned?.[0],
      claim = data?.claims?.find((r) => r.agent === view.ref);
    const role = view.kind === 'repository' ? 'Repository' : view.kind === 'agent' ? 'Agent' : 'Member';
    return (
      <MiniCard
        title={title}
        meta={[role, view.project, claim && (claim.paused ? 'Claims paused' : 'Claims enabled')]
          .filter(Boolean)
          .join(' · ')}
        detail={
          view.kind === 'repository'
            ? pr
              ? 'Latest PR · #' + pr.number + ' · ' + pr.title + ' · ' + pr.state
              : 'No visible pull requests in this project.'
            : assignment
              ? 'Latest assignment · ' +
                assignment.id +
                ' · ' +
                assignment.title +
                ' · ' +
                clean(assignment.status)
              : 'No visible assignments in this project.'
        }
      />
    );
  }
  if (task)
    return (
      <MiniCard
        title={task.title}
        meta={[task.id, task.type, clean(task.status), task.assignee].filter(Boolean).join(' · ')}
        detail={task.goal}
      />
    );
  if (pr)
    return (
      <MiniCard
        title={pr.title}
        meta={pr.repository + ' #' + pr.number + ' · ' + pr.state}
        detail={'Checks ' + pr.checks + ' · Review ' + clean(pr.review)}
      />
    );
  if (note)
    return (
      <MiniCard
        title={title}
        meta={note.actor + ' · ' + new Date(note.at).toLocaleString()}
        detail={note.text}
      />
    );
  return <MiniCard title={title} detail="Details unavailable." />;
}
export function ViewPreview({
  view,
  children,
  intent,
  preview,
  menu,
}: {
  view: View;
  children: ReactElement;
  intent?: string;
  preview?: ReactNode;
  menu?: 'entity' | 'ring';
}) {
  const noun =
    view.kind === 'project' ? 'project overview' : view.kind === 'pull' ? 'pull request' : view.kind;
  return (
    <EntityPreview
      link={children}
      menu={menu ? { view, ring: menu === 'ring' } : undefined}
      intent={intent || 'Open the ' + noun + ' view in this context.'}
      preview={
        preview ??
        (view.kind === 'index' ? (
          <MiniCard title={indexNames[view.ref]} meta="Across projects" />
        ) : view.kind === 'profile' ? (
          view.role === 'contact' ? (
            <ContactMini slug={view.ref} />
          ) : (
            <ProfileMini view={view} />
          )
        ) : view.kind === 'project' ? (
          <ProjectPreview id={view.project} />
        ) : (
          <RecordPreview view={view} />
        ))
      }
    />
  );
}
export function TicketReference({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ViewPreview view={{ kind: 'ticket', ticket: id }} menu="entity">
      <a className={className} href={'?ticket=' + id}>
        {children}
      </a>
    </ViewPreview>
  );
}
export function ActorReference({
  id,
  project,
  work,
}: {
  id: string;
  project: string;
  work: (view: View) => void;
}) {
  const read = useDataQuery<{
    project: { projectMembersByProject: { member: string }[] } | null;
    claims: { agent: string }[];
  }>(
    'query PairActorRole($project:String!){project:projectsSingle(where:{id:{eq:$project}}){projectMembersByProject{member}} claims:projectClaimStates(project:$project){agent}}',
    { project },
  );
  const kind = read.data?.project?.projectMembersByProject.some((row) => row.member === id)
    ? 'member'
    : read.data?.claims.some((row) => row.agent === id)
      ? 'agent'
      : null;
  return kind ? (
    <ViewLink view={{ kind: 'profile', role: kind, ref: id }} work={work}>
      {id}
    </ViewLink>
  ) : (
    <>{id}</>
  );
}

function ContactMini({ slug }: { slug: string }) {
  const { contacts, status } = useKnownPeople(true);
  const c = contacts.find((p) => p.slug === slug);
  return (
    <MiniCard
      title={c?.name || slug}
      meta={c && contactMeta(c)}
      detail={
        c?.summary ||
        (c?.agents.length
          ? 'Known to ' + c.agents.join(', ')
          : status === 'loading'
            ? 'Loading details…'
            : undefined)
      }
    />
  );
}
function ProfileMini({ view }: { view: Extract<View, { kind: 'profile' }> }) {
  const repo = view.role === 'repository';
  const ref = repo ? view.ref.replace(/^github:/, '') : view.ref;
  const r = useDataQuery<{ rows: { title: string }[] }>(
    repo
      ? 'query RepoLatest($ref:String!){rows:changes(where:{repository:{eq:$ref}},orderBy:{updatedAt:{direction:desc,priority:0}},limit:1){title}}'
      : `query PersonLatest($ref:String!){rows:tasks(where:{assignee:{eq:$ref},assigneeKind:{eq:${view.role}}},${latest}){title}}`,
    { ref },
  );
  return (
    <MiniCard
      title={ref}
      meta={view.role + ' · Across projects'}
      detail={r.data?.rows[0] && (repo ? 'Latest PR · ' : 'Latest assignment · ') + r.data.rows[0].title}
    />
  );
}
