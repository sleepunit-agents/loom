/** Canonical Discord REST path/query IDs, without lossy numeric coercion. */
export const isDiscordId=(value:unknown):value is string=>typeof value==='string'
  &&/^[1-9]\d{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
