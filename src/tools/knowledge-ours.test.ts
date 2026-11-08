/**
 * Tests for the ours/ knowledge class (t-81, 2026-08-31).
 *
 * Covers:
 * - repo citation → internal sourcing
 * - created_by / version metadata fields stored and retrieved
 * - domain prefix ours/ queryable via knowledge_recall
 * - ours/internal pages excluded from misfile audit in knowledge_maintain
 * - ours/provisional pages still flagged in misfile audit (missing repo citation)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeWrite } from './knowledge-write.js';
import { knowledgeRecall } from './knowledge-recall.js';
import { knowledgeMaintain } from './knowledge-maintain.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('ours/ knowledge class', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-ours-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('repo citation produces internal sourcing', async () => {
    const result = await knowledgeWrite(tempDir, {
      title: 'wake chain spec',
      domain: 'ours/art-ops',
      body: 'Art self-schedules work via the wake CLI.',
      citations: [{
        claim: 'wake CLI lives at ~/Art/wake/wake',
        source_kind: 'repo',
        source_locator: 'Art/wake/wake@HEAD',
        excerpt: 'wake in 4h -p "..."',
      }],
      created_by: 'art',
      version: '2026-08-31',
    });

    expect(result).toMatch(/internal/i);
    expect(result).toMatch(/ours\/art-ops/);
  });

  it('repo citation to someone else\'s repo on an ours/ domain is still internal (t-718)', async () => {
    // The check reads domain and source_kind only, never the locator.
    const result = await knowledgeWrite(tempDir, {
      title: 'checkout action notes',
      domain: 'ours/art-ops',
      body: 'How our CI uses actions/checkout.',
      citations: [{
        claim: 'checkout takes a ref input',
        source_kind: 'repo',
        source_locator: 'https://github.com/actions/checkout/blob/main/action.yml',
        excerpt: 'ref:',
      }],
    });

    expect(result).toMatch(/Sourcing: internal/);
  });

  it('stores and retrieves created_by and version', async () => {
    await knowledgeWrite(tempDir, {
      title: 'breakbrain density model',
      domain: 'ours/breakbrain',
      body: 'The density model governs note probability.',
      citations: [{
        claim: 'density parameter lives in density.js',
        source_kind: 'repo',
        source_locator: 'Art/Code/breakbrain/src/density.js',
        excerpt: 'const density = ...',
      }],
      created_by: 'art',
      version: 'v3',
    });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('breakbrain-density-model');
      expect(page).not.toBeNull();
      expect(page!.created_by).toBe('art');
      expect(page!.version).toBe('v3');
    } finally {
      backend.close();
    }
  });

  it('preserves created_by / version on upsert when omitted', async () => {
    await knowledgeWrite(tempDir, {
      title: 'homelab ingress',
      domain: 'ours/homelab',
      body: 'Initial ingress design.',
      citations: [{
        claim: 'traefik routes live in traefik/config',
        source_kind: 'repo',
        source_locator: 'homelab/traefik/config@HEAD',
        excerpt: 'EntryPoints...',
      }],
      created_by: 'art',
      version: 'wave-4',
    });

    // Upsert without created_by / version — they should be preserved.
    await knowledgeWrite(tempDir, {
      title: 'homelab ingress',
      domain: 'ours/homelab',
      body: 'Updated ingress design.',
      mode: 'replace',
      citations: [{
        claim: 'traefik config updated',
        source_kind: 'repo',
        source_locator: 'homelab/traefik/config@abc123',
        excerpt: 'EntryPoints v2...',
      }],
    });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('homelab-ingress');
      expect(page!.created_by).toBe('art');
      expect(page!.version).toBe('wave-4');
    } finally {
      backend.close();
    }
  });

  it('ours/ pages queryable by domain prefix', async () => {
    await knowledgeWrite(tempDir, {
      title: 'wake chain spec',
      domain: 'ours/art-ops',
      body: 'Art self-schedules work.',
      citations: [{ claim: 'wake CLI', source_kind: 'repo', source_locator: 'Art/wake/wake', excerpt: 'wake ...' }],
    });
    // A world-class page that must not appear in the ours/ filter.
    await knowledgeWrite(tempDir, {
      title: 'Mutable Instruments Rings',
      domain: 'music/eurorack',
      body: 'Rings is a resonator module.',
      citations: [{ claim: 'Rings resonates', source_kind: 'web', source_locator: 'https://example.com', excerpt: 'Rings resonates...' }],
    });

    const oursIndex = await knowledgeRecall(tempDir, { domain: 'ours', detail: 'index' });
    expect(oursIndex).toMatch(/ours\/art-ops/);
    expect(oursIndex).not.toMatch(/mutable-instruments-rings/);
  });

  it('ours/internal pages are NOT flagged by misfile audit', async () => {
    await knowledgeWrite(tempDir, {
      title: 'homelab ingress',
      domain: 'ours/homelab',
      body: 'Internal homelab design doc.',
      citations: [{
        claim: 'traefik config path',
        source_kind: 'repo',
        source_locator: 'homelab/traefik',
        excerpt: 'traefik routing rules...',
      }],
    });

    const report = await knowledgeMaintain(tempDir);
    // The ours/internal page must not appear under misfile audit.
    expect(report).not.toMatch(/homelab-ingress.*provisional/);
    expect(report).toMatch(/None — all active pages have independent citation support/);
  });

  it('ours/provisional pages (no repo citation) are flagged with repo hint', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      // Directly write a provisional ours/ page (conversation-only citations).
      await backend.writePage({
        slug: 'ours-provisional',
        title: 'Draft spec',
        domain: 'ours/breakbrain',
        body: 'Draft without a repo citation.',
        sourcing: 'provisional',
        citations: [{
          claim: 'we discussed this',
          source_kind: 'conversation',
          excerpt: 'we discussed...',
        }],
      });
    } finally {
      backend.close();
    }

    const report = await knowledgeMaintain(tempDir);
    expect(report).toMatch(/ours-provisional/);
    expect(report).toMatch(/repo citation/i);
  });

  it('conversation-only citations on ours/ page produce provisional sourcing', async () => {
    const result = await knowledgeWrite(tempDir, {
      title: 'sketch doc',
      domain: 'ours/breakbrain',
      body: 'Conversation sketch only.',
      citations: [{
        claim: 'we talked about this',
        source_kind: 'conversation',
        excerpt: 'sketch...',
      }],
    });
    expect(result).toMatch(/provisional/i);
  });

  it('mixed repo + conversation citations produce internal (not provisional)', async () => {
    const result = await knowledgeWrite(tempDir, {
      title: 'mixed citations doc',
      domain: 'ours/art-ops',
      body: 'Has both conversation and repo support.',
      citations: [
        { claim: 'we designed it', source_kind: 'conversation', excerpt: 'we designed...' },
        { claim: 'implementation', source_kind: 'repo', source_locator: 'Art/bin/foo', excerpt: 'foo()' },
      ],
    });
    expect(result).toMatch(/internal/i);
  });
});
