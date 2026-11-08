// Profile (t-1925 G; the account before it, Jonathan 2026-11-03: "put the signed-in person's avatar on the dock as an
// icon that opens their account page"): who you are and how you sign in. Rarely visited: when you're here it's to add or
// remove a passkey, see your agents, or sign out. Its shape (Jonathan approved the mock, 2026-11-06, with the name top
// LEFT): in a big window two columns, the left your name then your passkeys with a normal-size "Add a passkey" in their
// header, the right your agents, notifications, another device and Sign out; in a narrow tile or on a phone, one column,
// name first. The width it answers is its own box (account.css), so a tile and a phone get the same rule.
// Signed in (t-1871): each browser session on its own row, this device first, each with its own Sign out (sessions.ts
// keeps what a session was opened on and when it was last used).
// Its own chunk, with its own CSS.
import { useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { iconFor } from './safe';
import { ActButton, AgentAvatar, BlockView, Link, type Mark } from './blocks';
import { PasskeyAdd, usePush } from './passkeys';
import { MeAvatar, nameOf } from './account-button';
import { STATE } from './views';
import type { ListItem, Page, Section } from './loom';
import './account.css';

type AgentState = 'working' | 'available' | 'unavailable' | 'broken';
export interface Me {
  name: string; role: string;
  /** Their name as People has it (Jonathan Barket); else the slug, capitalised. */
  full?: string;
  /** When they became a member: "Aug 2026". */
  since?: string;
  agents?: Array<Mark & { id: string; state: AgentState }>;
}

/** The badge's colour for a state; the word and the face's expression are the agent pages' own (views.tsx STATE). */
const BADGE: Record<AgentState, 'blue' | 'default' | 'yellow' | 'danger'> = { working: 'blue', available: 'default', unavailable: 'yellow', broken: 'danger' };

function Pane({ label, title, action, intro, children, className }: { label?: string; title?: string; action?: React.ReactNode; intro?: string; children?: React.ReactNode; className?: string }) {
  return (
    <section className={`loom-acct__panel ${className ?? ''}`} aria-label={title ?? label}>
      {(label || title || action) && (
        <header className="loom-acct__head">
          <span className="grid min-w-0">
            {label && <span className="loom-acct__eyebrow">{label}</span>}
            {title && <h2 className="loom-acct__title">{title}</h2>}
          </span>
          {action}
        </header>
      )}
      {intro && <p className="loom-acct__intro">{intro}</p>}
      {children}
    </section>
  );
}

/** A passkey, as loom lists it: its name, when it was used and added, and Remove (asking first). A signed-in session is
 * the same row with a device for its glyph: what it is, when it signed in and was last used, and Sign out. */
function KeyRow({ k, icon = 'fingerprint-pattern' }: { k: ListItem; icon?: string }) {
  return (
    <li className="loom-acct__row" data-tone={k.tone}>
      <span className="loom-acct__glyph" aria-hidden><AnimatedIcon name={iconFor(icon)} size="sm" /></span>
      <span className="grid min-w-0">
        <span className="loom-acct__row-title">{k.text}</span>
        {k.meta && <span className="loom-acct__row-meta">{k.meta}</span>}
      </span>
      {k.act && <ActButton b={k.act} />}
    </li>
  );
}

/** Your call on this device (passkeys.tsx usePush), as one of Profile's panels: what it is, whether it's on, the switch. */
function Push({ csrf, devices, reload }: { csrf: string; devices?: Section; reload: () => void }) {
  const { can, sub, msg, busy, flip } = usePush(csrf, reload);
  return (
    <Pane label="Notifications" intro="Your call, on this device: a notification when something new needs you; a tap opens it on Home.">
      {!can ? <p className="loom-acct__row-meta">Needs loom over https; on an iPhone, loom added to the Home Screen first.</p> : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="loom-acct__row-meta">{sub === undefined ? '…' : sub ? 'On: Your call reaches this device.' : 'Off on this device.'}</span>
          <Button size="sm" variant={sub ? 'outline' : 'default'} disabled={busy || sub === undefined} onClick={() => void flip()}>{sub ? 'Turn off on this device' : 'Turn on for this device'}</Button>
        </div>
      )}
      {msg && <p role="status" className="loom-acct__row-meta mt-2">{msg}</p>}
      {/* Every device of yours that gets them (t-1978), each with a test to send it; Remove for a lost one. */}
      {devices && <div className="mt-3 grid gap-2" data-push-devices>
        <span className="loom-acct__eyebrow">{devices.title}</span>
        {devices.blocks.map((b, i) => (b.type === 'list'
          ? <ul key={i} className="loom-acct__rows">{(b.items as ListItem[]).map((k) => <KeyRow key={k.act?.fields?.ref ?? k.text} k={k} icon="bell" />)}</ul>
          : <BlockView key={i} b={b} />))}
      </div>}
    </Pane>
  );
}

export function AccountView({ me, csrf, add, reload, page }: {
  me: Me; csrf: string; add: { csrf: string } | { note: string }; reload: () => void; page: Page;
}) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const keys = page.sections.find((s) => s.id === 'passkeys');
  const sessions = page.sections.find((s) => s.id === 'sessions');
  const devices = page.sections.find((s) => s.id === 'notifications');
  const rest = page.sections.filter((s) => s.id !== 'passkeys' && s.id !== 'sessions' && s.id !== 'notifications');
  const listed: ListItem[] = keys?.blocks.flatMap((b) => (b.type === 'list' ? (b.items as ListItem[]) : [])) ?? [];
  const other = keys?.blocks.filter((b) => b.type !== 'list') ?? [];
  const canAdd = 'csrf' in add;
  const display = me.full ?? nameOf(me.name);
  return (
    <div className="loom-acct">
      <div className="loom-acct__grid">
        <div className="loom-acct__col">
          <section className="loom-acct__panel loom-acct__me" aria-label="You">
            <MeAvatar name={display} size={64} className="loom-acct__avatar shrink-0" />
            <span className="grid min-w-0 leading-tight">
              <h1 className="loom-acct__name" data-profile-name>{display}</h1>
              <span className="loom-acct__role">{me.role}{me.since ? ` · member since ${me.since}` : ''}</span>
            </span>
          </section>
          <Pane className="loom-acct__keys" label="Sign in" title={keys?.title ?? 'Passkeys'} intro="Keep at least two, on different devices, so losing one never locks you out."
            action={canAdd && !adding ? <Button size="sm" variant="outline" className="loom-acct__add" onClick={() => { setAdded(false); setAdding(true); }}>
              <AnimatedIcon name={iconFor('plus')} size="sm" />Add a passkey</Button> : undefined}>
            {(adding || !canAdd) && <div className="loom-acct__adding"><PasskeyAdd add={add} reload={() => { setAdding(false); setAdded(true); reload(); }} onCancel={() => setAdding(false)} /></div>}
            {added && !adding && <p role="status" className="loom-acct__row-meta">Added.</p>}
            {listed.length ? <ul className="loom-acct__rows">{listed.map((k) => <KeyRow key={`${k.text}\0${k.act?.fields?.id ?? ''}`} k={k} />)}</ul> : null}
            {other.map((b, i) => <BlockView key={i} b={b} />)}
          </Pane>
        </div>
        <div className="loom-acct__col">
          {me.agents && me.agents.length > 0 && (
            <Pane label="Your agents">
              <ul className="loom-acct__rows">
                {me.agents.map((a) => (
                  <li key={a.id} className="loom-acct__row">
                    <AgentAvatar a={a} size={36} state={STATE[a.state].status} />
                    <Link page={`loom:a/${a.id}`} className="grid min-w-0 no-underline">
                      <span className="loom-acct__row-title">{a.label}</span>
                      <span className="loom-acct__row-meta">You own this agent</span>
                    </Link>
                    <Badge variant={BADGE[a.state]}>{STATE[a.state].word}</Badge>
                  </li>
                ))}
              </ul>
            </Pane>
          )}
          <Push csrf={csrf} devices={devices} reload={reload} />
          {sessions && (
            <Pane className="loom-acct__sessions" label={sessions.title ?? 'Signed in'}>
              {sessions.blocks.map((b, i) => (b.type === 'list'
                ? <ul key={i} className="loom-acct__rows">{(b.items as ListItem[]).map((k) => <KeyRow key={k.act?.fields?.ref ?? k.text} k={k} icon="monitor-smartphone" />)}</ul>
                : <BlockView key={i} b={b} />))}
            </Pane>
          )}
          {rest.map((s: Section) => (
            <Pane key={s.id} label={s.title}>{s.blocks.map((b, i) => <BlockView key={i} b={b} />)}</Pane>
          ))}
          <form method="post" action="/logout" className="loom-acct__out"><input type="hidden" name="_csrf" value={csrf} />
            <Button type="submit" variant="danger" className="gap-2"><AnimatedIcon name={iconFor('log-out')} size="sm" />Sign out</Button>
          </form>
        </div>
      </div>
    </div>
  );
}
