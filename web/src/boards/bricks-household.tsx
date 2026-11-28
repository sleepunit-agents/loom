/** The `household` brick: the desktop's Household setup (pieces/household) on a board, for a household owner. It
 * reads that app's two selections (pieces/household/model.ts); `householdSetup` answers an owner and nobody else,
 * and anyone else is told the setup is unavailable. Tokens and browsers are shown by label and state: loom serves
 * no token's value, and none is shown. Revoking a token and signing a browser out are the desktop's own calls
 * (signin/session-change.ts over `token.revoke` and `sessions.revoke`), asked first. An outside program's grants are
 * saved by `program.setGrants`. What the desktop changes by a message to the agent (a member, an agent's appearance
 * and accounts, a restore) is said so here: the conversation is beside the board. A portrait is two chosen files read
 * in the browser and is left to the desktop.
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
 * for the page's life, by label and kind (./token-notices.ts), and every household brick drawn afterwards shows it.
 * A label here is one word in the shape of a reference (rule 1: a detail holds no sentence), and not one in
 * the shape of a credential (`looksLikeSecretValue`, which `boards.act` refuses by too). */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { addTokenNotice, dismissTokenNotice, seenTokenLabels, settleTokenNotice, useTokenNotices, type TokenNotice } from './token-notices';
import { SECRET_VALUE_WORDS, loomBearer, looksLikeSecretValue } from '../../../src/core/boards/value-shape';
import { useDataQuery } from '../data/graphql';
import { liveAgents } from '../data/live-agents';
import { memberOperation } from '../data/operation';
import { agentOwnership, householdSetupQuery, programLine, programNote, programQuery, sessionLine, setupWords, tokenState, type HouseholdSetup, type ProgramSetupData } from '../pieces/household/model';
import { sessionChange } from '../signin/session-change';
import { isMember, isRef } from './admin-data';
import { Action, Actions, AskRow, Chip, Fact, Facts, Field, Lead, Loading, Menu, Note, Opened, Opens, Problem, Row, Rows, Section, Segmented, State, Time, Unavailable, count, type Act, type BodyProps, type Tone } from './brick-kit';

const agentChip = (id: string) => (isRef(id) ? <Chip key={id} place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span key={id}>{id}</span>);
const memberChip = (id: string) => (isMember(id) ? <Chip key={id} place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip> : <span key={id}>{id}</span>);

const tokenTone = (state: string): Tone => (state === 'Active' ? 'good' : state === 'Expired' ? 'waiting' : 'muted');

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
  // What a token form could not say itself, kept outside every brick's body (./token-notices.ts): shown in every form.
  const notices = useTokenNotices(), notice = <TokenNotices notices={notices} />;
  // The same label seen anew in the token list ends a notice of unknown fate.
  useEffect(() => { if (setup) seenTokenLabels((label) => labelled(setup, programs, label)); }, [setup, programs, notices]);
  if (feed.status === 'loading') return <>{notice}<Loading /></>;
  if (!setup) return <>{notice}<Unavailable what="household setup" /></>;
  const agents = liveAgents(setup.agents), removed = setup.agents.filter((agent) => agent.removedAt);
  const tokens = setup.tokens.filter((token) => tokenState(token) === 'Active').length, browsers = setup.sessions.filter((session) => !session.ended).length;
  const summary = `${count(setup.members.length, 'member')} · ${count(agents.length, 'agent')}`, access = `${count(tokens, 'active token')} · ${count(browsers, 'signed-in browser')}`;
  if (form === 'compact') return <>{notice}<p className="board-brief">{summary} · {access}</p></>;
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
      {notice}
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
      {notice}
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
          {agents.map((agent) => (
            <Row key={agent.id} title={agentChip(agent.id)} end={<span>{agentOwnership(setup.members, agent.id)}</span>}
              meta={primary ? <>{agent.about || 'No description'} · GitHub accounts: {agent.github.join(', ') || 'none'} · {agent.spriteVersion ? 'Animated portrait' : 'Generated face'}</> : undefined} />
          ))}
        </Rows>
        <Note>Default agent: {setup.defaultAgent ?? 'None'}{primary && !!removed.length && <> · Removed: {removed.map((agent) => agent.id).join(', ')}</>}</Note>
      </Section>
      {primary && (
        <Section title="Tokens" count={setup.tokens.length || undefined}>
          {!setup.tokens.length ? <Note>No tokens</Note> : (
            <Rows>
              {setup.tokens.map((token) => {
                const line = <>{token.kind} · {token.identity}<br />Created <Time at={token.createdAt} /> · Last used {token.lastUsedAt ? <Time at={token.lastUsedAt} /> : 'Never'}{token.expiresAt && <> · Expires <Time at={token.expiresAt} /></>}</>;
                const state = <State tone={tokenTone(tokenState(token))}>{tokenState(token)}</State>;
                return token.revokedAt ? <Row key={token.fingerprint} title={token.label} meta={line} end={state} />
                  : <AskRow key={token.fingerprint} title={token.label} meta={line} end={state}
                      asks={{ busy, label: `Revoke token ${token.label}`, ask: 'Revoke token…', yes: 'Revoke it', no: 'Keep it', act: () => change('token.revoke', { fingerprint: token.fingerprint }, 'revokeToken'),
                        children: 'Revoke this token? Whatever uses it stops working, and it cannot be restored.' }} />;
              })}
            </Rows>
          )}
          <TokenMaker setup={setup} boxes={feed.status === 'live' ? feed.data?.boxes ?? [] : []} programs={programs} act={act} />
        </Section>
      )}
      {primary && (
        <Section title="Signed-in browsers" count={setup.sessions.length || undefined}>
          {!setup.sessions.length ? <Note>No browsers</Note> : (
            <Rows>
              {setup.sessions.map((session) => (
                <AskRow key={session.ref} title={session.device} meta={<>{sessionLine(session)} · Last used <Time at={session.seenAt} /></>}
                  asks={{ busy, label: `Sign out ${session.device}`, ask: 'Sign out browser…', yes: 'Sign it out', no: 'Keep it', act: () => change('sessions.revoke', { ref: session.ref }, 'revokeSession'),
                    children: 'Sign this browser out? It must sign in again.' }} />
              ))}
            </Rows>
          )}
        </Section>
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
          <Note>An agent’s animated portrait is changed on the desktop.</Note>
        </>
      )}
    </>
  );
}

type Box = { id: string; name: string; revokedAt: string | null };
type Kind = 'member' | 'agent' | 'machine' | 'program';
const KINDS: readonly { value: Kind; label: string }[] = [{ value: 'member', label: 'Household member' }, { value: 'agent', label: 'Agent' }, { value: 'machine', label: 'Machine' }, { value: 'program', label: 'Outside program' }];
/** What a member's, agent's or machine's token is called at the sign-in door. */
const doorKind = { member: 'owner', agent: 'agent', machine: 'runner' } as const;
const LABEL_RULE = 'A label here is one word of up to 120 letters, digits and . _ - : / @, starting with a letter or digit: the board is told it.';
const STALE = 'Sign in again to make a token. This browser signed in more than ten minutes ago, or is an automated one.';
const REFUSED = 'Token creation refused. Check its label and identity.';
const kindWords = (kind: string) => KINDS.find((k) => k.value === kind)?.label ?? kind;
/** The words of a notice: a token that may have been made, or one made whose value cannot be shown. */
const noticeWords = (notice: TokenNotice) => (notice.fate === 'unknown'
  ? `Token creation for “${notice.label}” (${kindWords(notice.kind)}) may have completed. Check its label in the token list and revoke it before trying again.`
  : `Token “${notice.label}” (${kindWords(notice.kind)}) was made after its form went away, so its value cannot be shown. Revoke it if you did not save it, and make another.`);
function TokenNotices({ notices }: { notices: readonly TokenNotice[] }) {
  return <>{notices.map((notice) => (
    <div key={notice.id}><Problem>{noticeWords(notice)}</Problem><Actions><Action kind="quiet" label={`Dismiss the notice for ${notice.label}`} onClick={() => dismissTokenNotice(notice.id)}>Dismiss</Action></Actions></div>
  ))}</>;
}
/** How many tokens of this label the lists hold, each token once. */
function labelled(setup: HouseholdSetup, programs: ProgramSetupData | null, label: string) {
  return new Set([...setup.tokens, ...(programs?.tokens ?? [])].filter((token) => token.label === label).map((token) => token.fingerprint)).size;
}

type Answer = { made: string } | { refused: string } | 'unknown';
/** Ask the sign-in door, and read its answer by its status before its body. Any 4xx made nothing: a refusal. No
 * reply, a 5xx, or a 2xx whose body is not a token: it may have been made. */
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
    return { refused: stale ? STALE : REFUSED };
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
      if (asked.notice !== null && answer !== 'unknown') settleTokenNotice(asked.notice, 'made' in answer ? 'made' : 'refused');
      return;
    }
    pending.current = null;
    setBusy(false);
    if (answer === 'unknown') { owner.current = null; addTokenNotice({ label: asked.label, kind: asked.kind, fate: 'unknown', had: asked.had }); return; }
    if ('refused' in answer) { owner.current = null; setProblem(answer.refused); return; }
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
