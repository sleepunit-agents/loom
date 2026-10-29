// The Passkeys page's own controls, beside its list (src/ui/handler.ts /passkeys): adding a passkey on this
// device (WebAuthn, the same calls loom's sign-in uses: src/ui/passkeys.ts) and push for Your call (src/ui/push.ts).
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

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
export function PasskeyAdd({ add, reload }: { add: { csrf: string } | { note: string }; reload: () => void }) {
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && !!(window.PublicKeyCredential && navigator.credentials);
  if ('note' in add) return <Card><CardContent className="py-4 text-sm opacity-80">{add.note}</CardContent></Card>;
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
  return (
    <Card><CardHeader><CardTitle>Add a passkey</CardTitle><CardDescription>On this device: it signs in with its own lock (Face ID, a fingerprint, a PIN).</CardDescription></CardHeader>
      <CardContent className="grid gap-3">
        <Input maxLength={60} placeholder="Name it, like Jonathan's phone" aria-label="Name" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button disabled={!supported || busy} onClick={go}>{busy ? 'Waiting for the device…' : 'Add a passkey'}</Button>
        {!supported && <p className="text-sm opacity-80">This browser has no passkeys.</p>}
        {msg && <p role="status" className={`text-sm ${msg.bad ? 'text-[color:var(--v-danger-fill,#b42c22)]' : 'opacity-80'}`}>{msg.text}</p>}
      </CardContent>
    </Card>
  );
}

/** Push for Your call on this device: a notification when something new needs you; a tap opens it on Home. */
export function PushSwitch({ csrf }: { csrf: string }) {
  const can = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (can) void navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setSub).catch(() => setSub(null)); }, [can]);
  const send = (path: string, s: PushSubscriptionJSON) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: csrf, sub: s }) });
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
    } catch (e) { setMsg(`That failed: ${why(e)}`); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader><CardTitle>Notifications</CardTitle><CardDescription>Your call, on this device: a notification when something new needs you, and a tap opens it on Home.</CardDescription></CardHeader>
      <CardContent className="grid gap-3">
        {!can ? <p className="text-sm opacity-80">Needs loom over https; on an iPhone, loom added to the Home Screen first.</p> : (
          <>
            <p className="text-sm opacity-80">{sub === undefined ? '…' : sub ? 'On: Your call reaches this device.' : 'Off on this device.'}</p>
            <Button variant={sub ? 'outline' : 'default'} disabled={busy || sub === undefined} onClick={flip}>{sub ? 'Turn off on this device' : 'Turn on for this device'}</Button>
          </>
        )}
        {msg && <p role="status" className="text-sm">{msg}</p>}
      </CardContent>
    </Card>
  );
}
