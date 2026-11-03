// Who's signed in, at the foot of the side: 000h's dropdown menu (the member's own: their account, Sign out) opening above
// it. Setup is the side's own row, so it isn't here too.
// Its own chunk (Radix's menu and positioning); the side shows the same button until it lands.
import { useRef } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { iconFor } from './safe';
import { AccountButton, nameOf } from './account-button';
import { ACCOUNT } from './nav';


export default function AccountMenu({ owner, sub, csrf, go }: { owner: string; sub: string; csrf: string; go: (href: string) => void }) {
  const out = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={out} method="post" action="/logout" hidden><input type="hidden" name="_csrf" value={csrf} /></form>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><AccountButton owner={owner} sub={sub} /></DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <DropdownMenuLabel>{nameOf(owner)}</DropdownMenuLabel>
          {ACCOUNT.map((a) => <DropdownMenuItem key={a.href} onSelect={() => go(a.href)}><AnimatedIcon name={iconFor('circle-user-round')} size="sm" />{a.label}</DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => out.current?.submit()}><AnimatedIcon name={iconFor('log-out')} size="sm" />Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
