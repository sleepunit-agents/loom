/**
 * A passkey's own sign-in token (docs/specs/passkeys.md, t-1969). In a household a passkey signs its person in with
 * an owner token minted for it when it's added, never the adding browser's: before this, revoking the page sign-in
 * links token (2026-11-07) stopped every passkey added from a link, Jonathan's only one included.
 *
 * The token:
 *   - is an owner token naming its member, so it reaches exactly what that person does, and stops when they leave;
 *   - is kept by sha256 alone, like every token; nobody ever holds the token itself, so only the passkey uses it;
 *   - says which passkey it's for (`passkey`: the sha256 of the credential id) and which token it was made from
 *     (`from`: its label, `from_sha256`): revoking that token leaves its passkeys alone unless asked to take them too
 *     (`loom token revoke --with-passkeys`, the page's "Revoke with its passkeys"), and so does removing a passkey
 *     whose browser session made others (the page's "Remove with the passkeys made from it"). Taking them follows
 *     the line down: a passkey made from a session that a passkey made from that token opened goes too;
 *   - is labeled `Passkey: <the passkey's name> · <person> · <12 hex>`, so the token list and the signed-in list say
 *     what it is.
 * Removing the passkey revokes its token, and so ends the sessions it opened.
 */
import { createHash } from 'node:crypto';
import { createToken, firstOwner, HouseholdError, isLive, loadTokens, memberOf, revokeToken, type Household, type TokenRecord } from '../household.js';
import { cleanLabel, sessionStore, signedInAt, type Passkey, type Session, type SessionStore } from './sessions.js';

/** A passkey is added only this soon after its browser signed in (a session left open on a desk can't add one). */
export const FRESH_SIGNIN_S = 10 * 60;
/** Why a browser that signed in longer ago can't add a passkey: the page's note and the refusal both say this. */
export const STALE_FOR_PASSKEY = `A passkey is added within ${FRESH_SIGNIN_S / 60} minutes of signing in: sign out, sign in again, then add it.`;
/** Whether this session signed in too long ago to add a passkey (none: it can't). */
export const staleForPasskey = (s: Session | null, nowS = Math.floor(Date.now() / 1000)) => !s || nowS - signedInAt(s) > FRESH_SIGNIN_S;

/** The token a passkey was made from: a token's label and sha256 (the env owner token has no record: its name). */
export interface Origin { label: string; sha256?: string }

/** The env owner token's name, where a passkey says what it was made from. */
export const ENV_OWNER = 'the env owner token (LOOM_BEARER_TOKEN)';

export const credentialHash = (credentialId: string) => createHash('sha256').update(credentialId).digest('hex');

/** The token a session or passkey digest is: its label, or the env owner token's name. */
export function originOf(h: Household, digestHex: string, envOwnerDigestHex?: string): Origin | undefined {
  if (envOwnerDigestHex !== undefined && digestHex === envOwnerDigestHex) return { label: ENV_OWNER };
  const t = loadTokens(h.home).find((x) => x.sha256 === digestHex);
  return t ? { label: t.label, sha256: t.sha256 } : undefined;
}

function tokenLabel(name: string, person: string, credentialId: string): string {
  // A label is 120 printable characters at most; a passkey's name is 60, cleaned as a session's label is.
  const clean = cleanLabel(name)?.slice(0, 60).trim() || 'A passkey';
  // A person's slug has no length bound of its own; the label's 120 does.
  return `Passkey: ${clean} · ${person.slice(0, 30)} · ${credentialHash(credentialId).slice(0, 12)}`;
}

/** Whether a token record is this person's passkey token for this credential. */
const isFor = (t: TokenRecord, person: string, credentialId: string) =>
  t.role === 'owner' && t.member === person && t.passkey === credentialHash(credentialId);

/**
 * A passkey's own owner token for `person`: the live one already made for this credential, else a new one. Found by
 * its `passkey` and `member`, never by its label, so two listeners (or a start that died between minting and binding)
 * end with the one token. Returns its digest and label.
 */
export function passkeyToken(h: Household, person: string, credentialId: string, name: string, from: Origin,
  /** Tests only (the two-listener race is otherwise untestable in one process): runs between looking and minting. */
  race?: () => void): { secret: string; tokenLabel: string } {
  if (!memberOf(h, person)) throw new HouseholdError(`no member named ${person} in this household`);
  const find = () => loadTokens(h.home).find((t) => isLive(t) && isFor(t, person, credentialId));
  let rec = find();
  if (!rec) {
    race?.();
    try {
      rec = createToken(h, { role: { kind: 'owner', member: person }, label: tokenLabel(name, person, credentialId),
        passkey: { credential: credentialHash(credentialId), from: from.label, ...(from.sha256 ? { from_sha256: from.sha256 } : {}) } }).record;
    } catch (e) {
      // Another listener made it first.
      rec = find();
      if (!rec) throw e;
    }
  }
  return { secret: rec.sha256, tokenLabel: rec.label };
}

/**
 * Revoke a passkey's own token. True if it was revoked; false if no live token has that label (already revoked, or
 * never written). Anything else (tokens.json locked or unreadable) throws: the caller must say so.
 */
export function revokePasskeyToken(h: Household, label: string): boolean {
  if (!loadTokens(h.home).some((t) => t.label === label && isLive(t) && t.passkey !== undefined)) return false;
  revokeToken(h, label);
  return true;
}

/**
 * A passkey token that no stored passkey signs in with (its passkey wasn't added after all) is revoked. Never throws:
 * it's called on a path that's already failing; one it can't revoke is said on stderr (nobody holds that token).
 */
export function dropUnusedPasskeyToken(h: Household, store: SessionStore, own: { secret: string; tokenLabel: string }): void {
  try {
    if (store.passkeys().some((k) => k.secret === own.secret)) return;
    revokePasskeyToken(h, own.tokenLabel);
  } catch (e) {
    process.stderr.write(`loom: the unused passkey token "${own.tokenLabel}" couldn't be revoked: ${(e as Error).message}\n`);
  }
}

/** The person a passkey signs in as, whether or not it still works: its token's member (the first owner's for none). */
export function passkeyPerson(h: Household, k: Passkey): string | undefined {
  const t = loadTokens(h.home).find((x) => x.sha256 === k.secret);
  if (!t || t.role !== 'owner') return undefined;
  return t.member ?? (isLive(t) ? firstOwner(h).person : undefined);
}

/**
 * Give each passkey made before t-1969 a token of its own (run at loom-http's start; idempotent). Only one whose
 * token is live still (or is the env owner token) moves, to a token for that token's person: a passkey whose token
 * was revoked stays stopped (it shows as stopped, and a new one is added in its place), and so does one whose token
 * is gone from tokens.json or whose person has left. One passkey that fails doesn't stop the others.
 */
export function migratePasskeys(h: Household, envOwnerDigestHex?: string): { moved: string[]; failed: Array<{ id: string; error: string }> } {
  const store = sessionStore(h.home);
  const out = { moved: [] as string[], failed: [] as Array<{ id: string; error: string }> };
  const todo = store.passkeys().filter((p) => !p.tokenLabel);
  if (!todo.length) return out;
  const tokens = loadTokens(h.home);
  for (const p of todo) {
    let own: { secret: string; tokenLabel: string } | undefined;
    try {
      let person: string | undefined;
      let from: Origin;
      if (envOwnerDigestHex !== undefined && p.secret === envOwnerDigestHex) {
        person = firstOwner(h).person;
        from = { label: ENV_OWNER };
      } else {
        const rec = tokens.find((t) => t.sha256 === p.secret);
        if (!rec || rec.role !== 'owner' || !isLive(rec)) continue;
        // A live owner token naming nobody is the first owner's (writeMembers pins its member when that changes).
        person = rec.member ?? firstOwner(h).person;
        from = { label: rec.label, sha256: rec.sha256 };
      }
      if (!memberOf(h, person)) continue;
      own = passkeyToken(h, person, p.id, p.label, from);
      if (store.bindPasskey(p.id, p.secret, own)) out.moved.push(p.id);
      else dropUnusedPasskeyToken(h, store, own);
    } catch (e) {
      out.failed.push({ id: p.id, error: (e as Error).message });
      if (own) dropUnusedPasskeyToken(h, store, own);
    }
  }
  return out;
}

/** How many kept passkeys these tokens' line holds: the passkeys that sign in with one of them. */
function keptAmong(made: TokenRecord[], kept: Passkey[]): number {
  const digests = new Set(made.map((t) => t.sha256));
  return kept.filter((k) => digests.has(k.secret)).length;
}

/**
 * How many passkeys revoking each live token with its passkeys (or removing the passkey that signs in with it, with
 * the ones added from it) would take: every kept passkey down its line, exactly what that does. Tokens with none
 * aren't in the map.
 */
export function passkeysMadeFrom(h: Household): Map<string, number> {
  const kept = sessionStore(h.home).passkeys();
  const tokens = loadTokens(h.home);
  const n = new Map<string, number>();
  for (const t of tokens) {
    if (!isLive(t)) continue;
    const c = keptAmong(madeFromAll(tokens, [t.sha256]), kept);
    if (c) n.set(t.sha256, c);
  }
  return n;
}

/** Every passkey token made from these tokens (by sha256), in any state, and those made from them, down the line. */
function madeFromAll(tokens: TokenRecord[], roots: string[]): TokenRecord[] {
  const seen = new Set(roots);
  const out: TokenRecord[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tokens) {
      if (t.passkey === undefined || !t.from_sha256 || !seen.has(t.from_sha256) || seen.has(t.sha256)) continue;
      seen.add(t.sha256);
      out.push(t);
      grew = true;
    }
  }
  return out;
}

/**
 * Revoke these passkey tokens (the live ones) and remove the passkeys that sign in with them. Returns the passkeys
 * removed. One that can't be revoked throws PasskeyTokenLeft naming it; none are removed then, so it can be redone.
 */
function takePasskeys(h: Household, made: TokenRecord[]): number {
  const store = sessionStore(h.home);
  for (const t of made) {
    if (!isLive(t)) continue;
    try { revokePasskeyToken(h, t.label); } catch (e) { throw new PasskeyTokenLeft(t.label, e); }
  }
  const digests = new Set(made.map((t) => t.sha256));
  let removed = 0;
  for (const k of store.passkeys()) if (digests.has(k.secret) && store.removePasskey(k.id)) removed += 1;
  return removed;
}

/**
 * Revoke a token, and with it, asked to, every passkey made from it, down the line: each one's token is revoked and
 * the passkey removed. Without `withPasskeys`, they keep working (each has its own token). Returns the revoked
 * record and how many passkeys went, or (not asked) how many were made from it and stay.
 */
export function revokeTokenAndPasskeys(h: Household, label: string, withPasskeys: boolean, withDevices = false): { token: TokenRecord; passkeys: number; devices: number } {
  const token = revokeToken(h, label);
  // Read after the revoke: no browser signed in with it can add another now.
  const made = madeFromAll(loadTokens(h.home), [token.sha256]);
  // Revoked as compromised (t-1978): the devices that signed in with it, and with what's taken with it, stop getting
  // notifications. A plain revoke (cleaning up the links token, say) leaves every device's alone.
  // First, so a passkey token that can't be revoked further on (PasskeyTokenLeft) leaves no device still notified.
  const devices = withDevices || withPasskeys ? sessionStore(h.home).removePushByTokens([token.sha256, ...(withPasskeys ? made.map((t) => t.sha256) : [])]) : 0;
  // No passkey made from it (an agent's token, say): no passkey is touched.
  if (!made.length) return { token, passkeys: 0, devices };
  // Not asked: the ones that keep working (a stopped one isn't counted as working).
  if (!withPasskeys) return { token, passkeys: keptAmong(made.filter((t) => isLive(t)), sessionStore(h.home).passkeys()), devices };
  return { token, passkeys: takePasskeys(h, made), devices };
}

/** The passkey was removed, but a token it, or one made from it, signs in with couldn't be revoked. */
export class PasskeyTokenLeft extends Error {
  constructor(readonly label: string, cause: unknown) { super((cause as Error).message, { cause }); }
}

/**
 * Remove a passkey: its own token is revoked with it (so the sessions it opened end), and, asked to, the passkeys
 * its sessions made, down the line. `removed` false: no such passkey. A store that can't be written throws as it
 * is (nothing was removed); a token that couldn't be revoked after the passkey went throws PasskeyTokenLeft.
 */
export function removePasskey(h: Household, id: string, withMade: boolean): { removed: boolean; made: number } {
  const store = sessionStore(h.home);
  const k = store.passkey(id);
  if (!k || !store.removePasskey(id)) return { removed: false, made: 0 };
  if (!k.tokenLabel) return { removed: true, made: 0 };
  const own = loadTokens(h.home).find((t) => t.sha256 === k.secret);
  try {
    if (own && isLive(own)) revokePasskeyToken(h, own.label);
  } catch (e) {
    throw new PasskeyTokenLeft(own!.label, e);
  }
  // takePasskeys names the one it couldn't revoke.
  return { removed: true, made: withMade && own ? takePasskeys(h, madeFromAll(loadTokens(h.home), [own.sha256])) : 0 };
}

/** "the passkey" / "the 3 passkeys", for what's said about passkeys made from something (the CLI's and the page's words). */
export const thePasskeys = (n: number) => (n === 1 ? 'the passkey' : `the ${n} passkeys`);
/** The same, starting a sentence. */
export const ThePasskeys = (n: number) => { const t = thePasskeys(n); return t.charAt(0).toUpperCase() + t.slice(1); };
