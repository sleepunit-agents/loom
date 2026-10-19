import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBCOMMANDS } from './cli/subcommands.js';

// docs/architecture.md is the at-a-glance map of loom. It only stays useful
// if it can't silently drift, so every moving part the source can enumerate
// has to be named on it: change the machine, redraw the map in the same PR.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf-8');
const map = read('docs', 'architecture.md');

const toolSources = read('src', 'server.ts') + read('src', 'transport', 'knowledge-tools.ts');
const tools = [...toolSources.matchAll(/server\.registerTool\(\s*['"](\w+)['"]/g)].map((m) => m[1]);

// MCP-App widget tools go through registerApp({ tool: '...' }), not registerTool.
const widgetTools = [...read('src', 'transport', 'mcp-app-hello.ts').matchAll(/\btool:\s*['"](\w+)['"]/g)].map(
  (m) => m[1],
);

const backendModules = readdirSync(join(repoRoot, 'src', 'backends'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

const backendSources = backendModules.map((f) => read('src', 'backends', f)).join('\n');
const tables = [...backendSources.matchAll(/CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((m) => m[1]);

/** Every moving part `doc` fails to name, labelled by kind. */
function missingFrom(doc: string): string[] {
  return [
    ...tools.filter((t) => !doc.includes(t)).map((t) => `tool "${t}"`),
    ...widgetTools.filter((t) => !doc.includes(t)).map((t) => `widget tool "${t}"`),
    ...SUBCOMMANDS.filter((c) => !doc.includes(`\`${c}\``)).map((c) => `subcommand "${c}"`),
    ...backendModules.filter((f) => !doc.includes(f)).map((f) => `src/backends/${f}`),
    ...[...new Set(tables)].filter((t) => !doc.includes(t)).map((t) => `table "${t}"`),
  ];
}

describe('docs/architecture.md covers every moving part', () => {
  it('finds what it enumerates (guards against a broken extractor)', () => {
    expect(tools.length).toBeGreaterThan(20);
    expect(widgetTools).toEqual(['loom_hello', 'loom_display_modes', 'loom_top_of_mind', 'loom_proposals']);
    expect(backendModules.length).toBeGreaterThan(10);
    expect(tables).toContain('memories');
    expect(tables).toContain('pages');
  });

  it('names every MCP tool, widget tool, CLI subcommand, backend module and SQLite table', () => {
    expect(missingFrom(map)).toEqual([]);
  });

  it.each([
    ['memory_prune', 'tool "memory_prune"'],
    ['knowledge_verify', 'tool "knowledge_verify"'],
    ['loom_top_of_mind', 'widget tool "loom_top_of_mind"'],
    ['loom_proposals', 'widget tool "loom_proposals"'],
    ['`doctor`', 'subcommand "doctor"'],
    ['retry.ts', 'src/backends/retry.ts'],
    ['memory_deletions', 'table "memory_deletions"'],
  ])('fails when %s is erased from the map', (name, expected) => {
    expect(missingFrom(map.replaceAll(name, ''))).toContain(expected);
  });
});
