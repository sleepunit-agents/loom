import { describe, it, expect } from 'vitest';
import {
  INSTALL_TARGETS,
  INSTALL_TARGET_KEYS,
  isInstallTargetKey,
  resolveSkillPath,
  getInstallTarget,
} from './harnesses.js';

describe('INSTALL_TARGETS', () => {
  it('exposes 5 canonical keys in order', () => {
    expect(INSTALL_TARGET_KEYS).toEqual([
      'claude-code',
      'codex',
      'gemini-cli',
      'opencode',
      'other',
    ]);
  });

  it('claude-code lives under ~/.claude/skills', () => {
    const t = getInstallTarget('claude-code');
    expect(t.toolPrefix).toBe('mcp__loom__');
    expect(resolveSkillPath(t, '/home/u')).toBe('/home/u/.claude/skills/loom-setup.md');
  });

  it('codex lives under ~/.agents/skills', () => {
    const t = getInstallTarget('codex');
    expect(t.toolPrefix).toBe('mcp__loom__');
    expect(resolveSkillPath(t, '/home/u')).toBe('/home/u/.agents/skills/loom-setup.md');
  });

  it('gemini-cli shares ~/.agents/skills with codex', () => {
    const t = getInstallTarget('gemini-cli');
    expect(t.toolPrefix).toBe('mcp__loom__');
    expect(resolveSkillPath(t, '/home/u')).toBe('/home/u/.agents/skills/loom-setup.md');
  });

  it('opencode uses loom_ prefix under ~/.agents/skills', () => {
    const t = getInstallTarget('opencode');
    expect(t.toolPrefix).toBe('loom_');
    expect(resolveSkillPath(t, '/home/u')).toBe('/home/u/.agents/skills/loom-setup.md');
  });

  it('other target has null skillDir', () => {
    const t = getInstallTarget('other');
    expect(t.skillDir).toBeNull();
    expect(resolveSkillPath(t, '/home/u')).toBeNull();
  });

  it('isInstallTargetKey narrows correctly', () => {
    expect(isInstallTargetKey('claude-code')).toBe(true);
    expect(isInstallTargetKey('nope')).toBe(false);
  });
});
