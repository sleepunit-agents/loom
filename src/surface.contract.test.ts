import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBCOMMANDS } from './cli/subcommands.js';
import { TOOLS } from './clients.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
const skillMd = readFileSync(join(repoRoot, 'assets', 'skill', 'SKILL.md'), 'utf-8');
const serverSrc = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf-8');

function extractServerTools(): string[] {
  const matches = [...serverSrc.matchAll(/server\.registerTool\(\s*['"](\w+)['"]/g)];
  return matches.map((m) => m[1]);
}

// Extract CLI subcommand names referenced in SKILL.md.
// Only match code contexts to avoid false positives from prose like "loom is already installed":
//   - inline code:  `loom <cmd> ...`
//   - code-block lines that begin with (optional whitespace + optional pipe) + loom <cmd>
function extractSkillMdCommands(): string[] {
  const inline = [...skillMd.matchAll(/`loom ([\w-]+)/g)].map((m) => m[1]);
  const block = [...skillMd.matchAll(/(?:^|\n)[ \t]*(?:\| )?loom ([\w-]+)/g)].map((m) => m[1]);
  return [...new Set([...inline, ...block])].filter((w) => !w.startsWith('-'));
}

const serverTools = extractServerTools();

// ─── MCP tool / clients.ts alignment ─────────────────────────────────────────

describe('server.ts tools vs clients.ts TOOLS', () => {
  it('every registered tool is listed in TOOLS', () => {
    for (const tool of serverTools) {
      expect(TOOLS, `"${tool}" registered in server.ts but missing from clients.ts TOOLS`).toContain(tool);
    }
  });

  it('every TOOLS entry has a server.tool registration (no ghost entries)', () => {
    for (const tool of TOOLS) {
      expect(serverTools, `"${tool}" in clients.ts TOOLS but not registered in server.ts`).toContain(tool);
    }
  });
});

// ─── MCP tools → README.md ────────────────────────────────────────────────────

describe('server.ts tools vs README.md', () => {
  it('every registered tool appears in README.md', () => {
    for (const tool of serverTools) {
      expect(readme, `"${tool}" registered in server.ts but missing from README.md`).toContain(tool);
    }
  });
});

// ─── CLI subcommands → README.md ─────────────────────────────────────────────

describe('CLI subcommands vs README.md', () => {
  it('every subcommand appears in README.md', () => {
    for (const cmd of SUBCOMMANDS) {
      expect(readme, `"${cmd}" in SUBCOMMANDS but missing from README.md`).toContain(cmd);
    }
  });
});

// ─── SKILL.md inverse check ───────────────────────────────────────────────────
// SKILL.md is a setup workflow — it need not document every tool/subcommand.
// But anything it references as a `loom <cmd>` must be a real registered subcommand.

describe('assets/skill/SKILL.md references', () => {
  it('every loom command referenced in SKILL.md is a registered subcommand', () => {
    const referenced = extractSkillMdCommands();
    for (const cmd of referenced) {
      expect(
        SUBCOMMANDS as readonly string[],
        `"loom ${cmd}" referenced in SKILL.md but "${cmd}" is not a registered subcommand`,
      ).toContain(cmd);
    }
  });
});
