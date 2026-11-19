import { z } from 'zod';

export const laneFactKinds = ['mirror-freshness', 'alert-ledger', 'cleanup-receipt', 'login-expiry','cleanup-week-journal','mirror-unit-state'] as const;
export type LaneFact = typeof laneFactKinds[number];
export const factDirectory = '/var/lib/loom/machine-facts';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stamp = count.positive();
const reason = z.enum(['outside-scope-or-primary','missing-symlink-locked-or-prunable','protected-branch','open-pr','no-exact-merged-pr','head-changed','dirty','ignored-data','git-lock','recent','in-use-or-unreadable-process','registration-changed','error']);
const alertKind = z.enum(['unit','unit-suppressed','message','triage','triage-joined','triage-skipped','clear','alert','verdict']);
const identifier = z.string().max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]*$/);
const alert = z.strictObject({
  at: stamp, kind: alertKind, source: identifier, id: identifier.optional(),
  verdict: z.enum(['real','fixed','false-alarm']).optional(),
});
const unitField = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const schemas = {
  'mirror-unit-state': z.strictObject({
    observedAt:stamp,LoadState:unitField,ActiveState:unitField,SubState:unitField,Result:unitField,
  }),
  'cleanup-week-journal': z.strictObject({
    observedAt:stamp,since:stamp,total:count,
    recent:z.array(z.strictObject({at:stamp,priority:z.number().int().min(0).max(7)})).max(100),
  }),
  'login-expiry': z.strictObject({ observedAt: stamp, refreshExpiresAt: stamp.max(253402300799) }),
  'mirror-freshness': z.strictObject({ observedAt: stamp, trackedMax: count, liveMax: stamp }),
  'alert-ledger': z.strictObject({ observedAt: stamp, since: stamp, entries: z.array(alert).max(100), tuneSources: z.array(identifier).max(100) }),
  'cleanup-receipt': z.strictObject({
    observedAt: stamp, since: stamp, started: count, finished: count, kept: count,
    removed: count, wouldRemove: count, reasons: z.partialRecord(reason, count),
    runs: z.array(z.strictObject({at:stamp,event:z.enum(['start','finish']),count,apply:z.boolean()})).max(100),
    removedHeads: z.array(z.string().regex(/^[a-f0-9]{40}$/)).max(100),
  }),
};

export function isLaneFact(kind: string): kind is LaneFact {
  return laneFactKinds.some(k => k === kind);
}

export function laneFactOutput(kind: LaneFact, raw: string, now = Math.floor(Date.now() / 1000)): string {
  const value = schemas[kind].parse(JSON.parse(raw));
  if (value.observedAt > now || now - value.observedAt > 900) throw Error('Expired machine fact');
  if ('since' in value) {
    const seconds = kind === 'alert-ledger' ? 26 * 3600 : 7 * 86400;
    if (value.since !== value.observedAt - seconds) throw Error('Incomplete observation window');
  }
  if ('recent' in value && (value.recent.length !== Math.min(value.total, 100)
      || value.recent.some(entry => entry.at < value.since || entry.at > value.observedAt)))
    throw Error('Incomplete cleanup journal');
  if ('entries' in value && value.entries.some(entry => entry.at < value.since || entry.at > value.observedAt))
    throw Error('Alert outside observation window');
  if ('kept' in value && Object.values(value.reasons).reduce((sum, n) => sum + n, 0) !== value.kept)
    throw Error('Incomplete cleanup reasons');
  if ('runs' in value && (value.runs.some(run => run.at < value.since || run.at > value.observedAt)
      || value.runs.filter(run => run.event === 'start').length !== value.started
      || value.runs.length !== value.started + value.finished || value.removedHeads.length !== value.removed))
    throw Error('Incomplete cleanup receipts');
  return JSON.stringify(value);
}
