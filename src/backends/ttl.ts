/**
 * TTL parsing and expiration utilities for memory aging.
 *
 * Supported formats:
 *   "7d"        — 7 days
 *   "30d"       — 30 days
 *   "24h"       — 24 hours
 *   "permanent" — never expires
 */

const DURATION_RE = /^(\d+)(d|h)$/;

/**
 * Parse a TTL string into milliseconds.
 * Returns null for "permanent" or undefined input.
 * Throws on invalid format.
 */
export function parseTTL(ttl: string | undefined): number | null {
  if (!ttl || ttl === 'permanent') return null;

  const match = ttl.match(DURATION_RE);
  if (!match) {
    throw new Error(`Invalid TTL format: "${ttl}". Use "7d", "24h", or "permanent".`);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'd': return amount * 24 * 60 * 60 * 1000;
    case 'h': return amount * 60 * 60 * 1000;
    default: throw new Error(`Unknown TTL unit: "${unit}"`);
  }
}

/**
 * Compute an ISO expiration timestamp from a created timestamp and TTL.
 * Returns null if TTL is permanent or undefined.
 */
export function computeExpiresAt(created: string, ttl: string | undefined): string | null {
  const ms = parseTTL(ttl);
  if (ms === null) return null;

  const expiresAt = new Date(new Date(created).getTime() + ms);
  return expiresAt.toISOString();
}

/**
 * Check if a memory has expired based on its expiresAt timestamp.
 */
export function isExpired(expiresAt: string | null | undefined, now?: Date): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt);
  return (now ?? new Date()) >= expiry;
}
