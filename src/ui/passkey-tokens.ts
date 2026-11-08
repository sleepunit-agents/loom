/**
 * A passkey's own sign-in token (docs/specs/passkeys.md, t-1969). In a household a passkey signs its person in with
 * an owner token minted for it when it's added, never the adding browser's: before this, revoking the page sign-in
 * links token (2026-11-07) stopped every passkey added from a link, Jonathan's only one included.
 *
 * The token:
 *   - is an owner token naming its member, so it reaches exactly what that person does, and stops when they leave;
 *   - is kept by sha256 alone, like every token; nobody ever holds the token itself, so only the passkey uses it;
 *   - says which passkey it's for (`passkey`: the sha256 of the credential id) and which token it was made from
 *     (`from`, `from_sha256`): revoking that token leaves its passkeys alone unless asked to take them too
 *     (`loom token revoke --with-passkeys`, the page's "Revoke with its passkeys");
 *   - is labeled `Passkey: <the passkey's name> · <person> · <12 hex>`, so the token list and the signed-in list say
 *     what it is.
 * Removing the passkey revokes its token, and so ends the sessions it opened.
 */
import { createHash } from 'node:crypto';
import { createToken, firstOwner, HouseholdError, isLive, loadTokens, memberOf, revokeToken, type Household, type TokenRecord } from '../household.js';
import { sessionStore, type Passkey, type SessionStore } from './sessions.js';

/** A passkey is added only this soon after its browser signed in (a session left open on a desk can't add one). */
export const FRESH_SIGNIN_S = 10 * 60;

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
  // A label is 120 printable characters at most; a passkey's name is 60, cleaned of anything else.
  const clean = name.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'A passkey';
  return `Passkey: ${clean} · ${person} · ${credentialHash(credentialId).slice(0, 12)}`;
}

/** Whether a token record is this person's passkey token for this credential. */
const isFor = (t: TokenRecord, person: string, credentialId: string) =>
  t.role === 'owner' && t.member === person && t.passkey === credentialHash(credentialId);

/**
 * A passkey's own owner token for `person`: the live one already made for this credential, else a new one. Found by
 * its `passkey` and `member`, never by its label, so two listeners (or a start that died between minting and binding)
 * end with the one token. Returns its digest and label.
 */
export function passkeyToken(h: Household, person: string, credentialId: string, name: string, from: Origin): { secret: string; tokenLabel: string } {
  if (!memberOf(h, person)) throw new HouseholdError(`no member named ${person} in this household`);
  const find = () => loadTokens(h.home).find((t) => isLive(t) && isFor(t, person, credentialId));
  let rec = find();
  if (!rec) {
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

/** A passkey token that no stored passkey signs in with (its passkey wasn't added after all) is revoked. */
export function dropUnusedPasskeyToken(h: Household, store: SessionStore, own: { secret: string; tokenLabel: string }): void {
  if (store.passkeys().some((k) => k.secret === own.secret)) return;
  revokePasskeyToken(h, own.tokenLabel);
}

/** The person a passkey signs in as, whether or not it still works: its token's member (the first owner's for none). */
export function passkeyPerson(h: Household, k: Passkey, envOwnerDigestHex?: string): string | undefined {
  if (envOwnerDigestHex !== undefined && k.secret === envOwnerDigestHex) return firstOwner(h).person;
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
      const own = passkeyToken(h, person, p.id, p.label, from);
      if (store.bindPasskey(p.id, p.secret, own)) out.moved.push(p.id);
      else dropUnusedPasskeyToken(h, store, own);
    } catch (e) {
      out.failed.push({ id: p.id, error: (e as Error).message });
    }
  }
  return out;
}

/** The live passkey tokens made from a token (by its sha256). */
export function passkeyTokensFrom(h: Household, sha256: string): TokenRecord[] {
  return loadTokens(h.home).filter((t) => isLive(t) && t.passkey !== undefined && t.from_sha256 === sha256);
}

/**
 * Revoke a token, and with it, asked to, every passkey made from it: each one's token is revoked and the passkey
 * removed. Without `withPasskeys`, its passkeys keep working (a passkey has its own token). Returns the revoked
 * record and how many passkeys went, or stayed.
 */
export function revokeTokenAndPasskeys(h: Household, label: string, withPasskeys: boolean): { token: TokenRecord; passkeys: number } {
  const live = loadTokens(h.home).find((t) => t.label === label && isLive(t));
  const made = live ? passkeyTokensFrom(h, live.sha256) : [];
  const token = revokeToken(h, label);
  if (!withPasskeys) return { token, passkeys: made.length };
  const store = sessionStore(h.home);
  for (const t of made) {
    revokePasskeyToken(h, t.label);
    for (const k of store.passkeys()) if (k.secret === t.sha256) store.removePasskey(k.id);
  }
  return { token, passkeys: made.length };
}
