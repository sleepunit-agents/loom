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

const backendModules = readdirSync(join(repoRoot, 'src', 'backends'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

const backendSources = backendModules.map((f) => read('src', 'backends', f)).join('\n');
const tables = [...backendSources.matchAll(/CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((m) => m[1]);

describe('docs/architecture.md covers every moving part', () => {
  it('finds what it enumerates (guards against a broken extractor)', () => {
    expect(tools.length).toBeGreaterThan(20);
    expect(backendModules.length).toBeGreaterThan(10);
    expect(tables).toContain('memories');
    expect(tables).toContain('pages');
  });

  it('names every registered MCP tool', () => {
    for (const tool of tools) {
      expect(map, `tool "${tool}" is registered but not on the architecture map`).toContain(tool);
    }
  });

  it('names every CLI subcommand', () => {
    for (const cmd of SUBCOMMANDS) {
      expect(map, `subcommand "${cmd}" is not on the architecture map`).toContain(`\`${cmd}\``);
    }
  });

  it('names every src/backends module', () => {
    for (const file of backendModules) {
      expect(map, `src/backends/${file} is not on the architecture map`).toContain(file);
    }
  });

  it('names every SQLite table', () => {
    for (const table of new Set(tables)) {
      expect(map, `table "${table}" is not on the architecture map`).toContain(table);
    }
  });
});
