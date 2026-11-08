/**
 * append-maintenance-log — appends a dated Markdown entry to a repo-tracked
 * changelog file for memory-maintenance operations.
 *
 * Blessed decision 3 (SLE-89 / SLE-71): the consolidation digest goes to a file
 * in the repo — not a `reference` memory, not an issue comment. This helper is the
 * canonical formatter for that file, shared by both maintenance tracks:
 *   - Tier 2: weekly consolidation  (Art-Consolidate)
 *   - Tier 3: monthly identity review (Art-Identity-Review)
 *
 * It is a plain filesystem append — NO git operations. Entries are append-only;
 * the maintainer batches commits (agents do not commit). See docs/memory-maintenance.md.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Tier2Entry {
  /** Defaults to "Art-Consolidate autopilot". */
  runName?: string;
  memoriesAudited: number;
  staleCount: number;
  duplicateCount: number;
  expiredCount: number;
  mergeCount: number;
  contradictions: number;
  pruned: number;
  notes?: string;
}

export interface Tier3Entry {
  /** Defaults to "Art-Identity-Review routine". */
  runName?: string;
  /** Section names updated in preferences.md (empty/omitted = no changes). */
  preferencesUpdated?: string[];
  /** Section names updated in self-model.md (empty/omitted = no changes). */
  selfModelUpdated?: string[];
  /** Whether IDENTITY.md itself changed. */
  identityChanged?: boolean;
  projectBriefsAccessed: number;
  projectBriefsStale: number;
  /** Free-form harness-manifest status, e.g. "4/4 present and current". */
  harnessManifests?: string;
  notes?: string;
}

export type MaintenanceLogEntry =
  | { type: 'tier-2'; timestamp?: Date; tier2: Tier2Entry; tier3?: never }
  | { type: 'tier-3'; timestamp?: Date; tier3: Tier3Entry; tier2?: never };

export interface AppendResult {
  success: boolean;
  filePath: string;
  /** ISO date (YYYY-MM-DD) of the entry that was written. */
  timestamp: string;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** ISO date (YYYY-MM-DD) in UTC. Stable regardless of the host time zone. */
function isoDate(ts: Date): string {
  return ts.toISOString().slice(0, 10);
}

function formatTier2(date: string, data: Tier2Entry): string {
  const lines = [
    `## [${date}] Weekly Consolidation (Tier 2)`,
    '',
    `- **Run:** ${data.runName ?? 'Art-Consolidate autopilot'}`,
    `- **Memories audited:** ${data.memoriesAudited} ` +
      `(${data.staleCount} stale, ${data.duplicateCount} duplicates, ${data.expiredCount} expired)`,
    `- **Operations:**`,
    `  - Merges: ${data.mergeCount}`,
    `  - Contradictions: ${data.contradictions}`,
    `  - Pruned: ${data.pruned}`,
  ];
  if (data.notes) lines.push(`- **Notes:** ${data.notes}`);
  return lines.join('\n');
}

function formatTier3(date: string, data: Tier3Entry): string {
  const prefs = data.preferencesUpdated ?? [];
  const self = data.selfModelUpdated ?? [];
  const lines = [
    `## [${date}] Monthly Identity Review (Tier 3)`,
    '',
    `- **Run:** ${data.runName ?? 'Art-Identity-Review routine'}`,
    `- **Manifest changes:**`,
    prefs.length > 0
      ? `  - preferences.md: ${prefs.length} section(s) updated (${prefs.join(', ')})`
      : `  - preferences.md: No changes`,
    self.length > 0
      ? `  - self-model.md: ${self.length} section(s) updated (${self.join(', ')})`
      : `  - self-model.md: No changes`,
    `  - IDENTITY.md: ${data.identityChanged ? 'Changes made' : 'No changes'}`,
    `- **Project briefs:** ${data.projectBriefsAccessed} accessed, ${data.projectBriefsStale} stale`,
  ];
  if (data.harnessManifests) lines.push(`- **Harness manifests:** ${data.harnessManifests}`);
  if (data.notes) lines.push(`- **Notes:** ${data.notes}`);
  return lines.join('\n');
}

export function formatEntry(entry: MaintenanceLogEntry): string {
  const date = isoDate(entry.timestamp ?? new Date());
  return entry.type === 'tier-2'
    ? formatTier2(date, entry.tier2)
    : formatTier3(date, entry.tier3);
}

// ─── File header ──────────────────────────────────────────────────────────────

export const FILE_HEADER = [
  '# Memory Maintenance Log',
  '',
  'Changelog of memory-maintenance operations. Tier 2 (weekly consolidation,',
  'Art-Consolidate) and Tier 3 (monthly identity review, Art-Identity-Review)',
  'agents append a dated summary after each run.',
  '',
  'Append-only: entries are never edited or removed. Agents do **not** commit —',
  'the maintainer batches commits. See `docs/memory-maintenance.md` for the format',
  'and procedure.',
  '',
].join('\n');

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Append a maintenance entry to `logFilePath`. Creates the file (with header) and
 * any missing parent directories on first write. Each entry is separated from the
 * previous content by a `---` thematic break.
 */
export async function appendMaintenanceLog(
  entry: MaintenanceLogEntry,
  logFilePath: string,
): Promise<AppendResult> {
  const date = isoDate(entry.timestamp ?? new Date());

  await mkdir(dirname(logFilePath), { recursive: true });

  let existing: string;
  try {
    existing = await readFile(logFilePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    existing = FILE_HEADER;
  }

  // Normalize trailing whitespace so the separator spacing is consistent
  // regardless of how a prior write/edit left the file.
  const base = existing.replace(/\s*$/, '');
  const block = `${base}\n\n---\n\n${formatEntry(entry)}\n`;

  await writeFile(logFilePath, block);

  return { success: true, filePath: logFilePath, timestamp: date };
}
