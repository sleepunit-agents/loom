// Who's signed in, at the foot of the side: 000h's dropdown menu (Setup, Passkeys, Sign out) opening above it.
// Its own chunk (Radix's menu and positioning); the side shows the same button until it lands.
import { useRef } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { iconFor } from './safe';
import { AccountButton } from './account-button';


export default function AccountMenu({ owner, sub, csrf, go }: { owner: string; sub: string; csrf: string; go: (href: string) => void }) {
  const out = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={out} method="post" action="/logout" hidden><input type="hidden" name="_csrf" value={csrf} /></form>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><AccountButton owner={owner} sub={sub} /></DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <DropdownMenuLabel>{owner}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => go('/setup')}><AnimatedIcon name={iconFor('settings')} size="sm" />Setup</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go('/passkeys')}><AnimatedIcon name={iconFor('key-round')} size="sm" />Passkeys</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => out.current?.submit()}><AnimatedIcon name={iconFor('log-out')} size="sm" />Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
