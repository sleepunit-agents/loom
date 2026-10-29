// The account menu's button (account-menu.tsx opens it): the member's avatar, name and role.
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { iconFor } from './safe';

export function AccountButton({ owner, sub, ...props }: { owner: string; sub: string } & React.ComponentProps<'button'>) {
  return (
    <button type="button" {...props} className="flex w-full items-center gap-3 rounded-2xl p-1.5 text-left hover:bg-[var(--v-beige)]">
      <Avatar variant="pink" className="size-9 shrink-0"><AvatarFallback>{owner[0]?.toUpperCase()}</AvatarFallback></Avatar>
      <span className="grid min-w-0 flex-1 leading-tight"><span className="truncate text-sm font-medium">{owner}</span><span className="text-xs opacity-70">{sub}</span></span>
      <AnimatedIcon name={iconFor('chevrons-up-down')} size="sm" />
    </button>
  );
}
