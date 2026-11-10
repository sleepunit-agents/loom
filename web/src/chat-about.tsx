// Chat about this (t-2034, t-2035; about.ts): the sheet that starts it. What it's about and who it goes to are shown
// before anything is sent; the agent is the server's pick for this member (/comms/route), and the member can change it.
// Nothing is sent to anyone they didn't see named. A refused send keeps their words and says why. Its own chunk: App
// mounts it the first time something asks.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { newId } from './comms-id';
import type { About } from './about';
import './chat-about.css';

type Agent = { id: string; label: string; bg: string };
type Route = { agents: string[]; pick: string | null; why: 'item' | 'default' | 'only' | 'choose'; passed?: string };
const WHY: Record<Route['why'], string> = { item: 'its agent', default: 'your household\'s assistant', only: 'your agent', choose: '' };

export default function ChatAbout({ about, csrf, agents, onClose, go }: {
  about: (About & { seen: string }) | null; csrf: string; agents: Agent[]; onClose: () => void; go: (href: string) => void;
}) {
  const [existing, setExisting] = useState<Array<{ id: string; title: string | null }>>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState('');
  // A send refused or lost (the member's to fix by changing it), apart from loom not saying who to ask.
  const [error, setError] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // One id per sheet: pressing Send twice, or again after a lost answer, is the same thread (openThread's repeat).
  const id = useRef(newId());
  useEffect(() => {
    if (!about) return;
    id.current = newId();
    setRoute(null); setTo(null); setChanging(false); setText(''); setError(null); setRouteError(null);
    const q = about.agent ? `?agent=${encodeURIComponent(about.agent)}` : '';
    // A late answer for an item since closed never lands on the next one's sheet.
    const gone = new AbortController();
    void fetch(`/comms/route${q}`, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: gone.signal })
      .then(async (r) => (r.ok ? (await r.json()) as Route : Promise.reject(r.status)))
      .then((r) => { setRoute(r); setTo(r.pick); setChanging(r.pick === null); })
      .catch(() => { if (!gone.signal.aborted) setRouteError('loom can\'t say who to ask right now. Close this and try again in a moment.'); });
    return () => gone.abort();
  }, [about]);
  useEffect(() => {
    setExisting([]);
    if (!about || !to) return;
    const gone = new AbortController();
    const q = new URLSearchParams({ agent: to, ...(about.ref ? { ref: about.ref } : { page: about.page! }) });
    void fetch(`/comms/about?${q}`, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: gone.signal })
      .then(async (r) => r.ok ? await r.json() as { threads: Array<{ id: string; title: string | null }> } : { threads: [] })
      .then((r) => { if (!gone.signal.aborted) setExisting(r.threads); }).catch(() => {});
    return () => gone.abort();
  }, [about, to]);
  const name = (a: string) => agents.find((x) => x.id === a)?.label ?? a;
  const send = async () => {
    if (!about || !to || !text.trim() || sending) return;
    setSending(true); setError(null);
    try {
      const r = await fetch('/comms/new', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ agent: to, id: id.current, text, about: { label: about.label, seen: about.seen, ...(about.ref ? { ref: about.ref } : {}), ...(about.page ? { page: about.page } : {}) }, _csrf: csrf }) });
      const j = await r.json().catch(() => ({})) as { thread?: { id: string }; error?: string };
      if (!r.ok || !j.thread) { setError(String(j.error ?? 'That didn\'t start.').replace(/^[a-z-]+: /, '')); return; }
      onClose();
      go(`/comms/${j.thread.id.replace(/^th:/, '')}`);
    } catch { setError('loom can\'t be reached right now. Your words are still here.'); } finally { setSending(false); }
  };
  const where = about ? [about.ref?.replace(/^github:/, ''), about.page ? `/${about.page}` : null].filter(Boolean).join(' · ') : '';
  return (
    <Dialog open={!!about} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent appearance="editor" showCloseButton className="loom-chat-about">
        <DialogHeader>
          <DialogTitle>Chat about this</DialogTitle>
          <DialogDescription>A private chat about this item. The agent looks it up as it is now.</DialogDescription>
        </DialogHeader>
        {about && (
          <form className="loom-chat-about__form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <div className="loom-chat-about__item" aria-label="What it's about">
              <span className="loom-chat-about__label">{about.label}</span>
              <span className="loom-chat-about__where loom-data">{where} · as of {new Date(about.seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="loom-chat-about__to">
              <span className="loom-chat-about__to-word">To</span>
              {!route && !routeError && <span className="loom-data">Finding who to ask…</span>}
              {route && to && !changing && (
                <>
                  <span className="loom-chat-about__agent" data-agent={to}>{name(to)}</span>
                  {WHY[route.why] && to === route.pick && <span className="loom-chat-about__why">{WHY[route.why]}</span>}
                  {route.agents.length > 1 && <button type="button" className="loom-chat-about__change" onClick={() => setChanging(true)}>Change</button>}
                </>
              )}
              {route && changing && (
                <span className="loom-chat-about__pick" role="radiogroup" aria-label="Who to ask">
                  {route.agents.map((a) => (
                    <button key={a} type="button" role="radio" aria-checked={a === to} data-on={a === to || undefined}
                      onClick={() => { if (error) { id.current = newId(); setError(null); } setTo(a); setChanging(false); }}>{name(a)}</button>
                  ))}
                </span>
              )}
              {route && route.agents.length === 0 && <span>You have no agents to ask.</span>}
            </div>
            {route?.passed && <p className="loom-chat-about__note" role="note">{route.passed === '?' ? 'This names an agent you can\'t ask.' : `This belongs to ${name(route.passed)}, who isn't an agent you can ask.`} Pick who should look at it.</p>}
            {existing.map((t) => <Button key={t.id} type="button" variant="outline" onClick={() => { onClose(); go(`/comms/${t.id.replace(/^th:/, '')}`); }}>Continue in {t.title ?? `your thread with ${name(to!)}`}</Button>)}
            {existing.length > 0 && <p className="loom-chat-about__note">Or start a new thread below.</p>}
            <textarea className="loom-chat-about__text" value={text} onChange={(e) => {
              // Words changed after a send that failed: a new send, not the old one again (whose thread may exist).
              if (error) { id.current = newId(); setError(null); }
              setText(e.target.value);
            }} rows={4} maxLength={39_000}
              placeholder="What do you want to know?" aria-label="Your message"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
            {(error ?? routeError) && <p className="loom-chat-about__error" role="alert">{error ?? routeError}</p>}
            <div className="loom-chat-about__go">
              <Button type="submit" disabled={!to || !text.trim() || sending}>{sending ? 'Starting…' : to ? `Send to ${name(to)}` : 'Send'}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
