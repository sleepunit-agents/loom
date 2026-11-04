// A reply typed into a Needs you's sheet and not sent, kept on this device, per item (Jonathan, 2026-11-04: he typed
// an answer, pressed Done, and his words were never sent). Closing the sheet keeps it; its row says "Draft not sent";
// sending it (or clearing the box) drops it. Only this browser's storage, and only ever as a convenience: storage
// that's blocked or full keeps nothing, and the sheet works the same.

const PREFIX = 'loom.draft.';
const MAX = 40_000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const local = (): Store | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

/** The unsent draft for item `key`, or ''. */
export function draftOf(key: string, s: Store | undefined = local()): string {
  try { return s?.getItem(PREFIX + key) ?? ''; } catch { return ''; }
}

/** Keep `text` as item `key`'s draft; blank drops it. */
export function keepDraft(key: string, text: string, s: Store | undefined = local()): void {
  try {
    if (text.trim()) s?.setItem(PREFIX + key, text.slice(0, MAX));
    else s?.removeItem(PREFIX + key);
  } catch { /* nowhere to keep it: the box still has it while the sheet is open */ }
}

/** Whether item `key` has a draft that wasn't sent. */
export const hasDraft = (key: string, s?: Store): boolean => !!draftOf(key, s).trim();

/**
 * A Needs you's footer, guarded: with words in the reply box, Done is "Send and mark done" (it sends them, and a reply
 * answers the ask), Dismiss waits until they're sent or cleared, and while anything is sending every answer waits.
 * Done becomes the send rather than being disabled: the owner meant to answer, and one tap does what they meant.
 */
export type FooterButton<B> = { b: B; send: true; label: string; disabled: boolean } | { b: B; send: false; disabled: boolean };
export function guardFooter<B extends { action: string }>(actions: B[], drafted: boolean, busy: boolean): FooterButton<B>[] {
  return actions.map((b) => b.action === 'needs-done' && drafted
    ? { b, send: true, label: busy ? 'Sending…' : 'Send and mark done', disabled: busy }
    : { b, send: false, disabled: busy || (drafted && b.action === 'needs-dismiss') });
}
