/** Value-free source model only, not an importer or an authorization decision.
 * The offline composition must still import exact grants and validate carry links. */
import { z } from 'zod';
import { secretName } from './input.js';

const requestId = z.string().regex(/^q-[0-9a-f]{8}$/);
const timestamp = z.iso.datetime({ precision: 3 });
const request = z.object({
  id: requestId,
  secret: secretName,
  // houseOf checks only string identity. Preserve it; final import must map it
  // to a registered new-side principal without normalizing or widening grants.
  agent: z.string(),
  house: z.string().regex(/^h-[0-9]{1,9}$/),
  service: z.string().min(1).optional(),
  why: z.string().min(1).max(300),
  minutes: z.number().int().min(1).max(480),
  at: timestamp,
  state: z.enum(['pending', 'granted', 'denied', 'revoked']),
  expires: timestamp.optional(),
  decided: timestamp.optional(),
  by: z.enum(['owner', 'policy']).optional(),
  who: z.string().min(1).optional(),
  always: z.literal(true).optional(),
  carriedFrom: requestId.optional(),
  claimedBy: requestId.optional(),
}).strict().superRefine((r, ctx) => {
  const invalid = () => ctx.addIssue({ code: 'custom', message: 'Invalid decision metadata' });
  if (r.state === 'pending') {
    if (r.expires || r.decided || r.by || r.who || r.always || r.carriedFrom || r.claimedBy) invalid();
  } else {
    if (!r.decided || !r.by) invalid();
    if ((r.state === 'granted' || r.state === 'revoked') && !r.expires) invalid();
    if (r.state === 'denied' && (r.expires || r.always || r.carriedFrom || r.claimedBy)) invalid();
    if (r.by === 'policy' && (r.who || r.always || r.carriedFrom || r.claimedBy)) invalid();
    if ((r.always || r.carriedFrom || r.claimedBy) && r.by !== 'owner') invalid();
    if (r.carriedFrom && (r.always || r.claimedBy)) invalid();
    if (r.always && (r.claimedBy || r.minutes !== 480)) invalid();
    if (r.carriedFrom && r.who) invalid();
    if (((r.by === 'policy' && r.state !== 'revoked') || (r.carriedFrom && r.state === 'granted')) && r.decided !== r.at) invalid();
    // Owner Allow/Always use one Date for decision and expiry. Revoke overwrites
    // decided, and a carry retains the earlier house's expiry instead.
    if (r.state === 'granted' && r.by === 'owner' && !r.carriedFrom && r.decided && r.expires
      && Date.parse(r.expires) !== Date.parse(r.decided) + r.minutes * 60_000) invalid();
  }
});
const source = z.object({ v: z.literal(1), requests: z.record(requestId, request) }).strict();
export type LegacySecretRequest = z.infer<typeof request>;

// JSON.parse accepts duplicate keys with last-key-wins semantics. After syntax
// validation, walk the token stream and reject duplicates at every object depth,
// comparing decoded keys so escaped aliases cannot hide records or unknown fields.
function rejectDuplicateKeys(text: string): void {
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)!;
  let cursor = 0;
  const value = (): void => {
    const token = tokens[cursor++];
    if (token === '{') {
      const keys = new Set<string>();
      if (tokens[cursor] === '}') { cursor++; return; }
      for (;;) {
        const key = JSON.parse(tokens[cursor++]) as string;
        if (keys.has(key)) throw new Error();
        keys.add(key);
        cursor++; // colon (the complete text already passed JSON syntax validation)
        value();
        if (tokens[cursor++] === '}') return;
      }
    }
    if (token === '[') {
      if (tokens[cursor] === ']') { cursor++; return; }
      for (;;) { value(); if (tokens[cursor++] === ']') return; }
    }
  };
  value();
}

/** Strict stored requests.json parser. Preserves original timestamps, state,
 * service absence and attribution; expired grants remain stored as granted.
 * No filesystem, legacy program, DB, clock or policy calls. Errors reveal no input.
 * Unknown fields refuse rather than silently importing accidental value material.
 * Links may refer to pruned historical rows: this parser retains them verbatim.
 */
export function parseLegacySecretRequests(bytes: Buffer): LegacySecretRequest[] {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const json: unknown = JSON.parse(text);
    rejectDuplicateKeys(text);
    const parsed = source.parse(json);
    for (const [key, r] of Object.entries(parsed.requests)) {
      if (key !== r.id || r.carriedFrom === r.id || r.claimedBy === r.id) throw new Error();
    }
    return Object.values(parsed.requests);
  } catch { throw new Error('Invalid legacy secret requests'); }
}
