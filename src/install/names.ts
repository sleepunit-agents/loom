/**
 * Canonical agent-name validation. Used by `loom doctor`, `loom
 * bootstrap` (tightening pending), and the install skill's interview.
 * Reserved names anticipate the alpha.7+ `agents switch` pointer slot
 * plus snapshot/export storage adjacent to agent dirs.
 *
 * See stack spec v1 §13 (Multi-agent layout).
 */

export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  'current',
  'default',
  'config',
  'backups',
  'cache',
  'tmp',
  'shared',
]);

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_LEN = 64;

export type NameCheck = { ok: true } | { ok: false; reason: string };

export function validateAgentName(name: string): NameCheck {
  if (name.length === 0) return { ok: false, reason: 'Name is empty.' };
  if (name.length > MAX_LEN) {
    return { ok: false, reason: `Name is longer than ${MAX_LEN} characters.` };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      reason: 'Name must be lowercase alphanumeric plus hyphens, starting with a letter or digit.',
    };
  }
  if (RESERVED_AGENT_NAMES.has(name)) {
    return { ok: false, reason: `"${name}" is reserved.` };
  }
  return { ok: true };
}
