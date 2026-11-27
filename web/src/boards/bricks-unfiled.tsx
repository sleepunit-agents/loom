/** The `unfiled` brick: the tickets under no project, as the desktop's Unfiled view lists them (pieces/work/query.ts,
 * its first page: latest change first, closed ones included). The big form files one into a project with the
 * desktop's Set project action: tasks.command `edit` with the project alone. The board is told `project`. */
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { unfiledPageSize, workUnfiledQuery } from '../pieces/work/query';
import { Action, Few, Loading, More, Note, Problem, Row, Rows, State, type Act, type Tone } from './brick-kit';
import { Pick, useTaskChoices, useTaskCommand } from './bricks-work';
import type { Form } from './layout';

type Row = { id: string; title: string; status: 'open' | 'in_progress' | 'closed'; changedAt: string };
const statusWords = { open: 'Open', in_progress: 'In progress', closed: 'Closed' };
const tone = (status: string): Tone => (status === 'in_progress' ? 'working' : status === 'closed' ? 'muted' : 'neutral');

export function Unfiled({ form, act }: { form: Form; act: Act }) {
  const read = useDataQuery<{ unfiled: Row[] }>(workUnfiledQuery, { offset: 0 }, { keep: true });
  const big = form === 'primary';
  const { projects } = useTaskChoices(!big), { busy, error, run } = useTaskCommand(act);
  const [filing, setFiling] = useState<string>();
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <Note>Unfiled tickets are unavailable.</Note>;
  const all = read.data.unfiled ?? [], rows = all.slice(0, unfiledPageSize);
  const total = `${all.length > unfiledPageSize ? `More than ${unfiledPageSize}` : rows.length || 'No'} unfiled ticket${rows.length === 1 ? '' : 's'}`;
  if (form === 'compact') return <p className="board-brief">{total}</p>;
  if (!rows.length) return <Note>No unfiled tickets. Every ticket you can see belongs to a project.</Note>;
  const file = async (id: string, project: string) => { if (project && await run('project', { action: 'edit', id, input: { project } })) setFiling(undefined); };
  return (
    <>
      <Note>{total}.</Note>
      <Few of={rows} first={big ? unfiledPageSize : 6} fit={!big}>{(shown, hidden) => <>
      <Rows>
        {shown.map((t) => (
          <Row key={t.id} place={{ brick: 'ticket', params: { ticket: t.id } }} title={<>{t.title} <span className="font-mono board-row-ref">{t.id}</span></>}
            end={<><State tone={tone(t.status)}>{statusWords[t.status] ?? t.status}</State>{big && filing !== t.id && <Action kind="quiet" label={`File ${t.id} into a project`} onClick={() => setFiling(t.id)}>File…</Action>}</>}>
            {big && filing === t.id && <div className="board-pick">
              {projects.length ? <Pick<string> label="Project" value="" options={projects.map((p) => ({ value: p.id, label: p.label }))} disabled={busy} onChange={(project) => void file(t.id, project)} />
                : <Note>There is no project to file it into.</Note>}
              <Action kind="quiet" onClick={() => setFiling(undefined)}>Cancel</Action>
            </div>}
          </Row>
        ))}
      </Rows>
      {hidden > 0 ? <More n={hidden} /> : all.length > rows.length && <Note>and more</Note>}
      </>}</Few>
      <Problem>{error}</Problem>
    </>
  );
}
