import { useState } from 'react';
import { ArrowUpRightIcon } from 'lucide-react';
import { Badge } from './ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Button } from './ui/button';
import { ModuleCard } from './module-card';
import { Reply } from './reply';

export type View = { ticket: string; kind: 'ticket' | 'pull' | 'comment'; ref?: string; intent?: 'work' };
export const ticketView = (ticket: string): View => ({ ticket, kind: 'ticket' });
export const viewKey = (v: View) =>
  JSON.stringify([v.kind, v.kind === 'pull' ? '' : v.ticket, v.ref, v.intent]);
export function viewLabel(v: View) {
  if (v.kind === 'comment') return v.ticket + ' · note ' + v.ref;
  if (v.kind === 'pull') return 'Review ' + v.ref?.split('/').slice(-3).join('/').replace('/pull/', '#');
  return (v.intent === 'work' ? 'Work on ' : 'Review ') + v.ticket;
}
type Related = { id: string; title: string; status: string; assignee: string | null };
type Pull = {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: string;
  checks: string;
  waitingOn: string;
};
type Note = { seq: number; text: string; actor: string; at: string };
export interface Ticket extends Related {
  project: string | null;
  goal: string;
  why: string;
  doneWhen: string;
  description: string;
  taskLinksByDependsOn: { type: string; taskRow: Related | null }[];
  taskLinksByTask: { type: string; dependsOnRow: Related | null }[];
  changeTasksByTask: { changeRow: Pull | null }[];
  taskCommentsByTask: Note[];
}
const relatedFields = 'id title status assignee';
export const detailsQuery = `query PairTicketView($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){
  ${relatedFields} project goal why doneWhen description
  taskLinksByDependsOn{type taskRow{${relatedFields}}} taskLinksByTask{type dependsOnRow{${relatedFields}}}
  changeTasksByTask{changeRow{repository number title url state checks waitingOn}}
  taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}}){seq text actor at}
}}`;
type Row = { title: string; state?: string; detail: string; target: View };
type Group = { name: string; rows: Row[] };
type PanelState = { page: number; expanded?: string };
export type SecondaryState = { selected: string; panels: Record<string, PanelState> };
function Secondary({
  groups,
  work,
  memory,
  view,
}: {
  groups: Group[];
  work: (v: View) => void;
  memory: Map<string, SecondaryState>;
  view: View;
}) {
  const key = viewKey(view);
  const [state, setState] = useState<SecondaryState>(() => memory.get(key) || { selected: '', panels: {} });
  function update(next: SecondaryState) {
    memory.set(key, next);
    setState(next);
  }
  const group = groups.find((g) => g.name === state.selected) || groups[0];
  if (!group) return null;
  return (
    <aside aria-label="Related work" className="pair-secondary min-w-0">
      <Tabs value={group.name} onValueChange={(name) => update({ ...state, selected: name })}>
        <div className="pair-tab-scroll">
          <TabsList variant="line" aria-label="Related work categories">
            {groups.map((g) => (
              <TabsTrigger key={g.name} value={g.name}>
                {g.name} · {g.rows.length}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="grid">
          {groups.map((g) => {
            const { page, expanded } = state.panels[g.name] || { page: 0 };
            const start = page * 5 < g.rows.length ? page * 5 : 0;
            function updatePanel(next: PanelState) {
              update({ ...state, panels: { ...state.panels, [g.name]: next } });
            }
            return (
              <TabsContent
                key={g.name}
                value={g.name}
                forceMount
                inert={g !== group}
                aria-hidden={g !== group}
                className="col-start-1 row-start-1 self-start data-[state=inactive]:invisible"
              >
                <ul className="divide-y">
                  {g.rows.slice(start, start + 5).map((row) => (
                    <li key={viewKey(row.target)} className="flex items-start gap-2 py-2">
                      <details open={expanded === viewKey(row.target)} className="min-w-0 flex-1 text-sm">
                        <summary
                          onClick={(event) => {
                            event.preventDefault();
                            updatePanel({
                              page,
                              expanded: expanded === viewKey(row.target) ? undefined : viewKey(row.target),
                            });
                          }}
                          className="cursor-pointer leading-snug [overflow-wrap:anywhere]"
                        >
                          {row.title}
                          {row.state && (
                            <span className="ml-2 text-xs text-muted-foreground">{row.state}</span>
                          )}
                        </summary>
                        <p className="mt-1 whitespace-pre-wrap text-card-body [overflow-wrap:anywhere]">
                          {row.detail}
                        </p>
                      </details>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={'Work on this: ' + row.title}
                        title="Work on this"
                        onClick={() => work(row.target)}
                      >
                        <ArrowUpRightIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
                {g.rows.length > 5 && (
                  <div className="flex gap-3 text-sm">
                    {start > 0 && (
                      <button onClick={() => updatePanel({ page: start / 5 - 1 })}>Previous</button>
                    )}
                    {start + 5 < g.rows.length && (
                      <button onClick={() => updatePanel({ page: start / 5 + 1 })}>
                        +{g.rows.length - start - 5} more
                      </button>
                    )}
                  </div>
                )}
              </TabsContent>
            );
          })}
        </div>
      </Tabs>
    </aside>
  );
}
export function TicketCanvas({
  ticket: t,
  view,
  work,
  memory,
}: {
  ticket: Ticket;
  memory: Map<string, SecondaryState>;
  view: View;
  work: (v: View) => void;
}) {
  const ticketRow = (r: Related): Row => ({
    title: r.title,
    state: r.status.replaceAll('_', ' '),
    detail: [r.id, r.assignee].filter(Boolean).join(' · '),
    target: ticketView(r.id),
  });
  const pulls = t.changeTasksByTask.flatMap((l) => (l.changeRow ? [l.changeRow] : []));
  const parent: Group = { name: 'Source ticket', rows: [ticketRow(t)] };
  if (view.kind !== 'ticket') {
    const pr = view.kind === 'pull' && pulls.find((p) => p.url === view.ref);
    const note = view.kind === 'comment' && t.taskCommentsByTask.find((n) => String(n.seq) === view.ref);
    return (
      <>
        <ModuleCard
          title={pr ? pr.title : note ? 'Comment on ' + t.id : 'Record unavailable'}
          description={
            pr
              ? pr.repository + ' #' + pr.number
              : note
                ? note.actor + ' · ' + new Date(note.at).toLocaleString()
                : t.id
          }
        >
          {pr && (
            <>
              <p>
                {pr.state} · Checks {pr.checks}
              </p>
              <a className="underline" href={pr.url} target="_blank" rel="noreferrer">
                Open pull request
              </a>
            </>
          )}
          {note && <Reply words={note.text} />}
        </ModuleCard>
        <Secondary view={view} memory={memory} groups={[parent]} work={work} />
      </>
    );
  }
  const relations = t.taskLinksByDependsOn.flatMap((l) =>
    l.taskRow ? [{ type: l.type, ticket: l.taskRow }] : [],
  );
  const related = [
    ...relations.filter((l) => l.type !== 'parent-child'),
    ...t.taskLinksByTask.flatMap((l) => (l.dependsOnRow ? [{ type: l.type, ticket: l.dependsOnRow }] : [])),
  ];
  const rank = (p: Pull) =>
    p.checks === 'failing' || p.waitingOn === 'you' ? 0 : p.state === 'open' ? 1 : 2;
  const ticketRank = (r: Related) =>
    r.status === 'blocked' ? 0 : r.status === 'in_progress' ? 1 : r.status === 'closed' ? 3 : 2;
  const groups: Group[] = [
    {
      name: 'Child tickets',
      rows: relations
        .filter((l) => l.type === 'parent-child')
        .sort((a, b) => ticketRank(a.ticket) - ticketRank(b.ticket))
        .map((l) => ticketRow(l.ticket)),
    },
    {
      name: 'Changes',
      rows: pulls
        .sort((a, b) => rank(a) - rank(b))
        .map((p) => ({
          title: p.title,
          state: p.checks === 'failing' ? 'Failing checks' : p.state,
          detail: p.repository + ' #' + p.number + ' · ' + p.state + ' · Checks ' + p.checks,
          target: { kind: 'pull', ticket: t.id, ref: p.url },
        })),
    },
    {
      name: 'Comments',
      rows: t.taskCommentsByTask.map((n) => ({
        title: n.actor + ' · ' + n.text.slice(0, 85).replace(/\s+/g, ' ') + (n.text.length > 85 ? '…' : ''),
        detail: n.text,
        target: { kind: 'comment', ticket: t.id, ref: String(n.seq) },
      })),
    },
    {
      name: 'Related tickets',
      rows: Array.from(new Map(related.map((l) => [l.ticket.id, ticketRow(l.ticket)])).values()),
    },
  ];
  return (
    <>
      <ModuleCard
        title={t.title}
        description={[t.project, t.id, t.assignee && 'Assigned to ' + t.assignee].filter(Boolean).join(' · ')}
        action={<Badge variant="secondary">{t.status.replaceAll('_', ' ')}</Badge>}
      >
        {Object.entries({
          Goal: t.goal,
          Why: t.why,
          'Done when': t.doneWhen,
          Description: t.description,
        }).map(
          ([name, words]) =>
            words && (
              <section key={name}>
                <h2 className="font-medium">{name}</h2>
                <div className="text-sm text-card-body">
                  <Reply words={words} />
                </div>
              </section>
            ),
        )}
      </ModuleCard>
      <Secondary view={view} memory={memory} groups={groups.filter((g) => g.rows.length)} work={work} />
    </>
  );
}
