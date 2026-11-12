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

// A name only counts as standalone: `recall` inside `knowledge_recall`, or
// `memory.ts` inside `sqlite-memory.ts`, must not satisfy it.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const standalone = (name: string) => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, 'g');
const names = (doc: string, name: string) => standalone(name).test(doc);

/** `doc` with every standalone occurrence of `name` removed, longer identifiers kept. */
const erase = (doc: string, name: string) => doc.replace(standalone(name), '');

/** Every moving part `doc` fails to name, labelled by kind. */
function missingFrom(doc: string): string[] {
  return [
    ...tools.filter((t) => !names(doc, t)).map((t) => `tool "${t}"`),
    ...widgetTools.filter((t) => !names(doc, t)).map((t) => `widget tool "${t}"`),
    ...SUBCOMMANDS.filter((c) => !doc.includes(`\`${c}\``)).map((c) => `subcommand "${c}"`),
    ...backendModules.filter((f) => !names(doc, f)).map((f) => `src/backends/${f}`),
    ...[...new Set(tables)].filter((t) => !names(doc, t)).map((t) => `table "${t}"`),
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
    expect(missingFrom(erase(map, name))).toContain(expected);
  });

  it('does not let a longer identifier stand in for a shorter one', () => {
    const withoutRecall = erase(map, 'recall');
    expect(withoutRecall).toContain('knowledge_recall');
    const missing = missingFrom(withoutRecall);
    expect(missing).toContain('tool "recall"');
    expect(missing).not.toContain('tool "knowledge_recall"');
  });
});

// Parse module specifiers rather than matching source text: comments and strings
// cannot create or hide an import at the replacement-piece boundary.
import { init, parse } from 'es-module-lexer';
import { relative, resolve, dirname } from 'node:path';
await init;
function moduleSpecifiers(source: string): string[] {
  return parse(source)[0].filter(i => i.type !== 'meta').map(i => i.specifier ?? '<computed>');
}
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []);
}
function seamErrors(path: string, source: string): string[] {
  const local = relative(join(repoRoot, 'src'), path).split('/');
  return moduleSpecifiers(source).flatMap(spec => {
    if (spec === '<computed>') return [`${path}: computed module import`];
    if (!spec.startsWith('.')) return [];
    const target = relative(join(repoRoot, 'src'), resolve(dirname(path), spec)).split('/');
    if (local[0] === 'core' && target[0] === 'pieces') return [`${path}: core imports a piece`];
    if (local[0] === 'pieces') {
      if (target[0] === 'core' || (target[0] === 'pieces' && (target[1] === local[1] || target.slice(2).join('/') === 'role.js'))) return [];
      return [`${path}: piece imports outside core, itself, or another piece's role.ts`];
    }
    return [];
  });
}
describe('in-process piece seams', () => {
  it('core imports no piece; pieces reach other pieces through role.ts only', () => {
    const files = [...filesUnder(join(repoRoot, 'src/core')), ...filesUnder(join(repoRoot, 'src/pieces'))];
    expect(files.flatMap(path => seamErrors(path, readFileSync(path, 'utf8')))).toEqual([]);
  });
  it('checks static, re-export and dynamic imports and ignores comments', () => {
    const piece = join(repoRoot, 'src/pieces/a/index.ts');
    expect(seamErrors(piece, `import '../b/index.js'; export * from '../b/private.js'; import('../b/secret.js');`)).toHaveLength(3);
    expect(seamErrors(piece, `import '../b/role.js'; import '../../core/index.js'; // import '../b/private.js'`)).toEqual([]);
    expect(seamErrors(join(repoRoot, 'src/core/x.ts'), `export * from '../pieces/a/role.js'`)).toHaveLength(1);
  });
});
