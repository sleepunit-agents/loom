/**
 * Passkeys for loom's page (docs/specs/passkeys.md): WebAuthn registration
 * and sign-in, verified with node:crypto alone. The browser hands over the
 * credential's public key as SPKI (`getPublicKey()`), so there's no CBOR or
 * COSE to decode here: only clientDataJSON (JSON) and authenticatorData (a
 * fixed byte layout).
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/** The algorithms loom accepts: ES256, EdDSA, RS256 (COSE ids). */
export const ALGS = [-7, -8, -257] as const;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class PasskeyError extends Error {}

/** Where passkeys work: LOOM_PUBLIC_URL's origin and its host (the RP ID), or null when it isn't https (or localhost). */
export function relyingParty(env: NodeJS.ProcessEnv): { origin: string; rpId: string } | null {
  const raw = env.LOOM_PUBLIC_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // https, or http on localhost, which browsers also treat as secure (for development).
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) return null;
    return { origin: u.origin, rpId: u.hostname };
  } catch {
    return null;
  }
}

function b64url(s: unknown, what: string, max = 4096): Buffer {
  if (typeof s !== 'string' || !s || s.length > max || !/^[A-Za-z0-9_-]+$/.test(s)) throw new PasskeyError(`${what} is not base64url`);
  return Buffer.from(s, 'base64url');
}

interface ClientData { type: string; challenge: string; origin: string }

function clientData(raw: Buffer, type: 'webauthn.create' | 'webauthn.get', origin: string): ClientData {
  let c: ClientData;
  try { c = JSON.parse(raw.toString('utf-8')); } catch { throw new PasskeyError('clientDataJSON is not JSON'); }
  if (c.type !== type) throw new PasskeyError(`clientDataJSON is ${String(c.type)}, not ${type}`);
  if (c.origin !== origin) throw new PasskeyError(`the passkey answered for ${String(c.origin)}, not ${origin}`);
  if (typeof c.challenge !== 'string') throw new PasskeyError('clientDataJSON has no challenge');
  return c;
}

interface AuthData { flags: number; counter: number; credentialId?: Buffer }

function authData(raw: Buffer, rpId: string, attested: boolean): AuthData {
  if (raw.length < 37) throw new PasskeyError('authenticatorData is too short');
  if (!raw.subarray(0, 32).equals(createHash('sha256').update(rpId).digest())) throw new PasskeyError(`the passkey isn't for ${rpId}`);
  const flags = raw[32];
  if (!(flags & FLAG_UP)) throw new PasskeyError('the person wasn\'t present');
  if (!(flags & FLAG_UV)) throw new PasskeyError('the person wasn\'t verified (Face ID, a fingerprint or a PIN)');
  const counter = raw.readUInt32BE(33);
  if (!attested) return { flags, counter };
  if (!(flags & FLAG_AT) || raw.length < 55) throw new PasskeyError('authenticatorData has no credential in it');
  const len = raw.readUInt16BE(53);
  if (raw.length < 55 + len) throw new PasskeyError('authenticatorData is cut short');
  return { flags, counter, credentialId: raw.subarray(55, 55 + len) };
}

function keyFor(spki: Buffer, alg: number): KeyObject {
  let key: KeyObject;
  try { key = createPublicKey({ key: spki, format: 'der', type: 'spki' }); } catch { throw new PasskeyError('the public key is not SPKI'); }
  const want = alg === -7 ? 'ec' : alg === -8 ? 'ed25519' : alg === -257 ? 'rsa' : null;
  if (!want || key.asymmetricKeyType !== want) throw new PasskeyError(`algorithm ${alg} with a ${key.asymmetricKeyType} key isn't one loom takes`);
  if (alg === -7 && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new PasskeyError('an ES256 key must be P-256');
  return key;
}

export interface Registration {
  id: string;
  publicKey: string;
  alg: number;
  counter: number;
  challenge: string;
}

/** Check a registration (navigator.credentials.create's answer, as posted). The caller spends the challenge. */
export function verifyRegistration(body: Record<string, unknown>, rp: { origin: string; rpId: string }): Registration {
  const id = b64url(body.id, 'id', 1400);
  const cd = clientData(b64url(body.clientDataJSON, 'clientDataJSON'), 'webauthn.create', rp.origin);
  const ad = authData(b64url(body.authenticatorData, 'authenticatorData', 8192), rp.rpId, true);
  if (!ad.credentialId!.equals(id)) throw new PasskeyError('the credential id doesn\'t match authenticatorData');
  const alg = Number(body.publicKeyAlgorithm);
  if (!(ALGS as readonly number[]).includes(alg)) throw new PasskeyError(`algorithm ${String(body.publicKeyAlgorithm)} isn't one loom takes`);
  const spki = b64url(body.publicKey, 'publicKey');
  keyFor(spki, alg);
  return { id: id.toString('base64url'), publicKey: spki.toString('base64url'), alg, counter: ad.counter, challenge: cd.challenge };
}

export interface Assertion {
  id: string;
  counter: number;
  challenge: string;
}

/** Check a sign-in (navigator.credentials.get's answer) against the stored key. The caller spends the challenge. */
export function verifyAssertion(
  body: Record<string, unknown>,
  stored: { publicKey: string; alg: number },
  rp: { origin: string; rpId: string },
): Assertion {
  const id = b64url(body.id, 'id', 1400).toString('base64url');
  const rawCd = b64url(body.clientDataJSON, 'clientDataJSON');
  const cd = clientData(rawCd, 'webauthn.get', rp.origin);
  const rawAd = b64url(body.authenticatorData, 'authenticatorData', 8192);
  const ad = authData(rawAd, rp.rpId, false);
  const signature = b64url(body.signature, 'signature', 1024);
  const key = keyFor(Buffer.from(stored.publicKey, 'base64url'), stored.alg);
  const signed = Buffer.concat([rawAd, createHash('sha256').update(rawCd).digest()]);
  const ok = stored.alg === -8 ? verify(null, signed, key, signature) : verify('sha256', signed, key, signature);
  if (!ok) throw new PasskeyError('the signature doesn\'t verify');
  return { id, counter: ad.counter, challenge: cd.challenge };
}

