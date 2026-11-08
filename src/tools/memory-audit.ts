/**
 * memory_audit tool — one-shot health report for the memory store.
 * Surfaces counts, stale memories, near-duplicate pairs, and expired refs.
 * Read-only: never deletes. Pair with `forget` / `update` to act on findings.
 */
import { createBackend } from '../backends/index.js';
import type { AuditOptions, AuditReport } from '../backends/types.js';

export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Memory audit`);
  lines.push('');
  lines.push(`**Total memories:** ${report.totalMemories}`);

  const cats = Object.entries(report.byCategory).sort((a, b) => b[1] - a[1]);
  if (cats.length > 0) {
    lines.push('');
    lines.push('**By category:**');
    for (const [c, n] of cats) lines.push(`- ${c}: ${n}`);
  }

  lines.push('');
  lines.push(`**Expired (would be pruned):** ${report.expired.length}`);
  for (const ref of report.expired.slice(0, 20)) lines.push(`- ${ref}`);
  if (report.expired.length > 20) {
    lines.push(`- … and ${report.expired.length - 20} more`);
  }

  lines.push('');
  lines.push(`**Stale (untouched beyond threshold):** ${report.stale.length}`);
  for (const s of report.stale.slice(0, 20)) {
    const proj = s.project ? ` [${s.project}]` : '';
    lines.push(`- ${s.ref} — *${s.title}*${proj} (last touch ${s.lastTouch.slice(0, 10)})`);
  }
  if (report.stale.length > 20) {
    lines.push(`- … and ${report.stale.length - 20} more`);
  }

  lines.push('');
  lines.push(`**Near-duplicate pairs:** ${report.duplicates.length}`);
  for (const d of report.duplicates) {
    lines.push(
      `- ${d.relevance.toFixed(3)}  ${d.a.ref} ↔ ${d.b.ref}  ` +
      `(*${d.a.title}* vs *${d.b.title}*)`,
    );
  }

  return lines.join('\n');
}

export async function memoryAudit(
  contextDir: string,
  options?: AuditOptions,
): Promise<string> {
  const backend = createBackend(contextDir);
  const report = await backend.audit(options);
  return formatAuditReport(report);
}
