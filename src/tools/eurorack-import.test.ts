import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  mapDomain,
  pathToSlug,
  extractTitle,
  discoverFiles,
  importEurorack,
  renderImportReport,
  resolveContextDir,
} from './eurorack-import.js';
import { createKnowledgeBackend } from '../backends/index.js';
import evalSet from './__fixtures__/eurorack-eval-set.json' with { type: 'json' };

const FIXTURE_DIR = fileURLToPath(new URL('./__fixtures__/eurorack', import.meta.url));

// ─── Unit: mapDomain ─────────────────────────────────────────────────────────

describe('mapDomain', () => {
  it('maps top-level philosophy.md', () => {
    expect(mapDomain('philosophy.md')).toBe('music/eurorack/philosophy');
  });

  it('maps setup-architecture.md', () => {
    expect(mapDomain('setup-architecture.md')).toBe('music/eurorack/architecture');
  });

  it('maps README.md to overview', () => {
    expect(mapDomain('README.md')).toBe('music/eurorack/overview');
  });

  it('maps modules/catalog.md', () => {
    expect(mapDomain('modules/catalog.md')).toBe('music/eurorack/modules');
  });

  it('maps notes/* files', () => {
    expect(mapDomain('notes/divskip-ocpx.md')).toBe('music/eurorack/notes');
    expect(mapDomain('notes/mg-json-format.md')).toBe('music/eurorack/notes');
    expect(mapDomain('notes/mg-rack-api.md')).toBe('music/eurorack/notes');
  });

  it('maps cases/{type}/spec.md to the case domain', () => {
    expect(mapDomain('cases/palette-4u/spec.md')).toBe('music/eurorack/cases/palette-4u');
    expect(mapDomain('cases/performance-7u/spec.md')).toBe('music/eurorack/cases/performance-7u');
    expect(mapDomain('cases/mantis-6u/spec.md')).toBe('music/eurorack/cases/mantis-6u');
  });

  it('maps date-prefixed case files to builds subdomain', () => {
    expect(mapDomain('cases/palette-4u/2026-02-19-techno-jbarket.md'))
      .toBe('music/eurorack/cases/palette-4u/builds');
    expect(mapDomain('cases/palette-4u/2026-02-19-techno-artfish.md'))
      .toBe('music/eurorack/cases/palette-4u/builds');
  });

  it('maps space-jungle.md to builds subdomain', () => {
    expect(mapDomain('cases/performance-7u/space-jungle.md'))
      .toBe('music/eurorack/cases/performance-7u/builds');
  });

  it('maps cases/{type}/csl.md (non-build) to case domain', () => {
    expect(mapDomain('cases/palette-4u/csl.md')).toBe('music/eurorack/cases/palette-4u');
  });
});

// ─── Unit: pathToSlug ────────────────────────────────────────────────────────

describe('pathToSlug', () => {
  it('generates stable slugs from paths', () => {
    expect(pathToSlug('philosophy.md')).toBe('eurorack-philosophy');
    expect(pathToSlug('README.md')).toBe('eurorack-readme');
    expect(pathToSlug('modules/catalog.md')).toBe('eurorack-modules-catalog');
    expect(pathToSlug('cases/palette-4u/spec.md')).toBe('eurorack-cases-palette-4u-spec');
    expect(pathToSlug('notes/divskip-ocpx.md')).toBe('eurorack-notes-divskip-ocpx');
  });

  it('handles date-prefixed filenames', () => {
    const slug = pathToSlug('cases/palette-4u/2026-02-19-techno-jbarket.md');
    expect(slug).toBe('eurorack-cases-palette-4u-2026-02-19-techno-jbarket');
  });
});

// ─── Unit: extractTitle ──────────────────────────────────────────────────────

describe('extractTitle', () => {
  it('extracts H1 heading from content', () => {
    const content = '# Philosophy\n\nSome content here.';
    expect(extractTitle(content, 'philosophy.md')).toBe('Philosophy');
  });

  it('extracts H1 with complex text', () => {
    const content = '# DivSkip + OCP X: Disconnected Gates & Pitch\n\nContent.';
    expect(extractTitle(content, 'divskip-ocpx.md')).toBe('DivSkip + OCP X: Disconnected Gates & Pitch');
  });

  it('falls back to filename when no H1', () => {
    expect(extractTitle('No heading here.', 'notes/mg-json-format.md')).toBe('mg-json-format');
  });
});

// ─── Unit: discoverFiles ─────────────────────────────────────────────────────

describe('discoverFiles', () => {
  it('discovers all markdown files from fixture dir', () => {
    const files = discoverFiles(FIXTURE_DIR);
    // Should include all .md files except CLAUDE.md
    expect(files).toContain('philosophy.md');
    expect(files).toContain('setup-architecture.md');
    expect(files).toContain('README.md');
    expect(files).toContain('modules/catalog.md');
    expect(files).toContain('cases/palette-4u/spec.md');
    expect(files).toContain('cases/palette-4u/2026-02-19-techno-jbarket.md');
    expect(files).toContain('cases/palette-4u/2026-02-19-techno-artfish.md');
    expect(files).toContain('cases/palette-4u/csl.md');
    expect(files).toContain('cases/performance-7u/spec.md');
    expect(files).toContain('cases/performance-7u/space-jungle.md');
    expect(files).toContain('cases/mantis-6u/spec.md');
    expect(files).toContain('notes/divskip-ocpx.md');
    expect(files).toContain('notes/mg-json-format.md');
    expect(files).toContain('notes/mg-rack-api.md');
  });

  it('skips CLAUDE.md', () => {
    const files = discoverFiles(FIXTURE_DIR);
    expect(files).not.toContain('CLAUDE.md');
  });

  it('skips JSON files', () => {
    const files = discoverFiles(FIXTURE_DIR);
    for (const f of files) {
      expect(f).not.toMatch(/\.json$/);
    }
  });

  it('returns exactly the expected count from the eurorack inventory', () => {
    const files = discoverFiles(FIXTURE_DIR);
    // 14 files: 15 markdown total minus CLAUDE.md
    expect(files).toHaveLength(14);
  });
});

// ─── Integration: importEurorack ─────────────────────────────────────────────

describe('importEurorack', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-er-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('dry-run returns report without writing pages', async () => {
    const report = await importEurorack({
      repoPath: FIXTURE_DIR,
      contextDir: tempDir,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.pagesCreated).toBe(14);
    expect(report.pagesFailed).toBe(0);

    // Verify nothing was written
    const backend = createKnowledgeBackend(tempDir);
    try {
      const pages = await backend.listPages();
      expect(pages).toHaveLength(0);
    } finally {
      backend.close();
    }
  });

  it('imports all 14 pages as provisional with correct domain tags', async () => {
    const report = await importEurorack({
      repoPath: FIXTURE_DIR,
      contextDir: tempDir,
    });

    expect(report.pagesCreated).toBe(14);
    expect(report.pagesFailed).toBe(0);

    const backend = createKnowledgeBackend(tempDir);
    try {
      const pages = await backend.listPages({ limit: 20 });
      expect(pages).toHaveLength(14);

      for (const page of pages) {
        expect(page.sourcing).toBe('provisional');
        expect(page.provenance).toMatch(/eurorack@/);
        expect(page.provenance).toMatch(/imported, unverified/);
        expect(page.citations).toHaveLength(0);
        expect(page.domain).toMatch(/^music\/eurorack/);
      }
    } finally {
      backend.close();
    }
  });

  it('writes pages with correct slugs derived from paths', async () => {
    await importEurorack({ repoPath: FIXTURE_DIR, contextDir: tempDir });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const phil = await backend.getPage('eurorack-philosophy');
      expect(phil).not.toBeNull();
      expect(phil!.domain).toBe('music/eurorack/philosophy');
      expect(phil!.title).toBe('Philosophy');

      const spec = await backend.getPage('eurorack-cases-palette-4u-spec');
      expect(spec).not.toBeNull();
      expect(spec!.domain).toBe('music/eurorack/cases/palette-4u');

      const build = await backend.getPage('eurorack-cases-palette-4u-2026-02-19-techno-jbarket');
      expect(build).not.toBeNull();
      expect(build!.domain).toBe('music/eurorack/cases/palette-4u/builds');
    } finally {
      backend.close();
    }
  });

  it('no fabricated citations (§E2)', async () => {
    await importEurorack({ repoPath: FIXTURE_DIR, contextDir: tempDir });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const pages = await backend.listPages({ limit: 20 });
      for (const page of pages) {
        expect(page.citations).toHaveLength(0);
      }
    } finally {
      backend.close();
    }
  });

  it('is regenerable: re-import overwrites without error', async () => {
    await importEurorack({ repoPath: FIXTURE_DIR, contextDir: tempDir });
    const report2 = await importEurorack({ repoPath: FIXTURE_DIR, contextDir: tempDir });

    expect(report2.pagesCreated).toBe(14);
    expect(report2.pagesFailed).toBe(0);

    const backend = createKnowledgeBackend(tempDir);
    try {
      const pages = await backend.listPages({ limit: 30 });
      expect(pages).toHaveLength(14);
    } finally {
      backend.close();
    }
  });
});

// ─── Integration: renderImportReport ─────────────────────────────────────────

describe('renderImportReport', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-er-rpt-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('includes summary counts and page list', async () => {
    const report = await importEurorack({
      repoPath: FIXTURE_DIR,
      contextDir: tempDir,
      dryRun: true,
    });
    const rendered = renderImportReport(report);

    expect(rendered).toMatch(/dry-run/i);
    expect(rendered).toMatch(/Pages created: 14/);
    expect(rendered).toMatch(/music\/eurorack\/philosophy/);
  });
});

// ─── Eval set: LIKE recall finds expected pages ───────────────────────────────
// Run queries from the Phase 3a eval set against the imported fixture corpus
// and verify the expected pages appear in results.

describe('eval-set recall (§A4 falsifiable trigger)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-er-eval-'));
    await importEurorack({ repoPath: FIXTURE_DIR, contextDir: tempDir });
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  for (const entry of evalSet) {
    it(`Q${entry.id}: ${entry.question.slice(0, 60)}`, async () => {
      const backend = createKnowledgeBackend(tempDir);
      try {
        // Use search_terms (keywords) not the full question — LIKE is verbatim substring match
        const results = await backend.queryPages({ query: entry.search_terms, limit: 15 });
        const foundSlugs = results.map((p) => p.slug);

        for (const expectedSlug of entry.expected_slugs) {
          expect(
            foundSlugs,
            `Q${entry.id} [terms: "${entry.search_terms}"]: expected "${expectedSlug}" for: "${entry.question}"`,
          ).toContain(expectedSlug);
        }
      } finally {
        backend.close();
      }
    });
  }
});

// ─── Unit: resolveContextDir ──────────────────────────────────────────────────

describe('resolveContextDir', () => {
  const originalEnv = process.env.LOOM_CONTEXT_DIR;

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.LOOM_CONTEXT_DIR;
    } else {
      process.env.LOOM_CONTEXT_DIR = originalEnv;
    }
  });

  it('returns resolved explicit path when provided', () => {
    const result = resolveContextDir('/some/explicit/dir');
    expect(result).toBe('/some/explicit/dir');
  });

  it('returns resolved LOOM_CONTEXT_DIR when set and no explicit path', () => {
    process.env.LOOM_CONTEXT_DIR = '/env/context/dir';
    const result = resolveContextDir(undefined);
    expect(result).toBe('/env/context/dir');
  });

  it('falls back to ~/.config/loom/default when LOOM_CONTEXT_DIR is unset', () => {
    delete process.env.LOOM_CONTEXT_DIR;
    const result = resolveContextDir(undefined);
    expect(result).toMatch(/[/\\]\.config[/\\]loom[/\\]default$/);
    expect(result).not.toBe(process.cwd());
  });

  it('explicit path takes precedence over LOOM_CONTEXT_DIR', () => {
    process.env.LOOM_CONTEXT_DIR = '/env/context/dir';
    const result = resolveContextDir('/explicit/wins');
    expect(result).toBe('/explicit/wins');
  });
});
