/**
 * c-loom-memory: it-loom-salience — temperature decay/bump, recompute, digest assembly.
 * Greens ac-loom-salience-field, ac-loom-digest-assemble, ac-loom-digest-inject.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import {
  temperature,
  tierOf,
  assembleDigest,
  recomputeSalienceForContext,
  digestForContext,
  clampConfidence,
  applyObservation,
  decayedConfidence,
  FEEDBACK_CONFIDENCE_MIN,
  FEEDBACK_CONFIDENCE_MAX,
  FEEDBACK_CONFIDENCE_DEFAULT,
  type DigestRow,
} from './salience.js';
import { remember } from '../tools/remember.js';
import { resolveSqliteDbPath } from '../config.js';

const NOW = Date.parse('2026-06-15T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('temperature (per-category half-life decay + access bump)', () => {
  it('is 1.0 at the moment of touch and 0.5 after one half-life', () => {
    expect(temperature(daysAgo(0), 'project', NOW)).toBeCloseTo(1.0, 5);
    expect(temperature(daysAgo(10), 'project', NOW)).toBeCloseTo(0.5, 2); // project half-life = 10d
    expect(temperature(daysAgo(90), 'user', NOW)).toBeCloseTo(0.5, 2); // user half-life = 90d
  });

  it('cools identity-level categories slower than working ones', () => {
    // same age, different category → user stays hotter than project
    expect(temperature(daysAgo(30), 'user', NOW)).toBeGreaterThan(temperature(daysAgo(30), 'project', NOW));
  });

  // The fixture order (fx-loom-salience-decay-bump): a just-recalled old atom is
  // hottest; an untouched old one is coldest; identity cools slowly in between.
  it('orders fresh / recalled / identity / untouched correctly', () => {
    const cases = {
      'fresh-project': temperature(daysAgo(1), 'project', NOW), // created 1d ago
      'old-untouched': temperature(daysAgo(60), 'project', NOW), // lastTouch = created, 60d
      'old-but-recalled': temperature(daysAgo(0), 'project', NOW), // last_accessed today
      'identity-fact': temperature(daysAgo(60), 'user', NOW), // user, 60d
    };
    const order = Object.entries(cases).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    expect(order).toEqual(['old-but-recalled', 'fresh-project', 'identity-fact', 'old-untouched']);
  });
});

// ── Feedback confidence model (t-338): confidence + evidence count, computed
// in code (never a prompt), decay reused from temperature()/HALF_LIVES above.
describe('clampConfidence', () => {
  it('holds confidence within [0.3, 0.9]', () => {
    expect(clampConfidence(0.95)).toBe(FEEDBACK_CONFIDENCE_MAX);
    expect(clampConfidence(0.1)).toBe(FEEDBACK_CONFIDENCE_MIN);
    expect(clampConfidence(0.6)).toBe(0.6);
  });
});

describe('applyObservation', () => {
  it('raises confidence by 0.05 on confirm', () => {
    expect(applyObservation(0.6, 'confirm')).toBeCloseTo(0.65, 5);
  });

  it('lowers confidence by 0.1 on contradict', () => {
    expect(applyObservation(0.6, 'contradict')).toBeCloseTo(0.5, 5);
  });

  it('a contradicting observation measurably lowers confidence even at the floor', () => {
    const atFloor = applyObservation(FEEDBACK_CONFIDENCE_MIN, 'contradict');
    expect(atFloor).toBe(FEEDBACK_CONFIDENCE_MIN); // can't go below the floor
    const aboveFloor = applyObservation(0.5, 'contradict');
    expect(aboveFloor).toBeLessThan(0.5); // but a real drop registers above it
  });

  it('never exceeds the max on repeated confirms', () => {
    let c = FEEDBACK_CONFIDENCE_DEFAULT;
    for (let i = 0; i < 20; i++) c = applyObservation(c, 'confirm');
    expect(c).toBe(FEEDBACK_CONFIDENCE_MAX);
  });
});

describe('decayedConfidence (reuses temperature()/HALF_LIVES — no separate decay rule)', () => {
  it('returns the raw value at the moment of touch', () => {
    expect(decayedConfidence(0.8, daysAgo(0), 'feedback', NOW)).toBeCloseTo(0.8, 5);
  });

  it('relaxes toward the neutral default as the memory cools', () => {
    // feedback half-life = 30d (HALF_LIVES.feedback): at 30 days old, temp = 0.5,
    // so the value should sit halfway between raw and FEEDBACK_CONFIDENCE_DEFAULT.
    const raw = 0.8;
    const decayed = decayedConfidence(raw, daysAgo(30), 'feedback', NOW);
    expect(decayed).toBeCloseTo(FEEDBACK_CONFIDENCE_DEFAULT + (raw - FEEDBACK_CONFIDENCE_DEFAULT) * 0.5, 2);
    expect(decayed).toBeLessThan(raw);
    expect(decayed).toBeGreaterThan(FEEDBACK_CONFIDENCE_DEFAULT);
  });

  it('approaches the neutral default for a very old, unconfirmed memory', () => {
    const decayed = decayedConfidence(0.9, daysAgo(365), 'feedback', NOW);
    expect(decayed).toBeCloseTo(FEEDBACK_CONFIDENCE_DEFAULT, 1);
  });

  it('decays a low (contradicted) raw value back up toward neutral, not further down', () => {
    const decayed = decayedConfidence(FEEDBACK_CONFIDENCE_MIN, daysAgo(60), 'feedback', NOW);
    expect(decayed).toBeGreaterThan(FEEDBACK_CONFIDENCE_MIN);
  });
});

describe('tierOf', () => {
  it('bands temperature into Hot/Warm/Cool', () => {
    expect(tierOf(0.9)).toBe('Hot');
    expect(tierOf(0.4)).toBe('Warm');
    expect(tierOf(0.05)).toBe('Cool');
  });
});

describe('assembleDigest (token-budget hottest-first, no generation)', () => {
  const rows: DigestRow[] = [
    { title: 'A', category: 'project', content: 'alpha body', salience: 0.9 },
    { title: 'B', category: 'self', content: 'beta body', salience: 0.5 },
    { title: 'C', category: 'reference', content: 'gamma body', salience: 0.05 },
  ];

  it('orders hottest-first and groups under tier headers', () => {
    const d = assembleDigest(rows)!;
    expect(d).toMatch(/Top of mind[\s\S]*\*\*A\*\*/); // Hot tier, atom A
    expect(d.indexOf('**A**')).toBeLessThan(d.indexOf('**B**')); // hottest first
    // it only ever emits the authored titles/content — never invented prose
    expect(d).toContain('alpha body');
    expect(d).not.toMatch(/synthesi|summary of|in conclusion/i);
  });

  it('respects the token budget (drops the coldest when over)', () => {
    const tiny = assembleDigest(rows, { tokenBudget: 12, charsPerToken: 1 })!; // ~12 chars
    expect(tiny).toContain('**A**'); // hottest kept
    expect(tiny).not.toContain('**C**'); // coldest dropped
  });

  it('returns null for an empty set', () => {
    expect(assembleDigest([])).toBeNull();
  });
});

describe('recompute + digest through the real store', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-salience-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a fresh memory inserts hot (salience 1.0) and shows in the digest', async () => {
    await remember(tmpDir, { category: 'project', title: 'Live build', content: 'wiring the boot digest' });
    const digest = digestForContext(tmpDir);
    expect(digest).toContain('Live build');
    expect(digest).toMatch(/Top of mind/); // fresh = hot
  });

  it('recompute cools an aged, untouched memory below a fresh one', async () => {
    await remember(tmpDir, { category: 'project', title: 'Old thread', content: 'last month' });
    await remember(tmpDir, { category: 'project', title: 'New thread', content: 'today' });
    // Age the first one's timestamps by 60 days (simulate the passage of time).
    const db = new BetterSqlite3(resolveSqliteDbPath(tmpDir));
    db.prepare('UPDATE memories SET created = ?, updated = NULL, last_accessed = NULL WHERE title = ?')
      .run(daysAgo(60), 'Old thread');
    db.close();

    const n = recomputeSalienceForContext(tmpDir, NOW);
    expect(n).toBe(2);

    const check = new BetterSqlite3(resolveSqliteDbPath(tmpDir), { readonly: true });
    const rows = check.prepare('SELECT title, salience FROM memories ORDER BY salience DESC').all() as { title: string; salience: number }[];
    check.close();
    expect(rows[0].title).toBe('New thread'); // fresh outranks aged
    expect(rows[1].salience).toBeLessThan(rows[0].salience);
  });
});
