/**
 * knowledge_history tool — body-revision listing, inspection, and restore.
 *
 * Replace-writes snapshot the displaced body into page_revisions (capped per
 * page, newest kept). This tool is the recovery surface: list a page's
 * snapshots, read one, or restore one. A restore snapshots the body it
 * displaces — restoring is never itself a destructive overwrite.
 */
import { createKnowledgeBackend } from '../backends/index.js';
import { resolveIdentityName } from '../config.js';

export interface KnowledgeHistoryToolInput {
  slug: string;
  revision_id?: number;
  restore?: boolean;
}

export async function knowledgeHistory(
  contextDir: string,
  input: KnowledgeHistoryToolInput,
): Promise<string> {
  if (!input.slug) {
    return 'Error: slug is required.';
  }
  if (input.restore && input.revision_id === undefined) {
    return 'Error: restore requires a revision_id — list revisions first to pick one.';
  }

  const backend = createKnowledgeBackend(contextDir);
  try {
    // ── Restore mode ──
    if (input.restore && input.revision_id !== undefined) {
      const result = await backend.restoreRevision({
        slug: input.slug,
        revision_id: input.revision_id,
        actor: resolveIdentityName(contextDir),
      });
      return (
        `Restored revision #${result.revision_id} onto \`${result.slug}\`. ` +
        `The displaced body was snapshotted as revision #${result.snapshot_id}.`
      );
    }

    // ── Read mode ──
    if (input.revision_id !== undefined) {
      const revision = await backend.getRevision(input.revision_id);
      if (!revision) {
        return `Error: revision not found: ${input.revision_id}`;
      }
      return (
        `# Revision #${revision.id} of \`${revision.slug}\`\n` +
        `op: ${revision.op} | by ${revision.actor ?? 'unknown'} | replaced: ${revision.replaced_at}\n\n` +
        `${revision.body}\n\n` +
        `_Pass restore: true to put this body back on the page._`
      );
    }

    // ── List mode ──
    const revisions = await backend.listRevisions(input.slug);
    const verifications = await backend.getVerifications(input.slug);

    if (revisions.length === 0 && verifications.length === 0) {
      return `\`${input.slug}\` has no revisions or verifications — its body has never been replaced, and it has never been verified.`;
    }

    const sections: string[] = [`# History — \`${input.slug}\``];

    if (revisions.length > 0) {
      const lines = revisions.map(
        (r) => `- **#${r.id}** | ${r.op} | by ${r.actor ?? 'unknown'} | replaced ${r.replaced_at} | ${r.body_length} chars`,
      );
      sections.push(
        `## ${revisions.length} body snapshot(s)\n\n${lines.join('\n')}\n\n` +
        `_Pass revision_id to read a snapshot; add restore: true to put it back._`,
      );
    } else {
      sections.push('## No body snapshots — its body has never been replaced.');
    }

    if (verifications.length > 0) {
      const vLines = verifications.map(
        (v) => `- **#${v.id}** | ${v.outcome} | by ${v.verifier ?? 'unknown'} | ${v.verified_at}` +
          (v.citation_checked ? ' | citations checked' : ''),
      );
      sections.push(`## ${verifications.length} verification(s)\n\n${vLines.join('\n')}`);
    }

    return sections.join('\n\n');
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
