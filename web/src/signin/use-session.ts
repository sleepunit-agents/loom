import { useEffect, useState } from 'react';
import { reconnectDelay, checkSessionEvent, setDeskMember } from '../data/connection';
const enc = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const dec = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) =>
    c.charCodeAt(0),
  );
async function post(url: string, body: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'Sign-in failed');
  return j;
}

export function useSession() {
  const [session, setSession] = useState<{ viewer: { id: string } | null; csrf?: string } | undefined>(),
    [message, say] = useState('');
  const [changedMember, setChangedMember] = useState(false);
  useEffect(() => {
    if (changedMember) location.reload();
  }, [changedMember]);
  useEffect(() => {
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      attempt = 0,
      checking = false;
    let member: string | null | undefined, deskOwner: string | undefined;
    let meta: HTMLMetaElement | undefined;
    async function check() {
      if (lifetime.signal.aborted || checking || timer !== undefined) return;
      checking = true;
      try {
        const response = await fetch('/auth/session', {
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw Error();
        const value = await response.json();
        if (!value || !(value.viewer === null || typeof value.viewer?.id === 'string')) throw Error();
        if (lifetime.signal.aborted) return;
        const id = value.viewer?.id ?? null;
        if (deskOwner && id !== null && deskOwner !== id) {
          lifetime.abort();
          if (meta) meta.content = '';
          setDeskMember(null);
          setSession(undefined);
          say('Your account changed. Reload to open its desk.');
          setChangedMember(true);
          return;
        }
        if (id !== null) deskOwner = id;
        if (!meta) {
          meta = document.createElement('meta');
          meta.name = 'loom-csrf';
          document.head.append(meta);
        }
        meta.content = value.csrf ?? '';
        attempt = 0;
        if (member === id) return;
        member = id;
        setDeskMember(id);
        setSession(value);
        say('');
      } catch {
        if (lifetime.signal.aborted) return;
        if (member === undefined) say('Could not reach loom. Reconnecting…');
        timer = setTimeout(() => {
          timer = undefined;
          void check();
        }, reconnectDelay(attempt++));
      } finally {
        checking = false;
      }
    }
    const visible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const poll = setInterval(visible, 60_000);
    globalThis.document?.addEventListener?.('visibilitychange', visible);
    globalThis.window?.addEventListener('focus', check);
    globalThis.window?.addEventListener(checkSessionEvent, check);
    void check();
    return () => {
      lifetime.abort();
      clearTimeout(timer);
      clearInterval(poll);
      setDeskMember(null);
      meta?.remove?.();
      globalThis.document?.removeEventListener?.('visibilitychange', visible);
      globalThis.window?.removeEventListener('focus', check);
      globalThis.window?.removeEventListener(checkSessionEvent, check);
    };
  }, []);
  const login = async () => {
    try {
      const o = await post('/login/passkey/options', {});
      const c = (await navigator.credentials.get({
        publicKey: {
          challenge: dec(o.challenge),
          rpId: o.rpId,
          userVerification: 'required',
          timeout: o.timeout,
        },
      })) as PublicKeyCredential;
      const r = c.response as AuthenticatorAssertionResponse;
      await post('/login/passkey', {
        id: enc(c.rawId),
        clientDataJSON: enc(r.clientDataJSON),
        authenticatorData: enc(r.authenticatorData),
        signature: enc(r.signature),
      });
      location.reload();
    } catch (e) {
      say(e instanceof Error ? e.message : 'Sign-in cancelled');
    }
  };
  return { session, message, login };
}
