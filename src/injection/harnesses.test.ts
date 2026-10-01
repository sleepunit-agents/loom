import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES, HARNESS_KEYS, resolveHarnessPath, type HarnessKey } from './harnesses.js';
import { INSTALL_TARGETS } from '../install/harnesses.js';

describe('HARNESSES preset table', () => {
  it('exposes exactly three keys: claude-code, codex, gemini-cli', () => {
    expect([...HARNESS_KEYS].sort()).toEqual(['claude-code', 'codex', 'gemini-cli']);
    expect(Object.keys(HARNESSES).sort()).toEqual(['claude-code', 'codex', 'gemini-cli']);
  });

  it('every preset has display, defaultPath, toolPrefix', () => {
    for (const key of HARNESS_KEYS) {
      const p = HARNESSES[key];
      expect(p.key).toBe(key);
      expect(typeof p.display).toBe('string');
      expect(p.display.length).toBeGreaterThan(0);
      expect(typeof p.defaultPath).toBe('string');
      expect(p.defaultPath.startsWith(homedir())).toBe(true);
      expect(p.toolPrefix).toBe('mcp__loom__');
    }
  });

  it('default paths match the documented conventions', () => {
    expect(HARNESSES['claude-code'].defaultPath).toBe(join(homedir(), '.claude', 'CLAUDE.md'));
    expect(HARNESSES['codex'].defaultPath).toBe(join(homedir(), '.codex', 'AGENTS.md'));
    expect(HARNESSES['gemini-cli'].defaultPath).toBe(join(homedir(), '.gemini', 'GEMINI.md'));
  });

  it('HarnessKey type narrows to the three string literals', () => {
    const k: HarnessKey = 'claude-code';
    expect(HARNESSES[k]).toBeDefined();
  });
});

describe('install/injection toolPrefix agreement (t-397)', () => {
  it('every shared harness key gets the same toolPrefix from both adapters', () => {
    for (const key of HARNESS_KEYS) {
      expect(HARNESSES[key].toolPrefix).toBe(INSTALL_TARGETS[key].toolPrefix);
    }
  });
});

describe('resolveHarnessPath', () => {
  it('returns the frozen defaultPath when home is undefined', () => {
    expect(resolveHarnessPath(HARNESSES['claude-code'])).toBe(HARNESSES['claude-code'].defaultPath);
  });

  it('returns a HOME-relative path when an override is provided', () => {
    const p = resolveHarnessPath(HARNESSES['codex'], '/tmp/fake-home');
    expect(p).toBe('/tmp/fake-home/.codex/AGENTS.md');
  });

  it('covers all three harnesses with override', () => {
    expect(resolveHarnessPath(HARNESSES['claude-code'], '/h')).toBe('/h/.claude/CLAUDE.md');
    expect(resolveHarnessPath(HARNESSES['codex'], '/h')).toBe('/h/.codex/AGENTS.md');
    expect(resolveHarnessPath(HARNESSES['gemini-cli'], '/h')).toBe('/h/.gemini/GEMINI.md');
  });
});
