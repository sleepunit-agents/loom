// The page's explanation is needed only after its title is tapped. Keep the bar itself synchronous.
import { Button } from '@/components/ui/button';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';

export default function PageInfoDrawer({ open, onOpenChange, title, line, more }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; line?: string; more?: string;
}) {
  return <Drawer open={open} onOpenChange={onOpenChange}>
    <DrawerContent className="loom-page-info">
      <DrawerHeader className="flex-col items-stretch gap-2">
        <DrawerTitle className="mb-0 break-words text-left leading-snug">{title}</DrawerTitle>
        {line && <DrawerDescription className="break-words text-left">{line}</DrawerDescription>}
        {more && <p className="loom-page-info__more max-w-prose break-words text-left text-sm leading-relaxed opacity-80">{more}</p>}
      </DrawerHeader>
      <DrawerFooter><DrawerClose asChild><Button variant="outline">Close</Button></DrawerClose></DrawerFooter>
    </DrawerContent>
  </Drawer>;
}
