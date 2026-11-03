// An app's tint from its name (000h's four), so an app wears the same colour in its header, in Find and on its tile.
const TINTS = ['pink', 'blue', 'yellow', 'olive'] as const;
export const tintOf = (s: string) => TINTS[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];
