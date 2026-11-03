// The toasts (000h's, Radix underneath): what an action said, for a few seconds. Their own chunk, loaded with the
// first one, so a page that never acts never carries them.
import { Toast, ToastAction, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from '@/components/ui/toast';
import type { Flash } from './loom';

export type Note = { id: number; ok: boolean; message: string; from?: string; undo?: Flash['undo'] };

export default function Toasts({ notes, wide, dismiss, undo }: { notes: Note[]; wide: boolean; dismiss: (id: number) => void; undo?: (n: Note) => void }) {
  return (
    <ToastProvider swipeDirection={wide ? 'right' : 'up'}>
      {notes.map((n) => (
        <Toast key={n.id} variant={n.ok ? 'default' : 'danger'} duration={n.undo ? 8000 : 4000} onOpenChange={(o) => !o && dismiss(n.id)}
          // A tap on a phone leaves the toast focused, and a focused toast never times out: let go of it.
          onPointerUp={(e) => { if (e.pointerType !== 'mouse') (e.currentTarget as HTMLElement).blur(); }}>
          <div className="grid gap-0.5"><ToastTitle>{n.from ? `${n.from}: ` : ''}{n.ok ? 'Done' : 'Not done'}</ToastTitle><ToastDescription>{n.message}</ToastDescription></div>
          {n.undo && undo && <ToastAction altText={n.undo.label ?? 'Undo'} onClick={() => undo(n)}>{n.undo.label ?? 'Undo'}</ToastAction>}
        </Toast>
      ))}
      {/* A phone shows toasts at the top, clear of the dock; a desktop keeps them bottom right. */}
      <ToastViewport className="max-lg:bottom-auto max-lg:right-auto max-lg:left-1/2 max-lg:-translate-x-1/2 max-lg:[top:calc(env(safe-area-inset-top)_+_12px)] lg:bottom-6" />
    </ToastProvider>
  );
}
