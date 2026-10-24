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
  digestData,
  heatOf,
  recallWeight,
  clampConfidence,
  applyObservation,
  decayedConfidence,
  FEEDBACK_CONFIDENCE_MIN,
  FEEDBACK_CONFIDENCE_MAX,
  FEEDBACK_CONFIDENCE_DEFAULT,
  type DigestRow,
} from './salience.js';
import { remember } from '../tools/remember.js';
import { recall } from '../tools/recall.js';
import { closeAllBackends } from './index.js';
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

  // t-1488: the lane missed five days and Top of Mind froze in write order,
  // because the digest trusted the stored field. Heat is read live now.
  it('the digest cools an aged memory even when no recompute has run', async () => {
    await remember(tmpDir, { category: 'project', title: 'Old thread', content: 'last month' });
    await remember(tmpDir, { category: 'project', title: 'New thread', content: 'today' });
    const db = new BetterSqlite3(resolveSqliteDbPath(tmpDir));
    // Stored salience still says 1.0 for both, as if the lane never ran.
    db.prepare('UPDATE memories SET created = ?, updated = NULL, last_accessed = NULL, salience = 1 WHERE title = ?')
      .run(daysAgo(60), 'Old thread');
    db.close();

    const data = digestData(tmpDir, 10, NOW)!;
    expect(data.atoms.map((a) => a.title)).toEqual(['New thread', 'Old thread']);
    expect(data.atoms[1].salience).toBeLessThan(0.2);
    expect(data.atoms[1].tier).toBe('Cool');

    const text = digestForContext(tmpDir, { nowMs: NOW })!;
    expect(text.indexOf('New thread')).toBeLessThan(text.indexOf('Old thread'));
    expect(text).toMatch(/## Background\n- \*\*Old thread\*\*/);
  });

  it('recall heat reheats a memory in the digest without a recompute; last_accessed alone does not', async () => {
    await remember(tmpDir, { category: 'project', title: 'Untouched', content: 'y' });
    await remember(tmpDir, { category: 'project', title: 'Recalled', content: 'x' });
    await remember(tmpDir, { category: 'project', title: 'Only looked at', content: 'z' });
    const db = new BetterSqlite3(resolveSqliteDbPath(tmpDir));
    db.prepare('UPDATE memories SET created = ?, updated = NULL, last_accessed = NULL').run(daysAgo(30));
    db.prepare('UPDATE memories SET recall_heat = 0.8, recall_heat_at = ? WHERE title = ?').run(daysAgo(0), 'Recalled');
    db.prepare('UPDATE memories SET last_accessed = ? WHERE title = ?').run(daysAgo(0), 'Only looked at');
    db.close();
    const atoms = digestData(tmpDir, 10, NOW)!.atoms;
    expect(atoms[0].title).toBe('Recalled');
    expect(atoms[0].salience).toBeCloseTo(0.8, 5);
    expect(atoms.find((a) => a.title === 'Only looked at')!.salience).toBeLessThan(0.2);
  });
});

// t-1489: one recall used to reset every result to full heat, so a vague query
// put ten unrelated memories at the top of mind. Recall adds heat by rank now.
describe('recall heat', () => {
  let tmpDir: string;
  const titles = ['Kiln temps for stoneware', 'Kiln shelf cracked', 'Kiln wiring permit', 'Glaze recipe notes', 'Clay supplier list'];
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-recallheat-'));
    for (const t of titles) await remember(tmpDir, { category: 'project', title: t, content: `${t}: details about the kiln and pottery studio` });
    // Old memories: written heat alone would be cold.
    const db = new BetterSqlite3(resolveSqliteDbPath(tmpDir));
    db.prepare('UPDATE memories SET created = ?, updated = NULL').run(new Date(Date.now() - 60 * 86_400_000).toISOString());
    db.close();
  });
  afterEach(async () => {
    await closeAllBackends();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const heats = () => {
    const db = new BetterSqlite3(resolveSqliteDbPath(tmpDir), { readonly: true });
    const rows = db.prepare('SELECT title, category, created, updated, recall_heat, recall_heat_at, last_accessed FROM memories').all() as Array<{
      title: string; category: string; created: string; updated: string | null; recall_heat: number; recall_heat_at: string | null; last_accessed: string | null;
    }>;
    db.close();
    return rows.map((r) => ({ ...r, heat: heatOf(r, Date.now()) })).sort((a, b) => b.heat - a.heat);
  };

  it('weights are steepest at the top', () => {
    expect([0, 1, 2, 3, 9].map(recallWeight)).toEqual([0.5, 0.3, 0.2, 0.1, 0.1]);
  });

  it('one recall adds heat by rank, and still stamps last_accessed on every result', async () => {
    await recall(tmpDir, { query: 'kiln', limit: 10 });
    const h = heats();
    expect(h.map((r) => Number(r.recall_heat.toFixed(2)))).toEqual([0.5, 0.3, 0.2, 0.1, 0.1]);
    expect(h.every((r) => r.last_accessed !== null)).toBe(true);
    // An incidental hit stays cool; the top hit is warm, not hot.
    expect(h[4].heat).toBeLessThan(0.2);
    expect(h[0].heat).toBeLessThan(0.6);
  });

  it('being the top hit again and again makes a memory hot, and only that one', async () => {
    for (let i = 0; i < 3; i++) await recall(tmpDir, { query: 'kiln', limit: 10 });
    const h = heats();
    expect(h[0].heat).toBeGreaterThanOrEqual(0.99);
    expect(h[0].heat).toBeLessThanOrEqual(1);
    expect(h[4].heat).toBeLessThan(0.35);
    const data = digestData(tmpDir, 10)!;
    expect(data.atoms[0].title).toBe(h[0].title);
    expect(data.atoms[0].tier).toBe('Hot');
    expect(data.atoms.at(-1)!.tier).not.toBe('Hot');
  });
});
