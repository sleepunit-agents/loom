// Profile (t-1925 G; the account before it, Jonathan 2026-11-03: "put the signed-in person's avatar on the dock as an
// icon that opens their account page"): who you are and how you sign in. Rarely visited: when you're here it's to add or
// remove a passkey, see your agents, or sign out. Its shape (Jonathan approved the mock, 2026-11-06, with the name top
// LEFT): in a big window two columns, the left your name then your passkeys with a normal-size "Add a passkey" in their
// header, the right your agents, notifications, another device and Sign out; in a narrow tile or on a phone, one column,
// name first. The width it answers is its own box (account.css), so a tile and a phone get the same rule.
// Signed-in devices were in the mock but aren't here: loom keeps no device or last-seen for a session (sessions.ts).
// Its own chunk, with its own CSS.
import { useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { iconFor } from './safe';
import { ActButton, AgentAvatar, BlockView, Link, type Mark } from './blocks';
import { PasskeyAdd, usePush } from './passkeys';
import { MeAvatar, nameOf } from './account-button';
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

const STATE: Record<AgentState, { word: string; badge: 'blue' | 'default' | 'yellow' | 'danger' }> = {
  working: { word: 'Working', badge: 'blue' }, available: { word: 'Quiet', badge: 'default' },
  unavailable: { word: 'Unavailable', badge: 'yellow' }, broken: { word: 'Broken', badge: 'danger' },
};

function Panel({ label, title, action, intro, children, className }: { label?: string; title?: string; action?: React.ReactNode; intro?: string; children?: React.ReactNode; className?: string }) {
  return (
    <section className={`loom-profile__panel ${className ?? ''}`} aria-label={title ?? label}>
      {(label || title || action) && (
        <header className="loom-profile__head">
          <span className="grid min-w-0">
            {label && <span className="loom-profile__eyebrow">{label}</span>}
            {title && <h2 className="loom-profile__title">{title}</h2>}
          </span>
          {action}
        </header>
      )}
      {intro && <p className="loom-profile__intro">{intro}</p>}
      {children}
    </section>
  );
}

/** A passkey, as loom lists it: its name, when it was used and added, and Remove (asking first). */
function KeyRow({ k }: { k: ListItem }) {
  return (
    <li className="loom-profile__row" data-tone={k.tone}>
      <span className="loom-profile__glyph" aria-hidden><AnimatedIcon name={iconFor('fingerprint-pattern')} size="sm" /></span>
      <span className="grid min-w-0">
        <span className="loom-profile__row-title">{k.text}</span>
        {k.meta && <span className="loom-profile__row-meta">{k.meta}</span>}
      </span>
      {k.act && <ActButton b={k.act} />}
    </li>
  );
}

/** Your call on this device (passkeys.tsx usePush), as one of Profile's panels: what it is, whether it's on, the switch. */
function Push({ csrf }: { csrf: string }) {
  const { can, sub, msg, busy, flip } = usePush(csrf);
  return (
    <Panel label="Notifications" intro="Your call, on this device: a notification when something new needs you; a tap opens it on Home.">
      {!can ? <p className="loom-profile__row-meta">Needs loom over https; on an iPhone, loom added to the Home Screen first.</p> : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="loom-profile__row-meta">{sub === undefined ? '…' : sub ? 'On: Your call reaches this device.' : 'Off on this device.'}</span>
          <Button size="sm" variant={sub ? 'outline' : 'default'} disabled={busy || sub === undefined} onClick={() => void flip()}>{sub ? 'Turn off on this device' : 'Turn on for this device'}</Button>
        </div>
      )}
      {msg && <p role="status" className="loom-profile__row-meta mt-2">{msg}</p>}
    </Panel>
  );
}

export function AccountView({ me, csrf, add, reload, page }: {
  me: Me; csrf: string; add: { csrf: string } | { note: string }; reload: () => void; page: Page;
}) {
  const [adding, setAdding] = useState(false);
  const keys = page.sections.find((s) => s.id === 'passkeys');
  const rest = page.sections.filter((s) => s.id !== 'passkeys');
  const listed: ListItem[] = keys?.blocks.flatMap((b) => (b.type === 'list' ? (b.items as ListItem[]) : [])) ?? [];
  const other = keys?.blocks.filter((b) => b.type !== 'list') ?? [];
  const canAdd = 'csrf' in add;
  const display = me.full ?? nameOf(me.name);
  return (
    <div className="loom-profile">
      <div className="loom-profile__grid">
        <div className="loom-profile__col">
          <section className="loom-profile__panel loom-profile__me" aria-label="You">
            <MeAvatar name={display} size={64} className="loom-profile__avatar shrink-0" />
            <span className="grid min-w-0 leading-tight">
              <h1 className="loom-profile__name" data-profile-name>{display}</h1>
              <span className="loom-profile__role">{me.role}{me.since ? ` · member since ${me.since}` : ''}</span>
            </span>
          </section>
          <Panel className="loom-profile__keys" label="Sign in" title="Passkeys" intro="Keep at least two, on different devices, so losing one never locks you out."
            action={canAdd && !adding ? <Button size="sm" variant="outline" className="loom-profile__add" onClick={() => setAdding(true)}>
              <AnimatedIcon name={iconFor('plus')} size="sm" />Add a passkey</Button> : undefined}>
            {(adding || !canAdd) && <div className="loom-profile__adding"><PasskeyAdd add={add} reload={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} /></div>}
            {listed.length ? <ul className="loom-profile__rows">{listed.map((k) => <KeyRow key={`${k.text}\0${k.act?.fields?.id ?? ''}`} k={k} />)}</ul> : null}
            {other.map((b, i) => <BlockView key={i} b={b} />)}
          </Panel>
        </div>
        <div className="loom-profile__col">
          {me.agents && me.agents.length > 0 && (
            <Panel label="Your agents">
              <ul className="loom-profile__rows">
                {me.agents.map((a) => (
                  <li key={a.id} className="loom-profile__row">
                    <AgentAvatar a={a} size={36} state={a.state === 'working' ? 'working' : a.state === 'broken' ? 'error' : 'idle'} />
                    <Link page={`loom:a/${a.id}`} className="grid min-w-0 no-underline">
                      <span className="loom-profile__row-title">{a.label}</span>
                      <span className="loom-profile__row-meta">You own this agent</span>
                    </Link>
                    <Badge variant={STATE[a.state].badge as never}>{STATE[a.state].word}</Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Push csrf={csrf} />
          {rest.map((s: Section) => (
            <Panel key={s.id} label={s.title}>{s.blocks.map((b, i) => <BlockView key={i} b={b} />)}</Panel>
          ))}
          <form method="post" action="/logout" className="loom-profile__out"><input type="hidden" name="_csrf" value={csrf} />
            <Button type="submit" variant="danger" size="sm" className="gap-2"><AnimatedIcon name={iconFor('log-out')} size="sm" />Sign out</Button>
          </form>
        </div>
      </div>
    </div>
  );
}
