/** The `ticket` brick's history, brought over from the desktop's ticket reader (web/src/pieces/tasks/index.tsx) with
 * the desktop's own reads: its pull requests, as `pull` chips (they come with the ticket's own read, `changeTasksByTask`,
 * so they add no read of their own); the conversation it was filed from (`taskSourceQuery`'s
 * `conversationsSingle`, asked once); its reviews, loom's rounds (`taskReviewHistory`) and GitHub's
 * (`taskGithubReviews`, thirty a page); and its story, the agents' activity posts about it (`ticketActivityPosts`,
 * thirty a page). Reviews and the story are read only when the member opens them, and each page once, when it is
 * asked for: none of them is a live read (docs/specs/boards.md, "Live reads and their cost"). */
import { useState, type ReactNode } from 'react';
import { useDataOnce } from '../data/graphql';
import { Reply } from '../pair/reply';
import { Action, Actions, Chip, Fact, Fold, Loading, Note, Row, Rows, State, Time, actorChip, type Tone } from './brick-kit';
import { threadPath } from './agents-data';

/** A pull request linked to the ticket, as the ticket's own read holds it. A link the member may not read has no row. */
export type TicketChange = { changeRow: { id: string; number: number; title: string; state: string; draft: boolean } | null };
/** The fields the ticket's read adds for its history (./bricks-ticket-edit.tsx, ticketMoreQuery). */
export const ticketHistoryFields = 'sourceKind sourceId changeTasksByTask{changeRow{id number title state draft}}';

/** A change's id as a board can hold it (src/core/boards/bricks/kit.ts, `change`). One in any other shape is drawn
 * as its number, with no chip. */
const changeRef = /^github:[a-z0-9._-]+\/[a-z0-9._-]+#[1-9]\d*$/;
const changeTone = (c: { state: string; draft: boolean }): Tone => (c.state === 'merged' ? 'good' : c.state === 'closed' ? 'muted' : c.draft ? 'muted' : 'working');
const changeWord = (c: { state: string; draft: boolean }) => (c.state === 'open' && c.draft ? 'draft' : c.state);
const changeChip = (c: { id: string; number: number }, label: ReactNode) => (changeRef.test(c.id)
  ? <Chip key={c.id} place={{ brick: 'pull', params: { change: c.id } }}>{label}</Chip> : <span key={c.id}>{label}</span>);
const rows = (links: TicketChange[] | undefined) => (links ?? []).flatMap((l) => (l.changeRow ? [l.changeRow] : []));

/** The ticket's pull requests: in a small form, one quiet line of chips by number; big, each with its title and state. */
export function TicketPulls({ links, big }: { links: TicketChange[] | undefined; big: boolean }) {
  const changes = rows(links);
  if (!changes.length) return null;
  if (!big) return <span className="board-linked" data-ticket-pulls=""><span>Pull requests</span>{changes.map((c) => changeChip(c, '#' + c.number))}</span>;
  return (
    <Fact label="Pull requests">
      {changes.map((c) => <span key={c.id} className="board-linked" data-ticket-pulls="">{changeChip(c, '#' + c.number)} {c.title} <State tone={changeTone(c)}>{changeWord(c)}</State></span>)}
    </Fact>
  );
}

/** The desktop's read of the conversation a ticket was filed from (web/src/pieces/tasks/query.ts, taskSourceQuery). */
export const ticketSourceQuery = `query BrickTicketSource($id:String!){source:conversationsSingle(where:{id:{eq:$id}}){id venue place}}`;
type Source = { id: string; venue: string; place: string };
/** Where the ticket was filed from (a ticket whose source is a conversation), in the primary form: a link to the thread for one of the app's own
 * conversations, a `session` chip for a handed-off session, and the venue's name for any other. Asked once, as
 * the conversation it names never changes; one the member may not read is not drawn. */
export function TicketSource({ id }: { id: string }) {
  const read = useDataOnce<{ source: Source | null }>(ticketSourceQuery, { id });
  const s = read.status === 'live' ? read.data?.source : null;
  if (!s || s.id !== id) return null;
  const where = s.venue === 'loom' || s.venue === 'terminal'
    ? <a href={threadPath(s.place)}>Open the conversation it was filed from</a>
    : s.venue === 'handoff' ? <Chip place={{ brick: 'session', params: { session: s.id } }}>The session it was filed from</Chip>
    : <span>A conversation on {s.venue}</span>;
  return <Fact label="Filed from"><span data-ticket-source="">{where}</span></Fact>;
}

/** One section the member opens before anything in it is read. Closing it forgets what was read. */
function OnDemand({ title, children }: { title: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Fold title={title} open={open} onToggle={() => setOpen(!open)}>{open && children()}</Fold>;
}

/** Pages of a read asked thirty-one at a time, newest first: thirty are drawn and the thirty-first says there are
 * more. The first page is read when this is drawn; each further one when the member asks for it, once. */
function Pages<C>({ first, older, page }: { first: C; /** The control's words: "Older posts". */ older: string; page: (cursor: C, more: (next: C) => ReactNode) => ReactNode }) {
  const [cursors, setCursors] = useState<C[]>([first]);
  const more = (at: number) => (next: C) => (at === cursors.length - 1
    ? <Actions><Action kind="quiet" onClick={() => setCursors([...cursors, next])}>{older}</Action></Actions> : null);
  return <>{cursors.map((c, i) => <div key={i}>{page(c, more(i))}</div>)}</>;
}

const PAGE = 30;
export const ticketPostsQuery = 'query BrickTicketPosts($task:String!,$before:String!){posts:ticketActivityPosts(task:$task,before:$before,limit:31){task id at agent thread words}}';
type Post = { task: string; id: string; at: string; agent: string; thread: string; words: string };
function PostPage({ ticket, before, more }: { ticket: string; before: string; more: (next: string) => ReactNode }) {
  const read = useDataOnce<{ posts: Post[] | null }>(ticketPostsQuery, { task: ticket, before });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live') return <Note>Its story is unavailable. Close it and open it again to try again.</Note>;
  const posts = (read.data?.posts ?? []).filter((p) => p.task === ticket);
  if (!posts.length) return <Note>{before === '0' ? 'No agent has posted about this ticket.' : 'There is nothing older.'}</Note>;
  return (
    <>
      <Rows label="Ticket story" beside>{posts.slice(0, PAGE).map((p) => (
        <Row key={p.id} title={actorChip('agent', p.agent)} end={<Time at={p.at} />}><Reply words={p.words} /></Row>
      ))}</Rows>
      {posts.length > PAGE && more(posts[PAGE - 1].id)}
    </>
  );
}
/** The ticket's story: what agents posted about it, newest first, read only once the member opens it. */
export function TicketStory({ ticket }: { ticket: string }) {
  return (
    <div data-ticket-story="">
      <OnDemand title="Story">{() => <Pages first="0" older="Older posts" page={(before, more) => <PostPage ticket={ticket} before={before} more={more} />} />}</OnDemand>
    </div>
  );
}

export const ticketRoundsQuery = 'query BrickTicketRounds($task:String!){rounds:taskReviewHistory(task:$task){change job headCommit tier round requestedAt completedAt verdict findings}}';
export const ticketGithubReviewsQuery = 'query BrickTicketGithubReviews($task:String!,$at:String,$id:String){reviews:taskGithubReviews(task:$task,beforeAt:$at,beforeId:$id){id change login submittedAt state headCommit body url}}';
type Round = { change: string; job: string; headCommit: string; tier: string; round: number; requestedAt: string; completedAt: string | null; verdict: string | null; findings: string | null };
type GithubReview = { id: string; change: string; login: string | null; submittedAt: string; state: string; headCommit: string | null; body: string; url: string };
type Cursor = { at: string | null; id: string | null };
/** A round's verdict in the pull brick's words (bricks-pull.tsx, verdictWord): one word for one thing on both
 * bricks (Jonathan, 2026-11-28). GitHub's states keep the desktop's words. */
const roundWord = (r: Round) => (!r.completedAt ? 'Pending' : r.verdict === 'CLEAR' ? 'Clear' : r.verdict === 'BLOCKING' ? 'Blocking' : 'No verdict');
const roundTone = (r: Round): Tone => (!r.completedAt ? 'working' : r.verdict === 'CLEAR' ? 'good' : r.verdict === 'BLOCKING' ? 'bad' : 'muted');
const githubWords: Record<string, [string, Tone]> = { APPROVED: ['approved', 'good'], CHANGES_REQUESTED: ['requested changes', 'bad'], COMMENTED: ['commented', 'neutral'], DISMISSED: ['review dismissed', 'muted'] };
const githubHref = (url: string) => (url.startsWith('https://github.com/') ? url : null);

function Rounds({ ticket, changes }: { ticket: string; changes: Map<string, number> }) {
  const read = useDataOnce<{ rounds: Round[] | null }>(ticketRoundsQuery, { task: ticket });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live') return <Note>Loom's reviews are unavailable. Close them and open them again to try again.</Note>;
  const rounds = (read.data?.rounds ?? []).filter((r) => changes.has(r.change)).reverse();
  if (!rounds.length) return <Note>Loom has not reviewed its pull requests.</Note>;
  return (
    <Rows label="Loom's reviews" beside>{rounds.map((r) => (
      <Row key={r.job} title={`Round ${r.round} · #${changes.get(r.change)} · ${r.headCommit.slice(0, 8)}`}
        end={<><State tone={roundTone(r)}>{roundWord(r)}</State><Time at={r.completedAt ?? r.requestedAt} /></>}>
        {r.findings ? <Reply words={r.findings} /> : undefined}
      </Row>
    ))}</Rows>
  );
}
function GithubPage({ ticket, before, more }: { ticket: string; before: Cursor; more: (next: Cursor) => ReactNode }) {
  const read = useDataOnce<{ reviews: GithubReview[] | null }>(ticketGithubReviewsQuery, { task: ticket, at: before.at, id: before.id });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live') return <Note>GitHub's reviews are unavailable. Close them and open them again to try again.</Note>;
  const reviews = read.data?.reviews ?? [];
  if (!reviews.length) return <Note>{before.id === null ? 'No one has reviewed its pull requests on GitHub.' : 'There is nothing older.'}</Note>;
  return (
    <>
      <Rows label="GitHub reviews" beside>{reviews.slice(0, PAGE).map((r) => {
        const [word, tone] = githubWords[r.state] ?? [r.state.toLowerCase(), 'neutral' as Tone], href = githubHref(r.url);
        return (
          <Row key={r.id} title={r.login ?? 'GitHub reviewer'} end={<><State tone={tone}>{word}</State><Time at={r.submittedAt} /></>}>
            {r.body && <Reply words={r.body} />}
            {href && <Note><a href={href} target="_blank" rel="noopener noreferrer">Open on GitHub</a></Note>}
          </Row>
        );
      })}</Rows>
      {reviews.length > PAGE && more({ at: reviews[PAGE - 1].submittedAt, id: reviews[PAGE - 1].id })}
    </>
  );
}
/** The ticket's reviews, loom's rounds and then GitHub's, newest first: only for a ticket with a pull request the
 * member may read, as the desktop does, and read only once the member opens them. */
export function TicketReviews({ ticket, links }: { ticket: string; links: TicketChange[] | undefined }) {
  const changes = new Map(rows(links).map((c) => [c.id, c.number]));
  if (!changes.size) return null;
  return (
    <div data-ticket-reviews="">
      <OnDemand title="Reviews">{() => (
        <>
          <Rounds ticket={ticket} changes={changes} />
          <Pages<Cursor> first={{ at: null, id: null }} older="Older GitHub reviews" page={(before, more) => <GithubPage ticket={ticket} before={before} more={more} />} />
        </>
      )}</OnDemand>
    </div>
  );
}
