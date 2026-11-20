import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button, Textarea } from '../../kit';
import { bindComposerViewport } from './viewport';
import './composer.css';

/** The one message bar, under a thread in Comms and on an agent's card on Home (the how-it-works site's
 * `.cm__compose`): a single line that grows with its words up to a few lines, with Send at its right as the one
 * filled button. Its words are the placeholder and its accessible name. At a keyboard Enter sends and Shift+Enter
 * makes a new line; on the phone shell Enter makes a new line and the button sends. Ctrl+Enter sends anywhere.
 * While a message is on its way the words cannot be changed, but the field keeps the keyboard's focus, so the
 * next message can be typed without reaching for it again. It owns no draft and no transport: the caller holds
 * the words and sends them. */
export function MessageBar({ name, value, onChange, onSend, busy = false, status }: {
  name: string; value: string; busy?: boolean; onChange(words: string): void; onSend(): unknown;
  /** Said under the bar, and to a screen reader, only while there is something to say ("Sending…", why it failed). */
  status?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null), input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => form.current ? bindComposerViewport(form.current) : undefined, []);
  // As tall as its words (the sheet stops it at a few lines). `field-sizing` does this alone where a browser has it.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el?.style) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  const label = `Message ${name}`;
  return <form ref={form} className="loom-composer" onSubmit={event => { event.preventDefault(); return onSend(); }}>
    <div className="loom-composer__bar">
      <Textarea ref={input} maxLength={100000} rows={1} className="loom-composer__input" aria-label={label} placeholder={label} value={value} readOnly={busy} aria-busy={busy || undefined}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent?.isComposing) return;
          const phone = !!event.currentTarget?.closest?.('[data-shell="phone"]');
          if (event.ctrlKey || event.metaKey || !event.shiftKey && !phone) { event.preventDefault(); void onSend(); }
        }} />
      <Button type="submit" variant="primary" className="loom-composer__send" disabled={busy || !value.trim()}
        onPointerDown={event => { if (event.button === 0 && document.activeElement === input.current) event.preventDefault(); }}>Send</Button>
    </div>
    <p role="status" className="loom-composer__status">{status}</p>
  </form>;
}

/** Where the bar would be, when this conversation cannot be written to: one quiet line that says why. */
export function ComposerOff({ children }: { children: ReactNode }) {
  return <p className="loom-composer__off">{children}</p>;
}
