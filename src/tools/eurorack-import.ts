/**
 * eurorack-import — one-shot importer for the jbarket/eurorack content.
 *
 * Reads markdown files from a local eurorack repo checkout, converts each to
 * a provisional knowledge page (§D, §E2 of the frozen v1 contract). No citations
 * are fabricated; pages enter sourcing='provisional' with a page-level provenance
 * string. Drop knowledge.db and re-run to regenerate (no idempotent-keying column).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createKnowledgeBackend } from '../backends/index.js';
import { resolveIdentityName } from '../config.js';

// ─── Context dir resolution ───────────────────────────────────────────────────

export function resolveContextDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.LOOM_CONTEXT_DIR) return resolve(process.env.LOOM_CONTEXT_DIR);
  return resolve(homedir(), '.config', 'loom', 'default');
}

// ─── Domain mapping ───────────────────────────────────────────────────────────

/**
 * Map a eurorack-repo-relative file path to a domain tag string.
 * Mirrors the folder→domain map from the Phase 3a inventory report.
 */
export function mapDomain(relPath: string): string {
  const parts = relPath.split('/');

  if (parts.length === 1) {
    const name = parts[0].replace(/\.md$/, '');
    if (name === 'philosophy') return 'music/eurorack/philosophy';
    if (name === 'setup-architecture') return 'music/eurorack/architecture';
    if (name === 'README') return 'music/eurorack/overview';
    return 'music/eurorack';
  }

  if (parts[0] === 'modules') return 'music/eurorack/modules';

  if (parts[0] === 'notes') return 'music/eurorack/notes';

  if (parts[0] === 'cases' && parts.length >= 3) {
    const caseType = parts[1]; // e.g. palette-4u, performance-7u, mantis-6u
    const fileName = parts[2];
    // Build files: date-prefixed (e.g. 2026-02-19-...) or named build-specific docs
    if (/^\d{4}-\d{2}-\d{2}/.test(fileName) || fileName === 'space-jungle.md') {
      return `music/eurorack/cases/${caseType}/builds`;
    }
    return `music/eurorack/cases/${caseType}`;
  }

  return 'music/eurorack';
}

// ─── Slug generation ──────────────────────────────────────────────────────────

/**
 * Derive a stable slug from the repo-relative file path.
 * e.g. "cases/palette-4u/spec.md" → "eurorack-cases-palette-4u-spec"
 */
export function pathToSlug(relPath: string): string {
  const withoutExt = relPath.replace(/\.md$/, '');
  const raw = 'eurorack-' + withoutExt;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

// ─── Title extraction ─────────────────────────────────────────────────────────

/**
 * Extract the H1 title from markdown content, falling back to filename.
 */
export function extractTitle(content: string, filePath: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return basename(filePath, extname(filePath));
}

// ─── File discovery ───────────────────────────────────────────────────────────

const SKIP_FILES = new Set(['CLAUDE.md']);

/**
 * Walk the eurorack repo directory, returning relative paths of markdown files
 * to import. Skips .git/, CLAUDE.md, and non-.md files.
 */
export function discoverFiles(repoPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip .git etc.
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (extname(entry.name) !== '.md') continue; // skip JSON, etc.
      if (SKIP_FILES.has(entry.name)) continue;
      results.push(relative(repoPath, fullPath));
    }
  }

  walk(repoPath);
  return results.sort();
}

// ─── SHA resolution ───────────────────────────────────────────────────────────

function resolveRepoSha(repoPath: string): string {
  try {
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoPath });
    if (result.status === 0 && result.stdout) {
      return result.stdout.toString().trim();
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Import record ────────────────────────────────────────────────────────────

export interface ImportRecord {
  relPath: string;
  slug: string;
  title: string;
  domain: string;
  status: 'created' | 'skipped' | 'error';
  error?: string;
}

export interface ImportReport {
  repoPath: string;
  sha: string;
  dryRun: boolean;
  records: ImportRecord[];
  pagesCreated: number;
  pagesSkipped: number;
  pagesFailed: number;
}

// ─── Core importer ────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** Absolute path to the eurorack repo checkout */
  repoPath: string;
  /** Loom context dir (knowledge.db lives here) */
  contextDir: string;
  /** When true, plan the import but write nothing */
  dryRun?: boolean;
}

export async function importEurorack(options: ImportOptions): Promise<ImportReport> {
  const { repoPath, contextDir, dryRun = false } = options;
  const sha = resolveRepoSha(repoPath);
  const provenance = `eurorack@${sha} (imported, unverified)`;

  const files = discoverFiles(repoPath);
  const records: ImportRecord[] = [];
  const actor = resolveIdentityName(contextDir);

  const backend = dryRun ? null : createKnowledgeBackend(contextDir);
  try {
    for (const relPath of files) {
      const slug = pathToSlug(relPath);
      let content: string;
      try {
        content = readFileSync(join(repoPath, relPath), 'utf-8');
      } catch (err) {
        records.push({
          relPath, slug, title: '', domain: '',
          status: 'error', error: `read failed: ${(err as Error).message}`,
        });
        continue;
      }

      const title = extractTitle(content, relPath);
      const domain = mapDomain(relPath);

      if (dryRun) {
        records.push({ relPath, slug, title, domain, status: 'created' });
        continue;
      }

      try {
        await backend!.writePage({
          slug,
          title,
          domain,
          body: content,
          sourcing: 'provisional',
          provenance,
          citations: [],
          actor,
        });
        records.push({ relPath, slug, title, domain, status: 'created' });
      } catch (err) {
        records.push({
          relPath, slug, title, domain,
          status: 'error', error: (err as Error).message,
        });
      }
    }
  } finally {
    backend?.close();
  }

  return {
    repoPath,
    sha,
    dryRun,
    records,
    pagesCreated: records.filter((r) => r.status === 'created').length,
    pagesSkipped: records.filter((r) => r.status === 'skipped').length,
    pagesFailed: records.filter((r) => r.status === 'error').length,
  };
}

// ─── Report rendering ─────────────────────────────────────────────────────────

export function renderImportReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(`Eurorack import ${report.dryRun ? '(dry-run)' : 'complete'}`);
  lines.push(`Repo: ${report.repoPath} @ ${report.sha}`);
  lines.push('');
  lines.push(`Pages created: ${report.pagesCreated}`);
  if (report.pagesSkipped > 0) lines.push(`Pages skipped: ${report.pagesSkipped}`);
  if (report.pagesFailed > 0) lines.push(`Pages failed:  ${report.pagesFailed}`);
  lines.push('');
  lines.push('## Pages');
  for (const r of report.records) {
    const icon = r.status === 'created' ? '✓' : r.status === 'skipped' ? '–' : '✗';
    lines.push(`${icon} [${r.domain}] ${r.title} (${r.slug})`);
    if (r.error) lines.push(`    Error: ${r.error}`);
  }
  return lines.join('\n');
}
