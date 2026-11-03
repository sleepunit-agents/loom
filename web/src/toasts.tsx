// The toasts (000h's, Radix underneath): what an action said, for a few seconds. Their own chunk, loaded with the
// first one, so a page that never acts never carries them.
import { Toast, ToastAction, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from '@/components/ui/toast';
import type { Flash } from './loom';

export type Note = { id: number; ok: boolean; message: string; from?: string; undo?: Flash['undo'] };

export default function Toasts({ notes, wide, dismiss, undo }: { notes: Note[]; wide: boolean; dismiss: (id: number) => void; undo?: (n: Note) => void }) {
  return (
    <ToastProvider swipeDirection={wide ? 'right' : 'down'}>
      {notes.map((n) => (
        <Toast key={n.id} variant={n.ok ? 'default' : 'danger'} duration={n.undo ? 8000 : 4000} onOpenChange={(o) => !o && dismiss(n.id)}>
          <div className="grid gap-0.5"><ToastTitle>{n.from ? `${n.from}: ` : ''}{n.ok ? 'Done' : 'Not done'}</ToastTitle><ToastDescription>{n.message}</ToastDescription></div>
          {n.undo && undo && <ToastAction altText={n.undo.label ?? 'Undo'} onClick={() => undo(n)}>{n.undo.label ?? 'Undo'}</ToastAction>}
        </Toast>
      ))}
      <ToastViewport className="[bottom:calc(var(--dock-h)_+_24px_+_env(safe-area-inset-bottom))] lg:bottom-6" />
    </ToastProvider>
  );
}
