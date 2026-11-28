/** The `household` brick: the desktop's Household setup (pieces/household) on a board, for a household owner. It
 * reads that app's two selections (pieces/household/model.ts); `householdSetup` answers an owner and nobody else,
 * and anyone else is told the setup is unavailable. Tokens and browsers are shown by label and state: loom serves
 * no token's value, and none is shown. Revoking a token and signing a browser out are the desktop's own calls
 * (signin/session-change.ts over `token.revoke` and `sessions.revoke`), asked first. An outside program's grants are
 * saved by `program.setGrants`. What the desktop changes by a message to the agent (a member, an agent's appearance
 * and accounts, a restore) is said so here: the conversation is beside the board. An agent's animated portrait is
 * changed on its row from two files chosen in the brick and sent straight to `household.setPortrait`
 * (./bricks-household-portrait.tsx); the board is told the agent and whether it was uploaded or restored.
 *
 * THE LISTS. Tokens and browsers are drawn live first, thirty at a time; the revoked, expired and signed-out ones are
 * folded behind one heading with their count, thirty at a time once opened. A body's tokens, each bound to one job,
 * are not among the household's others: they are in one fold, 'Job tokens', whose heading counts the running and the
 * ended, opened thirty at a time. One whose job has ended is 'Ended with its job' as loom's read says (sign-in refuses
 * it, src/core/data/authentication.ts `jobTokenCurrent`) and has no Revoke; a running job's token keeps it. Only tokens
 * that can still sign in are counted as active. A search over label, kind and owner filters the rows loom already
 * sent, every list of them, on Enter or Search: its words are this page's state and are never sent, stored or told
 * (`Listed`).
 *
 * MAKING A TOKEN. By the desktop's own door, `POST /api/signin/token` (`/api/signin/program` for an outside program;
 * src/core/signin/shared-links.ts), which answers a current household owner whose browser signed in within the last
 * ten minutes, with the same request as Household setup's Create token. Its answer is read by status first: any 4xx
 * is a refusal and says so; no reply, a 5xx, or a 2xx whose body is not a token is a token that may have been made.
 * The bearer it answers is held in one component's state and drawn once, with Copy and Hide: it is forgotten when the
 * member hides it, when the brick leaves its big form, is drawn again or loom reports another signed-in owner, and
 * when the page reloads. It is never passed to `act`, never written to a log, the address or storage, and never read
 * through the data hook, so no remembered answer holds it. A token loom made is always told to the board by label
 * and kind, whatever happened on the page meanwhile. What the member must still be told when the form cannot say it
 * (a token that may have been made, or one made after the form went away) is kept outside the component, in memory
 * for the page's life, by label and kind (./token-notices.ts), and the board's header row says it (./board-head.tsx).
 * A label here is one word in the shape of a reference (rule 1: a detail holds no sentence), and not one in
 * the shape of a credential (`looksLikeSecretValue`, which `boards.act` refuses by too). */
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { addTokenNotice, seenTokenLabels, settleTokenNotice, tokenKindWords, useTokenNotices } from './token-notices';
import { SECRET_VALUE_WORDS, loomBearer, looksLikeSecretValue } from '../../../src/core/boards/value-shape';
import { useDataQuery } from '../data/graphql';
import { liveAgents } from '../data/live-agents';
import { memberOperation } from '../data/operation';
import { agentOwnership, householdSetupQuery, programLine, programNote, programQuery, sessionLine, setupWords, tokenState, type HouseholdSetup, type ProgramSetupData, type SetupToken } from '../pieces/household/model';
import { sessionChange } from '../signin/session-change';
import { isMember, isRef } from './admin-data';
import { PortraitRow } from './bricks-household-portrait';
import { Action, Actions, AskRow, Chip, Fact, Facts, Field, Fold, Lead, Loading, Menu, Note, Opened, Opens, Problem, Row, Rows, Section, Segmented, State, Time, Unavailable, count, type Act, type BodyProps, type Tone } from './brick-kit';

const agentChip = (id: string) => (isRef(id) ? <Chip key={id} place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span key={id}>{id}</span>);
const memberChip = (id: string) => (isMember(id) ? <Chip key={id} place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip> : <span key={id}>{id}</span>);

const tokenTone = (state: string): Tone => (state === 'Active' ? 'good' : state === 'Expired' ? 'waiting' : 'muted');
/** A token's state as loom's setup read says it (household-read.ts): a body's token whose job has ended is 'Ended with
 * its job', since sign-in refuses it, whatever its own row says. A loom that does not say falls back to the row. */
const STATE_WORDS = { active: 'Active', revoked: 'Revoked', expired: 'Expired', 'ended with its job': 'Ended with its job' } as const;
const stateOf = (token: SetupToken): string => (token.state && STATE_WORDS[token.state]) || tokenState(token);
/** Can this token still sign in? Only these count as active tokens, in the headline too. */
const canSignIn = (token: SetupToken) => stateOf(token) === 'Active';

type Program = ProgramSetupData['tokens'][number];
function Grants({ token, catalogue, busy, save }: { token: Program; catalogue: ProgramSetupData['catalogue']; busy: boolean; save: (input: { fingerprint: string; records: string[]; operations: string[] }) => void }) {
  const [open, setOpen] = useState(false), [records, setRecords] = useState(token.records), [operations, setOperations] = useState(token.operations);
  const toggle = (list: string[], name: string) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
  const group = (label: string, names: string[], chosen: string[], set: (next: string[]) => void) => (
    <div className="board-choice" role="group" aria-label={label}>
      <span className="board-choice-label">{label}</span>
      <Actions>{names.map((name) => <Action key={name} pressed={chosen.includes(name)} disabled={busy || token.ended} onClick={() => set(toggle(chosen, name))}>{name}</Action>)}</Actions>
    </div>
  );
  return (
    <Row title={token.label} meta={<>{programLine(token)}<br />{count(token.records.length, 'record type')} · {count(token.operations.length, 'operation')}</>}
      end={token.ended ? undefined : <Opens open={open} onToggle={() => setOpen(!open)}>Grants</Opens>}>
      {open && !token.ended && (
        <Opened>
          {group('Record types', catalogue.records, records, setRecords)}
          {group('Operations', catalogue.operations, operations, setOperations)}
          <Actions><Action kind="primary" disabled={busy} onClick={() => save({ fingerprint: token.fingerprint, records, operations })}>Save program grants</Action></Actions>
        </Opened>
      )}
    </Row>
  );
}

export function Household({ form, act }: BodyProps) {
  const primary = form === 'primary';
  const feed = useDataQuery<{ householdSetup: HouseholdSetup | null; boxes?: Box[] }>(householdSetupQuery, undefined, { keep: true });
  const programFeed = useDataQuery<{ programSetup: ProgramSetupData | null }>(programQuery, undefined, { keep: true, pause: !primary });
  const [busy, setBusy] = useState(false), [message, say] = useState('');
  const setup = feed.status === 'live' ? feed.data?.householdSetup ?? null : null;
  const programs = primary && programFeed.status === 'live' ? programFeed.data?.programSetup ?? null : null;
  // What a token form could not say itself is kept outside every brick's body (./token-notices.ts) and said once, in
  // the board's header row (./board-head.tsx). Here only the token list is read: the same label seen anew in it ends
  // a notice of unknown fate.
  const notices = useTokenNotices();
  useEffect(() => { if (setup) seenTokenLabels((label) => labelled(setup, programs, label)); }, [setup, programs, notices]);
  if (feed.status === 'loading') return <Loading />;
  if (!setup) return <Unavailable what="household setup" />;
  const agents = liveAgents(setup.agents), removed = setup.agents.filter((agent) => agent.removedAt);
  const tokens = setup.tokens.filter(canSignIn).length, browsers = setup.sessions.filter((session) => !session.ended).length;
  const summary = `${count(setup.members.length, 'member')} · ${count(agents.length, 'agent')}`, access = `${count(tokens, 'active token')} · ${count(browsers, 'signed-in browser')}`;
  if (form === 'compact') return <><p className="board-brief">{summary} · {access}</p></>;
  const change = async (name: 'token.revoke' | 'sessions.revoke' | 'program.setGrants', input: object, report: string) => {
    if (busy) return false;
    setBusy(true); say('');
    try {
      if (name === 'program.setGrants') await memberOperation(name, input);
      else if (await sessionChange(name, input) === 'signed-out') return false;
      act(report, {}); say(setupWords.saved); return true;
    } catch { say(name === 'program.setGrants' ? setupWords.notSaved : setupWords.notRevoked); return false; }
    finally { setBusy(false); }
  };
  if (!primary) return (
    <>
      <Lead>{summary}</Lead>
      <Facts>
        <Fact label="Members">{setup.members.map((member) => <span key={member.id} className="board-household-who">{memberChip(member.id)} {member.role === 'owner' ? 'Household owner' : 'Member'}</span>)}</Fact>
        <Fact label="Agents">{agents.map((agent) => <span key={agent.id} className="board-household-who">{agentChip(agent.id)} {agentOwnership(setup.members, agent.id)}</span>)}</Fact>
      </Facts>
      <Note>Default agent: {setup.defaultAgent ?? 'None'} · {access}</Note>
    </>
  );
  return (
    <>
      <Lead>{summary}</Lead>
      <div className="board-meta"><span>{access}</span></div>
      {message && <p role="status" className="board-note">{message}</p>}
      <Section title="Members" count={setup.members.length}>
        <Rows>
          {setup.members.map((member) => (
            <Row key={member.id} title={memberChip(member.id)} end={<State tone={member.role === 'owner' ? 'working' : 'neutral'}>{member.role === 'owner' ? 'Household owner' : 'Member'}</State>}
              meta={member.fullOwner ? 'Owns every agent, present and future'
                : primary ? (member.agents.length ? <>Owns {member.agents.filter((id) => agents.some((agent) => agent.id === id)).map(agentChip)}</> : 'Owns no agent') : undefined} />
          ))}
        </Rows>
      </Section>
      <Section title="Agents" count={agents.length}>
        <Rows>
          {agents.map((agent) => {
            const end = <span>{agentOwnership(setup.members, agent.id)}</span>;
            const meta = <>{agent.about || 'No description'} · GitHub accounts: {agent.github.join(', ') || 'none'} · {agent.spriteVersion ? 'Animated portrait' : 'Generated face'}</>;
            // An agent whose id a board cannot hold is not offered the change: the board could not be told of it.
            return isRef(agent.id) ? <PortraitRow key={agent.id} agent={agent.id} version={agent.spriteVersion ?? null} title={agentChip(agent.id)} meta={meta} end={end} act={act} />
              : <Row key={agent.id} title={agentChip(agent.id)} end={end} meta={meta} />;
          })}
        </Rows>
        <Note>Default agent: {setup.defaultAgent ?? 'None'}{primary && !!removed.length && <> · Removed: {removed.map((agent) => agent.id).join(', ')}</>}</Note>
      </Section>
      {primary && (
        <Listed title="Tokens" what="token" rows={setup.tokens} live={canSignIn} id={(token) => token.fingerprint}
          fields={(token) => [token.label, token.kind, token.identity]} fieldWords="label, kind or owner" folded="Revoked or expired" none="No tokens"
          apart={{ is: (token) => !!token.forJob, title: 'Job tokens', live: 'running', past: 'ended' }}
          top={<TokenMaker setup={setup} boxes={feed.status === 'live' ? feed.data?.boxes ?? [] : []} programs={programs} act={act} />}
          draw={(token) => {
            const line = <>{token.kind} · {token.identity}<br />Created <Time at={token.createdAt} /> · Last used {token.lastUsedAt ? <Time at={token.lastUsedAt} /> : 'Never'}{token.expiresAt && <> · Expires <Time at={token.expiresAt} /></>}</>;
            const state = <State tone={tokenTone(stateOf(token))}>{stateOf(token)}</State>;
            // A revoked token has nothing to revoke, and neither has a body's token whose job is over: sign-in refuses it.
            return token.revokedAt || (token.forJob && !canSignIn(token)) ? <Row key={token.fingerprint} title={token.label} meta={line} end={state} />
              : <AskRow key={token.fingerprint} title={token.label} meta={line} end={state}
                  asks={{ busy, label: `Revoke token ${token.label}`, ask: 'Revoke token…', yes: 'Revoke it', no: 'Keep it', act: () => change('token.revoke', { fingerprint: token.fingerprint }, 'revokeToken'),
                    children: 'Revoke this token? Whatever uses it stops working, and it cannot be restored.' }} />;
          }} />
      )}
      {primary && (
        <Listed title="Signed-in browsers" what="browser" rows={setup.sessions} live={(session) => !session.ended} id={(session) => session.ref}
          fields={(session) => [session.device, session.isAgent ? 'Agent browser' : 'Browser', session.tokenLabel, session.member]} fieldWords="name, kind or owner" folded="Signed out" none="No browsers"
          draw={(session) => (
            <AskRow key={session.ref} title={session.device} meta={<>{sessionLine(session)} · Last used <Time at={session.seenAt} /></>}
              asks={{ busy, label: `Sign out ${session.device}`, ask: 'Sign out browser…', yes: 'Sign it out', no: 'Keep it', act: () => change('sessions.revoke', { ref: session.ref }, 'revokeSession'),
                children: 'Sign this browser out? It must sign in again.' }} />
          )} />
      )}
      {programs && (
        <Section title="Outside program grants">
          {!programs.tokens.length ? <Note>No outside program tokens yet.</Note>
            : <Rows>{programs.tokens.map((token) => <Grants key={JSON.stringify(token)} token={token} catalogue={programs.catalogue} busy={busy} save={(input) => void change('program.setGrants', input, 'setGrants')} />)}</Rows>}
          <Note>{programNote}</Note>
        </Section>
      )}
      {primary && (
        <>
          <Note>To add or change a member, an agent’s description, badge, face or GitHub accounts, or to restore a removed agent, ask the agent in the conversation: it proposes the change and you answer it in the Inbox.</Note>
        </>
      )}
    </>
  );
}

/** How many of a folded list are drawn at a time. */
export const FOLD_PAGE = 30;
/** The words searched for: every one must be in one of the row's fields, in any case. */
const terms = (typed: string) => typed.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
const matches = (fields: readonly (string | null)[], words: string[]) => {
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((word) => text.includes(word));
};
/** Rows drawn thirty at a time, with Show 30 more until every one is. Drawn anew (its `key`) when the search changes. */
function Paged<T>({ rows, label, id, draw }: { rows: readonly T[]; label: string; id(row: T): string; draw(row: T): ReactNode }) {
  const [shown, setShown] = useState(FOLD_PAGE);
  return (
    <>
      <Rows label={label}>{rows.slice(0, shown).map((row) => <Fragment key={id(row)}>{draw(row)}</Fragment>)}</Rows>
      {rows.length > shown && <Actions><Action kind="quiet" label={`Show ${FOLD_PAGE} more ${label.toLowerCase()}`} onClick={() => setShown(shown + FOLD_PAGE)}>{`Show ${FOLD_PAGE} more`}</Action></Actions>}
    </>
  );
}
/** Rows set apart from the rest in a fold of their own (a body's tokens, bound to one job): its heading counts the
 * live and the past ones, and it opens thirty at a time, the live ones first. */
type Apart<T> = { is(row: T): boolean; title: string; /** What a live one is called in the heading: "running". */ live: string; past: string };
/** A list of tokens or browsers as loom sent it: the live ones first, thirty at a time; the rest (revoked, expired,
 * signed out) folded behind one heading, drawn thirty at a time once it is opened. Rows `apart` says are not among
 * either: they are in one fold of their own. Above them, a search over what is already here, every row of them: what
 * is typed is this component's state, applied on Enter or Search to the rows loom sent, and is never a parameter,
 * never sent, never stored, never in the address and never told to the board (rule 1). */
function Listed<T>({ title, what, rows, live, id, fields, fieldWords, folded, none, top, apart, draw }: { title: string; what: string; rows: readonly T[]; live(row: T): boolean; id(row: T): string;
  fields(row: T): readonly (string | null)[]; /** What is searched, said when nothing matches: "label, kind or owner". */ fieldWords: string; folded: string; none: string; top?: ReactNode; apart?: Apart<T>; draw(row: T): ReactNode }) {
  const [typed, setTyped] = useState(''), [asked, setAsked] = useState(''), [open, setOpen] = useState(false), [openApart, setOpenApart] = useState(false);
  const words = asked ? terms(asked) : [];
  const found = words.length ? rows.filter((row) => matches(fields(row), words)) : rows;
  const own = apart ? found.filter((row) => !apart.is(row)) : found, set = apart ? found.filter(apart.is) : [];
  const current = own.filter(live), past = own.filter((row) => !live(row));
  const setLive = set.filter(live), setPast = set.filter((row) => !live(row));
  const name = `Search ${what}s`;
  const submit = (event: FormEvent) => { event.preventDefault(); setAsked(typed.trim()); };
  return (
    <Section title={title} count={rows.length ? `${current.length} live` : undefined}>
      {top}
      {!rows.length ? <Note>{none}</Note> : (
        <>
          <form className="board-search" role="search" aria-label={name} onSubmit={submit}>
            <input className="board-input" type="search" aria-label={name} placeholder={`${name}…`} maxLength={400} autoComplete="off" value={typed}
              onChange={(event) => { setTyped(event.target.value); if (!event.target.value.trim()) setAsked(''); }} />
            <Action submit disabled={!typed.trim()}>Search</Action>
            {asked && <Action kind="quiet" onClick={() => { setTyped(''); setAsked(''); }}>{`Show every ${what}`}</Action>}
          </form>
          {current.length ? <Paged key={asked} rows={current} label={`Live ${what}s`} id={id} draw={draw} />
            : <Note>{words.length ? `No live ${what} matches.` : `No live ${what}s`}</Note>}
          {!!past.length && (
            <Fold title={`${folded} · ${past.length}`} open={open} onToggle={() => setOpen(!open)}>
              <Paged key={asked} rows={past} label={`${folded} ${what}s`} id={id} draw={draw} />
            </Fold>
          )}
          {apart && !!set.length && (
            <Fold title={`${apart.title} · ${setLive.length} ${apart.live} · ${setPast.length} ${apart.past}`} open={openApart} onToggle={() => setOpenApart(!openApart)}>
              <Paged key={asked} rows={[...setLive, ...setPast]} label={apart.title} id={id} draw={draw} />
            </Fold>
          )}
          {words.length > 0 && !found.length && <Note>{`No ${what} matches. Every word must be in its ${fieldWords}.`}</Note>}
        </>
      )}
    </Section>
  );
}

type Box = { id: string; name: string; revokedAt: string | null };
type Kind = 'member' | 'agent' | 'machine' | 'program';
const KINDS: readonly { value: Kind; label: string }[] = (['member', 'agent', 'machine', 'program'] as const).map((value) => ({ value, label: tokenKindWords[value] }));
/** What a member's, agent's or machine's token is called at the sign-in door. */
const doorKind = { member: 'owner', agent: 'agent', machine: 'runner' } as const;
const LABEL_RULE = 'A label here is one word of up to 120 letters, digits and . _ - : / @, starting with a letter or digit: the board is told it.';
const STALE = 'Sign in again to make a token. This browser signed in more than ten minutes ago, or is an automated one.';
const REFUSED = 'Token creation refused. Check its label and identity.';
const AFTER_WRITE = 'If a token with this label is in the list now, loom made it before it refused: revoke it, because its value was never shown.';
/** How many tokens of this label the lists hold, each token once. */
function labelled(setup: HouseholdSetup, programs: ProgramSetupData | null, label: string) {
  return new Set([...setup.tokens, ...(programs?.tokens ?? [])].filter((token) => token.label === label).map((token) => token.fingerprint)).size;
}

type Answer = { made: string } | { refused: string; /** The door checks the sign-in again after it writes: a 401 or 403 can follow a token it did make. */ unsure?: boolean } | 'unknown';
/** Ask the sign-in door, and read its answer by its status before its body. A 4xx is a refusal; a 400 or 409 made
 * nothing, and a 401 or 403 nearly always made nothing (the door checks the sign-in once more after it writes, so
 * the member is told to look). No reply, a 5xx, or a 2xx whose body is not a token: it may have been made. */
async function ask(url: string, body: object): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch { return 'unknown'; }
  if (response.status >= 400 && response.status < 500) {
    let stale = false;
    if (response.status === 403) {
      try { const result: unknown = await response.json(); stale = !!result && typeof result === 'object' && 'error' in result && result.error === 'Sign in again before making a token'; } catch { /* a refusal all the same */ }
    }
    return { refused: stale ? STALE : REFUSED, ...(response.status === 401 || response.status === 403 ? { unsure: true } : {}) };
  }
  if (!response.ok) return 'unknown';
  try {
    const result: unknown = await response.json();
    const token = !!result && typeof result === 'object' && 'ok' in result && result.ok === true && 'value' in result && !!result.value && typeof result.value === 'object' && 'token' in result.value ? result.value.token : undefined;
    if (typeof token === 'string' && loomBearer.test(token)) return { made: token };
  } catch { /* not readable: below */ }
  return 'unknown';
}

/** A request this form asked and no longer follows: its answer goes to a notice kept outside the form. */
type Asked = { label: string; kind: Kind; had: number; notice: number | null };

/** Household setup's Create token on a board. Everything typed is the form's; the bearer is `bearer` and nothing else. */
function TokenMaker({ setup, boxes, programs, act }: { setup: HouseholdSetup; boxes: Box[]; programs: ProgramSetupData | null; act: Act }) {
  const [open, setOpen] = useState(false), [kind, setKind] = useState<Kind>('member'), [label, setLabel] = useState(''), [who, setWho] = useState(''), [expires, setExpires] = useState('');
  const [records, setRecords] = useState<string[]>([]), [operations, setOperations] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [note, setNote] = useState(''), [bearer, setBearer] = useState('');
  const here = useRef(true), pending = useRef<Asked | null>(null), owner = useRef<string | null>(null);
  /** The form lets go of the request it is waiting on: the member is told, outside the form, it may have been made. */
  const letGo = () => {
    const asked = pending.current;
    if (!asked) return;
    pending.current = null;
    asked.notice = addTokenNotice({ label: asked.label, kind: asked.kind, fate: 'unknown', had: asked.had });
  };
  // Gone while loom was asked (folded, removed, drawn small, another board): the notice outlives the body.
  useEffect(() => { here.current = true; return () => { here.current = false; letGo(); }; }, []);
  // As on the desktop, a token shown or asked for is dropped when loom reports another signed-in owner. A moment with
  // no report (the program setup not read, or its feed between answers) is not a change.
  const signedIn = programs?.owner ?? null;
  useEffect(() => {
    if (owner.current === null || signedIn === null || signedIn === owner.current) return;
    owner.current = null; setBearer(''); setNote('');
    if (pending.current) { letGo(); setBusy(false); }
  }, [signedIn]);
  const choices = kind === 'agent' ? liveAgents(setup.agents).map((a) => ({ value: a.id, label: a.id }))
    : kind === 'machine' ? boxes.filter((box) => !box.revokedAt).map((box) => ({ value: box.id, label: box.name }))
    : setup.members.map((member) => ({ value: member.id, label: member.id }));
  const chosen = choices.some((choice) => choice.value === who) ? who : choices[0]?.value ?? '';
  const toggle = (list: string[], name: string) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
  const make = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || bearer) return;
    if (!isRef(label)) { setProblem(LABEL_RULE); return; }
    // A label that has the shape of a value is refused before anything is sent: the board would be told it.
    if (looksLikeSecretValue(label)) { setProblem(SECRET_VALUE_WORDS); return; }
    if (!chosen) { setProblem('Choose who the token is for.'); return; }
    if (kind === 'program' && !programs) { setProblem('Outside program tokens are unavailable.'); return; }
    setBusy(true); setProblem(''); setNote('');
    const asked: Asked = { label, kind, had: labelled(setup, programs, label), notice: null };
    pending.current = asked; owner.current = signedIn;
    const until = expires.trim() ? { expiresAt: expires.trim() } : {};
    const body = kind === 'program' ? { label, member: chosen, records, operations, ...until }
      : { kind: doorKind[kind], label, [kind === 'agent' ? 'agent' : kind === 'machine' ? 'box' : 'member']: chosen, ...until };
    const answer = await ask(kind === 'program' ? '/api/signin/program' : '/api/signin/token', body);
    // Made: the board is told its label and kind, whatever changed on the page while loom was asked.
    if (typeof answer === 'object' && 'made' in answer) act('token', { label: asked.label, kind: asked.kind });
    if (pending.current !== asked) {
      // The form let go of it: the notice it left says what loom answered. A refusal made nothing, so it ends.
      // A 401 or 403 is the one refusal that can follow a write (see `Answer`): the notice stays as it is.
      if (asked.notice !== null && answer !== 'unknown' && !('refused' in answer && answer.unsure)) settleTokenNotice(asked.notice, 'made' in answer ? 'made' : 'refused');
      return;
    }
    pending.current = null;
    setBusy(false);
    if (answer === 'unknown') { owner.current = null; addTokenNotice({ label: asked.label, kind: asked.kind, fate: 'unknown', had: asked.had }); return; }
    if ('refused' in answer) { owner.current = null; setProblem(answer.refused + (answer.unsure ? ' ' + AFTER_WRITE : '')); return; }
    setBearer(answer.made); setProblem(''); setOpen(false); setLabel(''); setExpires(''); setRecords([]); setOperations([]);
  };
  const copy = () => {
    const failed = () => { if (here.current) setNote('Could not copy. Select the token and copy it.'); };
    // No clipboard outside a secure page: say so rather than doing nothing.
    if (!navigator.clipboard) { failed(); return; }
    navigator.clipboard.writeText(bearer).then(() => { if (here.current) setNote('Copied.'); }, failed);
  };
  if (bearer) return (
    <Section title="New token">
      <Note>Save this token now. It is shown once: it is gone when you hide it, when this brick is drawn again and when the page reloads.</Note>
      <Facts><Fact label="Token" wide><span className="board-household-token font-mono" aria-label="Token value">{bearer}</span></Fact></Facts>
      {note && <p role="status" className="board-note">{note}</p>}
      <Actions>
        <Action kind="primary" onClick={copy}>Copy token</Action>
        <Action kind="quiet" onClick={() => { setBearer(''); setNote(''); setProblem(''); owner.current = null; }}>Hide token</Action>
      </Actions>
    </Section>
  );
  if (!open) return <><Problem>{problem}</Problem><Actions><Action onClick={() => { setOpen(true); setProblem(''); }}>Make a token…</Action></Actions></>;
  const group = (name: string, names: string[], list: string[], set: (next: string[]) => void) => (
    <div className="board-choice" role="group" aria-label={name}>
      <span className="board-choice-label">{name}</span>
      <Actions>{names.map((n) => <Action key={n} pressed={list.includes(n)} disabled={busy} onClick={() => set(toggle(list, n))}>{n}</Action>)}</Actions>
    </div>
  );
  return (
    <form className="board-form" aria-label="Make a token" autoComplete="off" onSubmit={(event) => void make(event)}>
      <Field label="Token label" value={label} onChange={setLabel} disabled={busy} placeholder="pump-laptop" />
      <Segmented label="For" value={kind} options={KINDS.filter((k) => k.value !== 'program' || programs)} disabled={busy} onChange={(next) => { setKind(next); setWho(''); setProblem(''); }} />
      {choices.length ? <Menu label={kind === 'agent' ? 'Agent' : kind === 'machine' ? 'Machine' : 'Member'} value={chosen} options={choices} disabled={busy} onChange={(next) => setWho(String(next))} />
        : <Note>{kind === 'machine' ? 'No active machine.' : kind === 'agent' ? 'No agent.' : 'No member.'}</Note>}
      {kind === 'program' && programs && <>{group('Record types', programs.catalogue.records, records, setRecords)}{group('Operations', programs.catalogue.operations, operations, setOperations)}<Note>{programNote}</Note></>}
      <Field label="Expires (optional ISO time)" value={expires} onChange={setExpires} disabled={busy} />
      <Note>The board is told this token's label and kind, never its value. {LABEL_RULE}</Note>
      <Problem>{problem}</Problem>
      <Actions>
        <Action submit kind="primary" disabled={busy}>{busy ? 'Making…' : 'Make token'}</Action>
        <Action kind="quiet" disabled={busy} onClick={() => { setOpen(false); setProblem(''); }}>Cancel</Action>
      </Actions>
    </form>
  );
}
