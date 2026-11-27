/** Settings' words for secrets: what a standing answer, a recorded use and the outcome of a change are called. The
 * desktop's Settings (controls.tsx, ../secrets-view.tsx) and the boards page's `secrets` brick say the same. Plain
 * strings: nothing here holds, reads or names a secret's value. */
export const ANSWER_WORDS = { ask: 'Ask each time', auto: 'Allow automatically', never: 'Never allow' } as const;
export const USE_WORDS = { started: 'Delivery unconfirmed', released: 'Delivered', failed: 'Failed' } as const;
/** A change is acknowledged or it is not; no reply's own words are ever shown. */
export const resultText = (saved: boolean) => saved ? 'Saved.' : 'Change not confirmed. Check the current item before starting a new change.';
export const WRITE_ONLY_WORDS = 'The value is write-only. It cannot be read back here.';
