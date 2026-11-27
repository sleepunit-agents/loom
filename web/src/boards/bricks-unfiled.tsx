/** The `unfiled` brick: the tickets under no project, as the desktop's Unfiled view lists them (pieces/work/query.ts,
 * its first page: latest change first, closed ones included). The big form files one into a project with the
 * desktop's Set project action: tasks.command `edit` with the project alone. The board is told `project`. */
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { unfiledPageSize, workUnfiledQuery } from '../pieces/work/query';
import { Loading, ticketChip, type Act } from './brick-kit';
import { Pick, useTaskChoices, useTaskCommand } from './bricks-work';
import type { Form } from './layout';

type Row = { id: string; title: string; status: 'open' | 'in_progress' | 'closed'; changedAt: string };
const statusWords = { open: 'Open', in_progress: 'In progress', closed: 'Closed' };

export function Unfiled({ form, act }: { form: Form; act: Act }) {
  const read = useDataQuery<{ unfiled: Row[] }>(workUnfiledQuery, { offset: 0 }, { keep: true });
  const big = form === 'primary';
  const { projects } = useTaskChoices(!big), { busy, error, run } = useTaskCommand(act);
  const [filing, setFiling] = useState<string>();
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <p className="text-muted-foreground">Unfiled tickets are unavailable.</p>;
  const all = read.data.unfiled ?? [], rows = all.slice(0, unfiledPageSize);
  const count = `${all.length > unfiledPageSize ? `More than ${unfiledPageSize}` : rows.length || 'No'} unfiled ticket${rows.length === 1 ? '' : 's'}`;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  if (!rows.length) return <p className="text-muted-foreground">No unfiled tickets. Every ticket you can see belongs to a project.</p>;
  const shown = rows.slice(0, big ? unfiledPageSize : 6);
  const file = async (id: string, project: string) => { if (project && await run('project', { action: 'edit', id, input: { project } })) setFiling(undefined); };
  return (
    <>
      <p>{count}.</p>
      <ul className="board-notes">
        {shown.map((t) => (
          <li key={t.id}>
            <span className="board-line" style={{ marginTop: 0 }}>
              {ticketChip(t.id)}<span>{t.title}</span><span className="board-state">{statusWords[t.status] ?? t.status}</span>
              {big && filing !== t.id && <button type="button" className="board-action" aria-label={`File ${t.id} into a project`} onClick={() => setFiling(t.id)}>File…</button>}
            </span>
            {big && filing === t.id && <>
              {projects.length ? <Pick<string> label="Project" value="" options={projects.map((p) => ({ value: p.id, label: p.label }))} disabled={busy} onChange={(project) => void file(t.id, project)} />
                : <p className="text-muted-foreground">There is no project to file it into.</p>}
              <button type="button" className="board-action" onClick={() => setFiling(undefined)}>Cancel</button>
            </>}
          </li>
        ))}
      </ul>
      {all.length > shown.length && <p className="text-muted-foreground">and more</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}
