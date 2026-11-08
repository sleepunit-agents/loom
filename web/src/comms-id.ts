// A Comms message's id (docs/specs/comms.md): 16 base32 characters, random. Its own module so the desktop's composer
// (desk-agents.tsx) starts a thread without loading Comms' chunk.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => B32[x & 31]).join('');
}
