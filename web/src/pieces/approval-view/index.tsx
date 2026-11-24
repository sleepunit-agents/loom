import { shellCommandRecord } from '../../../../src/apps/shell-command-record';
import { RuleEditor } from './rule-editor';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Split, List, Row, NoteRow, Empty, Error, Loading, Button, Actions, Textarea, Search, Reader, Meta, Title, Facts, Fact, Section, Disclosure, Body } from '../../kit';
import { briefTime, fullTime } from '../../kit/time';
import { displayName } from '../../kit/words';
import { approvalTitle, type CardFact, quotedDecision, folders, matches, rows, kindWord, kindChoice, tierWord, scopeWord, ruleKey, recordWord, type Approval, type ApprovalSnapshot, type Rule } from './model';
export type { ApprovalSnapshot } from './model';

export type RenderApprovalChange = (approval: Approval) => ReactNode;
interface ChangePresentation { renderChange?: RenderApprovalChange }

/** The composition binds these commands to the authenticated operation door.
 * A visible button is not authority: the operation rechecks the exact request.
 * Always is offered only when that door supplies its concrete scope and action.
 */
export interface ApprovalActions {
  openRuleConversation?(path:string):void;
  refreshProposal?(id: string): void;
  supports?(approval: Approval): boolean;
  /** confirm is the second, explicit yes a dangerous action needs. */
  allow(id: string, confirm?: boolean, review?: string): Promise<void>;
  deny(id: string, reason?: string): Promise<void>;
  always?: { label: string; approval: string; run(id: string): Promise<void> };
}
function Unavailable({ status }: { status: ApprovalSnapshot['status'] }) {
  return status === 'loading' ? <Loading label="Opening Approvals…" />
    : <Error text={status === 'denied' ? 'Sign in with access to see Approvals.' : 'Waiting for connection.'} />;
}
type Name = (id: string) => string;
/** The question is said under the title only when it says more than the title with a question mark. */
const same = (words: string) => words.trim().replace(/[?.!\s]+$/, '').toLowerCase();
/** Who a private request is for: "for you" when it is the viewer's own, the person's name otherwise. */
const forWhom = (a: Approval, viewer: string | undefined, name: Name) => a.member ? a.member === viewer ? 'for you' : `for ${name(a.member)}` : '';
/** A card's plain facts, in the kit's own list. A raw id kept for certainty is drawn small. */
const cardFacts = (facts: readonly CardFact[]) => facts.map((fact, index) => <Fact key={index} label={fact.label}>{fact.small ? <span className="loom-reader__meta">{fact.value}</span> : fact.value}</Fact>);
function Answer({ approval, actions, caution }: { approval: Approval; actions?: ApprovalActions; caution?: ReactNode }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirming, setConfirming] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [reason, setReason] = useState('');
  const dangerous = approval.kind === 'dangerous';
  const active = useRef(false);
  async function send(action: () => Promise<void>, allowing = false) {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    // A refusal is the program's own answer, in words written for the person answering: say it as it is.
    try {
      await action();
      if (allowing) setAllowed(true);
    } catch (error) {
      if (allowing) actions?.refreshProposal?.(approval.id);
      const refused = error as { name?: unknown; message?: unknown } | null;
      setError(refused?.name === 'WorkRefused' && typeof refused.message === 'string' ? refused.message : 'Could not save your answer. Reconnect and try again.');
    }
    finally { active.current = false; setBusy(false); }
  }
  const allow=(confirm?:boolean)=>approval.review?actions!.allow(approval.id,confirm,approval.review):
    confirm?actions!.allow(approval.id,true):actions!.allow(approval.id);
  // One filled button: Allow, or (a dangerous request, asked a second time) Yes, allow it. Always and Deny stay quiet.
  return <>
    {!allowed && caution}
    {approval.state === 'pending' && actions && (!actions.supports || actions.supports(approval)) && <>
      {dangerous && confirming && <Body>This cannot be undone.</Body>}
      <Disclosure label="Add a reason for denying">
        <label>Reason for the requesting agent<Textarea value={reason} maxLength={2000} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      </Disclosure>
      <Actions label="Answer approval">
        {dangerous && confirming
          ? <><Button variant="primary" disabled={busy} onClick={() => void send(() => allow(true), true)}>Yes, allow it</Button>
            <Button disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button></>
          : <Button variant="primary" disabled={busy} onClick={() => dangerous ? setConfirming(true) : void send(() => allow(), true)}>Allow</Button>}
        {actions.always?.approval === approval.id && <Button disabled={busy} onClick={() => void send(() => actions.always!.run(approval.id))}>{actions.always.label}</Button>}
        <Button disabled={busy} onClick={() => void send(() => reason.trim() ? actions.deny(approval.id, reason.trim()) : actions.deny(approval.id))}>Deny</Button>
      </Actions></>}
    {busy && <Body quiet role="status">Saving answer…</Body>}
    {error && <Error title="Couldn’t save your answer" text={error} />}
  </>;
}
type DetailsToggle = { open: boolean; toggle(): void };
function Details({ approval: a, snapshot, actions, renderChange, inline = false, details, viewer, name, displayTitle }: { approval: Approval; displayTitle?: string; snapshot: ApprovalSnapshot; actions?: ApprovalActions; inline?: boolean; details?: DetailsToggle; viewer?: string; name: Name } & ChangePresentation) {
  const household = a.operation === 'household.change';
  const change = household ? undefined : renderChange?.(a);
  const record = snapshot.record.filter(r => r.approval === a.id).sort((x, y) => x.seq - y.seq);
  const decision = record.filter(r => r.event === 'allow' || r.event === 'deny').at(-1);
  const answered = a.decidedBy && <Meta>{quotedDecision(decision) ?? `Answered by ${name(a.decidedBy)}`}</Meta>;
  const time = (at: string) => <time dateTime={at} title={fullTime(at, snapshot.timezone)}>{briefTime(at, snapshot.timezone)}</time>;
  const ends = a.expiresAt && <Meta>Allowance ends {time(a.expiresAt)}</Meta>;
  const whom = forWhom(a, viewer, name);
  const card = a.card;
  const title = card?.title ?? displayTitle ?? approvalTitle(a);
  const exact = card?.exact ?? a.exactRequest;
  const shell = a.kind === 'command' && record.some(event => event.event === 'request' && event.note === shellCommandRecord);
  const fullCommand = shell && <Disclosure label="Full command"><pre className="whitespace-pre-wrap break-words">{a.details}</pre></Disclosure>;
  const exactRequest = exact && <Disclosure label="Exact request"><pre className="whitespace-pre-wrap break-words">{exact}</pre></Disclosure>;
  const storedSummary = !household && !change && a.changeSummary;
  const ifYes = card?.ifYes ?? a.ifYes, ifNo = card?.ifNo ?? a.ifNo;
  const caution = a.review ? <Body role="note">The request has been refreshed. Review the current settings before allowing it.</Body> : household && a.state === 'pending' && a.blocked
    ? <Body role="note">loom will refuse this as things stand: {a.blocked.replace(/^This cannot be allowed(?: yet| as it stands)?: /, '')}</Body>
    : !household && a.problem ? <Body role="note">This cannot be allowed as it stands: {a.problem}</Body> : null;
  const showStored = !household || !!card;
  // In a conversation: the same request and the same answer controls on a compact card, built from the kit's reader
  // parts like a question’s (inbox-view ChatQuestion).
  if (inline) return <Reader aria-label={household ? title : a.ask} data-inline="">
    <Meta>{kindWord[a.kind] ?? a.kind} · {a.state}{showStored && whom && ` · ${whom}`}</Meta>
    <Body><strong>{household ? title : a.ask}</strong></Body>
    <Body quiet>{a.why}</Body>
    {details && household && <Button aria-expanded={details.open} onClick={details.toggle}>Details</Button>}
    {card && card.facts.length > 0 && <Facts>{cardFacts(card.facts)}</Facts>}
    {showStored && <Body quiet>Allow: {ifYes} Deny: {ifNo}</Body>}
    {storedSummary && <Body>{storedSummary}</Body>}
    {change}
    {!household && <Meta>Allows {kindWord[a.kind] ?? a.kind}: {a.target}</Meta>}
    {fullCommand}
    <Answer key={a.review ?? a.id} approval={a} actions={actions} caution={caution} />
    {exactRequest}
    {showStored && <>{answered}{ends}</>}
  </Reader>;
  return <Reader aria-label="Approval">
    <Meta>{kindWord[a.kind] ?? a.kind} · {a.state}</Meta>
    <Title>{title}</Title>
    {showStored && <Meta>{[name(a.agent), a.project, whom].filter(Boolean).join(' · ')}</Meta>}
    {!household && a.ask && same(a.ask) !== same(a.what) && <Body>{a.ask}</Body>}
    <Facts>
      <Fact label="Why">{a.why}</Fact>
      {card && cardFacts(card.facts)}
      {showStored && <Fact label="If you allow">{ifYes}</Fact>}
      {showStored && <Fact label="If you deny">{ifNo}</Fact>}
      {storedSummary && <Fact label="Exactly what will change">{storedSummary}</Fact>}
      {!household && <Fact label="Exactly what this allows">{`${kindWord[a.kind] ?? a.kind}: ${a.target}`}</Fact>}
    </Facts>
    {change}
    {fullCommand}
    <Answer key={a.review ?? a.id} approval={a} actions={actions} caution={caution} />
    {showStored && <>{!decision && answered}{ends}</>}
    {exactRequest}
    {!household && !shell && !change && a.details && <Section label="Details"><Body>{a.details}</Body></Section>}
    {showStored && record.length > 0 && <Section label="History"><ol className="grid gap-1.5">{record.map(r => <li key={r.seq}><Body>{recordWord(r, name)} <span className="loom-reader__meta">{time(r.at)}</span></Body></li>)}</ol></Section>}
  </Reader>;
}

/** Same current request and answer controls as the tile, with before and after. */
export function ApprovalCard({ id, snapshot, actions, renderChange, details, viewer, names, displayTitle }: { id: string; displayTitle?: string; snapshot: ApprovalSnapshot; actions?: ApprovalActions; details?: DetailsToggle; viewer?: string; names?: Readonly<Record<string, string>> } & ChangePresentation) {
  if (snapshot.status !== 'live') return <Unavailable status={snapshot.status} />;
  const approval = snapshot.approvals.find(a => a.id === id);
  return approval ? <Details key={id} displayTitle={displayTitle} approval={approval} snapshot={snapshot} actions={actions} renderChange={renderChange} inline details={details} viewer={viewer} name={id => displayName(id, names)} /> : <Empty title="Approval unavailable" />;
}
/** A standing rule, opened: what it is, and (for a household owner) its fields. */
function RuleReader({ rule, rules, go, name, zone }: { rule?: Rule; rules: readonly Rule[]; go?: (path:string)=>void; name: Name; zone: string }) {
  return <Reader aria-label="Rule">
    <Meta>{rule ? 'standing rule' : 'new standing rule'}</Meta>
    <Title>{rule ? scopeWord(rule.scope) : 'New rule'}</Title>
    {rule && <Meta>{[kindChoice[rule.kind] ?? rule.kind, rule.person && `for ${name(rule.person)}`, tierWord[rule.tier] ?? rule.tier].filter(Boolean).join(' · ')}</Meta>}
    {rule && !go && <Facts>
      <Fact label="When asked about">{kindChoice[rule.kind] ?? rule.kind}</Fact>
      <Fact label="Scope">{rule.scope}</Fact>
      <Fact label="Person">{rule.person && name(rule.person)}</Fact>
      <Fact label="Answer">{tierWord[rule.tier] ?? rule.tier}</Fact>
    </Facts>}
    {go ? <RuleEditor rules={rules} go={go} rule={rule} /> : <Body quiet>Ask an agent in chat to change a standing rule. Only a household owner can change rules.</Body>}
    {rule && <Meta>Set by {name(rule.setBy)} · <time dateTime={rule.setAt} title={fullTime(rule.setAt, zone)}>{briefTime(rule.setAt, zone)}</time></Meta>}
  </Reader>;
}

/** No transport or cached private records: the generated query client supplies
 * the current visible snapshot, and drops it on disconnect or access loss. */
export default function Approvals({ snapshot, actions, renderChange, navigation, viewer, names }: { snapshot: ApprovalSnapshot; actions?: ApprovalActions;
  navigation?: { selected?: string; select(id?: string): void; folder: string; openFolder(id: string): void };
  /** The signed-in member, and display names by id, where the composition has read them. */
  viewer?: string; names?: Readonly<Record<string, string>>;
} & ChangePresentation) {
  const [localFolder, setLocalFolder] = useState('pending'), [query, setQuery] = useState(''), [localSelected, setLocalSelected] = useState<string>();
  // The rule open in the reader: the one that was chosen (kept as it was then, so its editor stays through a removal
  // the program has not yet confirmed), or a new one.
  const [ruleOpen, setRuleOpen] = useState<{ key: string; rule?: Rule }>();
  const folder = navigation ? navigation.folder : localFolder;
  const selected = navigation ? navigation.selected : localSelected;
  const setSelected = navigation ? navigation.select : setLocalSelected;
  const live = snapshot.status === 'live';
  const name: Name = id => displayName(id, names);
  const shown = rows(snapshot, folder, query);
  const approval = live ? snapshot.approvals.find(a => a.id === selected) : undefined;
  const rules = live ? snapshot.rules.filter(r => matches([r.kind, r.scope, r.person, r.tier], query)) : [];
  const notices = live ? snapshot.notices.filter(n => matches([n.what, n.agent, n.target, n.kind], query)).sort((a,b) => b.at.localeCompare(a.at)) : [];
  const rulesView = folder === 'rules', noticesView = folder === 'notices';
  useEffect(() => { if (!rulesView || !live) setRuleOpen(undefined); }, [rulesView, live]);
  const openRule = live && rulesView && !approval ? ruleOpen : undefined;
  const counts: Record<string, number> = { rules: snapshot.rules.length, notices: snapshot.notices.length };
  return <Split label="Approvals" folders={folders.map(f => ({ ...f, count: live ? counts[f.id] ?? rows(snapshot, f.id, '').length : undefined }))}
    folder={folder} onFolder={id => { setRuleOpen(undefined); if (navigation) navigation.openFolder(id); else { setLocalFolder(id); setLocalSelected(undefined); } }}
    search={<Search label="Search approvals" value={query} onChange={setQuery} />}
    listTitle={folders.find(f => f.id === folder)?.label ?? 'Approvals'} listKey={JSON.stringify([folder, query])}
    listCount={live ? rulesView ? rules.length : noticesView ? notices.length : shown.length : undefined}
    listAction={live && rulesView && actions?.openRuleConversation && <Button onClick={() => setRuleOpen({ key: 'new' })}>New rule</Button>}
    list={!live ? <Unavailable status={snapshot.status} />
      : rulesView ? rules.length ? <List label="Standing rules">{rules.map(r => <Row key={ruleKey(r)} title={scopeWord(r.scope)} meta={`${kindChoice[r.kind] ?? r.kind}${r.person ? ` · for ${name(r.person)}` : ''}`} status={tierWord[r.tier] ?? r.tier}
          selected={openRule?.key === ruleKey(r)} onClick={() => setRuleOpen({ key: ruleKey(r), rule: r })} />)}</List> : <Empty title={query ? 'No matching rules' : 'No standing rules'} text={actions?.openRuleConversation ? undefined : 'Only a household owner can change standing rules.'} />
      : noticesView ? notices.length ? <List label="Reported steps">{notices.map(n => <NoteRow key={n.id} title={n.what} meta={`${name(n.agent)} · ${kindWord[n.kind as Approval['kind']] ?? n.kind} · ${n.target}`} status={briefTime(n.at, snapshot.timezone)} />)}</List> : <Empty title={query ? 'No matching steps' : 'No reported steps'} />
      : shown.length ? <List label="Approvals">{shown.map(a => <Row key={a.id} title={approvalTitle(a)} meta={a.why} status={`${name(a.agent)} · ${a.state}`} selected={a.id === selected} onClick={() => setSelected(a.id)} />)}</List> : <Empty title={query ? 'No matching approvals' : 'No approvals here'} />}
    reader={approval ? <Details key={approval.id} approval={approval} snapshot={snapshot} actions={actions} renderChange={renderChange} viewer={viewer} name={name} />
      : openRule ? <RuleReader key={openRule.key} rule={openRule.rule} rules={snapshot.rules} go={actions?.openRuleConversation} name={name} zone={snapshot.timezone} /> : null}
    open={!!approval || !!openRule} onBack={() => { setRuleOpen(undefined); if (approval) setSelected(undefined); }} backLabel="Back to Approvals"
    blank={<Empty title={rulesView ? 'Open a rule' : noticesView ? 'Reported steps' : 'Open an approval'} text={rulesView ? (actions?.openRuleConversation ? 'Choose a rule to change it, or start a new one.' : 'Only a household owner can change standing rules.') : noticesView ? 'Each step is shown whole in the list.' : 'Choose a request to read exactly what it allows.'} />} />;
}
