/** The `pull` brick: one pull request, read from the same `changes` rows the desktop's Changes reads
 * (web/src/data/work-query.ts) and said in the same words (pieces/change-view/model.ts), with
 * a link to its page on GitHub and, big, the files it touches (`change_files`, kept from the same read of GitHub),
 * each opening in place to its patch (the server's changeFilePatch read, asked once each time a file is opened; the
 * opened files are forgotten when the brick leaves its big form, or its change or head commit changes). Big, it
 * also says when loom last read GitHub (`changeSync`, a household owner's read, as on the desktop), opens on demand
 * loom's reviews of the pull request (the desktop's `changeReviewHistory`), and offers the desktop's Refresh
 * (`/api/changes/refresh`, `changes.refresh`) to the member loom says may use it (`workChangesRefresh`). A merge is
 * answered through its approval, on the desktop. */
import { useRef, useState } from 'react';
import { useDataOnce, useDataQuery } from '../data/graphql';
import { useWorkAccess } from '../data/work-approvals';
import { refreshChanges, RefreshError } from '../data/work-refresh';
import { checksWord, checkWord, mergeableWord, reviewWord, roleWord, stateWord, summary, waitingWord, type Change, type ChangeSnapshot, type ReviewRound } from '../pieces/change-view/model';
import { Action, Chip, Fact, Facts, Fold, Lead, Loading, Note, Opened, Opens, Problem, Row, Rows, Section, State, Time, Unavailable, ticketChip, useOwnFlag, words, type Act, type Params, type Raise, type Tone } from './brick-kit';
import type { Form } from './layout';

type Row = Pick<Change, 'id' | 'repository' | 'number' | 'url' | 'title' | 'state' | 'draft' | 'authorLogin' | 'project' | 'agent' | 'branch' | 'headCommit' | 'baseBranch' | 'checks' | 'review' | 'mergeable' | 'waitingOn'>;
type Read = {
  changes: Row[];
  changeChecks: ChangeSnapshot['checks'][number][];
  changePeople: ChangeSnapshot['people'][number][];
  changeFiles: { change: string; path: string; additions: number; deletions: number }[];
  changeTasks: { change: string; task: string; taskRow: { id: string; title: string; status: string } | null }[];
  /** When loom last read GitHub: a household owner's read (one row), empty for anyone else. */
  changeSync?: NonNullable<ChangeSnapshot['sync']>[];
};
/** The fields of the desktop's ChangesView selection, for one change. */
export const pullQuery = `query BrickPull($id:String!){
  changes(where:{id:{eq:$id}},limit:1){id repository number url title state draft authorLogin project agent branch headCommit baseBranch checks review mergeable waitingOn}
  changeChecks(where:{change:{eq:$id}}){change name state}
  changePeople(where:{change:{eq:$id}}){change login role}
  changeTasks(where:{change:{eq:$id}}){change task taskRow{id title status}}
  changeFiles(where:{change:{eq:$id}}){change path additions deletions}
  changeSync{readAt failed nextAt}
}`;

/** Open, draft, merged or closed: the stored state, with a draft said as one. */
export const pullState = (c: Pick<Change, 'state' | 'draft'>) => (c.state === 'open' && c.draft ? 'Draft' : stateWord[c.state] ?? c.state);
const tone = (c: Pick<Change, 'state' | 'draft' | 'waitingOn'>): Tone => (c.state === 'merged' ? 'good' : c.state !== 'open' || c.draft ? 'muted' : c.waitingOn === 'you' ? 'waiting' : 'working');
/** The pull request's own page on GitHub, and only a GitHub address: anything else draws no link. */
export const pullHref = (url: string | null | undefined) => (url && /^https:\/\/github\.com\/[^\s]+$/.test(url) ? url : null);
const checkTone = (state: string): Tone => (state === 'failing' ? 'bad' : state === 'passing' ? 'good' : state === 'running' ? 'working' : 'muted');
/** What the brick marks itself for: it was merged, it was closed, or its checks went to failing. */
export function pullFlag(was: string, now: string): string | null {
  const [state, checks] = now.split('|'), [stateBefore, checksBefore] = was.split('|');
  if (state !== stateBefore) return state === 'merged' ? 'Merged' : state === 'closed' ? 'Closed' : null;
  return checks !== checksBefore && checks === 'failing' ? 'Checks failing' : null;
}

/** One changed file's patch, read from GitHub by the server when asked (docs/specs/boards.md). Not a live read. */
export const filePatchQuery = 'query BrickPullFilePatch($change:String!,$path:String!){patch:changeFilePatch(change:$change,path:$path){state patch cut}}';
type Patch = { state: 'patch' | 'none' | 'unlisted' | 'unavailable'; patch: string | null; cut: boolean };
/** What the brick says where there is no patch to draw, by the read's state. */
export const noPatchWords: Record<Exclude<Patch['state'], 'patch'>, string> = {
  none: 'GitHub has no patch for this file: it may be binary, too large for GitHub to show, renamed with no change in it, or empty.',
  unlisted: 'GitHub does not list this file for the pull request just now: it may have changed since. Close the file and open it again in a moment.',
  unavailable: 'GitHub could not be read for this file. Close the file and open it again to try again.',
};
/** How a line of a patch is marked: added, removed, a hunk's header, or context (none). Its sign stays in its words. */
export const patchLine = (line: string) => (line.startsWith('@@') ? 'board-patch-hunk' : line.startsWith('+') ? 'board-patch-add' : line.startsWith('-') ? 'board-patch-remove' : undefined);
/** The patch of one file, asked for when its row is opened. Drawn as plain text, a line at a time: nothing in it is
 * read as markup or a link. */
function FilePatch({ change, path }: { change: string; path: string }) {
  const read = useDataOnce<{ patch: Patch | null }>(filePatchQuery, { change, path });
  if (read.status === 'loading') return <Loading />;
  const p = read.status === 'live' ? read.data?.patch : undefined;
  if (read.status !== 'live' || !p) return <Note>This file's patch could not be read. Close the file and open it again to try again.</Note>;
  if (p.state !== 'patch' || p.patch === null) return <Note>{noPatchWords[p.state === 'patch' ? 'unavailable' : p.state] ?? noPatchWords.unavailable}</Note>;
  return (
    <>
      {/* It scrolls sideways where a line is longer than the placement, so the keyboard can reach it. */}
      <pre className="board-patch" role="region" aria-label={'Patch of ' + path}><code>{p.patch.split('\n').map((line, i) => <span key={i} className={patchLine(line)}>{line + '\n'}</span>)}</code></pre>
      {p.cut && <Note>Only the first 200 KB of this patch is shown. The whole of it is on GitHub.</Note>}
    </>
  );
}

/** The desktop's read of a pull request's cold reviews (web/src/data/work-views.tsx). Asked only while the brick's
 * "Loom's reviews" is opened, and live while it is. */
export const reviewHistoryQuery = 'query ChangeReviewHistory($change: String!) { changeReviewHistory(change: $change) { change job headCommit tier round verdict findings } }';
/** A round's verdict in the desktop's words. */
export const verdictWord = (v: ReviewRound['verdict']) => (v === null ? 'Pending' : v === 'NONE' ? 'No verdict' : v === 'CLEAR' ? 'Clear' : 'Blocking');
const verdictTone = (v: ReviewRound['verdict']): Tone => (v === null ? 'working' : v === 'CLEAR' ? 'good' : v === 'BLOCKING' ? 'bad' : 'muted');
function ReviewHistory({ change, head }: { change: string; head: string }) {
  const read = useDataQuery<{ changeReviewHistory: ReviewRound[] }>(reviewHistoryQuery, { change });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live') return <Note>Loom's reviews are unavailable. Close them and open them again to try again.</Note>;
  const rounds = (read.data?.changeReviewHistory ?? []).filter((r) => r.change === change);
  if (!rounds.length) return <Note>Loom has not reviewed it.</Note>;
  return (
    <Rows label="Loom's reviews" beside>{rounds.map((r) => (
      <Row key={r.job} title={`Round ${r.round} · ${r.tier}`} end={<State tone={verdictTone(r.verdict)}>{verdictWord(r.verdict)}</State>}
        meta={<>{r.headCommit === head ? 'Current commit' : 'Earlier commit'} <span className="font-mono">{r.headCommit.slice(0, 7)}</span></>}>
        {r.findings ? <Facts><Fact wide label="Findings"><pre className="board-tail">{r.findings}</pre></Fact></Facts> : undefined}
      </Row>
    ))}</Rows>
  );
}

/** What the brick says after a press of Read GitHub again, by how it ended. */
export const refreshWords = {
  done: 'Loom has read GitHub again.',
  refused: 'Loom refused: only a household owner may have it read GitHub again.',
  failed: 'GitHub could not be read just now. Try again in a moment.',
} as const;
type Refreshing = 'idle' | 'pending' | keyof typeof refreshWords;
/** The desktop's Refresh, for the member loom says may use it (the desktop's own rule, `useWorkAccess`). One press is
 * one request; a second press while it runs is dropped. */
function Refresh({ act, readAt, failed }: { act: Act; /** When loom last read GitHub, where the member may know. */ readAt?: string | null; /** That last read failed. */ failed?: boolean }) {
  const access = useWorkAccess();
  const [state, setState] = useState<Refreshing>('idle');
  const lock = useRef(false);
  if (!access.refresh && state === 'idle' && !readAt && !failed) return null;
  async function press() {
    if (lock.current) return;
    lock.current = true; setState('pending');
    try { await refreshChanges(); setState('done'); act('refresh', {}); }
    catch (error) { setState(error instanceof RefreshError && error.status === 403 ? 'refused' : 'failed'); }
    finally { lock.current = false; }
  }
  return (
    <>
      {state === 'done' && <Note data-refresh="done">{refreshWords.done}</Note>}
      {(state === 'refused' || state === 'failed') && <Problem>{refreshWords[state]}</Problem>}
      {(readAt || failed || access.refresh) && (
        <div className="board-foot">
          {readAt && <span>Last read from GitHub <Time at={readAt} /></span>}
          {failed && <span>The last read failed: this is the copy from before it.</span>}
          {access.refresh && <Action kind="quiet" disabled={state === 'pending'} onClick={() => void press()}>{state === 'pending' ? 'Reading GitHub…' : 'Read GitHub again'}</Action>}
        </div>
      )}
    </>
  );
}

export function Pull({ params, form, act, raise }: { params: Params; form: Form; act: Act; raise: Raise }) {
  const id = words(params.change);
  const read = useDataQuery<Read>(pullQuery, { id }, { keep: true });
  const c = read.data?.changes[0];
  // The opened files belong to one change at one head commit, in the big form. Leaving the big form, or a new change
  // or head, forgets them before anything is drawn, so nothing is asked again without being opened, and no patch
  // stays open on an older head than the files listed beside it.
  const scope = form === 'primary' && c ? JSON.stringify([c.id, c.headCommit]) : null;
  const [opened, setOpened] = useState<{ scope: string | null; paths: readonly string[]; review?: boolean }>({ scope, paths: [] });
  if (opened.scope !== scope) setOpened({ scope, paths: [] });
  const paths = opened.scope === scope ? opened.paths : [];
  const reviewOpen = opened.scope === scope && !!opened.review;
  const toggle = (path: string) => setOpened((now) => ({ scope, paths: now.scope !== scope ? [path] : now.paths.includes(path) ? now.paths.filter((p) => p !== path) : [...now.paths, path], review: now.scope === scope && now.review }));
  const toggleReview = () => setOpened((now) => (now.scope !== scope ? { scope, paths: [], review: true } : { ...now, review: !now.review }));
  useOwnFlag(c && `${c.state}|${c.checks}`, raise, pullFlag);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !c) return <Unavailable what="pull request" />;
  if (form === 'compact') return <p className="board-brief"><State tone={tone(c)}>{pullState(c)}</State> {c.state === 'open' ? <><b>{waitingWord(c)}</b> · </> : null}#{c.number} {c.title}</p>;
  // A linked ticket is shown only when the member may read the ticket itself, as the desktop does.
  const tickets = (read.data?.changeTasks ?? []).flatMap((link) => (link.taskRow && link.taskRow.id === link.task ? [link.taskRow] : []));
  const checks = [...(read.data?.changeChecks ?? [])].sort((a, b) => a.state.localeCompare(b.state));
  const people = read.data?.changePeople ?? [];
  const files = [...(read.data?.changeFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const sync = read.data?.changeSync?.[0];
  return (
    <>
      <Lead>{c.title}</Lead>
      <div className="board-meta">
        <State tone={tone(c)}>{pullState(c)}</State>
        {form === 'primary' && <span className="font-mono">#{c.number}</span>}
        <Chip place={{ brick: 'repository', params: { repository: c.repository } }}>{c.repository}</Chip>
        {c.project && <Chip place={{ brick: 'project', params: { project: c.project } }}>{c.project}</Chip>}
        {c.agent && <Chip place={{ brick: 'agent', params: { agent: c.agent } }}>{c.agent}</Chip>}
        {form === 'side' && tickets.map((t) => <span key={t.id} title={t.title}>{ticketChip(t.id)}</span>)}
      </div>
      <Note>{summary(c)}</Note>
      {pullHref(c.url) && <Note><a href={pullHref(c.url)!} target="_blank" rel="noopener noreferrer">Open on GitHub</a></Note>}
      {form === 'primary' && (
        <>
          <Facts>
            <Fact label="Branch"><span><span className="font-mono">{c.branch}</span> into <span className="font-mono">{c.baseBranch}</span>, opened by {c.authorLogin}</span></Fact>
            <Fact label="Checks"><span className="board-pull-list"><span>{checksWord[c.checks] ?? c.checks}</span>{checks.map((k) => <State key={k.name} tone={checkTone(k.state)}>{checkWord[k.state] ?? k.state}: {k.name}</State>)}</span></Fact>
            <Fact label="Review">{reviewWord[c.review] ?? c.review}</Fact>
            <Fact label="Can be merged">{mergeableWord[c.mergeable] ?? c.mergeable}</Fact>
            {people.length > 0 && <Fact label="People on it"><span className="board-pull-list">{people.map((p) => <span key={p.login + ':' + p.role}>{roleWord[p.role] ?? p.role}: {p.login}</span>)}</span></Fact>}
            {c.state === 'open' && c.waitingOn === 'you' && <Fact label="Merge"><span className="board-note">The merge is answered in Changes on the desktop.</span></Fact>}
          </Facts>
          <Section title="Files changed" count={files.length || undefined}>
            {files.length > 0
              ? <Rows label="Files changed" beside>{files.map((f) => (
                  <Row key={f.path} title={<Opens open={paths.includes(f.path)} onToggle={() => toggle(f.path)}><span className="font-mono">{f.path}</span></Opens>} end={<span className="font-mono">+{f.additions} −{f.deletions}</span>}>
                    {paths.includes(f.path) ? <Opened><FilePatch change={c.id} path={f.path} /></Opened> : undefined}
                  </Row>
                ))}</Rows>
              : <Note>Which files it changes is not known yet.</Note>}
          </Section>
          {tickets.length > 0 && (
            <Section title="Tickets">
              <Rows>{tickets.map((t) => <Row key={t.id} place={{ brick: 'ticket', params: { ticket: t.id } }} title={<>{t.title} <span className="font-mono board-row-ref">{t.id}</span></>} />)}</Rows>
            </Section>
          )}
          <Fold title="Loom's reviews" open={reviewOpen} onToggle={toggleReview}><ReviewHistory change={c.id} head={c.headCommit} /></Fold>
          <Refresh act={act} readAt={sync?.readAt} failed={!!sync?.failed} />
        </>
      )}
    </>
  );
}
