// The account menu's button (account-menu.tsx opens it): the member's avatar, name and role.
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { iconFor } from './safe';

/** A member's name as a person reads it: a slug (jonathan) gets its capital. */
export const nameOf = (slug: string) => (/^[a-z0-9-]+$/.test(slug) ? slug.replace(/^./, (c) => c.toUpperCase()) : slug);

/** The member's avatar, as the dock, the side and the account draw it. */
export function MeAvatar({ name, size = 40, className }: { name: string; size?: number; className?: string }) {
  return (
    <Avatar variant="pink" className={className} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>
      <AvatarFallback>{name[0]?.toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

export function AccountButton({ owner, sub, ...props }: { owner: string; sub: string } & React.ComponentProps<'button'>) {
  return (
    <button type="button" {...props} className="flex w-full items-center gap-3 rounded-2xl p-1.5 text-left hover:bg-[var(--v-beige)]">
      <MeAvatar name={owner} size={36} className="shrink-0" />
      <span className="grid min-w-0 flex-1 leading-tight"><span className="truncate text-sm font-medium">{nameOf(owner)}</span><span className="text-xs opacity-70">{sub}</span></span>
      <AnimatedIcon name={iconFor('chevrons-up-down')} size="sm" />
    </button>
  );
}
