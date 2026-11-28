/** Whether a typed NAME is really a pasted secret VALUE. The `secrets` brick reports a secret's name and the
 * `household` brick a token's label, and both reach the agent's brief (the owner's ruling, 2026-11-27). A value
 * pasted into Name or Label by mistake would go with it, so the page refuses such a name before anything is sent
 * and `boards.act` refuses it again in those two details (bricks/secrets.ts, bricks/household.ts): this one function
 * for both.
 *
 * This module has NO imports, so the boards page and the server load the same file and nothing else with it; the
 * page's bundle guard checks that it stays so (web/boards-guard.ts). It does not use the output check's list in
 * src/runtime/fixed-program.ts, which is written for text (case-blind, no body needed) and is left as it is.
 *
 * It is a shape test, not a proof. A name is refused when either holds:
 * - KNOWN. At the start of the name, or just after a character that is not a letter or digit, one of `KNOWN`'s
 *   prefixes, matched in the case real credentials use, followed by that kind's body; and the body looks random:
 *   the prefix and body, cut at each character that is not a letter or digit, have a piece of at least 8 characters
 *   holding letters and digits that change from one to the other at least twice (`a1b`, `1a2`, `AKIA…N7EX…`).
 *   Words joined by `-` or `_` (`sk-region-postgres-backup`, `AGE-SECRET-KEY-BACKUP`) do not.
 * - LONG RUN. A piece of the name between characters that are not letters or digits, of at least 32 characters,
 *   with at least four digits, the digits in at least two groups, and either both letter cases or digits making a
 *   fifth of it or more (a random key with no known prefix; `productionPostgresReplicaPassword2026`, digits in one
 *   group at the end, is a name).
 * What still passes is in docs/accepted-tradeoffs.md; value-shape.fixture.ts lists both sides. */

export const SECRET_VALUE_WORDS = 'That looks like a secret value, not a name.';
/** loom's own bearer, exactly as /api/signin/token hands it back (the page checks loom's answer with it). */
export const loomBearer = /^loom_[A-Za-z0-9_-]{43}$/;

/** Each kind a credential is known by: its prefix and its body, as one sticky pattern read from a word's start.
 * Only what a name can hold: a secret's name takes letters, digits and `. _ -`, a token's label those and `: / @`. So
 * `Bearer …` and a private key's header (a blank) and loom's sign-in cookie (`loom_ui=`) are not here. */
export const KNOWN: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'loom bearer', pattern: /loom_[A-Za-z0-9_-]{43}/y },
  { kind: 'loom body token', pattern: /body_[a-f0-9]{32,}/y },
  { kind: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/y },
  { kind: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{20,}/y },
  { kind: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/y },
  { kind: 'Anthropic or OpenAI key', pattern: /sk-[A-Za-z0-9_-]{20,}/y },
  { kind: 'Stripe key', pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/y },
  { kind: 'AWS access key id', pattern: /AKIA[A-Z0-9]{16}/y },
  { kind: 'GitLab token', pattern: /glpat-[A-Za-z0-9_-]{20,}/y },
  { kind: 'Google API key', pattern: /AIza[A-Za-z0-9_-]{35}/y },
  { kind: 'age secret key', pattern: /AGE-SECRET-KEY-[A-Z0-9]{20,}/y },
];

const cut = /[^A-Za-z0-9]+/;
const isDigit = (c: string) => c >= '0' && c <= '9';
/** How often a piece goes from letter to digit or digit to letter. */
const switches = (piece: string) => [...piece].filter((c, i) => i > 0 && isDigit(c) !== isDigit(piece[i - 1]!)).length;
const digitGroups = (piece: string) => piece.match(/[0-9]+/g)?.length ?? 0;
const randomPiece = (piece: string) => piece.length >= 8 && /[A-Za-z]/.test(piece) && /[0-9]/.test(piece) && switches(piece) >= 2;

/** A known credential starting at `at`: the whole of what its pattern takes from there, if that looks random. */
function knownAt(name: string, at: number): boolean {
  return KNOWN.some(({ pattern }) => {
    pattern.lastIndex = at;
    const found = pattern.exec(name);
    return !!found && found[0].split(cut).some(randomPiece);
  });
}

function longRun(piece: string): boolean {
  if (piece.length < 32) return false;
  const digits = piece.match(/[0-9]/g)?.length ?? 0;
  return digits >= 4 && digitGroups(piece) >= 2 && ((/[a-z]/.test(piece) && /[A-Z]/.test(piece)) || digits * 5 >= piece.length);
}

export function looksLikeSecretValue(name: string): boolean {
  // The whole of it is loom's own bearer, to the character, and not words: refused whatever its pieces look like
  // (the Label field sits beside where a bearer is shown; about one real bearer in 200 has no random-looking piece).
  if (loomBearer.test(name) && /[A-Z0-9]/.test(name)) return true;
  for (let at = 0; at < name.length; at++) if ((at === 0 || cut.test(name[at - 1]!)) && knownAt(name, at)) return true;
  return name.split(cut).some(longRun);
}
