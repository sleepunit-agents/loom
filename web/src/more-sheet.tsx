// The phone's More drawer (000h's drawer) around its menu (more-menu.tsx). Its own chunk, with the drawer's dialog,
// focus trap and scroll lock: the first screen never draws it (web-app.test.ts, the first page's weight). App.tsx
// mounts it the first time More is pressed and keeps it for its closing motion.
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import MoreMenu from './more-menu';

type Tab = { label: string; href: string; current: boolean; count?: number };
type Agent = { id: string; label: string; bg: string; fg: string; href: string; asks?: number };

export default function MoreSheet({ open, onOpenChange, here, pages, agents, icon, go, chat }: {
  open: boolean; onOpenChange: (o: boolean) => void; here?: string; pages: Tab[]; agents: Agent[]; icon: (label: string) => string; go: (href: string) => void;
  chat?: () => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader><DrawerTitle>More</DrawerTitle>{here && <DrawerDescription>{here}'s other pages</DrawerDescription>}</DrawerHeader>
        {open && <MoreMenu pages={pages} agents={agents} here={here} icon={icon} go={go} chat={chat} />}
      </DrawerContent>
    </Drawer>
  );
}
