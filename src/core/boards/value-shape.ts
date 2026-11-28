/** Whether a typed NAME is really a pasted secret VALUE. The `secrets` brick reports a secret's name and the
 * `household` brick a token's label, and both reach the agent's brief (the owner's ruling, 2026-11-27). A value
 * pasted into Name or Label by mistake would go with it, so the page refuses such a name before anything is sent
 * and `boards.act` refuses it again in those two details (bricks/secrets.ts, bricks/household.ts): this one function for both.
 *
 * It is a shape test, not a proof. Three shapes are refused:
 * - loom's own bearer: `loom_` and 43 letters, digits, `_` or `-` (what /api/signin/token hands back);
 * - a credential loom's existing check already knows (`looksLikeCredential`, the list that keeps a credential out
 *   of a fixed program's output, src/runtime/fixed-program.ts: GitHub `ghp_`…`github_pat_`, Slack `xox?-`,
 *   `sk-`/`sk-ant-`, `AGE-SECRET-KEY-`, `body_`, `loom_ui=`, a private key's header, `Bearer `), starting the name
 *   or just after a separator;
 * - a run of 32 or more characters with no separator (blank, `.`, `_`, `-`, `:`, `/`, `@`) that mixes letters and
 *   digits and is nearly all letters and digits: a random key with no known prefix.
 * What still passes is in docs/accepted-tradeoffs.md. */
import { looksLikeCredential } from '../../runtime/fixed-program.js';

export const SECRET_VALUE_WORDS = 'That looks like a secret value, not a name.';
export const loomBearer = /^loom_[A-Za-z0-9_-]{43}$/;
const separators = /[\s._\-:/@]+/;

const randomRun = (run: string) => {
  if (run.length < 32) return false;
  const letters = (run.match(/[A-Za-z]/g) ?? []).length, digits = (run.match(/[0-9]/g) ?? []).length;
  return letters > 0 && digits > 0 && letters + digits >= 0.9 * run.length;
};

/** The list is written for text and finds a credential anywhere: `task-runner-pump-station-north` holds `sk-` and twenty
 * more. Here one counts only when it starts the name or follows a separator. One starts at `i` when the list finds
 * one from `i` and none from `i + 1`, since a find past `i` would be found from `i + 1` as well. */
const knownAt = (name: string, i: number) => looksLikeCredential(name.slice(i)) && !looksLikeCredential(name.slice(i + 1));
const starts = (name: string) => [0, ...[...name].flatMap((c, i) => (separators.test(c) ? [i + 1] : []))];

export function looksLikeSecretValue(name: string): boolean {
  return loomBearer.test(name) || starts(name).some((i) => knownAt(name, i)) || name.split(separators).some(randomRun);
}
