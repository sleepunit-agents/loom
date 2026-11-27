import { ToolbarFrame } from '../../kit/toolbar';
import { RuleEditor } from './rule-editor';
import { useEffect, useState, type ReactNode } from 'react';
import { Split, List, Row, NoteRow, Empty, Error, Loading, Button, Actions, Textarea, Search, Reader, Meta, Title, Facts, Fact, Section, Disclosure, Body } from '../../kit';
import { briefTime, fullTime } from '../../kit/time';
import { displayName } from '../../kit/words';
import { answerKey, approvalReading, cautionWords, forWhom, reasonLimit, secondYesWords, useAnswering, type ApprovalActions, type Name } from './answering';
export type { ApprovalActions } from './answering';
import { approvalTitle, type CardFact, folders, matches, rows, kindWord, kindChoice, tierWord, scopeWord, ruleKey, recordWord, type Approval, type ApprovalSnapshot, type Rule } from './model';
export type { ApprovalSnapshot } from './model';

export type RenderApprovalChange = (approval: Approval) => ReactNode;
interface ChangePresentation { renderChange?: RenderApprovalChange }

function Unavailable({ status }: { status: ApprovalSnapshot['status'] }) {
  return status === 'loading' ? <Loading label="Opening Approvals…" />
    : <Error text={status === 'denied' ? 'Sign in with access to see Approvals.' : 'Waiting for connection.'} />;
}
/** A card's plain facts, in the kit's own list. A raw id kept for certainty is drawn small. */
const cardFacts = (facts: readonly CardFact[]) => facts.map((fact, index) => <Fact key={index} label={fact.label}>{fact.small ? <span className="loom-reader__meta">{fact.value}</span> : fact.value}</Fact>);
/** The answer controls. Every decision in them is ./answering.ts; this is only how the desktop draws it. */
function Answer({ approval, actions, caution }: { approval: Approval; actions?: ApprovalActions; caution?: ReactNode }) {
  const answer = useAnswering(approval, actions), busy = answer.busy;
  // One filled button: Allow, or (a dangerous request, asked a second time) Yes, allow it. Always and Deny stay quiet.
  return <>
    {!answer.allowed && caution}
    {answer.open && <>
      {answer.confirming && <Body>{secondYesWords}</Body>}
      <Disclosure label="Add a reason for denying">
        <label>Reason for the requesting agent<Textarea value={answer.reason} maxLength={reasonLimit} disabled={busy} onChange={event => answer.setReason(event.target.value)} /></label>
      </Disclosure>
      <Actions label="Answer approval">
        {answer.confirming
          ? <><Button variant="primary" disabled={busy} onClick={answer.confirm}>Yes, allow it</Button>
            <Button disabled={busy} onClick={answer.cancel}>Cancel</Button></>
          : <Button variant="primary" disabled={busy} onClick={answer.allow}>Allow</Button>}
        {answer.always && <Button disabled={busy} onClick={answer.always.run}>{answer.always.label}</Button>}
        <Button disabled={busy} onClick={answer.deny}>Deny</Button>
      </Actions></>}
    {busy && <Body quiet role="status">Saving answer…</Body>}
    {answer.error && <Error title="Couldn’t save your answer" text={answer.error} />}
  </>;
}
type DetailsToggle = { open: boolean; toggle(): void };
function Details({ approval: a, snapshot, actions, renderChange, inline = false, details, viewer, name, displayTitle }: { approval: Approval; displayTitle?: string; snapshot: ApprovalSnapshot; actions?: ApprovalActions; inline?: boolean; details?: DetailsToggle; viewer?: string; name: Name } & ChangePresentation) {
  const change = a.operation === 'household.change' ? undefined : renderChange?.(a);
  const { household, record, decision, card, title, shell, showStored, ifYes, ifNo, storedSummary, ...reading } = approvalReading(a, snapshot.record, name, { displayTitle, change: !!change });
  const answered = reading.answered && <Meta>{reading.answered}</Meta>;
  const time = (at: string) => <time dateTime={at} title={fullTime(at, snapshot.timezone)}>{briefTime(at, snapshot.timezone)}</time>;
  const ends = a.expiresAt && <Meta>Allowance ends {time(a.expiresAt)}</Meta>;
  const whom = forWhom(a, viewer, name);
  const fullCommand = shell && <Disclosure label="Full command"><pre className="whitespace-pre-wrap break-words">{reading.fullCommand}</pre></Disclosure>;
  const exactRequest = reading.exact && <Disclosure label="Exact request"><pre className="whitespace-pre-wrap break-words">{reading.exact}</pre></Disclosure>;
  const words = cautionWords(a), caution = words ? <Body role="note">{words}</Body> : null;
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
    <Answer key={answerKey(a)} approval={a} actions={actions} caution={caution} />
    {exactRequest}
    {showStored && <>{answered}{ends}</>}
  </Reader>;
  return <Reader aria-label="Approval">
    <Meta>{kindWord[a.kind] ?? a.kind} · {a.state}</Meta>
    <Title>{title}</Title>
    {showStored && <Meta>{[name(a.agent), a.project, whom].filter(Boolean).join(' · ')}</Meta>}
    {reading.ask && <Body>{reading.ask}</Body>}
    <Facts>
      <Fact label="Why">{a.why}</Fact>
      {card && cardFacts(card.facts)}
      {showStored && <Fact label="If you allow">{ifYes}</Fact>}
      {showStored && <Fact label="If you deny">{ifNo}</Fact>}
      {storedSummary && <Fact label="Exactly what will change">{storedSummary}</Fact>}
      {!household && <Fact label="Exactly what this allows">{reading.allows}</Fact>}
    </Facts>
    {change}
    {fullCommand}
    <Answer key={answerKey(a)} approval={a} actions={actions} caution={caution} />
    {showStored && <>{!decision && answered}{ends}</>}
    {exactRequest}
    {reading.details && <Section label="Details"><Body>{reading.details}</Body></Section>}
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
  const rulesView = folder === 'rules', noticesView = folder === 'notices';
  const shown = rulesView || noticesView ? [] : rows(snapshot, folder, query);
  const approval = live && selected !== undefined ? snapshot.approvals.find(a => a.id === selected) : undefined;
  const rules = live && rulesView ? snapshot.rules.filter(r => matches([r.kind, r.scope, r.person, r.tier], query)) : [];
  const notices = live && noticesView ? snapshot.notices.filter(n => matches([n.what, n.agent, n.target, n.kind], query)).sort((a,b) => b.at.localeCompare(a.at)) : [];
  useEffect(() => { if (!rulesView || !live) setRuleOpen(undefined); }, [rulesView, live]);
  const openRule = live && rulesView && !approval ? ruleOpen : undefined;
  const pending = live ? snapshot.approvals.reduce((count, card) => count + Number(card.state === 'pending'), 0) : 0;
  const counts: Record<string, number> = { pending, history: snapshot.approvals.length - pending, rules: snapshot.rules.length, notices: snapshot.notices.length };
  return <ToolbarFrame title="Approvals" controls={<Search label="Search approvals" value={live ? query : ''} disabled={!live} onChange={setQuery}/>}>
    <Split label="Approvals" folders={folders.map(f => ({ ...f, count: live ? counts[f.id] : undefined }))}
    folder={folder} onFolder={id => { setRuleOpen(undefined); if (navigation) navigation.openFolder(id); else { setLocalFolder(id); setLocalSelected(undefined); } }}
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
    blank={<Empty title={rulesView ? 'Open a rule' : noticesView ? 'Reported steps' : 'Open an approval'} text={rulesView ? (actions?.openRuleConversation ? 'Choose a rule to change it, or start a new one.' : 'Only a household owner can change standing rules.') : noticesView ? 'Each step is shown whole in the list.' : 'Choose a request to read exactly what it allows.'} />} />
  </ToolbarFrame>;
}
