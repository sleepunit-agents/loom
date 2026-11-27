/** The `account` brick: the signed-in member's own passkeys, signed-in browsers and notification devices, as the
 * desktop's Account piece shows them, from its one selection (pieces/account/query.ts). Every change is the
 * desktop's: `account.removePasskey`, `account.revokeSession` (through signin/session-change.ts, which reloads when
 * the browser signed out was this one), `notifications.removeDevice` and turning this device on (the hook the page's
 * bell uses, ./notify-device.ts), adding a passkey (pieces/account/passkey.ts) and the one-time sign-in link
 * (signin/device-link.ts). Each removal asks first. The board is told only that an action happened: a passkey's
 * name, a reference and the sign-in link never leave this module except to the door they are for.
 *
 * The read does not say which signed-in browser is this one, so no row is marked; signing out the browser in use
 * reloads the page to the sign-in screen. The notification device that is this one is marked. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { deviceLabel } from '../../../src/core/signin/browser-device';
import { useDataQuery } from '../data/graphql';
import { NOTIFICATION_WORDS, removeNotificationDevice } from '../pieces/account/notifications';
import { PASSKEY_WORDS, addPasskey, post } from '../pieces/account/passkey';
import { accountQuery, type Account as AccountRead } from '../pieces/account/query';
import { memberOperation } from '../data/operation';
import { DEVICE_LINK_WORDS, requestSigninLink } from '../signin/device-link';
import { sessionChange } from '../signin/session-change';
import { Action, Actions, Fact, Facts, Lead, Loading, Note, Problem, Rows, Section, State, Time, Unavailable, type Act, type BodyProps } from './brick-kit';
import { useDeviceNotifications } from './notify-device';
import { AskRow, Asks } from './settings-kit';

const some = (n: number, one: string, many = one + 's') => `${n || 'No'} ${n === 1 ? one : many}`;

export function Account({ form, act }: BodyProps) {
  const read = useDataQuery<{ account: AccountRead | null }>(accountQuery, undefined, { keep: true });
  if (read.status === 'loading') return <Loading />;
  const account = read.status === 'live' ? read.data?.account : null;
  if (!account) return <Unavailable what="account" />;
  const passkeys = account.passkeys.filter((key) => !key.ended).length, browsers = account.sessions.filter((session) => !session.ended).length;
  const devices = account.notifications?.devices.length ?? 0;
  const counts = [some(passkeys, 'passkey'), some(browsers, 'signed-in browser'), some(devices, 'notification device')];
  if (form === 'compact') return <p className="board-brief">{counts.join(' · ')}</p>;
  if (form === 'side') return (
    <>
      <Lead>{account.member}</Lead>
      <Facts>
        <Fact label="Passkeys">{counts[0]}</Fact>
        <Fact label="Browsers">{counts[1]}</Fact>
        <Fact label="Notifications">{counts[2]}</Fact>
      </Facts>
      <Note>Make this brick big to change them.</Note>
    </>
  );
  return <Whole account={account} act={act} />;
}

function Whole({ account, act }: { account: AccountRead; act: Act }) {
  const [busy, setBusy] = useState(false), [message, say] = useState('');
  const notify = useDeviceNotifications(account.notifications ?? null);
  /** One change at a time. The board is told once the operation took it, and never when this browser was signed out. */
  const change = async (action: string, failed: string, work: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true); say('');
    try {
      if ((await work()) === 'signed-out') return false;
      act(action, {}); say('Saved.'); return true;
    } catch { say(failed); return false; } finally { setBusy(false); }
  };
  const lost = 'Could not save. Check the connection and try again.';
  const active = account.passkeys.filter((key) => !key.ended);
  const signOut = async () => {
    if (busy) return false;
    setBusy(true); say('');
    try { await post('/logout', {}); location.reload(); return true; } catch { say('Could not sign out. Check the connection and try again.'); setBusy(false); return false; }
  };
  const devices = account.notifications?.devices ?? [];
  return (
    <>
      <Lead>{account.member}</Lead>
      {message && <p role="status" className="board-note">{message}</p>}

      <Section title="Passkeys" count={account.passkeys.length || undefined}>
        {!account.passkeys.length && <Note>No passkeys yet.</Note>}
        <Rows>
          {account.passkeys.map((key) => (
            <AskRow key={key.ref} title={key.label} end={<State tone={key.ended ? 'muted' : 'good'}>{key.ended ? 'Stopped' : 'Active'}</State>}
              meta={<>Added <Time at={key.createdAt} />{key.lastUsedAt && <> · Last used <Time at={key.lastUsedAt} /></>}</>}
              asks={{ busy, label: `Remove passkey ${key.label}`, ask: 'Remove…', yes: 'Remove passkey', no: 'Keep',
                act: () => change('removePasskey', lost, () => memberOperation('account.removePasskey', { ref: key.ref })),
                children: `Remove this passkey? The browsers it signed in are signed out.${!key.ended && active.length === 1 ? ' It is your only active passkey.' : ''}` }} />
          ))}
        </Rows>
        <AddPasskey enabled={!busy} />
      </Section>

      <Section title="Signed-in browsers" count={account.sessions.length || undefined}>
        <Rows>
          {account.sessions.map((session) => (
            <AskRow key={session.ref} title={deviceLabel(session.device)} end={<State tone={session.ended ? 'muted' : 'good'}>{session.ended ? 'Ended' : 'Signed in'}</State>}
              meta={<>Last used <Time at={session.seenAt} /></>}
              asks={{ busy, label: `Sign out ${deviceLabel(session.device)}`, ask: 'Sign out…', yes: 'Sign out browser', no: 'Keep',
                act: () => change('revokeSession', 'Could not confirm sign-out. Check your sign-in and connection.', () => sessionChange('account.revokeSession', { ref: session.ref })),
                children: 'Sign this browser out? If it is the one you are using, you will have to sign in again here.' }} />
          ))}
        </Rows>
      </Section>

      <Section title="Notifications" count={devices.length || undefined}>
        <p role="status" className="board-note">{NOTIFICATION_WORDS[notify.state]}</p>
        {notify.state === 'off' && (
          <Actions><Action disabled={busy || notify.busy} onClick={async () => { if (await notify.on()) act('enableNotifications', {}); }}>Turn on notifications on this device</Action></Actions>
        )}
        <Problem>{notify.error}</Problem>
        <Rows>
          {devices.map((device) => (
            <AskRow key={device.ref} title={deviceLabel(device.device)} end={device.ref === notify.ref ? <State tone="working">This device</State> : undefined}
              meta={<>Last confirmed <Time at={device.seenAt} /></>}
              asks={{ busy, label: `Remove notification device ${deviceLabel(device.device)}`, ask: 'Remove…', yes: 'Remove notification device', no: 'Keep',
                act: () => change('removeDevice', lost, () => removeNotificationDevice(device.ref)),
                children: 'Stop notifications on this device? It can be turned on again only from that device.' }} />
          ))}
        </Rows>
      </Section>

      <Section title="Sign in another device"><DeviceLink member={account.member} enabled={!busy} /></Section>

      <Section title="This device">
        <Asks busy={busy} ask="Sign out this device…" yes="Sign out this device" no="Keep" act={signOut}>Sign out of loom on this device?</Asks>
      </Section>
    </>
  );
}

/** Account's own form. The name goes to the sign-in door with the new passkey and nowhere else. */
function AddPasskey({ enabled }: { enabled: boolean }) {
  const [label, setLabel] = useState(''), [busy, setBusy] = useState(false), [message, say] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!enabled || busy || !name) return;
    setBusy(true); say('');
    try { await addPasskey(name); setLabel(''); say('Passkey added.'); }
    catch (e) { say(e instanceof Error ? e.message : 'Could not add the passkey'); }
    finally { setBusy(false); }
  };
  return (
    <form className="board-form" aria-label="Add a passkey" onSubmit={(event) => void submit(event)}>
      <label className="board-field"><span>Passkey name</span>
        <span className="board-pick">
          <input className="board-input" aria-label="Passkey name" required maxLength={60} value={label} disabled={!enabled || busy} onChange={(e) => setLabel(e.target.value)} />
          <Action submit disabled={!enabled || busy}>{busy ? 'Waiting for device…' : 'Add a passkey'}</Action>
        </span>
      </label>
      <Note>{PASSKEY_WORDS}</Note>
      {message && <p role="status" className="board-note">{message}</p>}
    </form>
  );
}

/** The one-time link, as the desktop's DeviceLink shows it: asked for once, never retried, on screen until hidden
 * or until this brick leaves the page, and kept nowhere else. */
function DeviceLink({ member, enabled }: { member: string; enabled: boolean }) {
  const [link, setLink] = useState<string>(), [busy, setBusy] = useState(false), [message, say] = useState('');
  const shown = useRef(true), pending = useRef(false);
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);
  const make = async () => {
    if (!enabled || pending.current) return;
    pending.current = true; setBusy(true); setLink(undefined); say('');
    try {
      const result = await requestSigninLink();
      if (!shown.current) return;
      if (result === 'signin') say(DEVICE_LINK_WORDS.again); else setLink(result.path);
    } catch { if (shown.current) say(DEVICE_LINK_WORDS.lost); }
    finally { pending.current = false; if (shown.current) setBusy(false); }
  };
  return (
    <section className="board-form" aria-label="Sign in another device">
      <Note>{DEVICE_LINK_WORDS.about(member)}</Note>
      <Actions>
        <Action disabled={!enabled || busy} onClick={() => void make()}>Make sign-in link</Action>
        {link && <Action kind="quiet" onClick={() => setLink(undefined)}>Hide sign-in link</Action>}
      </Actions>
      {link && <p role="status" data-signin-link className="board-account-link font-mono">{new URL(link, location.origin).href}</p>}
      {message && <p role="status" className="board-note">{message}</p>}
    </section>
  );
}
