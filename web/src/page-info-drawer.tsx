// The page's explanation is needed only after its title is tapped. Keep the bar itself synchronous.
import { Button } from '@/components/ui/button';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';

export default function PageInfoDrawer({ open, onOpenChange, title, line, more, chat }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; line?: string; more?: string;
  /** Chat about this page (about.ts): a phone's way to it, as a window's menu is a desktop's. */
  chat?: () => void;
}) {
  return <Drawer open={open} onOpenChange={onOpenChange}>
    <DrawerContent className="loom-page-info">
      <DrawerHeader className="flex-col items-stretch gap-2">
        <DrawerTitle className="mb-0 break-words text-left leading-snug">{title}</DrawerTitle>
        {line && <DrawerDescription className="break-words text-left">{line}</DrawerDescription>}
        {more && <p className="loom-page-info__more max-w-prose break-words text-left text-sm leading-relaxed opacity-80">{more}</p>}
      </DrawerHeader>
      <DrawerFooter>
        {chat && <Button onClick={chat}>Chat about this</Button>}
        <DrawerClose asChild><Button variant="outline">Close</Button></DrawerClose>
      </DrawerFooter>
    </DrawerContent>
  </Drawer>;
}
