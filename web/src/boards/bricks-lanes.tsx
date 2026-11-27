/** The `lanes` brick: a project's active tickets as the desktop's board reads them (`projectBoardTickets`,
 * pieces/work/board.tsx), each card with who has it, its priority and why it is where it is. The big form adds
 * what the desktop's project page says beside its board: how many questions in the project wait on the member
 * (`inboxProjectNeeds`, pieces/work/index.tsx) and, for each agent whose claims the member may direct, whether it
 * takes new tickets here, with the desktop's pause and resume (`work.setProjectClaims`,
 * pieces/work/claim-controls.tsx). A pause or a resume asks first. */
import { useRef, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { displayName } from '../kit/words';
import { Action, Actions, Few, Loading, More, Problem, Row, Rows, Section, State, Time, Unavailable, words, type Act, type Params } from './brick-kit';
import { priorityWord } from './bricks-work';
import type { Form } from './layout';

type Lane = { id: string; title: string; lane: string; reason: string | null; assignee: string | null; priority?: number };
type Direction = { agent: string; paused: boolean; revision: number; at: string | null };
export const lanesQuery = 'query BrickLanes($project:String!){projectBoardTickets(project:$project,offset:0,limit:60){id title lane reason assignee priority}}';
const needsQuery = 'query WorkProjectDecisions { inboxProjectNeeds { project needs } }';
const claimsQuery = 'query WorkClaimStates($project:String!){projectClaimStates(project:$project){agent paused revision at}}';

function Tools({ project, act }: { project: string; act: Act }) {
  const needs = useDataQuery<{ inboxProjectNeeds: { project: string; needs: number }[] }>(needsQuery, {}, { keep: true });
  const claims = useDataQuery<{ projectClaimStates: Direction[] }>(claimsQuery, { project }, { keep: true });
  const [asking, setAsking] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const waiting = needs.status === 'live' ? needs.data?.inboxProjectNeeds?.find((row) => row.project === project)?.needs ?? 0 : 0;
  const rows = claims.status === 'live' ? claims.data?.projectClaimStates ?? [] : [];
  async function change(row: Direction) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await memberOperation('work.setProjectClaims', { project, agent: row.agent, paused: !row.paused, expectedRevision: row.revision });
      act(row.paused ? 'resume' : 'pause', {}); setAsking(undefined);
    } catch { setError('The direction could not be saved. Check the current state and try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!waiting && !rows.length) return null;
  return (
    <div className="board-lanes-tools" data-lanes-tools="">
      {waiting > 0 && <p className="board-meta"><State tone="waiting">Needs you · {waiting}</State></p>}
      {rows.length > 0 && (
        <Section title="New claims">
          <Rows>
            {rows.map((row) => {
              const name = displayName(row.agent), verb = row.paused ? 'Resume new claims for ' : 'Pause new claims for ';
              return (
                <Row key={row.agent} place={{ brick: 'agent', params: { agent: row.agent } }} title={name}
                  meta={<>{row.paused ? 'New claims paused' : 'New claims enabled'}{row.at && <> · <Time at={row.at} /></>}</>}
                  end={asking === row.agent ? undefined : <Action kind="quiet" label={verb + name} onClick={() => { setError(''); setAsking(row.agent); }}>{row.paused ? 'Resume…' : 'Pause…'}</Action>}>
                  {asking === row.agent && <Actions><Action disabled={busy} onClick={() => void change(row)}>{verb + name}</Action><Action kind="quiet" onClick={() => setAsking(undefined)}>Cancel</Action></Actions>}
                </Row>
              );
            })}
          </Rows>
        </Section>
      )}
      <Problem>{error}</Problem>
    </div>
  );
}

export function Lanes({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const project = words(params.project);
  const read = useDataQuery<{ projectBoardTickets: Lane[] }>(lanesQuery, { project }, { keep: true });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <Unavailable what="project" />;
  const cap = form === 'primary' ? 8 : 3;
  const count = (lane: string) => read.data!.projectBoardTickets.filter((t) => t.lane === lane).length;
  if (form === 'compact') return <p className="board-brief">{count('Working')} working · {count('Verifying')} verifying · {count('Waiting')} waiting</p>;
  const names = ['Working', 'Verifying', 'Waiting'], inLane = names.map((lane) => read.data!.projectBoardTickets.filter((t) => t.lane === lane));
  // The side form has room for a few tickets in all: they are dealt to the lanes in turn, so each lane shows its first.
  const dealt = Array.from({ length: cap }, (_, n) => inLane.flatMap((rows) => (rows[n] ? [rows[n]] : []))).flat();
  return (
    <>
      <Few of={dealt} first={dealt.length} fit={form === 'side'} least={0} most={9}>{(drawn) => (
      <div className="board-lanes">
        {names.map((lane, at) => {
          const all = inLane[at], rows = all.filter((t) => drawn.includes(t));
          return (
            <section key={lane} aria-label={lane} data-empty={all.length === 0}>
              <h3><span>{lane}</span><small>{all.length}</small></h3>
              <ul>
                  {rows.map((t) => (
                    <li key={t.id}>
                      <button type="button" className="board-ticket" data-flip={'tk-' + t.id} data-place={JSON.stringify({ brick: 'ticket', params: { ticket: t.id } })}>
                        {t.title}
                        <small><span className="font-mono">{t.id}</span>{typeof t.priority === 'number' ? ' · ' + priorityWord(t.priority) : ''}{t.assignee ? ' · ' + displayName(t.assignee) : ''}</small>
                        {t.reason && <small>{t.reason}</small>}
                      </button>
                    </li>
                  ))}
                  {all.length > rows.length && <li><More n={all.length - rows.length} /></li>}
              </ul>
            </section>
          );
        })}
      </div>
      )}</Few>
      {form === 'primary' && <Tools project={project} act={act} />}
    </>
  );
}
