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

/**
 * A piece's form, the same guard (a task's ask, answered on its page: Jonathan, 2026-11-04): the words typed in its
 * boxes (textareas only: never a secret or a one-line value) are kept on this device by the page, the action and its
 * hidden fields, until the form is sent. Leaving the page, or pressing another button on it, loses nothing.
 */
export const formDraftKey = (path: string, action: string, hidden?: Record<string, string>): string =>
  `form:${path}:${action}:${JSON.stringify(hidden ?? {})}`;

/** The words kept for a form, by field name ({} when none, or when what's kept can't be read). */
export function keptWords(key: string, s: Store | undefined = local()): Record<string, string> {
  const raw = draftOf(key, s);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch { return {}; }
}

/** Keep a form's words (blank ones dropped; none at all drops the draft). */
export function keepWords(key: string, words: Record<string, string>, s: Store | undefined = local()): void {
  const kept = Object.fromEntries(Object.entries(words).filter(([, v]) => v.trim()));
  keepDraft(key, Object.keys(kept).length ? JSON.stringify(kept) : '', s);
}
