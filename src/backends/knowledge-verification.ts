/** Synchronous verification over an already-open existing knowledge store.
 * Owns the immediate transaction and retries; never opens a path or initializes schema.
 * Callers publish committed changes separately. This alone supplies no cross-store receipt.
 */
import type { Database } from 'better-sqlite3';
import type { KnowledgeVerifyInput, KnowledgeVerifyResult } from './types.js';
import { retryWrite } from './retry.js';

const MAX_PAGE_BODY_LENGTH = 64 * 1024;

export function verifyKnowledgePages(db: Database, input: KnowledgeVerifyInput, now: number): KnowledgeVerifyResult {
  const timestamp = new Date(now).toISOString();
  const verifiedAt = input.verified_at ?? timestamp;

  const single = input.slug !== undefined;
  const batch = input.slugs !== undefined;
  if (single === batch) {
    throw new Error(
      'verifyPages: provide exactly one of slug (single) or slugs (batch)',
    );
  }
  if (batch && (input.note !== undefined || input.freshness_anchor !== undefined)) {
    throw new Error(
      'verifyPages: note and freshness_anchor are single-page options — not allowed in batch mode',
    );
  }

  const slugs = single ? [input.slug!] : input.slugs!;
  if (slugs.length === 0) {
    throw new Error('verifyPages: slugs must not be empty');
  }

  // Validate every slug before stamping anything — no partial batches.
  type PageRow = { id: number; status: string; body: string; freshness_anchor: string | null; domain: string };
  const rows: Array<{ id: number; slug: string; body: string; freshness_anchor: string | null; domain: string }> = [];
  for (const slug of slugs) {
    const page = db.prepare(
      'SELECT id, status, body, freshness_anchor, domain FROM pages WHERE slug = ?',
    ).get(slug) as PageRow | undefined;

    if (!page) {
      throw new Error(`verifyPages: page not found: ${slug}`);
    }
    if (page.status === 'archived') {
      throw new Error(
        `verifyPages: page '${slug}' is archived — restore it before verifying`,
      );
    }
    rows.push({ id: page.id, slug, body: page.body, freshness_anchor: page.freshness_anchor, domain: page.domain });
  }

  const outcome = input.outcome ?? 'confirmed';
  const citationChecked = input.citation_checked ? 1 : 0;
  const insertVerification = db.prepare(
    'INSERT INTO verifications (page_id, verifier, verified_at, outcome, citation_checked) VALUES (?, ?, ?, ?, ?)',
  );

  // verified_at means "last SUCCESSFUL verification" — it drives the
  // stale-first queue and SLA checks. A 'stale' outcome is a failed
  // verification: it goes in the audit trail but must not renew the
  // stamp, or a known-wrong page drops to the back of the queue.
  const stamped = outcome !== 'stale';

  let noted = false;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const finalAnchor = input.freshness_anchor ?? row.freshness_anchor;
      const slaClass = deriveSlaClass(finalAnchor, row.domain);
      db.prepare(
        'UPDATE pages SET verified_at = CASE WHEN ? THEN ? ELSE verified_at END, freshness_anchor = COALESCE(?, freshness_anchor), sla_class = ? WHERE id = ?',
      ).run(stamped ? 1 : 0, verifiedAt, input.freshness_anchor ?? null, slaClass, row.id);

      if (input.note) {
        const dateLabel = verifiedAt.slice(0, 10);
        const newBody = `${row.body}\n\n## Verification — ${dateLabel}\n\n${input.note}`;
        enforcePageBodyCap(newBody);
        // A note changes the body, so it bumps `updated` — a pure stamp
        // deliberately does not (updated means "content changed").
        db.prepare(
          'UPDATE pages SET body = ?, updated = ? WHERE id = ?',
        ).run(newBody, timestamp, row.id);
        noted = true;
      }

      // The attributed audit trail (t-675) — recorded for every outcome,
      // additive to the verified_at stamp above (which stays for
      // freshness sort/SLA and only moves on success).
      insertVerification.run(row.id, input.verifier ?? null, verifiedAt, outcome, citationChecked);
    }
  });
  retryWrite(() => tx.immediate());

  return {
    verified: rows.length,
    slugs: rows.map((r) => r.slug),
    verified_at: verifiedAt,
    stamped,
    noted,
  };
}

/**
 * SLA class derivation — deterministic, no model required (t-434).
 *
 * Priority:
 *   1. version-anchored: freshness_anchor matches /v?\d+\.\d+/ → 'software' (14d)
 *   2. device-domain: domain starts with a known device-domain prefix → 'device' (7d)
 *   3. else → 'default' (30d)
 *
 * Callers may override with KnowledgePageInput.sla_class.
 */
const DEVICE_DOMAIN_PREFIXES: readonly string[] = ['music/gear', 'monitor/hardware'];
const RE_SLA_VERSION = /v?\d+\.\d+/i;

export function deriveSlaClass(
  anchor: string | null | undefined,
  domain: string,
): 'device' | 'software' | 'default' {
  if (anchor && RE_SLA_VERSION.test(anchor)) return 'software';
  if (DEVICE_DOMAIN_PREFIXES.some((p) => domain === p || domain.startsWith(`${p}/`))) return 'device';
  return 'default';
}

export function enforcePageBodyCap(body: string): void {
  if (body.length > MAX_PAGE_BODY_LENGTH) {
    throw new Error(
      `Page body exceeds hard cap of ${MAX_PAGE_BODY_LENGTH} characters ` +
      `(got ${body.length}). The knowledge backend enforces a size limit to bound memory and disk usage.`,
    );
  }
}

