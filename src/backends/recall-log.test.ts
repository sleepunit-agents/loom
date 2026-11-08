import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendRecallObservation,
  readRecallObservations,
  summarizeRecallObservations,
  formatRecallStats,
  parseSinceDuration,
  isRecallLogEnabled,
  recallLogPath,
} from './recall-log.js';
import type { RecallObservation } from './types.js';

function obs(over: Partial<RecallObservation> = {}): RecallObservation {
  return {
    ts: '2026-08-28T10:00:00.000Z',
    tool: 'recall',
    query: 'loom rescue',
    limit: 10,
    diversity: 0.3,
    candidates: 12,
    returned: 3,
    topScore: 0.81,
    threshold: null,
    diversityDrops: 1,
    latencyMs: 12,
    hit: true,
    ...over,
  };
}

describe('recall observation log', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-recall-log-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates telemetry/recall.jsonl on first write with every field present', () => {
    expect(existsSync(recallLogPath(dir))).toBe(false);
    appendRecallObservation(dir, obs({ category: 'project' }), {});
    const lines = readFileSync(recallLogPath(dir), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    for (const key of [
      'ts', 'tool', 'query', 'category', 'limit', 'diversity', 'candidates',
      'returned', 'topScore', 'threshold', 'diversityDrops', 'latencyMs', 'hit',
    ]) {
      expect(row, `missing ${key}`).toHaveProperty(key);
    }
    expect(row.tool).toBe('recall');
    expect(row.hit).toBe(true);
  });

  it('appends one line per search and truncates the query to 120 chars', () => {
    appendRecallObservation(dir, obs(), {});
    appendRecallObservation(dir, obs({ query: 'x'.repeat(500) }), {});
    const rows = readRecallObservations(dir);
    expect(rows).toHaveLength(2);
    expect(rows[1].query).toHaveLength(120);
  });

  it('does not throw when the write fails', () => {
    // A regular file where the context dir should be: mkdir must fail.
    const bogus = join(dir, 'not-a-dir');
    writeFileSync(bogus, 'x');
    expect(() => appendRecallObservation(bogus, obs(), {})).not.toThrow();
  });

  it('is disabled by LOOM_RECALL_LOG=0 / off / false', () => {
    for (const v of ['0', 'off', 'FALSE', 'no']) {
      expect(isRecallLogEnabled({ LOOM_RECALL_LOG: v })).toBe(false);
      appendRecallObservation(dir, obs(), { LOOM_RECALL_LOG: v });
    }
    expect(isRecallLogEnabled({})).toBe(true);
    expect(isRecallLogEnabled({ LOOM_RECALL_LOG: '1' })).toBe(true);
    expect(existsSync(recallLogPath(dir))).toBe(false);
  });

  it('reads back with a since filter and skips malformed lines', () => {
    appendRecallObservation(dir, obs({ ts: '2026-08-01T00:00:00.000Z' }), {});
    appendRecallObservation(dir, obs({ ts: '2026-08-27T00:00:00.000Z' }), {});
    writeFileSync(recallLogPath(dir), 'not json\n', { flag: 'a' });
    expect(readRecallObservations(dir)).toHaveLength(2);
    expect(readRecallObservations(dir, { since: new Date('2026-08-20T00:00:00Z') })).toHaveLength(1);
    expect(readRecallObservations(join(dir, 'nowhere'))).toEqual([]);
  });
});

describe('summarizeRecallObservations', () => {
  it('computes counts, hit rate, medians, and the recent misses newest-first', () => {
    const rows: RecallObservation[] = [
      obs({ ts: '2026-08-28T10:00:00.000Z', latencyMs: 10, topScore: 0.9 }),
      obs({ ts: '2026-08-28T10:01:00.000Z', latencyMs: 30, topScore: 0.7, diversityDrops: 2 }),
      obs({ ts: '2026-08-28T10:02:00.000Z', latencyMs: 20, hit: false, returned: 0, topScore: null, query: 'miss one', candidates: 0, diversityDrops: 0 }),
      obs({ ts: '2026-08-28T10:03:00.000Z', latencyMs: 40, hit: false, returned: 0, topScore: null, query: 'miss two', category: 'user', candidates: 0, diversityDrops: 0 }),
    ];
    const stats = summarizeRecallObservations(rows);
    expect(stats.searches).toBe(4);
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(2);
    expect(stats.hitRate).toBeCloseTo(0.5);
    expect(stats.medianLatencyMs).toBe(25);
    expect(stats.medianTopScore).toBeCloseTo(0.8);
    expect(stats.diversityDrops).toBe(3);
    expect(stats.recentMisses.map((m) => m.query)).toEqual(['miss two', 'miss one']);
    expect(stats.recentMisses[0].category).toBe('user');
  });

  it('caps recent misses at 10 by default', () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      obs({ ts: `2026-08-28T10:${String(i).padStart(2, '0')}:00.000Z`, hit: false, query: `q${i}` }));
    const stats = summarizeRecallObservations(rows);
    expect(stats.recentMisses).toHaveLength(10);
    expect(stats.recentMisses[0].query).toBe('q14');
  });

  it('formats an empty window and a populated one', () => {
    expect(formatRecallStats(summarizeRecallObservations([]), '7d')).toMatch(/0 searches/);
    const text = formatRecallStats(summarizeRecallObservations([
      obs(), obs({ hit: false, topScore: null, returned: 0, query: 'gone', project: 'vigil' }),
    ]), '7d');
    expect(text).toMatch(/2 searches/);
    expect(text).toMatch(/hit rate\s+1\/2 \(50%\)/);
    expect(text).toMatch(/median latency\s+12 ms/);
    expect(text).toMatch(/median topScore\s+0\.810/);
    expect(text).toMatch(/"gone"\s+\[project=vigil\]/);
  });
});

describe('parseSinceDuration', () => {
  it('parses m/h/d/w', () => {
    expect(parseSinceDuration('30m')).toBe(30 * 60_000);
    expect(parseSinceDuration('24h')).toBe(24 * 3_600_000);
    expect(parseSinceDuration('7d')).toBe(7 * 86_400_000);
    expect(parseSinceDuration('2w')).toBe(14 * 86_400_000);
  });
  it('rejects junk', () => {
    expect(() => parseSinceDuration('soon')).toThrow(/--since/);
    expect(() => parseSinceDuration('7')).toThrow();
  });
});
