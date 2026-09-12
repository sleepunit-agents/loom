import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeWrite } from './knowledge-write.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeWrite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-kw-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a page with web citation and returns success message', async () => {
    const result = await knowledgeWrite(tempDir, {
      domain: 'music/eurorack',
      title: 'Mutable Instruments Rings',
      body: 'Modal synthesizer module. Physical modelling resonator.',
      citations: [
        {
          claim: 'Rings uses physical modelling',
          source_kind: 'web',
          source_locator: 'https://mutable-instruments.net/modules/rings/',
          excerpt: 'Rings is a resonator module based on physical modelling.',
        },
      ],
    });

    expect(result).toMatch(/mutable-instruments-rings/);
    expect(result).toMatch(/Sourcing: sourced/);
    expect(result).not.toMatch(/Provisional/i);
  });

  it('stores conversation-only citations as provisional (§E1 gate)', async () => {
    const result = await knowledgeWrite(tempDir, {
      domain: 'music/eurorack',
      title: 'Patch Session Notes',
      body: 'We discovered that running Rings into Clouds creates lush textures.',
      citations: [
        {
          claim: 'Rings into Clouds = lush textures',
          source_kind: 'conversation',
          source_locator: 'session/2026-05-30',
          excerpt: 'That combo sounded great.',
        },
      ],
    });

    expect(result).toMatch(/Provisional/i);
    expect(result).toMatch(/provisional/i);

    // Verify backend state
    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('patch-session-notes');
      expect(page).not.toBeNull();
      expect(page!.sourcing).toBe('provisional');
    } finally {
      backend.close();
    }
  });

  it('stores sourced when at least one non-conversation citation exists', async () => {
    const result = await knowledgeWrite(tempDir, {
      domain: 'music/eurorack',
      title: 'Mutable Plaits',
      body: 'Macro-oscillator module with many synthesis engines.',
      citations: [
        {
          claim: 'Plaits has 16 synthesis engines',
          source_kind: 'web',
          source_locator: 'https://mutable-instruments.net/modules/plaits/',
          excerpt: 'Sixteen synthesis engines.',
        },
        {
          claim: 'I prefer the modal engine',
          source_kind: 'conversation',
          source_locator: 'session/abc',
          excerpt: 'modal sounds best to me',
        },
      ],
    });

    expect(result).toMatch(/Sourcing: sourced/);

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('mutable-plaits');
      expect(page!.sourcing).toBe('sourced');
    } finally {
      backend.close();
    }
  });

  it('repo citation on a world-class domain stays sourced, not internal (t-660)', async () => {
    // A world-class page (domain does NOT start with "ours/") with a repo citation
    // must NOT be classified as internal — repo citations only trigger internal for ours/ pages.
    const result = await knowledgeWrite(tempDir, {
      domain: 'programming/github',
      title: 'GitHub Actions run — what it records about what it tested',
      body: 'GitHub Actions records the ref, SHA, and workflow file on each run.',
      citations: [
        {
          claim: 'Actions records ref and SHA on each run',
          source_kind: 'repo',
          source_locator: 'https://github.com/actions/checkout/blob/main/action.yml',
          excerpt: 'ref: inputs.ref',
        },
      ],
    });

    expect(result).toMatch(/Sourcing: sourced/);
    expect(result).not.toMatch(/internal/i);

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('github-actions-run-what-it-records-about-what-it-tested');
      expect(page).not.toBeNull();
      expect(page!.sourcing).toBe('sourced');
    } finally {
      backend.close();
    }
  });

  it('returns error when no citations provided', async () => {
    const result = await knowledgeWrite(tempDir, {
      domain: 'test',
      title: 'No Citations',
      body: 'Some content',
      citations: [],
    });

    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/citation/i);
  });

  it('upserts an existing page by slug', async () => {
    await knowledgeWrite(tempDir, {
      slug: 'rings-module',
      domain: 'music/eurorack',
      title: 'Rings',
      body: 'Original body.',
      citations: [
        {
          claim: 'Rings is a resonator',
          source_kind: 'web',
          source_locator: 'https://mutable-instruments.net/modules/rings/',
          excerpt: 'Resonator module.',
        },
      ],
    });

    const result2 = await knowledgeWrite(tempDir, {
      slug: 'rings-module',
      domain: 'music/eurorack',
      title: 'Rings (updated)',
      body: 'Updated body with more detail.',
      citations: [
        {
          claim: 'Rings can self-oscillate',
          source_kind: 'web',
          source_locator: 'https://mutable-instruments.net/modules/rings/',
          excerpt: 'In some modes Rings self-oscillates.',
        },
      ],
    });

    expect(result2).toMatch(/rings-module/);
    expect(result2).toMatch(/Citations added: 1/);
  });

  it('auto-derives slug from title', async () => {
    const result = await knowledgeWrite(tempDir, {
      domain: 'music',
      title: 'Buchla vs Moog: Voltage Control Philosophies',
      body: 'Buchla uses positive gates; Moog uses negative.',
      citations: [
        {
          claim: 'Buchla uses positive voltage',
          source_kind: 'web',
          source_locator: 'https://example.com/buchla',
          excerpt: 'Buchla East Coast uses positive voltage control.',
        },
      ],
    });

    expect(result).toMatch(/buchla-vs-moog/);
  });

  it('rejects body exceeding hard cap', async () => {
    const result = await knowledgeWrite(tempDir, {
      domain: 'test',
      title: 'Large Page',
      body: 'x'.repeat(65 * 1024),
      citations: [
        {
          claim: 'big claim',
          source_kind: 'web',
          source_locator: 'https://example.com',
          excerpt: 'excerpt',
        },
      ],
    });

    expect(result).toMatch(/Error/i);
  });

  // ── Upsert semantics: mode, title/domain revision, citation dedup ──

  const baseCitation = {
    claim: 'Rings is a resonator',
    source_kind: 'web' as const,
    source_locator: 'https://mutable-instruments.net/modules/rings/',
    excerpt: 'Resonator module.',
  };

  async function seedRings() {
    return knowledgeWrite(tempDir, {
      slug: 'rings',
      domain: 'music/eurorack',
      title: 'Rings',
      body: 'Original body.',
      citations: [baseCitation],
    });
  }

  it('reports created vs updated, and replace is the default upsert mode', async () => {
    const first = await seedRings();
    expect(first).toMatch(/Knowledge page created/);

    const second = await knowledgeWrite(tempDir, {
      slug: 'rings',
      domain: 'music/eurorack',
      title: 'Rings',
      body: 'Replacement body.',
      citations: [{ ...baseCitation, claim: 'Rings self-oscillates', excerpt: 'Self-oscillation.' }],
    });
    expect(second).toMatch(/Knowledge page updated \(body replaced\)/);

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('rings');
      expect(page!.body).toBe('Replacement body.');
    } finally {
      backend.close();
    }
  });

  it('mode: "append" adds the new body after the existing one', async () => {
    await seedRings();

    const result = await knowledgeWrite(tempDir, {
      slug: 'rings',
      domain: 'music/eurorack',
      title: 'Rings',
      body: '## Addendum\nNew section.',
      mode: 'append',
      citations: [{ ...baseCitation, claim: 'Addendum claim', excerpt: 'Addendum excerpt.' }],
    });
    expect(result).toMatch(/Knowledge page updated \(body appended\)/);

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('rings');
      expect(page!.body).toBe('Original body.\n\n## Addendum\nNew section.');
    } finally {
      backend.close();
    }
  });

  it('append mode enforces the combined body cap', async () => {
    await knowledgeWrite(tempDir, {
      slug: 'big',
      domain: 'test',
      title: 'Big',
      body: 'x'.repeat(40 * 1024),
      citations: [baseCitation],
    });

    const result = await knowledgeWrite(tempDir, {
      slug: 'big',
      domain: 'test',
      title: 'Big',
      body: 'y'.repeat(40 * 1024),
      mode: 'append',
      citations: [baseCitation],
    });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/hard cap/i);
  });

  it('re-sending identical citations on upsert dedupes instead of duplicating', async () => {
    await seedRings();

    const result = await knowledgeWrite(tempDir, {
      slug: 'rings',
      domain: 'music/eurorack',
      title: 'Rings',
      body: 'Original body.',
      citations: [
        baseCitation, // exact duplicate — must be skipped
        { ...baseCitation, claim: 'A genuinely new claim', excerpt: 'New excerpt.' },
      ],
    });
    expect(result).toMatch(/Citations added: 1 \(1 duplicate skipped\)/);

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('rings');
      expect(page!.citations).toHaveLength(2);
    } finally {
      backend.close();
    }
  });

  it('title and domain follow the write on upsert', async () => {
    await seedRings();

    await knowledgeWrite(tempDir, {
      slug: 'rings',
      domain: 'music/eurorack/mutable',
      title: 'Mutable Instruments Rings',
      body: 'Revised.',
      citations: [{ ...baseCitation, claim: 'Revision claim', excerpt: 'Revision excerpt.' }],
    });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('rings');
      expect(page!.title).toBe('Mutable Instruments Rings');
      expect(page!.domain).toBe('music/eurorack/mutable');
    } finally {
      backend.close();
    }
  });
});
