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
import { fullTime } from '../kit/time';
import { useDeadline } from '../pieces/comms/use-deadline';
import { accountLine, accountServices, loginLine, loginState, modelGroups, runtimeAccountsQuery, serviceLine, subscriptionSetupQuery, subscriptionWords, usagePercent, usageReadStale, weeklyNote, weeklyUsageQuery, windowName,
  type RuntimeAccountDetail, type RuntimeAccountsData, type SubscriptionSetup, type WeeklyAccount, type WeeklyDimension } from '../pieces/runtime/model-query';
import { isMember, isRef } from './admin-data';
import { Chip, Loading, Unavailable, useOwnFlag, type Act, type BodyProps } from './brick-kit';

const time = (value: string | null, zone?: string) => (value ? fullTime(value, zone) : 'Not available');
const share = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 2 });
const dimensions: [WeeklyDimension, string][] = [['agents', 'Agent'], ['triggers', 'Trigger'], ['conversations', 'Conversation']];
const readLine = (at: string | null, zone: string | undefined, now: number) => {
  const read = Date.parse(at ?? '');
  return Number.isFinite(read) ? time(at, zone) + (usageReadStale(read, now) ? subscriptionWords.stale : '') : 'Not available';
};

function Weekly({ account }: { account: string }) {
  const feed = useDataQuery<{ modelAccounts: WeeklyAccount[] }>(weeklyUsageQuery, { detailId: account }, { keep: true });
  const [dimension, setDimension] = useState<WeeklyDimension>('agents');
  const selected = (feed.status === 'live' ? feed.data?.modelAccounts ?? [] : []).filter((row) => row.id === account);
  const now = useDeadline(selected.flatMap((row) => row.weeklyUsage?.map((week) => week.resetsAt) ?? []));
  if (feed.status === 'loading') return <Loading />;
  if (feed.status !== 'live' || !feed.data) return <p className="text-muted-foreground">Weekly usage is unavailable.</p>;
  const weeks = selected.flatMap((row) => row.weeklyUsage?.filter((week) => Date.parse(week.resetsAt) > now) ?? []);
  if (!weeks.length) return <p className="text-muted-foreground">No current weekly reading is available.</p>;
  return (
    <>
      <div className="board-line" role="group" aria-label="Group by">Group by
        {dimensions.map(([value, word]) => <button key={value} type="button" className="board-action" aria-pressed={dimension === value} onClick={() => setDimension(value)}>{word}</button>)}
      </div>
      <p className="text-muted-foreground">{weeklyNote}</p>
      {weeks.map((week) => (
        <div key={week.window}>
          <p>{windowName(week.window)} · {share.format(week.usage)} used</p>
          {week[dimension].map((group) => (
            <div className="board-line" key={JSON.stringify(group.key)}>
              {dimension === 'agents' && isRef(group.key) ? <Chip place={{ brick: 'agent', params: { agent: group.key } }}>{group.title}</Chip>
                : dimension === 'conversations' && isRef(group.key) ? <Chip place={{ brick: 'session', params: { session: group.key } }}>{group.title}</Chip> : <span>{group.title}</span>}
              <span className="text-muted-foreground">{share.format(group.share)}</span>
            </div>
          ))}
          <p className="text-muted-foreground">Unattributed · {share.format(week.unattributed)}</p>
        </div>
      ))}
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
    <>
      <button type="button" className="board-action" disabled={state === 'sending' || state === 'sent'} onClick={() => void ask()}>Sign in on this machine</button>
      {state === 'sent' && <span role="status">{subscriptionWords.signInSent}</span>}
      {state === 'failed' && <span role="status">{subscriptionWords.signInFailed}</span>}
    </>
  );
}

function Account({ account, zone, now, act }: { account: RuntimeAccountDetail; zone?: string; now: number; act: Act }) {
  const logins = account.logins ?? [];
  return (
    <dl style={{ margin: '.4rem 0 .8rem' }}>
      <div>
        <dt>Usage</dt>
        <dd>
          {account.windows?.length ? account.windows.map((w) => (
            <p key={w.window}>{windowName(w.window)} · {w.usage === null ? 'Not read yet' : usagePercent(w.usage)}
              <span className="text-muted-foreground">{w.usageReadAt ? ' · Read ' + readLine(w.usageReadAt, zone, now) : ''}{w.resetsAt ? ' · Resets ' + time(w.resetsAt, zone) : ''}{w.reserve !== null ? ' · Reserve ' + usagePercent(w.reserve) : ''}</span>
            </p>
          )) : <p>{account.usage === null ? 'Not read yet' : usagePercent(account.usage)}<span className="text-muted-foreground"> · Read {readLine(account.usageReadAt, zone, now)} · Resets {time(account.resetsAt, zone)}</span></p>}
          <p>Has room: {account.hasRoom ? 'Yes' : 'No'}</p>
        </dd>
      </div>
      <div><dt>Weekly usage</dt><dd><Weekly account={account.id} /></dd></div>
      <div>
        <dt>Sign-ins</dt>
        <dd>
          {account.pendingSignIns?.map((box) => <p key={box.id}>{box.name} · Sign-in requested</p>)}
          {logins.length ? logins.map((login) => (
            <div key={JSON.stringify([login.box.id, login.place, login.harness])}>
              <div className="board-line">
                <strong>{login.box.name}</strong><span>{loginLine(login)}</span>
                <span className="board-state">{loginState(login)}</span>
                {login.canRequest && <SignIn account={account.id} box={login.box.id} act={act} />}
              </div>
              <p className="text-muted-foreground">Checked {time(login.checkedAt, zone)}{login.expiresAt ? ` · ${login.expired ? 'Ended' : 'Ends'} ${time(login.expiresAt, zone)}` : ''}</p>
            </div>
          )) : !account.pendingSignIns?.length && <p>No sign-ins reported.</p>}
        </dd>
      </div>
      <div><dt>Owner</dt><dd>{isMember(account.owner) ? <Chip place={{ brick: 'person', params: { person: 'member:' + account.owner } }}>{account.owner}</Chip> : account.owner}</dd></div>
      <div><dt>Service</dt><dd>{account.provider}</dd></div>
      <div><dt>Configured machines</dt><dd>{account.signedInOn.map((box) => box.name).join(' · ') || 'No machines'}</dd></div>
    </dl>
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
  if (!open) return <div className="board-line"><button type="button" className="board-action" onClick={() => setOpen(true)}>Add a subscription</button>{message && <span role="status">{message}</span>}</div>;
  return (
    <form aria-label="Add a subscription" onSubmit={(event) => void submit(event)}>
      <p className="text-muted-foreground">Owner: {setup.member}</p>
      <div className="board-line" role="group" aria-label="Service">Service
        {setup.providers.map((p) => <button key={p} type="button" className="board-action" aria-pressed={provider === p} disabled={busy} onClick={() => setProvider(p)}>{p}</button>)}
      </div>
      <label className="board-line">Label<input className="board-input" required maxLength={200} value={label} disabled={busy} onChange={(e) => setLabel(e.target.value)} /></label>
      {!!setup.machines.length && (
        <div className="board-line" role="group" aria-label="Machines to sign in on">Machines to sign in on
          {setup.machines.map((m) => <button key={m.id} type="button" className="board-action" aria-pressed={machines.includes(m.id)} disabled={busy} onClick={() => setMachines(machines.includes(m.id) ? machines.filter((id) => id !== m.id) : [...machines, m.id])}>{m.name}</button>)}
        </div>
      )}
      <div className="board-line">
        <button type="submit" className="board-action" disabled={busy}>Add subscription</button>
        <button type="button" className="board-action" disabled={busy} onClick={() => { setOpen(false); setMessage(''); }}>Cancel</button>
      </div>
      {message && <p role="status">{message}</p>}
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
  const zone = feed.data?.deskTime?.timezone, now = Date.now();
  const full = rows.filter((row) => row.level === 'almost full').length;
  const count = `${rows.length} subscription${rows.length === 1 ? '' : 's'}${full ? ` · ${full} almost full` : ''}${need ? ` · ${need} ${need === 1 ? 'sign-in' : 'sign-ins'} needed` : ''}`;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  const services = accountServices(rows, primary ? search : '', primary && attentionOnly);
  const setup = creation.status === 'live' ? creation.data?.subscriptionSetup : null;
  const groups = primary ? modelGroups(feed.data) : new Map();
  return (
    <>
      <p className="board-line"><span>{count}</span></p>
      {primary && (
        <div className="board-line" role="search">
          <input className="board-input" type="search" aria-label="Search subscriptions" placeholder="Search subscriptions…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className="board-action" aria-pressed={attentionOnly} onClick={() => setAttentionOnly(!attentionOnly)}>Needs attention</button>
        </div>
      )}
      {!rows.length ? <p className="text-muted-foreground">No model accounts yet.</p> : !services.size ? <p className="text-muted-foreground">No matching subscriptions.</p> : [...services].map(([provider, accounts]) => (
        <section key={JSON.stringify(provider)} aria-label={provider ?? 'Shared summaries'} style={{ marginTop: '.6rem' }}>
          <p className="board-lead">{serviceLine(provider, accounts)}</p>
          {accounts.map((account, index) => account.__typename === 'RuntimeAccountSummary' ? <p key={index}>{account.label} · {account.level}</p> : (
            <div key={account.id}>
              <div className="board-line">
                {primary ? <button type="button" className="board-action" aria-expanded={open === account.id} onClick={() => setOpen(open === account.id ? '' : account.id)}>{account.label}</button> : null}
                <span>{accountLine(account)}</span>
              </div>
              {!primary && !!account.windows?.length && <p className="text-muted-foreground">{account.windows.map((w) => `${windowName(w.window)} ${w.usage === null ? 'not read yet' : usagePercent(w.usage)}`).join(' · ')}</p>}
              {primary && open === account.id && <Account account={account} zone={zone} now={now} act={act} />}
            </div>
          ))}
        </section>
      ))}
      {primary && (
        <dl style={{ marginTop: '.9rem' }}>
          <div>
            <dt>Models in preference order</dt>
            <dd>
              {!groups.size ? <p className="text-muted-foreground">No model preferences yet.</p> : [...groups].map(([agent, models]) => (
                <div className="board-line" key={agent}>
                  {isRef(agent) ? <Chip place={{ brick: 'agent', params: { agent } }}>{agent}</Chip> : <span>{agent}</span>}
                  <span>{models.map((row: { model: string }, index: number) => row.model + (index === 0 ? ' · Primary' : '')).join(', ')}</span>
                </div>
              ))}
            </dd>
          </div>
        </dl>
      )}
      {primary && setup && !!setup.providers.length && <Add key={setup.member} setup={setup} act={act} />}
    </>
  );
}
