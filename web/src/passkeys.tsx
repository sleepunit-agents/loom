// Profile's own controls (account.tsx; src/ui/handler.ts /account, /passkeys): adding a passkey on this device
// (WebAuthn, the same calls loom's sign-in uses: src/ui/passkeys.ts) and push for Your call (src/ui/push.ts).
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Callout } from './safe';

const enc = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const why = (e: unknown) => {
  const x = e as { name?: string; message?: string };
  return x?.name === 'NotAllowedError' ? 'Cancelled.' : x?.name === 'InvalidStateError' ? 'This device already has a passkey here.' : String(x?.message ?? e);
};

/** Add a passkey on this device, or the reason it can't be done here (loom's note). */
export function PasskeyAdd({ add, reload, onCancel }: { add: { csrf: string } | { note: string }; reload: () => void; onCancel?: () => void }) {
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && !!(window.PublicKeyCredential && navigator.credentials);
  if ('note' in add) return <Callout icon="fingerprint-pattern" title="Adding a passkey isn’t possible here">{add.note}</Callout>;
  const go = async () => {
    setBusy(true); setMsg(null);
    try {
      const o = await post('/passkeys/options', { _csrf: add.csrf });
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: dec(o.challenge), rp: o.rp, user: { ...o.user, id: dec(o.user.id) }, pubKeyCredParams: o.pubKeyCredParams,
        authenticatorSelection: o.authenticatorSelection, timeout: o.timeout, attestation: 'none',
        excludeCredentials: o.excludeCredentials.map((c: { id: string }) => ({ type: 'public-key' as const, id: dec(c.id) })),
      } }) as PublicKeyCredential;
      const r = cred.response as AuthenticatorAttestationResponse;
      if (!r.getPublicKey || !r.getAuthenticatorData) throw new Error('This browser can\'t hand over the passkey\'s key; try a current Safari, Chrome or Firefox.');
      await post('/passkeys', { _csrf: add.csrf, label: label.trim(), id: enc(cred.rawId), clientDataJSON: enc(r.clientDataJSON),
        authenticatorData: enc(r.getAuthenticatorData()), publicKey: enc(r.getPublicKey()!), publicKeyAlgorithm: r.getPublicKeyAlgorithm() });
      setLabel(''); setMsg({ bad: false, text: 'Added.' }); reload();
    } catch (e) { setMsg({ bad: true, text: why(e) }); } finally { setBusy(false); }
  };
  // Opened from the Passkeys header's "Add a passkey" (account.tsx): name it, then the device asks for its lock.
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <p className="text-sm opacity-80">On this device: it signs in with its own lock (Face ID, a fingerprint, a PIN).</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input autoFocus maxLength={60} placeholder="Name it, like Jonathan's phone" aria-label="Name" className="min-w-0 flex-1 basis-48" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button type="submit" size="sm" disabled={!supported || busy}>{busy ? 'Waiting for the device…' : 'Add'}</Button>
        {onCancel && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>}
      </div>
      {!supported && <p className="text-sm opacity-80">This browser has no passkeys.</p>}
      {msg && <p role="status" className={`text-sm ${msg.bad ? 'text-[color:var(--v-danger-fill)]' : 'opacity-80'}`}>{msg.text}</p>}
    </form>
  );
}

/**
 * This device's push for Your call: can it (a secure page with a service worker and PushManager), is it on, and the
 * switch. Shared by Profile's Notifications panel (account.tsx) and the ask on every page (PushAsk).
 */
export function usePush(csrf: string, onChange?: () => void) {
  const can = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = (path: string, s: PushSubscriptionJSON, again = false) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: csrf, sub: s, ...(again ? { again: true } : {}) }) });
  useEffect(() => {
    if (!can) return;
    void navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(async (s) => {
      // What this device holds, sent again once per app load (t-1978): loom's record of it can be lost while the
      // device still says On, and nothing would ever send it again. One its person removed on Profile is refused, and
      // turned off here too, so this switch says what's true.
      if (s && csrf && !resent) {
        resent = true;
        const r = await send('/push/subscribe', s.toJSON(), true).catch(() => null);
        if (r?.status === 409 && (await r.json().catch(() => ({}))).removed) { await s.unsubscribe().catch(() => undefined); setSub(null); return; }
      }
      setSub(s);
    }).catch(() => setSub(null));
  }, [can, csrf]);
  const flip = async () => {
    setBusy(true); setMsg(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (sub) { const s = sub.toJSON(); await sub.unsubscribe(); await send('/push/unsubscribe', s); setSub(null); return; }
      if (await Notification.requestPermission() !== 'granted') { setMsg('Notifications are blocked for this site in the browser settings.'); return; }
      const { publicKey } = await (await fetch('/push/key', { credentials: 'same-origin' })).json();
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: dec(publicKey) });
      const r = await send('/push/subscribe', s.toJSON());
      if (!r.ok) { const e = (await r.json().catch(() => ({}))).error || 'loom said no'; await s.unsubscribe(); setMsg(e); return; }
      setSub(s);
    } catch (e) { setMsg(`That failed: ${why(e)}`); } finally { setBusy(false); onChange?.(); }
  };
  return { can, sub, msg, busy, flip };
}
/** This app load already sent the device's subscription again (usePush): once is enough. */
let resent = false;

const ASKED = 'loom.push-asked';
const ASK_AGAIN_MS = 30 * 86_400_000;
/** An iPhone or iPad in a browser tab: web push needs loom added to the Home Screen and opened from there. */
const iosTab = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent)
  && !(navigator as Navigator & { standalone?: boolean }).standalone && !matchMedia('(display-mode: standalone)').matches;

/**
 * The ask (Jonathan, 2026-10-31: "I've never been asked afaik"): the switch lived on the Passkeys page, so no device
 * ever turned push on, and an alert in loom reached nobody. On any page, a device that could get Your call and
 * doesn't is asked once (Not now: again in 30 days); an iPhone in a Safari tab is told how to make it able to.
 */
export function PushAsk({ csrf }: { csrf: string }) {
  const { can, sub, msg, busy, flip } = usePush(csrf);
  const [hidden, setHidden] = useState(() => {
    try { return Date.now() - Number(localStorage.getItem(ASKED) || 0) < ASK_AGAIN_MS; } catch { return false; }
  });
  const later = () => { try { localStorage.setItem(ASKED, String(Date.now())); } catch { /* private mode */ } setHidden(true); };
  if (hidden) return null;
  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  if (can && (sub === undefined || sub || denied)) return null;
  if (!can && !(iosTab() && window.isSecureContext)) return null;
  return (
    <Card className="mb-4 min-w-0">
      <CardHeader><CardTitle>Get alerts on this {/iPhone|Android|Mobile/.test(navigator.userAgent) ? 'phone' : 'device'}</CardTitle>
        <CardDescription>{can ? 'A notification when something needs you: an alert, a permission, a to-do. A tap opens it here.'
          : 'An iPhone sends notifications only for an app on the Home Screen: tap Share, then Add to Home Screen, and open loom from its icon. This card asks again there.'}</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {can && <Button disabled={busy} onClick={() => void flip()}>Turn on</Button>}
        <Button variant="outline" onClick={later}>{can ? 'Not now' : 'Got it'}</Button>
        {msg && <p role="status" className="w-full text-sm">{msg}</p>}
      </CardContent>
    </Card>
  );
}
