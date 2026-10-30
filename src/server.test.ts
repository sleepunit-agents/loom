/**
 * Tests for the MCP server factory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLoomServer, type LoomServerConfig } from './server.js';
import { CURRENT_STACK_VERSION } from './config.js';
import { createKnowledgeBackend } from './backends/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContextDir(base: string): string {
  const contextDir = join(base, 'context');
  mkdirSync(join(contextDir, 'memories'), { recursive: true });

  return contextDir;
}

function makeConfig(base: string): LoomServerConfig {
  return { contextDir: makeContextDir(base) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createLoomServer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a server without errors', () => {
    const config = makeConfig(tmpDir);
    const { server } = createLoomServer(config);
    expect(server).toBeDefined();
  });

  it('creates multiple independent server instances', () => {
    const config = makeConfig(tmpDir);
    const { server: s1 } = createLoomServer(config);
    const { server: s2 } = createLoomServer(config);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1).not.toBe(s2);
  });

  // t-415: every tool must declare ToolAnnotations so clients that gate on
  // readOnlyHint/destructiveHint under approval:never (e.g. Codex) can tell
  // a read from a write without a human in the loop. undefined means
  // "not asserted" here, not "false" — most tools only carry readOnlyHint,
  // and destructiveHint/idempotentHint are only meaningful when
  // readOnlyHint is false (MCP spec).
  const EXPECTED_ANNOTATIONS: Record<string, {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  }> = {
    identity: { readOnlyHint: true, openWorldHint: false },
    dossier: { readOnlyHint: true, openWorldHint: false },
    remember: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    recall: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    update: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    forget: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    memory_prune: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    memory_list: { readOnlyHint: true, openWorldHint: false },
    episodes: { readOnlyHint: true, openWorldHint: false },
    find_similar: { readOnlyHint: true, openWorldHint: false },
    memory_audit: { readOnlyHint: true, openWorldHint: false },
    memory_recompute_salience: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    memory_archive: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    memory_merge: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    memory_restore: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    memory_propose: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    memory_proposals: { readOnlyHint: true, openWorldHint: false },
    memory_ratify: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    memory_reject: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    update_identity: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    bootstrap: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    harness_init: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    harness_describe: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    knowledge_write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    knowledge_recall: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    knowledge_maintain: { readOnlyHint: true, openWorldHint: false },
    knowledge_archive: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    knowledge_restore: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    knowledge_move: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    knowledge_merge: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    knowledge_supersede: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    knowledge_purge: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    knowledge_verify: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    knowledge_history: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    memory_history: { readOnlyHint: true, openWorldHint: false },
    memory_revision_restore: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    person_write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    person_verify: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    person_archive: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    person_restore: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    person: { readOnlyHint: true, openWorldHint: false },
    person_list: { readOnlyHint: true, openWorldHint: false },
    person_history: { readOnlyHint: true, openWorldHint: false },
    person_evidence: { readOnlyHint: true, openWorldHint: false },
    knowledge_list: { readOnlyHint: true, openWorldHint: false },
    note_write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    note_read: { readOnlyHint: true, openWorldHint: false },
    note_list: { readOnlyHint: true, openWorldHint: false },
    person_revision_restore: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  };

  // t-1597: agent to agent. The household's HTTP server hands a session a
  // relay that calls the clock piece as that session's own agent; a server
  // with none (stdio, a lone stack) has no relay tool at all.
  it('has a relay tool only when it is given a relay, and passes the ask through as the clock\'s argv', async () => {
    const connect = async (config: LoomServerConfig) => {
      const { server } = createLoomServer(config);
      const client = new Client({ name: 'relay-test', version: '1' });
      const [c, s] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(s), client.connect(c)]);
      return client;
    };
    const none = await connect(makeConfig(tmpDir));
    expect((await none.listTools()).tools.map((t) => t.name)).not.toContain('relay');

    const seen: string[][] = [];
    const client = await connect({
      ...makeConfig(tmpDir),
      relay: async (argv) => { seen.push(argv); return { ok: true, text: 'r-12345678: mark wakes within a minute' }; },
    });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'relay');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    const r = await client.callTool({ name: 'relay', arguments: { to: 'mark', say: 'review #3?', why: 'w', reply_to: 'r-aaaaaaaa', from: 'discord:#x' } });
    expect(seen).toEqual([['relay', '--to', 'mark', '--say', 'review #3?', '--why', 'w', '--reply-to', 'r-aaaaaaaa', '--from', 'discord:#x']]);
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(/mark wakes/);
    expect(r.isError).toBeFalsy();

    const refused = await connect({ ...makeConfig(tmpDir), relay: async () => ({ ok: false, text: 'wake: the household doesn\'t pair art with fez' }) });
    const e = await refused.callTool({ name: 'relay', arguments: { to: 'fez', say: 'hi' } });
    expect(e.isError).toBe(true);
    expect((e.content as Array<{ text: string }>)[0].text).toMatch(/doesn't pair/);
  });

  it('advertises correct ToolAnnotations for every registered tool', async () => {
    const { server } = createLoomServer(makeConfig(tmpDir));
    const client = new Client({ name: 'annotation-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      const expectedNames = Object.keys(EXPECTED_ANNOTATIONS);
      const actualNames = tools.map((t) => t.name);
      // Catches drift: a new tool landing with no entry here (and no
      // annotations) would otherwise pass silently.
      expect(actualNames.sort()).toEqual(expectedNames.slice().sort());

      for (const [name, expected] of Object.entries(EXPECTED_ANNOTATIONS)) {
        const annotations = byName.get(name)?.annotations;
        expect(annotations?.readOnlyHint, `${name}.readOnlyHint`).toBe(expected.readOnlyHint);
        expect(annotations?.openWorldHint, `${name}.openWorldHint`).toBe(expected.openWorldHint);
        if (expected.destructiveHint !== undefined) {
          expect(annotations?.destructiveHint, `${name}.destructiveHint`).toBe(expected.destructiveHint);
        }
        if (expected.idempotentHint !== undefined) {
          expect(annotations?.idempotentHint, `${name}.idempotentHint`).toBe(expected.idempotentHint);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('createLoomServer — stack version', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-version-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes CURRENT_STACK_VERSION on boot for a fresh context dir', () => {
    const contextDir = makeContextDir(tmpDir);
    const stampPath = join(contextDir, 'LOOM_STACK_VERSION');
    expect(existsSync(stampPath)).toBe(false);

    createLoomServer({ contextDir });

    expect(existsSync(stampPath)).toBe(true);
    expect(readFileSync(stampPath, 'utf-8')).toBe(`${CURRENT_STACK_VERSION}\n`);
  });

  it('leaves an existing in-range LOOM_STACK_VERSION alone', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), '1\n');

    createLoomServer({ contextDir });

    expect(readFileSync(join(contextDir, 'LOOM_STACK_VERSION'), 'utf-8')).toBe('1\n');
  });

  it('throws on boot when on-disk version is ahead of what loom understands', () => {
    const contextDir = makeContextDir(tmpDir);
    const ahead = CURRENT_STACK_VERSION + 1;
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), `${ahead}\n`);

    expect(() => createLoomServer({ contextDir })).toThrow(new RegExp(`is version ${ahead}`, 'i'));
  });

  it('throws on boot when LOOM_STACK_VERSION is unparseable', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), 'banana');

    expect(() => createLoomServer({ contextDir })).toThrow(/unparseable/i);
  });
});

describe('createLoomServer — blank identity guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-bootguard-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('boots normally for a non-default contextDir even with no IDENTITY.md', () => {
    // All existing tests exercise this path — non-default dir, no enforcement
    const contextDir = join(tmpDir, 'explicit-context');
    mkdirSync(join(contextDir, 'memories'), { recursive: true });
    expect(() => createLoomServer({ contextDir })).not.toThrow();
  });

  it('boots normally for a non-default contextDir that has IDENTITY.md', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'IDENTITY.md'), '# Test\n');
    expect(() => createLoomServer({ contextDir })).not.toThrow();
  });
});

// t-675 (Mark, review 5558293087): the full server's knowledge registration
// must attribute to the LOCAL identity — the context dir's identity, or
// LOOM_IDENTITY — never a hard-coded 'art'. Covers author, replace actor,
// restore actor, and verifier, for a non-Art context and for the override.
describe('createLoomServer — knowledge attribution uses the local identity', () => {
  let tmpDir: string;
  const savedIdentity = process.env.LOOM_IDENTITY;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-identity-'));
    delete process.env.LOOM_IDENTITY;
  });

  afterEach(() => {
    if (savedIdentity === undefined) delete process.env.LOOM_IDENTITY;
    else process.env.LOOM_IDENTITY = savedIdentity;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function exercise(contextDir: string) {
    const { server } = createLoomServer({ contextDir });
    const client = new Client({ name: 'identity-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const citations = [{ claim: 'x', source_kind: 'web', source_locator: 'https://example.com/x', excerpt: 'x' }];
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy();
        return result;
      };
      await call('knowledge_write', { title: 'Rings', domain: 'music/eurorack', body: 'v1', citations });
      await call('knowledge_write', { slug: 'rings', title: 'Rings', domain: 'music/eurorack', body: 'v2', citations });
      // t-1598: the freshness listing a verification sweep picks from, as the CLI's `knowledge list` gives it.
      const listed = JSON.parse(((await call('knowledge_list', { domain: 'music/eurorack' })).content as { text: string }[])[0].text);
      expect(listed.map((p: { slug: string }) => p.slug)).toEqual(['rings']);
      expect(Object.keys(listed[0]).sort()).toEqual(['created', 'domain', 'freshness_anchor', 'sla_class', 'slug', 'title', 'verified_at']);
      const backend = createKnowledgeBackend(contextDir);
      let revisionId: number;
      try {
        revisionId = (await backend.listRevisions('rings'))[0].id;
      } finally {
        backend.close();
      }
      await call('knowledge_history', { slug: 'rings', revision_id: revisionId, restore: true });
      await call('knowledge_verify', { slug: 'rings', outcome: 'confirmed', citation_checked: true });
    } finally {
      await client.close();
      await server.close();
    }

    const backend = createKnowledgeBackend(contextDir);
    try {
      const page = await backend.getPage('rings');
      const revisions = await backend.listRevisions('rings');
      const [verification] = await backend.getVerifications('rings');
      return {
        author: page!.author,
        revisionActors: revisions.map((r) => r.actor),
        verifier: verification.verifier,
        body: page!.body,
      };
    } finally {
      backend.close();
    }
  }

  it('attributes to the context dir identity (a non-Art context)', async () => {
    const contextDir = join(tmpDir, 'mark');
    mkdirSync(join(contextDir, 'memories'), { recursive: true });
    const got = await exercise(contextDir);
    expect(got.body).toContain('v1'); // the restore actually ran
    expect(got.author).toBe('mark');
    expect(got.revisionActors).toEqual(['mark', 'mark']); // replace + restore
    expect(got.verifier).toBe('mark');
  });

  it('LOOM_IDENTITY overrides the context dir name', async () => {
    process.env.LOOM_IDENTITY = 'gabe';
    const contextDir = join(tmpDir, 'mark');
    mkdirSync(join(contextDir, 'memories'), { recursive: true });
    const got = await exercise(contextDir);
    expect(got.author).toBe('gabe');
    expect(got.revisionActors).toEqual(['gabe', 'gabe']);
    expect(got.verifier).toBe('gabe');
  });
});

describe('createLoomServer — person cards over MCP', () => {
  let tmpDir: string;
  const savedIdentity = process.env.LOOM_IDENTITY;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-person-'));
    process.env.LOOM_IDENTITY = 'art';
  });

  afterEach(() => {
    if (savedIdentity === undefined) delete process.env.LOOM_IDENTITY;
    else process.env.LOOM_IDENTITY = savedIdentity;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes, reads, lists, archives and splices a card into identity', async () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'IDENTITY.md'), 'Creed');
    const { server } = createLoomServer({ contextDir });
    const client = new Client({ name: 'person-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const text = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return (result.content as { text: string }[])[0].text;
      };

      const written = JSON.parse(await text('person_write', {
        slug: 'patrick-kells',
        name: 'Patrick Kells',
        summary: 'Field lead.',
        where: { pond: { value: 'field / et-livonia' } },
        how: { tz: 'America/New_York', mode: 'terse' },
        may: [{ text: 'may draft field-setup changes', source: 'Jonathan, Discord #pond 2026-10-08' }],
      }));
      expect(written).toMatchObject({ unchanged: false, revision_id: null });

      expect(await text('person_write', { slug: 'patrick-kells', how: { tier: 2 } })).toMatch(/^Error: .*"tier" is a reserved key/);
      expect(await text('person_verify', { slug: 'patrick-kells', fields: ['pond'] })).toContain('"verified_at"');

      const read = JSON.parse(await text('person', { slug: 'patrick-kells' }));
      expect(read.rendered).toContain('pond: field / et-livonia [ok]');
      expect(JSON.parse(await text('person', { slug: 'nobody' }))).toEqual({ found: false });
      expect(JSON.parse(await text('person_list', {}))[0]).toMatchObject({ slug: 'patrick-kells', stale: 0, unverified: 0 });

      const identity = await text('identity', { people: ['patrick-kells'] });
      expect(identity).toContain('# In the room');
      expect(identity).toContain('**How:** mode: terse · tz: America/New_York');

      const archived = JSON.parse(await text('person_archive', { slug: 'patrick-kells', reason: 'test' }));
      expect(archived.archived).toBe(true);
      expect(await text('identity', { people: ['patrick-kells'] })).toContain('_(card for patrick-kells is archived)_');
      await text('person_restore', { slug: 'patrick-kells' });

      // t-1598: what the card condenses, as the CLI's `person evidence` gives it.
      await text('remember', { category: 'user', title: 'Patrick prefers mornings', content: 'Calls before 10.', metadata: { person: 'patrick-kells' } });
      const evidence = JSON.parse(await text('person_evidence', { slug: 'patrick-kells' }));
      expect(evidence.map((e: { title: string }) => e.title)).toContain('Patrick prefers mornings');
      expect(JSON.parse(await text('person_evidence', { slug: 'nobody-here' }))).toEqual([]);

      // Unknown keys reject at the MCP boundary instead of being stripped (PR143 review).
      const before = await text('person', { slug: 'patrick-kells' });
      const histBefore = await text('person_history', { slug: 'patrick-kells' });
      const strays = [
        { slug: 'patrick-kells', name: 'P', live: { tasks: ['x'] } },
        { slug: 'patrick-kells', name: 'Patrick Kells', merge: false, hows: { tz: 'x' } },
        { slug: 'new-person', name: 'N', live: {} },
      ];
      for (const args of strays) {
        const r = await client.callTool({ name: 'person_write', arguments: args });
        const msg = (r.content as { text: string }[])[0].text;
        expect(r.isError || msg.startsWith('Error'), msg).toBeTruthy();
        expect(msg).toMatch(/live|hows|[Uu]nrecognized/);
      }
      expect(await text('person', { slug: 'patrick-kells' })).toBe(before);
      expect(await text('person_history', { slug: 'patrick-kells' })).toBe(histBefore);
      expect(JSON.parse(await text('person', { slug: 'new-person' }))).toEqual({ found: false });
      expect(await text('person_history', { slug: '../x' })).toMatch(/^Error: slug/);

      const history = JSON.parse(await text('person_history', { slug: 'patrick-kells' }));
      expect(history.map((h: { op: string }) => h.op)).toEqual(['restore', 'archive', 'verify']);
      const restored = JSON.parse(await text('person_revision_restore', { slug: 'patrick-kells', revision_id: history[2].id }));
      expect(restored.card.where.pond.verified_at).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
