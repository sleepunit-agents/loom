// The account (Jonathan, 2026-11-03: "put the signed-in person's avatar on the dock as an icon that opens their account
// page"): who's signed in and what they are in the household, their passkeys, push on this device, and signing out.
// A phone opens it from the avatar at the end of the dock; a desktop from the side's account menu. Its own chunk.
import { useRef, type ReactNode } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { iconFor } from './safe';
import { PasskeyAdd, PushSwitch } from './passkeys';
import { MeAvatar, nameOf } from './account-button';

export function AccountView({ me, csrf, add, reload, children }: {
  me: { name: string; role: string }; csrf: string; add: { csrf: string } | { note: string }; reload: () => void; children: ReactNode;
}) {
  const out = useRef<HTMLFormElement>(null);
  return (
    <div className="grid gap-4">
      <Card><CardContent className="flex items-center gap-4 py-5">
        <MeAvatar name={me.name} size={64} className="shrink-0" />
        <span className="grid min-w-0 leading-tight">
          <span className="truncate font-[family-name:var(--font-display)] text-2xl font-semibold">{nameOf(me.name)}</span>
          <span className="text-sm opacity-70">{me.role}</span>
        </span>
      </CardContent></Card>
      {/* The passkeys list and "another device", as loom answers them (the page's sections). */}
      {children}
      <PasskeyAdd add={add} reload={reload} />
      <PushSwitch csrf={csrf} />
      <form ref={out} method="post" action="/logout"><input type="hidden" name="_csrf" value={csrf} />
        <Button type="submit" variant="outline" className="w-full gap-2"><AnimatedIcon name={iconFor('log-out')} size="sm" />Sign out</Button>
      </form>
    </div>
  );
}
