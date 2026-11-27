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
import { useHouseholdZone } from '../data/zone';
import { fullTime } from '../kit/time';
import { NOTIFICATION_WORDS, removeNotificationDevice } from '../pieces/account/notifications';
import { PASSKEY_WORDS, addPasskey, post } from '../pieces/account/passkey';
import { accountQuery, type Account as AccountRead } from '../pieces/account/query';
import { memberOperation } from '../data/operation';
import { DEVICE_LINK_WORDS, requestSigninLink } from '../signin/device-link';
import { sessionChange } from '../signin/session-change';
import { Loading, Unavailable, type Act, type BodyProps } from './brick-kit';
import { useDeviceNotifications } from './notify-device';

const count = (n: number, one: string, many = one + 's') => `${n || 'No'} ${n === 1 ? one : many}`;

export function Account({ form, act }: BodyProps) {
  const read = useDataQuery<{ account: AccountRead | null }>(accountQuery, undefined, { keep: true });
  if (read.status === 'loading') return <Loading />;
  const account = read.status === 'live' ? read.data?.account : null;
  if (!account) return <Unavailable what="account" />;
  const passkeys = account.passkeys.filter((key) => !key.ended).length, browsers = account.sessions.filter((session) => !session.ended).length;
  const devices = account.notifications?.devices.length ?? 0;
  const counts = [count(passkeys, 'passkey'), count(browsers, 'signed-in browser'), count(devices, 'notification device')];
  if (form === 'compact') return <p className="board-brief">{counts.join(' · ')}</p>;
  if (form === 'side') return (
    <>
      <p className="board-lead">{account.member}</p>
      <dl>
        <dt>Passkeys</dt><dd>{counts[0]}</dd>
        <dt>Signed-in browsers</dt><dd>{counts[1]}</dd>
        <dt>Notifications</dt><dd>{counts[2]}</dd>
      </dl>
      <p className="text-muted-foreground">Make this brick big to change them.</p>
    </>
  );
  return <Whole account={account} act={act} />;
}

/** A question before something is removed: nothing is sent until the member says yes. */
function Ask({ words, yes, busy, onYes, onNo }: { words: string; yes: string; busy: boolean; onYes(): void; onNo(): void }) {
  return (
    <span className="board-line" role="group" aria-label={words}>
      <span>{words}</span>
      <button type="button" className="board-action" disabled={busy} onClick={onYes}>{yes}</button>
      <button type="button" className="board-action" disabled={busy} onClick={onNo}>Keep</button>
    </span>
  );
}

function Whole({ account, act }: { account: AccountRead; act: Act }) {
  const zone = useHouseholdZone();
  const [asking, setAsking] = useState<string>(), [busy, setBusy] = useState(false), [message, say] = useState('');
  const notify = useDeviceNotifications(account.notifications ?? null);
  /** One change at a time. The board is told once the operation took it, and never when this browser was signed out. */
  const change = async (action: string, failed: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); say('');
    try {
      if ((await work()) === 'signed-out') return;
      setAsking(undefined); act(action, {}); say('Saved.');
    } catch { say(failed); } finally { setBusy(false); }
  };
  const lost = 'Could not save. Check the connection and try again.';
  const active = account.passkeys.filter((key) => !key.ended);
  const signOut = async () => {
    if (busy) return;
    setBusy(true); say('');
    try { await post('/logout', {}); location.reload(); } catch { say('Could not sign out. Check the connection and try again.'); setBusy(false); }
  };
  return (
    <>
      <p className="board-lead">{account.member}</p>
      {message && <p role="status">{message}</p>}

      <h4>Passkeys</h4>
      {!account.passkeys.length && <p className="text-muted-foreground">No passkeys yet.</p>}
      <ul className="board-notes">
        {account.passkeys.map((key) => (
          <li key={key.ref}>
            <span className="board-line" style={{ marginTop: 0 }}>
              <span>{key.label}</span><span className="board-state">{key.ended ? 'Stopped' : 'Active'}</span>
              {asking !== 'passkey:' + key.ref && <button type="button" className="board-action" disabled={busy} aria-label={`Remove passkey ${key.label}`} onClick={() => setAsking('passkey:' + key.ref)}>Remove passkey…</button>}
            </span>
            <small>Added {fullTime(key.createdAt, zone)}{key.lastUsedAt ? ` · Last used ${fullTime(key.lastUsedAt, zone)}` : ''}</small>
            {asking === 'passkey:' + key.ref && (
              <Ask busy={busy} yes="Remove passkey" onNo={() => setAsking(undefined)}
                words={`Remove this passkey? The browsers it signed in are signed out.${!key.ended && active.length === 1 ? ' It is your only active passkey.' : ''}`}
                onYes={() => void change('removePasskey', lost, () => memberOperation('account.removePasskey', { ref: key.ref }))} />
            )}
          </li>
        ))}
      </ul>
      <AddPasskey enabled={!busy} />

      <h4>Signed-in browsers</h4>
      <ul className="board-notes">
        {account.sessions.map((session) => (
          <li key={session.ref}>
            <span className="board-line" style={{ marginTop: 0 }}>
              <span>{deviceLabel(session.device)}</span><span className="board-state">{session.ended ? 'Ended' : 'Signed in'}</span>
              {asking !== 'browser:' + session.ref && <button type="button" className="board-action" disabled={busy} aria-label={`Sign out ${deviceLabel(session.device)}`} onClick={() => setAsking('browser:' + session.ref)}>Sign out browser…</button>}
            </span>
            <small>Last used {fullTime(session.seenAt, zone)}</small>
            {asking === 'browser:' + session.ref && (
              <Ask busy={busy} yes="Sign out browser" onNo={() => setAsking(undefined)}
                words="Sign this browser out? If it is the one you are using, you will have to sign in again here."
                onYes={() => void change('revokeSession', 'Could not confirm sign-out. Check your sign-in and connection.', () => sessionChange('account.revokeSession', { ref: session.ref }))} />
            )}
          </li>
        ))}
      </ul>

      <h4>Notifications</h4>
      <p role="status">{NOTIFICATION_WORDS[notify.state]}</p>
      {notify.state === 'off' && (
        <button type="button" className="board-action" disabled={busy || notify.busy} onClick={async () => { if (await notify.on()) act('enableNotifications', {}); }}>Turn on notifications on this device</button>
      )}
      {notify.error && <p role="alert" className="text-destructive">{notify.error}</p>}
      <ul className="board-notes">
        {(account.notifications?.devices ?? []).map((device) => (
          <li key={device.ref}>
            <span className="board-line" style={{ marginTop: 0 }}>
              <span>{deviceLabel(device.device)}</span>{device.ref === notify.ref && <span className="board-state">This device</span>}
              {asking !== 'device:' + device.ref && <button type="button" className="board-action" disabled={busy} aria-label={`Remove notification device ${deviceLabel(device.device)}`} onClick={() => setAsking('device:' + device.ref)}>Remove notification device…</button>}
            </span>
            <small>Last confirmed {fullTime(device.seenAt, zone)}</small>
            {asking === 'device:' + device.ref && (
              <Ask busy={busy} yes="Remove notification device" onNo={() => setAsking(undefined)}
                words="Stop notifications on this device? It can be turned on again only from that device."
                onYes={() => void change('removeDevice', lost, () => removeNotificationDevice(device.ref))} />
            )}
          </li>
        ))}
      </ul>

      <h4>Sign in another device</h4>
      <DeviceLink member={account.member} enabled={!busy} />

      <h4>This device</h4>
      {asking === 'logout'
        ? <Ask busy={busy} yes="Sign out this device" words="Sign out of loom on this device?" onYes={() => void signOut()} onNo={() => setAsking(undefined)} />
        : <button type="button" className="board-action" disabled={busy} onClick={() => setAsking('logout')}>Sign out this device…</button>}
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
    <form aria-label="Add a passkey" onSubmit={(event) => void submit(event)}>
      <p className="text-muted-foreground">{PASSKEY_WORDS}</p>
      <label className="board-line"><span>Passkey name</span>
        <input className="board-input" aria-label="Passkey name" required maxLength={60} value={label} disabled={!enabled || busy} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" className="board-action" disabled={!enabled || busy}>{busy ? 'Waiting for device…' : 'Add a passkey'}</button>
      </label>
      {message && <p role="status">{message}</p>}
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
    <section aria-label="Sign in another device">
      <p className="text-muted-foreground">{DEVICE_LINK_WORDS.about(member)}</p>
      <button type="button" className="board-action" disabled={!enabled || busy} onClick={() => void make()}>Make sign-in link</button>
      {link && (
        <>
          <p role="status" data-signin-link style={{ overflowWrap: 'anywhere' }}>{new URL(link, location.origin).href}</p>
          <button type="button" className="board-action" onClick={() => setLink(undefined)}>Hide sign-in link</button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
