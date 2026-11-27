/** The `subscriptions` brick: the desktop's Subscriptions app (pieces/subscriptions, pieces/runtime/model-accounts.tsx)
 * on a board. It reads that app's own selection and says each account in its words (pieces/runtime/model-query.ts):
 * an account the member may not read in full is a label and a level, as loom sends it. A sign-in is asked for by
 * `runtime.accountSignIn`, which only files the request: the provider's instructions arrive in the Inbox, so the
 * whole of the desktop's flow runs here. A subscription is added by `runtime.accountCreate`; its label is typed
 * here and goes to that operation alone. No credential is read or shown: loom serves none. */
import { useRef, useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { newId } from '../data/id';
import { memberOperation } from '../data/operation';
import { useDeadline } from '../pieces/comms/use-deadline';
import { accountServices, loginCounts, loginLine, loginState, modelGroups, runtimeAccountsQuery, serviceLevel, serviceNeedsSignIn, subscriptionSetupQuery, subscriptionWords, usagePercent, usageReadStale, weeklyNote, weeklyUsageQuery, windowName,
  type AccountLogin, type RuntimeAccountDetail, type RuntimeAccountsData, type SubscriptionSetup, type WeeklyAccount, type WeeklyDimension } from '../pieces/runtime/model-query';
import { isMember, isRef } from './admin-data';
import { Action, Actions, Chip, Fact, Facts, Few, Lead, Loading, Meter, More, Note, Opened, Opens, Row, Rows, Section, Segmented, State, Time, Unavailable, count, useOwnFlag, type Act, type BodyProps, type Tone } from './brick-kit';

const share = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 2 });
const dimensions: { value: WeeklyDimension; label: string }[] = [{ value: 'agents', label: 'Agent' }, { value: 'triggers', label: 'Trigger' }, { value: 'conversations', label: 'Conversation' }];
const levelTone = (level: string): Tone => (level === 'almost full' ? 'bad' : level === 'getting full' ? 'waiting' : level === 'plenty' ? 'good' : 'neutral');
const loginTone = (login: AccountLogin): Tone => (!login.reporting ? 'muted' : login.expired || login.state !== 'signed-in' ? 'waiting' : 'good');

function Weekly({ account }: { account: string }) {
  const feed = useDataQuery<{ modelAccounts: WeeklyAccount[] }>(weeklyUsageQuery, { detailId: account }, { keep: true });
  const [dimension, setDimension] = useState<WeeklyDimension>('agents');
  const selected = (feed.status === 'live' ? feed.data?.modelAccounts ?? [] : []).filter((row) => row.id === account);
  const now = useDeadline(selected.flatMap((row) => row.weeklyUsage?.map((week) => week.resetsAt) ?? []));
  if (feed.status === 'loading') return <Loading />;
  if (feed.status !== 'live' || !feed.data) return <Note>Weekly usage is unavailable.</Note>;
  const weeks = selected.flatMap((row) => row.weeklyUsage?.filter((week) => Date.parse(week.resetsAt) > now) ?? []);
  if (!weeks.length) return <Note>No current weekly reading is available.</Note>;
  return (
    <>
      <Segmented<WeeklyDimension> label="Group by" value={dimension} options={dimensions} onChange={setDimension} />
      {weeks.map((week) => (
        <Rows key={week.window} label={windowName(week.window)}>
          <Row title={`${windowName(week.window)} · ${share.format(week.usage)} used`} />
          {week[dimension].map((group) => (
            <Row key={JSON.stringify(group.key)} end={<span className="board-number">{share.format(group.share)}</span>}
              title={dimension === 'agents' && isRef(group.key) ? <Chip place={{ brick: 'agent', params: { agent: group.key } }}>{group.title}</Chip>
                : dimension === 'conversations' && isRef(group.key) ? <Chip place={{ brick: 'session', params: { session: group.key } }}>{group.title}</Chip> : group.title} />
          ))}
          <Row title={<span className="board-note">Unattributed</span>} end={<span className="board-number">{share.format(week.unattributed)}</span>} />
        </Rows>
      ))}
      <Note>{weeklyNote}</Note>
    </>
  );
}

function SignIn({ account, box, act }: { account: string; box: string; act: Act }) {
  const [state, setState] = useState<'ready' | 'sending' | 'sent' | 'failed'>('ready');
  async function ask() {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    try { await memberOperation('runtime.accountSignIn', { account, box }); act('signIn', {}); setState('sent'); }
    catch { setState('failed'); }
  }
  return (
    <Actions>
      <Action disabled={state === 'sending' || state === 'sent'} onClick={() => void ask()}>Sign in on this machine</Action>
      {state === 'sent' && <span role="status" className="board-note">{subscriptionWords.signInSent}</span>}
      {state === 'failed' && <span role="status" className="board-problem">{subscriptionWords.signInFailed}</span>}
    </Actions>
  );
}

/** An account's usage windows: each a name, a bar, how full, and when it resets. Opened, each also says when it was
 * read (and that the reading is stale) and what is held in reserve. */
function Windows({ account, now, detail }: { account: RuntimeAccountDetail; now: number; detail?: boolean }) {
  const windows = account.windows?.length ? account.windows : [{ window: '', usage: account.usage, usageReadAt: account.usageReadAt, resetsAt: account.resetsAt, reserve: null }];
  return (
    <div className="board-windows">
      {windows.map((w) => {
        const read = Date.parse(w.usageReadAt ?? ''), name = w.window ? windowName(w.window) : 'Usage';
        return (
          <div key={w.window}>
            <span>{name}</span>
            {w.usage === null ? <span className="board-windows-none">Not read yet</span> : <><Meter label={name} value={Math.round(w.usage * 100)} /><span className="board-number">{usagePercent(w.usage)}</span></>}
            {(w.resetsAt || detail) && (
              <small>
                {w.resetsAt && <>Resets <Time at={w.resetsAt} /></>}
                {detail && <>{w.resetsAt ? ' · ' : ''}{Number.isFinite(read) ? <>Read <Time at={read} />{usageReadStale(read, now) ? subscriptionWords.stale : ''}</> : 'Reading not available'}{w.reserve !== null ? ' · Reserve ' + usagePercent(w.reserve) : ''}</>}
              </small>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Account({ account, act }: { account: RuntimeAccountDetail; act: Act }) {
  const logins = account.logins ?? [];
  return (
    <Opened>
      <Facts>
        <Fact label="Has room">{account.hasRoom ? 'Yes' : 'No'}</Fact>
        <Fact label="Owner">{isMember(account.owner) ? <Chip place={{ brick: 'person', params: { person: 'member:' + account.owner } }}>{account.owner}</Chip> : account.owner}</Fact>
        <Fact label="Service">{account.provider}</Fact>
        <Fact label="Configured machines">{account.signedInOn.map((box) => box.name).join(' · ') || 'No machines'}</Fact>
      </Facts>
      <Section title="Sign-ins">
        {!logins.length && !account.pendingSignIns?.length ? <Note>No sign-ins reported.</Note> : (
          <Rows>
            {account.pendingSignIns?.map((box) => <Row key={box.id} title={box.name} end={<State tone="waiting">Sign-in requested</State>} />)}
            {logins.map((login) => (
              <Row key={JSON.stringify([login.box.id, login.place, login.harness])} title={login.box.name} end={<State tone={loginTone(login)}>{loginState(login)}</State>}
                meta={<>{loginLine(login)} · Checked <Time at={login.checkedAt} />{login.expiresAt && <> · {login.expired ? 'Ended' : 'Ends'} <Time at={login.expiresAt} /></>}</>}>
                {login.canRequest && <SignIn account={account.id} box={login.box.id} act={act} />}
              </Row>
            ))}
          </Rows>
        )}
      </Section>
      <Section title="Weekly usage"><Weekly account={account.id} /></Section>
    </Opened>
  );
}

/** "Add a subscription", as the desktop's form (pieces/subscriptions/create.tsx): the same input, and the same
 * request id for the same settings, so a retry cannot add a second one. */
function Add({ setup, act }: { setup: SubscriptionSetup; act: Act }) {
  const [open, setOpen] = useState(false), [provider, setProvider] = useState(setup.providers[0] ?? ''), [label, setLabel] = useState(''), [machines, setMachines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const attempt = useRef<{ key: string; id: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const input = { provider, label: label.trim(), machines: [...machines].sort() };
    if (!input.label) { setMessage(subscriptionWords.noLabel); return; }
    const key = JSON.stringify(input);
    if (attempt.current?.key !== key) attempt.current = { key, id: newId() };
    setBusy(true); setMessage('');
    try {
      await memberOperation('runtime.accountCreate', input, attempt.current.id);
      attempt.current = null; act('create', {});
      setLabel(''); setMachines([]); setMessage(subscriptionWords.added(input.machines.length));
    } catch { setMessage(subscriptionWords.notConfirmed); }
    finally { setBusy(false); }
  }
  if (!open) return <Actions><Action onClick={() => setOpen(true)}>Add a subscription</Action>{message && <span role="status" className="board-note">{message}</span>}</Actions>;
  return (
    <form className="board-form" aria-label="Add a subscription" onSubmit={(event) => void submit(event)}>
      <Facts><Fact label="Owner">{setup.member}</Fact></Facts>
      <Segmented<string> label="Service" value={provider} options={setup.providers.map((p) => ({ value: p, label: p }))} onChange={setProvider} disabled={busy} />
      <label className="board-field"><span>Label</span><input className="board-input" required maxLength={200} value={label} disabled={busy} onChange={(e) => setLabel(e.target.value)} /></label>
      {!!setup.machines.length && (
        <div className="board-choice" role="group" aria-label="Machines to sign in on">
          <span className="board-choice-label">Machines to sign in on</span>
          <Actions>{setup.machines.map((m) => <Action key={m.id} pressed={machines.includes(m.id)} disabled={busy} onClick={() => setMachines(machines.includes(m.id) ? machines.filter((id) => id !== m.id) : [...machines, m.id])}>{m.name}</Action>)}</Actions>
        </div>
      )}
      <Actions>
        <Action submit kind="primary" disabled={busy}>Add subscription</Action>
        <Action kind="quiet" disabled={busy} onClick={() => { setOpen(false); setMessage(''); }}>Cancel</Action>
      </Actions>
      {message && <p role="status" className="board-note">{message}</p>}
    </form>
  );
}

export function Subscriptions({ form, act, raise }: BodyProps) {
  const primary = form === 'primary';
  const feed = useDataQuery<RuntimeAccountsData>(runtimeAccountsQuery, undefined, { keep: true });
  const creation = useDataQuery<{ subscriptionSetup: SubscriptionSetup | null }>(subscriptionSetupQuery, undefined, { keep: true, pause: !primary });
  const [search, setSearch] = useState(''), [attentionOnly, setAttentionOnly] = useState(false), [open, setOpen] = useState('');
  const rows = feed.status === 'live' && Array.isArray(feed.data?.modelAccounts) ? feed.data.modelAccounts : undefined;
  const need = rows?.reduce((n, row) => n + (row.__typename === 'RuntimeAccountDetail' ? (row.logins ?? []).filter((login) => login.needsSignIn).length : 0), 0);
  useOwnFlag(need, raise, (was, now) => (now > was ? 'Sign-in needed' : null));
  if (feed.status === 'loading') return <Loading />;
  if (!rows) return <Unavailable what="list of subscriptions" />;
  const now = Date.now();
  const full = rows.filter((row) => row.level === 'almost full').length;
  const summary = `${count(rows.length, 'subscription')}${full ? ` · ${full} almost full` : ''}${need ? ` · ${count(need, 'sign-in')} needed` : ''}`;
  if (form === 'compact') return <p className="board-brief">{summary}</p>;
  const services = accountServices(rows, primary ? search : '', primary && attentionOnly);
  const setup = creation.status === 'live' ? creation.data?.subscriptionSetup : null;
  const groups = primary ? modelGroups(feed.data) : new Map();
  return (
    <>
      <Lead>{summary}</Lead>
      {primary && rows.length > 0 && (
        <div className="board-pick" role="search">
          <input className="board-input" type="search" aria-label="Search subscriptions" placeholder="Search subscriptions…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Action kind="quiet" pressed={attentionOnly} onClick={() => setAttentionOnly(!attentionOnly)}>Needs attention</Action>
        </div>
      )}
      {/* Small, it is each subscription and how full it is; its windows, sign-ins and settings are in the big form. */}
      {!primary && rows.length > 0 && <Few of={[...services].flatMap(([, accounts]) => accounts)} first={6}>{(shown, hidden) => <>
        <Rows beside>{shown.map((account, index) => <Row key={index} title={account.label} end={<State tone={levelTone(account.level)}>{account.level}</State>}
          meta={account.__typename === 'RuntimeAccountDetail' && (account.logins ?? []).some((login) => login.needsSignIn) ? 'Sign-in needed' : undefined} />)}</Rows>
        <More n={hidden} />
      </>}</Few>}
      {!rows.length ? <Note>No model accounts yet.</Note> : !services.size ? <Note>No matching subscriptions.</Note> : primary && [...services].map(([provider, accounts]) => (
        <Section key={JSON.stringify(provider)} title={provider ?? 'Shared summaries'} count={`${accounts.length} · ${serviceLevel(accounts)}${serviceNeedsSignIn(accounts) ? ' · Sign-in needed' : ''}`}>
          <Rows>
            {accounts.map((account, index) => {
              if (account.__typename === 'RuntimeAccountSummary') return <Row key={index} title={account.label} end={<State tone={levelTone(account.level)}>{account.level}</State>} />;
              const logins = account.logins ?? [], { signedIn, attention, lastKnown } = loginCounts(account);
              const line = [account.owner, logins.length ? `${signedIn} signed in` : 'No sign-ins reported', attention > 0 && `${attention} ${attention === 1 ? 'needs' : 'need'} attention`,
                lastKnown > 0 && `${lastKnown} last known`, !!account.pendingSignIns?.length && 'Sign-in requested'].filter(Boolean).join(' · ');
              return (
                <Row key={account.id} meta={line} end={<State tone={levelTone(account.level)}>{account.level}</State>}
                  title={primary ? <Opens open={open === account.id} onToggle={() => setOpen(open === account.id ? '' : account.id)}>{account.label}</Opens> : account.label}>
                  <Windows account={account} now={now} detail={primary && open === account.id} />
                  {primary && open === account.id && <Account account={account} act={act} />}
                </Row>
              );
            })}
          </Rows>
        </Section>
      ))}
      {primary && (
        <Section title="Models in preference order">
          {!groups.size ? <Note>No model preferences yet.</Note> : (
            <Rows>
              {[...groups].map(([agent, models]) => (
                <Row key={agent} title={isRef(agent) ? <Chip place={{ brick: 'agent', params: { agent } }}>{agent}</Chip> : agent}
                  meta={models.map((row: { model: string }, index: number) => row.model + (index === 0 ? ' · Primary' : '')).join(', ')} />
              ))}
            </Rows>
          )}
        </Section>
      )}
      {primary && setup && !!setup.providers.length && <Add key={setup.member} setup={setup} act={act} />}
    </>
  );
}
